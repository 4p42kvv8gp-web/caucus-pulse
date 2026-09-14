import test from 'node:test';
import assert from 'node:assert/strict';
import { runEventShadow } from '../src/event-runner.js';
const copy = (value) => JSON.parse(JSON.stringify(value));
const empty = () => ({ version: 1, receipts: {}, events: [] });
const plan = (key = 'one', ids = ['1']) => ({ key, request: { custom_id: key, params: { model: 'synthetic', messages: [{ role: 'user', content: ids.join(',') }] } },
  posts: ids.map((id) => ({ id, text: `source ${id}` })), sourceHash: `source-${key}`, correctionHash: 'corrections-1',
  runAsOf: '2026-09-14T15:00:00Z', mode: 'retrospective', policyVersion: 'event-v1' });
const valid = (events = [{ id: 'event-1', title: 'A synthetic event' }]) => ({ valid: true, events, errors: [], unresolved: [] });
function rig({ state = empty() } = {}) {
  const r = { state, durable: copy(state), remote: copy(state), calls: [], actions: [], result: valid(), snapshots: {} };
  r.options = {
    state,
    save: async (s) => { r.actions.push(`save:${Object.values(s.receipts).map((v) => v.status).join(',')}`); r.durable = copy(s); },
    checkpoint: async (s) => { r.actions.push(`checkpoint:${Object.values(s.receipts).map((v) => v.status).join(',')}`); r.remote = copy(s); },
    client: { messages: { create: async (request, options) => {
      r.calls.push({ request, options }); r.actions.push('paid-call');
      assert.equal(Object.values(r.remote.receipts).filter((v) => v.status === 'submitting').length, 1);
      return { id: `msg-${r.calls.length}`, content: [{ type: 'text', text: 'synthetic result' }] };
    } } },
    refresh: async () => { r.actions.push('refresh'); },
    validate: async (message, posts, opts) => {
      r.actions.push('validate');
      assert.equal(Object.values(r.remote.receipts).some((v) => v.response?.id === message.id), true);
      return r.result;
    },
    currentSnapshot: async (p) => r.snapshots[p.key] || { sourceHash: p.sourceHash, correctionHash: p.correctionHash },
    now: () => '2026-09-14T15:01:00Z'
  };
  r.run = (plans, override = {}) => runEventShadow(plans, { ...r.options, ...override });
  return r;
}

test('intent is checkpointed before the paid call and raw response before validation; replay deduplicates accepted output', async () => {
  const r = rig();
  const p = plan();
  const first = await r.run([p]);
  assert.equal(first.accepted, 1);
  assert.equal(first.attempts, 1);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0], { request: p.request.params, options: { maxRetries: 0 } });
  assert.ok(r.actions.indexOf('checkpoint:submitting') < r.actions.indexOf('paid-call'));
  assert.ok(r.actions.indexOf('checkpoint:response-saved') < r.actions.indexOf('validate'));
  assert.deepEqual(r.state.events, [{ id: 'event-1', title: 'A synthetic event', receiptKey: 'one' }]);
  const later = { ...p, runAsOf: '2026-09-14T18:00:00Z', request: { ...p.request, runClock: 'later' } };
  const replay = await r.run([later]);
  assert.equal(replay.calls, 0);
  assert.equal(r.state.events.length, 1);
  assert.deepEqual(r.state.receipts.one.plan.request, p.request);
  assert.equal(r.state.receipts.one.plan.runAsOf, p.runAsOf);
});

test('a valid empty event result is accepted and never resubmitted', async () => {
  const r = rig(); r.result = valid([]);
  await r.run([plan()]); await r.run([plan()]);
  assert.equal(r.calls.length, 1);
  assert.equal(r.state.receipts.one.status, 'accepted');
  assert.deepEqual(r.state.events, []);
});

test('overlapping source IDs retain separate request manifests', async () => {
  const r = rig(), seen = [];
  const validate = async (_message, posts, options) => { seen.push({ ids: posts.map((p) => p.id), options }); return valid([{ id: 'same-label', title: 'Separate observations' }]); };
  await r.run([plan('one', ['1', '2']), plan('two', ['2', '3'])], { validate });
  assert.deepEqual(seen.map((v) => v.ids), [['1', '2'], ['2', '3']]);
  assert.equal(seen[0].options.sourceHash, 'source-one');
  assert.deepEqual(r.state.events.map((e) => e.receiptKey), ['one', 'two']);
});

for (const change of ['sourceHash', 'correctionHash']) test(`${change} changing during the call supersedes the response instead of accepting it`, async () => {
  const r = rig(), create = r.options.client.messages.create;
  r.options.client.messages.create = async (...args) => {
    const response = await create(...args);
    r.snapshots.one = { sourceHash: 'source-one', correctionHash: 'corrections-1', [change]: 'changed' };
    return response;
  };
  const result = await r.run([plan()]);
  assert.equal(result.superseded, 1);
  assert.equal(r.state.receipts.one.status, 'superseded');
  assert.ok(r.state.receipts.one.response);
  assert.deepEqual(r.state.events, []);
});

test('snapshot changes during validation prevent acceptance, and later corrections withdraw accepted observations', async () => {
  const r = rig();
  await r.run([plan()], { validate: async () => { r.snapshots.one = { sourceHash: 'source-one', correctionHash: 'changed' }; return valid(); } });
  assert.equal(r.state.receipts.one.status, 'superseded');
  const second = rig(); await second.run([plan()]);
  second.snapshots.one = { sourceHash: 'source-one', correctionHash: 'new-correction' };
  await second.run([]);
  assert.equal(second.calls.length, 1);
  assert.equal(second.state.receipts.one.status, 'superseded');
  assert.deepEqual(second.state.events, []);
});

test('checkpoint failure prevents a call, and restart of a submitting receipt never guesses that it was unsent', async () => {
  const r = rig();
  await assert.rejects(r.run([plan()], { checkpoint: async () => { throw new Error('remote checkpoint failed'); } }), /checkpoint failed/);
  assert.equal(r.calls.length, 0);
  assert.equal(r.durable.receipts.one.status, 'submitting');
  const restarted = rig({ state: copy(r.durable) });
  const result = await restarted.run([plan()]);
  assert.equal(result.unknown, 1);
  assert.equal(result.calls, 0);
  assert.equal(result.attempts, 1);
});

test('raw response save failure leaves a durable uncertain submission and prevents blind retry', async () => {
  const r = rig(), save = r.options.save;
  await assert.rejects(r.run([plan()], { save: async (s) => {
    if (s.receipts.one?.status === 'response-saved') throw new Error('disk full');
    await save(s);
  } }), /disk full/);
  assert.equal(r.calls.length, 1);
  assert.equal(r.durable.receipts.one.status, 'submitting');
  const restarted = rig({ state: copy(r.durable) });
  await restarted.run([plan()]);
  assert.equal(restarted.calls.length, 0);
  assert.equal(restarted.state.receipts.one.status, 'submission-unknown');
});

test('raw response checkpoint failure replays saved validation without another paid request', async () => {
  const r = rig(), checkpoint = r.options.checkpoint;
  await assert.rejects(r.run([plan()], { checkpoint: async (s) => {
    if (s.receipts.one?.status === 'response-saved') throw new Error('push rejected');
    await checkpoint(s);
  } }), /push rejected/);
  assert.equal(r.durable.receipts.one.status, 'response-saved');
  assert.equal(r.actions.includes('validate'), false);
  const restarted = rig({ state: copy(r.durable) });
  const result = await restarted.run([]);
  assert.equal(result.calls, 0);
  assert.equal(result.accepted, 1);
  assert.equal(restarted.state.events.length, 1);
});

test('validator and final save crashes both replay raw responses without duplicate events', async () => {
  const r = rig();
  await assert.rejects(r.run([plan()], { validate: async () => { throw new Error('validator crashed'); } }), /validator crashed/);
  const restarted = rig({ state: copy(r.durable) }), save = restarted.options.save;
  await assert.rejects(restarted.run([], { save: async (s) => {
    if (s.receipts.one?.status === 'accepted') throw new Error('acceptance save failed');
    await save(s);
  } }), /acceptance save failed/);
  const final = rig({ state: copy(restarted.durable) });
  await final.run([]); await final.run([]);
  assert.equal(final.calls.length, 0);
  assert.equal(final.state.events.length, 1);
});

for (const status of [429, 529]) test(`definitive ${status} is retryable later but the pilot cannot exceed two attempts across reruns`, async () => {
  const r = rig();
  r.options.client.messages.create = async () => { r.calls.push({}); throw Object.assign(new Error('known rejected'), { status }); };
  await r.run([plan()]);
  assert.equal(r.state.receipts.one.status, 'planned');
  assert.equal(r.state.receipts.one.retryable, true);
  await r.run([plan()]);
  await r.run([plan(), plan('two')], { maxCalls: 100 });
  assert.equal(r.calls.length, 2);
  assert.equal(r.state.attempts, 2);
  assert.equal(r.state.maxCalls, 2);
  assert.equal(r.state.receipts.two.attempts, 0);
});

test('connection errors, timeouts and other 5xx responses never automatically retry', async () => {
  for (const error of [new Error('connection reset'), Object.assign(new Error('timeout'), { status: 408 }), Object.assign(new Error('server error'), { status: 500 })]) {
    const r = rig();
    r.options.client.messages.create = async () => { r.calls.push({}); throw error; };
    await r.run([plan()]); await r.run([plan()]);
    assert.equal(r.calls.length, 1);
    assert.equal(r.state.receipts.one.status, 'submission-unknown');
  }
});

test('a partial response is retained for review and not promoted or resubmitted', async () => {
  const r = rig(); r.result = { valid: false, events: [{ id: 'tentative' }], errors: ['missing source'], unresolved: ['1'] };
  await r.run([plan()]); await r.run([plan()]);
  assert.equal(r.calls.length, 1);
  assert.equal(r.state.receipts.one.status, 'partial');
  assert.deepEqual(r.state.receipts.one.validation.unresolved, ['1']);
  assert.deepEqual(r.state.events, []);
});

test('the pilot cap applies across distinct requests and a key cannot silently change its source manifest', async () => {
  const r = rig(); await r.run([plan('one'), plan('two'), plan('three')]);
  await r.run([plan('three')]);
  assert.equal(r.calls.length, 2);
  assert.equal(r.state.receipts.three.status, 'planned');
  await assert.rejects(r.run([{ ...plan('one'), sourceHash: 'changed' }]), /key collision/);
  assert.equal(r.calls.length, 2);
});

test('invalid ledgers and missing current snapshots fail closed before model work', async () => {
  const r = rig(); await r.run([plan()]);
  r.state.attempts = 0;
  await assert.rejects(r.run([]), /attempt ledger/);
  const second = rig();
  await assert.rejects(second.run([plan()], { currentSnapshot: async () => null }), /current source/);
  assert.equal(second.calls.length, 0);
});
