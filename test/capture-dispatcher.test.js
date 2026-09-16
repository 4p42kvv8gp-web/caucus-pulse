import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_STATUSES, API_VERSION, MAX_DISPATCHES, MAX_DURATION_MS, REPOSITORY,
  createGitHubClient, initialState, tick
} from '../src/capture-dispatcher.js';

const START = '2026-09-16T02:00:00.000Z';
const ms = Date.parse(START);
const at = (minutes) => new Date(ms + minutes * 60_000).toISOString();
const capture = (minutes = -10, attemptMinutes = minutes) => ({ lastPollAt: at(minutes), lastPollAttemptAt: at(attemptMinutes), lastPollRunId: '9001', lastPollRunAttempt: 1 });
const runUrl = (id) => `https://api.github.com/repos/${REPOSITORY}/actions/runs/${id}`;
const htmlUrl = (id) => `https://github.com/${REPOSITORY}/actions/runs/${id}`;
const receipt = (id = 9001) => ({ status: 200, data: { workflow_run_id: id, run_url: runUrl(id), html_url: htmlUrl(id) } });
const rawRun = (id, overrides = {}) => ({
  id, path: '.github/workflows/poll.yml', status: 'queued', conclusion: null, run_attempt: 1,
  url: runUrl(id), html_url: htmlUrl(id), head_branch: 'main', event: 'workflow_dispatch',
  created_at: START, run_started_at: START, ...overrides
});
const child = (overrides = {}) => ({ id: 9001, runAttempt: 1, path: '.github/workflows/poll.yml', status: 'queued', conclusion: null, branch: 'main', event: 'workflow_dispatch', ...overrides });
function rig(overrides = {}, options = {}) {
  const writes = [], calls = [];
  let clock = START;
  const client = {
    listActiveWriters: async () => { calls.push('writers'); return { complete: true, runs: [] }; },
    getCaptureState: async () => { calls.push('capture'); return capture(); },
    dispatch: async (input) => { calls.push({ dispatch: input }); return receipt(); },
    getRun: async (id) => { calls.push({ run: id }); return child(); },
    ...overrides
  };
  return {
    writes, calls, client, state: initialState({ now: START, controllerRunId: 123, ...options }),
    now: () => clock, setClock: (value) => { clock = value; },
    persist: async (state) => { writes.push(structuredClone(state)); }
  };
}
const step = (r, state = r.state, overrides = {}) => tick({ state, client: r.client, persist: r.persist, now: r.now, ...overrides });
const response = (data, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function restRig(handler, options = {}) {
  const calls = [];
  const client = createGitHubClient({ token: 'synthetic-private-token', ...options, fetchImpl: async (url, opts) => {
    calls.push({ url, ...opts });
    return handler(new URL(url), opts, calls);
  } });
  return { client, calls };
}

test('intent is durable before the one fixed capture-only dispatch and exact receipt is stored', async () => {
  const r = rig();
  r.client.dispatch = async (input) => {
    assert.equal(r.writes.length, 1);
    assert.equal(r.writes[0].pending.phase, 'intent');
    assert.equal(r.writes[0].pending.dispatchKey, input.dispatchKey);
    return receipt();
  };
  const result = await step(r);
  assert.equal(result.pending.phase, 'accepted');
  assert.equal(result.pending.runId, 9001);
  assert.equal(result.pending.runUrl, runUrl(9001));
  assert.equal(result.dispatches, 1);
  assert.equal(result.status, 'active');
  assert.equal(r.state.dispatches, 0, 'input state is never mutated');
  assert.equal(r.writes.length, 2);
});

test('client fixes repo, API version, main ref, capture_only and dispatch key', async () => {
  const r = restRig(() => response(receipt().data));
  await r.client.dispatch({ dispatchKey: 'capture-pilot-123-1' });
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].url, `https://api.github.com/repos/${REPOSITORY}/actions/workflows/poll.yml/dispatches`);
  assert.equal(r.calls[0].method, 'POST');
  assert.equal(r.calls[0].headers['X-GitHub-Api-Version'], API_VERSION);
  assert.equal(r.calls[0].redirect, 'error');
  assert.deepEqual(JSON.parse(r.calls[0].body), { ref: 'main', inputs: { capture_only: true, dispatch_key: 'capture-pilot-123-1' } });
  await assert.rejects(() => r.client.dispatch({ dispatchKey: 'injected\nkey' }), /invalid_dispatch_key/);
  assert.equal(r.calls.length, 1);
});

test('every noncompleted status is checked without a date or branch filter; old second-page writer blocks', async () => {
  const r = restRig((url) => {
    assert.equal(url.searchParams.get('created'), null);
    assert.equal(url.searchParams.get('branch'), null);
    const status = url.searchParams.get('status'), page = url.searchParams.get('page');
    if (status === 'queued') return response({ total_count: 101, workflow_runs: page === '1'
      ? Array.from({ length: 100 }, (_, index) => rawRun(index + 1, { path: '.github/workflows/test.yml' }))
      : [rawRun(101, { path: '.github/workflows/nightly.yml@main', created_at: at(-10000) })] });
    return response({ total_count: 0, workflow_runs: [] });
  });
  const listed = await r.client.listActiveWriters({ excludeRunId: 123 });
  assert.equal(listed.complete, true);
  assert.deepEqual(listed.runs.map((run) => run.id), [101]);
  assert.equal(r.calls.length, ACTIVE_STATUSES.length + 1);
  assert.deepEqual([...new Set(r.calls.map((call) => new URL(call.url).searchParams.get('status')))], ACTIVE_STATUSES);
});

test('writers on other branches still block; controller itself is excluded', async () => {
  const r = restRig((url) => response({ total_count: url.searchParams.get('status') === 'in_progress' ? 3 : 0, workflow_runs: url.searchParams.get('status') === 'in_progress' ? [
    rawRun(123, { path: '.github/workflows/poll.yml', status: 'in_progress' }),
    rawRun(456, { path: '.github/workflows/news-context.yml', status: 'in_progress', head_branch: 'other' }),
    rawRun(789, { path: '.github/workflows/test.yml', status: 'in_progress' })
  ] : [] }));
  const listed = await r.client.listActiveWriters({ excludeRunId: 123 });
  assert.deepEqual(listed.runs.map((run) => run.id), [456]);
});

for (const [label, page] of [
  ['underfilled list', { total_count: 2, workflow_runs: [rawRun(1)] }],
  ['overfilled list', { total_count: 0, workflow_runs: [rawRun(1)] }],
  ['search cap', { total_count: 1001, workflow_runs: [] }],
  ['duplicate IDs', { total_count: 2, workflow_runs: [rawRun(1), rawRun(1)] }],
  ['missing workflow identity', { total_count: 1, workflow_runs: [rawRun(1, { path: null })] }],
  ['unknown status', { total_count: 1, workflow_runs: [rawRun(1, { status: 'mystery' })] }]
]) test(`${label} cannot establish idle evidence`, async () => {
  const r = restRig(() => response(page));
  await assert.rejects(() => r.client.listActiveWriters(), /incomplete_run_list|invalid_run/);
});

test('changing total_count between pages fails closed instead of skipping moved rows', async () => {
  const r = restRig((url) => response(url.searchParams.get('page') === '1'
    ? { total_count: 101, workflow_runs: Array.from({ length: 100 }, (_, index) => rawRun(index + 1)) }
    : { total_count: 100, workflow_runs: [] }));
  await assert.rejects(() => r.client.listActiveWriters(), /incomplete_run_list/);
});

test('base64 state response is decoded and only capture fields escape the helper', async () => {
  const source = { ...capture(), sinceId: '123456789', lastPollSuccessAt: at(-10), usage: { private: 'must-not-leak' }, privateContext: 'must-not-leak' };
  const r = restRig((url) => {
    assert.equal(url.pathname, `/repos/${REPOSITORY}/contents/data/state.json`);
    assert.equal(url.searchParams.get('ref'), 'main');
    return response({ type: 'file', path: 'data/state.json', encoding: 'base64', sha: 'a'.repeat(40), content: Buffer.from(JSON.stringify(source)).toString('base64') + '\n' });
  });
  const result = await r.client.getCaptureState();
  assert.equal(result.lastPollAt, capture().lastPollAt);
  assert.equal(result.stateBlobSha, 'a'.repeat(40));
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
});

test('wrong content path, bad base64, invalid date or incomplete capture clocks fail closed', async () => {
  const base = { type: 'file', path: 'data/state.json', encoding: 'base64', content: Buffer.from(JSON.stringify(capture())).toString('base64') };
  for (const invalid of [
    { ...base, path: '.env' }, { ...base, encoding: 'none' }, { ...base, content: '!!!!' },
    { ...base, content: Buffer.from(JSON.stringify({ lastPollAt: START })).toString('base64') },
    { ...base, content: Buffer.from(JSON.stringify({ ...capture(), lastPollAt: 'yesterday' })).toString('base64') }
  ]) {
    const r = restRig(() => response(invalid));
    await assert.rejects(() => r.client.getCaptureState(), /invalid_capture_state/);
  }
});

for (const [label, current] of [['recent successful capture', capture(-1, -10)], ['recent failed attempt', capture(-60, -1)]]) {
  test(`${label} prevents extra dispatch`, async () => {
    const r = rig({ getCaptureState: async () => current });
    const result = await step(r);
    assert.equal(result.decisions.at(-1).kind, 'capture_recent');
    assert.equal(result.dispatches, 0);
  });
}

test('a busy writer or incomplete/failed API evidence prevents dispatch', async () => {
  for (const evidence of [{ complete: true, runs: [child()] }, { complete: false, runs: [] }, null]) {
    const r = rig({ listActiveWriters: async () => evidence });
    const result = await step(r);
    assert.equal(result.dispatches, 0);
    assert.equal(r.calls.includes('capture'), false);
  }
  const r = rig({ listActiveWriters: async () => { throw new Error('token=do-not-copy'); } });
  const result = await step(r);
  assert.equal(result.stopReason, 'evidence_unavailable');
  assert.equal(JSON.stringify(r.writes).includes('do-not-copy'), false);
});

for (const status of [204, 408, 500, 502]) test(`HTTP ${status} dispatch is uncertain and never retried`, async () => {
  let posts = 0;
  const r = rig({ dispatch: async () => { posts++; return { status, data: null }; } });
  const result = await step(r);
  assert.equal(result.stopReason, 'uncertain_dispatch');
  assert.equal(result.pending.phase, 'intent');
  const second = await step(r, result);
  assert.deepEqual(second, result);
  assert.equal(posts, 1);
  const reloadedIntent = structuredClone(r.writes[0]);
  assert.equal((await step(r, reloadedIntent)).stopReason, 'uncertain_dispatch');
  assert.equal(posts, 1);
});

test('timeout or malformed receipt stops without repeating POST or exposing error content', async () => {
  for (const result of [
    { status: 200, data: {} },
    { status: 200, data: { ...receipt().data, workflow_run_id: '9001' } },
    { status: 200, data: { ...receipt().data, run_url: 'https://attacker.invalid/run' } },
    { status: 200, data: { ...receipt().data, html_url: htmlUrl(9002) } },
    null
  ]) {
    let posts = 0;
    const r = rig({ dispatch: async () => { posts++; if (!result) throw new Error('private headers'); return result; } });
    const state = await step(r);
    assert.equal(state.stopReason, 'uncertain_dispatch');
    await step(r, state);
    assert.equal(posts, 1);
    assert.equal(JSON.stringify(r.writes).includes('private headers'), false);
  }
});

test('definite HTTP rejection is terminal and is not retried', async () => {
  for (const status of [401, 403, 404, 422, 429]) {
    const r = rig({ dispatch: async () => ({ status }) });
    const state = await step(r);
    assert.equal(state.stopReason, 'dispatch_rejected');
    assert.equal(state.pending.phase, 'rejected');
    assert.equal(state.pending.httpStatus, status);
  }
});

test('failed intent persistence prevents the remote mutation', async () => {
  const r = rig();
  await assert.rejects(() => step(r, r.state, { persist: async () => { throw new Error('disk unavailable'); } }), /journal_write_failed/);
  assert.equal(r.calls.some((call) => call.dispatch), false);
});

test('failed receipt persistence leaves durable intent, which stops after restart', async () => {
  const r = rig();
  let durable;
  await assert.rejects(() => step(r, r.state, { persist: async (state) => {
    if (state.pending.phase === 'accepted') throw new Error('disk unavailable');
    durable = structuredClone(state);
  } }), /journal_write_failed/);
  assert.equal(durable.pending.phase, 'intent');
  const restarted = await step(r, durable);
  assert.equal(restarted.stopReason, 'uncertain_dispatch');
  assert.equal(r.calls.filter((call) => call.dispatch).length, 1);
});

test('returned run ID is followed and no dispatch occurs while that child is pending', async () => {
  const r = rig();
  const accepted = await step(r);
  const before = r.calls.length;
  r.setClock(at(5));
  const waiting = await step(r, accepted);
  assert.equal(waiting.decisions.at(-1).kind, 'waiting_for_child');
  assert.deepEqual(r.calls.slice(before), [{ run: 9001 }]);
});

test('job success alone cannot count as successful capture', async () => {
  const r = rig({ getRun: async () => child({ status: 'completed', conclusion: 'success' }) });
  const accepted = await step(r);
  r.setClock(at(5));
  const result = await step(r, accepted);
  assert.equal(result.stopReason, 'capture_not_advanced');
  assert.equal(result.completed[0].captureAdvanced, false);
  assert.equal(result.dispatches, 1);
});

test('successful child plus committed capture advancement permits only a later eligible dispatch', async () => {
  const r = rig();
  const accepted = await step(r);
  r.client.getRun = async () => child({ status: 'completed', conclusion: 'success', createdAt: START, startedAt: at(0.1) });
  r.client.getCaptureState = async () => capture(1);
  r.setClock(at(5));
  const recent = await step(r, accepted);
  assert.equal(recent.completed[0].captureAdvanced, true);
  assert.equal(recent.completed[0].captureVerified, true);
  assert.equal(recent.completed[0].captureAt, at(1));
  assert.equal(recent.pending, null);
  assert.equal(recent.dispatches, 1);
  assert.equal(recent.decisions.at(-1).kind, 'capture_recent');
  r.setClock(at(6));
  const second = await step(r, recent);
  assert.equal(second.dispatches, 2);
  assert.equal(second.pending.dispatchKey, 'capture-pilot-123-2');
});

test('a completed failed child records any published capture but stops the pilot', async () => {
  const r = rig();
  const accepted = await step(r);
  r.setClock(at(5));
  r.client.getRun = async () => child({ status: 'completed', conclusion: 'failure' });
  r.client.getCaptureState = async () => capture(1);
  const result = await step(r, accepted);
  assert.equal(result.stopReason, 'child_failed');
  assert.equal(result.completed[0].captureAdvanced, true);
  assert.equal(result.dispatches, 1);
});

test('a different workflow or branch cannot impersonate the accepted child', async () => {
  for (const invalid of [{ id: 9999 }, { path: '.github/workflows/nightly.yml' }, { branch: 'feature' }, { event: 'push' }]) {
    const r = rig();
    const accepted = await step(r);
    r.client.getRun = async () => child(invalid);
    const result = await step(r, accepted);
    assert.equal(result.stopReason, 'invalid_child_run');
    assert.equal(result.dispatches, 1);
  }
});

test('duration, dispatch and tick ceilings cannot be expanded', async () => {
  assert.throws(() => initialState({ now: START, controllerRunId: 1, durationMs: MAX_DURATION_MS + 1 }), /invalid_pilot_bounds/);
  assert.throws(() => initialState({ now: START, controllerRunId: 1, maxDispatches: MAX_DISPATCHES + 1 }), /invalid_pilot_bounds/);
  const r = rig();
  r.setClock(at(50));
  assert.equal((await step(r)).stopReason, 'duration_complete');
  assert.equal(r.calls.length, 0);
  r.setClock(START);
  assert.equal((await step(r, { ...r.state, dispatches: 10 })).stopReason, 'dispatch_limit');
  assert.equal((await step(r, { ...r.state, tickCount: 120 })).stopReason, 'tick_limit');
  assert.equal(r.calls.length, 0);
});

test('deadline crossed during evidence requests prevents POST', async () => {
  const r = rig();
  r.client.getCaptureState = async () => { r.setClock(at(51)); return capture(); };
  assert.equal((await step(r)).stopReason, 'duration_complete');
  assert.equal(r.calls.some((call) => call.dispatch), false);
});

test('future capture times and backwards clocks fail closed', async () => {
  const future = rig({ getCaptureState: async () => capture(1) });
  assert.equal((await step(future)).stopReason, 'future_capture_clock');
  const backwards = rig();
  backwards.setClock(at(-1));
  assert.equal((await step(backwards)).stopReason, 'clock_moved_backwards');
});

test('HTTP request budget and timeout are enforced with no hidden retries', async () => {
  const r = restRig(() => response({ total_count: 0, workflow_runs: [] }), { maxRequests: 1 });
  await assert.rejects(() => r.client.listActiveWriters(), /request_budget_exhausted/);
  assert.equal(r.calls.length, 1);
  let calls = 0;
  const stalled = createGitHubClient({ token: 'synthetic', timeoutMs: 10, fetchImpl: async () => { calls++; return new Promise(() => {}); } });
  await assert.rejects(() => stalled.dispatch({ dispatchKey: 'capture-pilot-123-1' }), /request_timeout/);
  assert.equal(calls, 1);
});

test('child API errors stop safely with the exact accepted receipt retained', async () => {
  const r = rig();
  const accepted = await step(r);
  r.client.getRun = async () => { throw Object.assign(new Error('private response'), { code: 'unexpected_http', httpStatus: 403 }); };
  const result = await step(r, accepted);
  assert.equal(result.stopReason, 'evidence_unavailable');
  assert.equal(result.pending.runId, 9001);
  assert.equal(result.decisions.at(-1).httpStatus, 403);
  assert.equal(JSON.stringify(result).includes('private response'), false);
});

for (const [label, markers] of [
  ['absent identity', { lastPollRunId: undefined, lastPollRunAttempt: undefined }],
  ['another run', { lastPollRunId: '9002', lastPollRunAttempt: 1 }],
  ['another attempt', { lastPollRunId: '9001', lastPollRunAttempt: 2 }]
]) test(`timestamp advancement with ${label} is never attributed to the dispatched child`, async () => {
  const r = rig();
  const accepted = await step(r);
  r.setClock(at(5));
  r.client.getRun = async () => child({ status: 'completed', conclusion: 'success' });
  r.client.getCaptureState = async () => ({ ...capture(1), ...markers });
  const result = await step(r, accepted);
  assert.equal(result.stopReason, 'capture_not_attributed');
  assert.equal(result.completed[0].captureAdvanced, true);
  assert.equal(result.completed[0].captureAttributed, false);
  assert.equal(result.completed[0].captureVerified, false);
  assert.equal(result.dispatches, 1);
});

test('numeric capture markers normalize; unsafe or malformed identities fail closed', async () => {
  const r = rig();
  const accepted = await step(r);
  r.setClock(at(5));
  r.client.getRun = async () => child({ status: 'completed', conclusion: 'success' });
  r.client.getCaptureState = async () => ({ ...capture(1), lastPollRunId: 9001, lastPollRunAttempt: '1' });
  const result = await step(r, accepted);
  assert.equal(result.completed[0].captureVerified, true);
  assert.equal(result.completed[0].captureRunId, '9001');
  assert.equal(result.completed[0].captureRunAttempt, 1);
  for (const invalid of ['0', '-1', '1e3', '9007199254740993', 'bad', 0, 1.5]) {
    const bad = rig({ getCaptureState: async () => ({ ...capture(), lastPollRunId: invalid }) });
    assert.equal((await step(bad)).stopReason, 'evidence_unavailable');
    assert.equal(bad.calls.some((call) => call.dispatch), false);
  }
});

test('deadline crossed while persisting intent stops before POST', async () => {
  const r = rig();
  const result = await step(r, r.state, { persist: async (state) => {
    r.writes.push(structuredClone(state));
    if (state.pending?.phase === 'intent') r.setClock(at(50));
  } });
  assert.equal(result.stopReason, 'duration_complete');
  assert.equal(result.pending.phase, 'not_sent');
  assert.equal(r.calls.some((call) => call.dispatch), false);
});

test('impossible calendar dates cannot be treated as capture evidence', async () => {
  const r = rig({ getCaptureState: async () => ({ ...capture(), lastPollAt: '2026-02-31T12:00:00Z' }) });
  assert.equal((await step(r)).stopReason, 'evidence_unavailable');
  assert.equal(r.calls.some((call) => call.dispatch), false);
});

test('oversized streamed responses fail before parsing private or unbounded data', async () => {
  const r = restRig(() => new Response('x'.repeat(2 * 1024 * 1024 + 1)));
  await assert.rejects(() => r.client.getCaptureState(), /response_too_large/);
  assert.equal(r.calls.length, 1);
});

test('observed dynamic Pages run paths are valid nonwriters without hiding actual capture writers', async () => {
  const r = restRig((url) => response({ total_count: url.searchParams.get('status') === 'in_progress' ? 2 : 0, workflow_runs: url.searchParams.get('status') === 'in_progress' ? [
    rawRun(35044818631, { path: 'dynamic/pages/pages-build-deployment', status: 'in_progress' }),
    rawRun(35044747479, { path: '.github/workflows/poll.yml', status: 'in_progress' })
  ] : [] }));
  assert.deepEqual((await r.client.listActiveWriters()).runs.map(({ id }) => id), [35044747479]);
});

test('unknown repository workflows conservatively block; unknown dynamic paths fail closed', async () => {
  const r = restRig((url) => response({ total_count: url.searchParams.get('status') === 'queued' ? 1 : 0, workflow_runs: url.searchParams.get('status') === 'queued' ? [
    rawRun(12, { path: '.github/workflows/new.writer.yml' })
  ] : [] }));
  assert.deepEqual((await r.client.listActiveWriters()).runs.map(({ id }) => id), [12]);
  const unknown = restRig(() => response({ total_count: 1, workflow_runs: [rawRun(13, { path: 'dynamic/unknown/unreviewed' })] }));
  await assert.rejects(() => unknown.client.listActiveWriters(), /invalid_run/);
});

test('a run moving between active status queries remains blocking and deduplicated', async () => {
  const r = restRig((url) => {
    const queried = url.searchParams.get('status');
    return response(['queued', 'in_progress'].includes(queried)
      ? { total_count: 1, workflow_runs: [rawRun(44, { status: 'in_progress' })] }
      : { total_count: 0, workflow_runs: [] });
  });
  assert.deepEqual((await r.client.listActiveWriters()).runs.map(({ id }) => id), [44]);
});

test('a completed run returned during status transition is safely ignored after identity validation', async () => {
  const r = restRig((url) => response(url.searchParams.get('status') === 'queued'
    ? { total_count: 1, workflow_runs: [rawRun(44, { status: 'completed', conclusion: 'success' })] }
    : { total_count: 0, workflow_runs: [] }));
  assert.deepEqual((await r.client.listActiveWriters()).runs, []);
});

test('default REST allowance supports 50 one-minute idle ticks without weakening the hard cap', async () => {
  const r = restRig((url) => url.pathname.endsWith('/actions/runs')
    ? response({ total_count: 0, workflow_runs: [] })
    : response({ type: 'file', path: 'data/state.json', encoding: 'base64', content: Buffer.from(JSON.stringify(capture())).toString('base64') }));
  for (let minute = 0; minute < 50; minute++) {
    await r.client.listActiveWriters();
    await r.client.getCaptureState();
  }
  assert.equal(r.client.requestCount, 300);
  for (let i = 0; i < 100; i++) await r.client.getCaptureState();
  await assert.rejects(() => r.client.getCaptureState(), /request_budget_exhausted/);
  assert.equal(r.calls.length, 400);
});
