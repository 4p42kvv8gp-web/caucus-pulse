import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeParsed, emptyOut, finishOut, mergeMessage, collectResults, chunkRequests, runClassification, planDay, mergeDay, writeDay, pendingIdsFor, dayComplete, readClassificationFile } from '../src/classify.js';
import { readQueue, requestManifest, submitJob, emptyQueue, queueLockPath } from '../src/classification-queue.js';
import { classifyLive, combineInterpretations } from '../src/classify-live.js';

const tax = { weather: { label: 'Weather', subtopics: { storm: { label: 'Storm' } } } };
const post = (id, date = '2026-09-12', extra = {}) => ({ id, text: `Storm observation ${id}`, createdAt: `${date}T16:00:00Z`, type: 'tweet', ...extra });
const reply = (assignments, emerging = []) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ assignments, emerging }) }] });
const assignment = (id, topics = [['weather', 'storm']]) => ({ id, topics });
const result = (custom_id, message) => ({ custom_id, result: { type: 'succeeded', message } });
const iterable = (rows) => (async function* () { yield* rows; })();

function fixture(t, archive) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'classification-integrity-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const topics = new Map();
  const opts = {
    dates: Object.keys(archive), tax, model: 'offline-model', queueFile: path.join(temp, 'queue.json'),
    loadDay: (date) => archive[date] || [], topicsFor: (date) => topics.get(date) || null,
    plan: (date, taxonomy) => planDay(date, { tax: taxonomy, tweets: archive[date] || [], prior: {}, resolve: () => null }),
    publish: (pl, out, model) => writeDay(pl, out, model, { pathFor: (date) => date, write: (date, data) => topics.set(date, data) }),
    hints: async (items) => items, refresh: async () => {}, log: () => {}
  };
  return { temp, topics, opts };
}

test('request validation rejects foreign, duplicate and invalid rows while keeping exact source strings', () => {
  const out = emptyOut();
  const status = mergeParsed({ assignments: [
    assignment('9007199254740993'), assignment('2'), assignment('2'), assignment('outside'),
    assignment('3', [['weather', 'invented']]), { ...assignment('4'), incident: { kind: 'flooding', place: 'River County', name: 'River flood' } },
    { ...assignment('5'), incident: { kind: 'invented', place: 'River County' } }
  ], emerging: [{ label: 'River flood', ids: ['4', 'outside', '2', '4'] }] }, tax, out, ['9007199254740993', '2', '3', '4', '5', '6']);
  assert.deepEqual(Object.keys(out.assignments).sort(), ['4', '9007199254740993']);
  assert.deepEqual(status.retryIds, ['2', '3', '5', '6']);
  assert.deepEqual(out.incidents['4'], { kind: 'flooding', place: 'River County', name: 'River flood' });
  assert.deepEqual(finishOut(out).emerging, [{ label: 'River flood', ids: ['4'] }]);
  assert.throws(() => mergeParsed({}, tax, out), /manifest/);
});

test('truncated, refused and missing model output remains pending, including legitimate empty assignments', () => {
  const out = emptyOut();
  mergeMessage(reply([assignment('1', [])]), tax, out, ['1', '2']);
  assert.deepEqual(out.assignments['1'], []);
  assert.deepEqual(out.requestStatus.request.retryIds, ['2']);
  mergeMessage({ ...reply([assignment('2')]), stop_reason: 'max_tokens' }, tax, out, ['2'], 'truncated');
  assert.equal(out.assignments['2'], undefined);
  assert.equal(out.failedChunks, 2);
});

test('batch results accept only the saved custom ID and row ID manifest', async () => {
  const requests = chunkRequests([post('1'), post('2')], tax, 'offline', '2026-09-12_', { examples: [] });
  const manifest = requestManifest(requests);
  const id = requests[0].custom_id;
  const client = { messages: { batches: { results: async () => iterable([result('foreign', reply([assignment('1')])), result(id, reply([assignment('1'), assignment('99')]))]) } } };
  const out = (await collectResults(client, 'batch', tax, manifest)).get('2026-09-12_');
  assert.deepEqual(Object.keys(out.assignments), ['1']);
  assert.deepEqual(out.requestStatus[id].retryIds, ['2']);
  client.messages.batches.results = async () => iterable([result(id, reply([assignment('1')])), result(id, reply([assignment('2')]))]);
  const duplicate = (await collectResults(client, 'batch', tax, manifest)).get('2026-09-12_');
  assert.deepEqual(duplicate.assignments, {});
  assert.equal(duplicate.requestStatus[id].error, 'duplicate-result');
});

test('partial day keeps prior accepted evidence and retries only missing IDs', () => {
  const tweets = [post('1'), post('2')];
  const pl = planDay('2026-09-12', { tax, tweets, prior: {}, resolve: () => null });
  const first = emptyOut();
  mergeMessage(reply([assignment('1')], [{ label: 'River flood', ids: ['1'] }]), tax, first, ['1', '2']);
  const day1 = mergeDay(pl, finishOut(first)).day;
  assert.deepEqual(day1.pendingIds, ['2']);
  assert.equal(day1.complete, false);
  const day2 = mergeDay({ ...pl, previous: day1 }, { assignments: { 2: [] }, incidents: {}, emerging: [] }).day;
  assert.deepEqual(day2.assignments, { 1: [['weather', 'storm']], 2: [] });
  assert.deepEqual(day2.emerging, [{ label: 'River flood', ids: ['1'] }]);
  assert.equal(dayComplete(tweets, day2), true);
});

test('saved batch resumes its own date and taxonomy after midnight, without submitting again', async (t) => {
  const { opts, topics } = fixture(t, { '2026-09-12': [post('1')] });
  let submitted = 0, retrieved = 0, ended = false;
  const client = { messages: { batches: {
    create: async ({ requests }) => { submitted++; assert.equal(readQueue(opts.queueFile).jobs[0].status, 'submitting'); return { id: 'batch-one' }; },
    retrieve: async () => { retrieved++; return { processing_status: ended ? 'ended' : 'in_progress' }; },
    results: async () => iterable([result('2026-09-12_chunk-0', reply([assignment('1')]))])
  } } };
  assert.equal((await runClassification({ ...opts, client })).status, 'pending');
  assert.equal(retrieved, 1);
  ended = true;
  const done = await runClassification({ ...opts, dates: ['2026-09-13'], tax: {}, model: 'different', client });
  assert.equal(done.status, 'complete');
  assert.equal(submitted, 1);
  assert.equal(topics.get('2026-09-12').model, 'offline-model');
  assert.deepEqual(topics.get('2026-09-12').assignments['1'], [['weather', 'storm']]);
  assert.ok(readQueue(opts.queueFile).completed['batch-one']);
  assert.deepEqual(readQueue(opts.queueFile).jobs, []);
});

test('failed chunks survive completed batch and only unresolved IDs are resubmitted', async (t) => {
  const { opts, topics } = fixture(t, { '2026-09-12': [post('1'), post('2')] });
  const sent = [];
  const client = { messages: { batches: {
    create: async ({ requests }) => { sent.push(requests.flatMap((r) => r.params.messages[0].content.split('\n').map((s) => JSON.parse(s).id))); return { id: `b${sent.length}` }; },
    retrieve: async () => ({ processing_status: 'ended' }),
    results: async () => iterable([result('2026-09-12_chunk-0', reply([assignment(sent.length === 1 ? '1' : '2')]))])
  } } };
  assert.equal((await runClassification({ ...opts, client })).status, 'partial');
  assert.deepEqual(topics.get('2026-09-12').pendingIds, ['2']);
  assert.equal((await runClassification({ ...opts, client })).status, 'complete');
  assert.deepEqual(sent, [['1', '2'], ['2']]);
});

test('uncertain submission is held for reconciliation; dry run makes no provider calls', async (t) => {
  const { opts } = fixture(t, { '2026-09-12': [post('1')] });
  let calls = 0;
  const client = { messages: { batches: { create: async () => { calls++; throw new Error('network lost after sending'); } } } };
  assert.equal((await runClassification({ ...opts, dryRun: true, clientFactory: () => { throw new Error('no auth in dry run'); } })).status, 'planned');
  assert.equal(fs.existsSync(opts.queueFile), false);
  await assert.rejects(runClassification({ ...opts, client }), /network lost/);
  assert.equal(readQueue(opts.queueFile).jobs[0].status, 'submission-unknown');
  await assert.rejects(runClassification({ ...opts, client }), /Reconcile/);
  assert.equal(calls, 1);
});

test('definite budget rejection clears unsent intent and corrupt queue fails closed', async (t) => {
  const { opts } = fixture(t, { '2026-09-12': [post('1')] });
  const client = { messages: { batches: { create: async () => { const e = new Error('cap'); e.code = 'ANTHROPIC_BUDGET_EXCEEDED'; throw e; } } } };
  await assert.rejects(submitJob(client, emptyQueue(), { dates: opts.dates, model: 'm', taxonomy: tax, requests: chunkRequests([post('1')], tax, 'm', '', { examples: [] }) }, { file: opts.queueFile }), /cap/);
  assert.deepEqual(readQueue(opts.queueFile).jobs, []);
  fs.writeFileSync(opts.queueFile, '{broken');
  await assert.rejects(runClassification({ ...opts, client }), SyntaxError);
});

test('live failures persist and retry on empty poll; emerging evidence stays in its source date', async () => {
  const posts = [post('1'), post('2', '2026-09-13'), post('3', '2026-09-13', { type: 'retweet', refId: '1' })];
  const files = new Map(); let calls = 0, sent;
  const opts = {
    tax, model: 'offline', dates: ['2026-09-12', '2026-09-13'], load: (date) => posts.filter((p) => p.createdAt.startsWith(date)),
    read: (file, fallback) => files.get(file) || fallback, write: (file, data) => files.set(file, data), livePath: (date) => `live/${date}`, nightlyPath: (date) => `nightly/${date}`,
    resolve: () => null, hints: async (items) => items, refresh: async () => {}, configured: () => true, warn: () => {},
    client: { messages: { create: async (params) => { calls++; sent = params.messages[0].content.split('\n').map((l) => JSON.parse(l).id); if (calls === 1) throw new Error('temporary'); return reply([assignment('1'), assignment('2')], [{ label: 'River flood', ids: ['1', '2', 'outside'] }]); } } }
  };
  assert.equal((await classifyLive(posts, opts)).pending, 3);
  const done = await classifyLive([], opts);
  assert.equal(done.pending, 0);
  assert.deepEqual(sent, ['1', '2']);
  assert.deepEqual(files.get('live/2026-09-12').emerging, [{ label: 'River flood', ids: ['1'] }]);
  assert.deepEqual(files.get('live/2026-09-13').emerging, [{ label: 'River flood', ids: ['2'] }]);
  assert.deepEqual(files.get('live/2026-09-13').assignments['3'], [['weather', 'storm']]);
  assert.equal(await classifyLive([], opts), null);
  assert.equal(calls, 2);
});

test('reviewed correction with stale pending marker remains settled', () => {
  assert.deepEqual(pendingIdsFor([post('1')], { assignments: { 1: [] }, pendingIds: ['1'], corrected: { 1: { by: 'reviewer' } } }), []);
});

test('synchronous chunks publish accepted work before a later chunk fails', async (t) => {
  const posts = Array.from({ length: 41 }, (_, i) => post(String(i + 1)));
  const { opts, topics } = fixture(t, { '2026-09-12': posts });
  let calls = 0;
  const client = { messages: { create: async (params) => {
    calls++;
    if (calls === 2) { assert.equal(Object.keys(topics.get('2026-09-12').assignments).length, 40); throw new Error('second request failed'); }
    return reply(params.messages[0].content.split('\n').map((line) => assignment(JSON.parse(line).id)));
  } } };
  const run = await runClassification({ ...opts, client, sync: true });
  assert.equal(run.status, 'partial');
  assert.deepEqual(topics.get('2026-09-12').pendingIds, ['41']);
  assert.equal(fs.existsSync(opts.queueFile), false);
});

test('completed batch ledger clears stale legacy pointer without retrieving a second time', async (t) => {
  const { opts } = fixture(t, { '2026-09-12': [post('1')] });
  let retrieved = 0, cleared = 0;
  const client = { messages: { batches: {
    create: async () => ({ id: 'finished' }), retrieve: async () => { retrieved++; return { processing_status: 'ended' }; },
    results: async () => iterable([result('2026-09-12_chunk-0', reply([assignment('1')]))])
  } } };
  await runClassification({ ...opts, client });
  await runClassification({ ...opts, client, legacy: { batchId: 'finished', dates: opts.dates }, onLegacyComplete: () => { cleared++; } });
  assert.equal(retrieved, 1);
  assert.equal(cleared, 1);
});

test('live run does not lose pending backlog at its per-poll cap or without credentials', async () => {
  const posts = [post('1'), post('2')], files = new Map();
  let calls = 0;
  const opts = {
    tax, dates: ['2026-09-12'], load: () => posts,
    read: (f, fallback) => files.get(f) || fallback, write: (f, d) => files.set(f, d), livePath: (d) => `live/${d}`, nightlyPath: (d) => `nightly/${d}`,
    resolve: () => null, hints: async (items) => items, refresh: async () => {}, configured: () => false, warn: () => {}, maxPosts: 1,
    client: { messages: { create: async (params) => { calls++; return reply(params.messages[0].content.split('\n').map((s) => assignment(JSON.parse(s).id))); } } }
  };
  assert.equal((await classifyLive(posts, opts)).pending, 2);
  assert.equal(calls, 0);
  assert.equal((await classifyLive([], { ...opts, configured: () => true })).pending, 1);
  assert.deepEqual(files.get('live/2026-09-12').pendingIds, ['2']);
  assert.equal((await classifyLive([], { ...opts, configured: () => true })).pending, 0);
  assert.equal(calls, 2);
});

test('malformed interpretation file fails closed instead of becoming an empty paid workload', (t) => {
  const { temp } = fixture(t, {});
  const file = path.join(temp, 'topics.json');
  assert.equal(readClassificationFile(file), null);
  fs.writeFileSync(file, '{broken');
  assert.throws(() => readClassificationFile(file), SyntaxError);
  fs.writeFileSync(file, JSON.stringify({ date: '2026-09-12' }));
  assert.throws(() => readClassificationFile(file), /Invalid classification file/);
});

test('settled nightly evidence replaces provisional evidence while pending nightly work preserves live results', () => {
  const live = { assignments: { 1: [['weather', null]], 2: [['weather', 'storm']] }, emerging: [{ label: 'Old provisional label', ids: ['1', '2'] }], pendingIds: ['1'] };
  const nightly = { assignments: { 1: [['weather', 'storm']], 2: [] }, emerging: [{ label: 'River flood', ids: ['1'] }], pendingIds: ['2'] };
  const combined = combineInterpretations(live, nightly);
  assert.deepEqual(combined.assignments, { 1: [['weather', 'storm']], 2: [['weather', 'storm']] });
  assert.deepEqual(combined.emerging, [{ label: 'Old provisional label', ids: ['2'] }, { label: 'River flood', ids: ['1'] }]);
  assert.deepEqual(combined.pendingIds, []);
});

test('malformed emerging structure retries the affected accepted records instead of declaring complete', () => {
  const out = emptyOut();
  const status = mergeParsed({ assignments: [assignment('1'), assignment('2')], emerging: [{ label: '', ids: ['1'] }] }, tax, out, ['1', '2']);
  assert.deepEqual(status.acceptedIds, ['2']);
  assert.deepEqual(status.retryIds, ['1']);
  assert.deepEqual(Object.keys(out.assignments), ['2']);
  const all = emptyOut();
  mergeParsed({ assignments: [assignment('1')], emerging: 'bad shape' }, tax, all, ['1']);
  assert.deepEqual(all.assignments, {});
});

test('a correction arriving during a pending batch remains authoritative over model and anchors', () => {
  const pl = { date: '2026-09-12', tweets: [post('1')], toClassify: [post('1')], deferred: [], inherited: {}, anchored: { 1: [['weather', 'storm']] }, previous: { assignments: { 1: [] }, corrected: { 1: { by: 'reviewer' } }, pendingIds: ['1'] } };
  const day = mergeDay(pl, { assignments: { 1: [['weather', 'storm']] }, incidents: {}, emerging: [] }).day;
  assert.deepEqual(day.assignments['1'], []);
  assert.equal(day.complete, true);
});

test('concurrent runner in the same checkout cannot submit duplicate work', async (t) => {
  const { opts } = fixture(t, { '2026-09-12': [post('1')] });
  let release, entered;
  const inside = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const client = { messages: { batches: {
    create: async () => { calls++; entered(); await gate; return { id: 'one-only' }; },
    retrieve: async () => ({ processing_status: 'in_progress' })
  } } };
  const first = runClassification({ ...opts, client });
  await inside;
  await assert.rejects(runClassification({ ...opts, client }), /Another classification runner is active/);
  release();
  assert.equal((await first).status, 'pending');
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(queueLockPath(opts.queueFile)), false);
});
