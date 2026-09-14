// Synthetic posts and articles exercise data contracts; these fixtures do
// not measure whether a live model correctly understands real reporting.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifierLine, chunkRequests, withEvidence, mergeParsed, emptyOut, runClassification, planDay, writeDay, newsReconsideration, mergeDay } from '../src/classify.js';
import { requestManifest, readQueue, emptyQueue, submitJob } from '../src/classification-queue.js';
import { classifyLive, combineInterpretations } from '../src/classify-live.js';

const tax = { immigration: { label: 'Immigration', subtopics: { detention: { label: 'Detention' } } } };
const date = '2026-09-12';
const post = (id, extra = {}) => ({ id, type: 'tweet', text: 'Families are being sent to Dilley detention again.', createdAt: `${date}T17:00:00Z`, ...extra });
const article = (version = 1, extra = {}) => ({ id: 'n_dilley', publisher: 'Synthetic Wire', sourceId: 'fixture', url: 'https://fixture.example.test/dilley', title: 'Dilley family detention expands', passages: ['At Dilley, officials said family detention would expand this week.'], publishedAt: `${date}T14:00:00Z`, fetchedAt: `${date}T15:00:00Z`, extract: 'body', version, ...extra });
const store = (version = 1) => ({ items: [article(version)], version });
const reply = (assignments, emerging = []) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ assignments, emerging }) }] });
const classifyRow = (line, extra = {}) => ({ id: line.id, topics: [['immigration', 'detention']], evidence_used: (line.evidence || []).map((e) => e.id), ...extra });
const linesOf = (request) => request.params.messages[0].content.split('\n').map((line) => JSON.parse(line));
const batchResult = (request, rows = linesOf(request).map((line) => classifyRow(line))) => ({ custom_id: request.custom_id, result: { type: 'succeeded', message: reply(rows) } });
const iterable = (rows) => (async function* () { yield* rows; })();

function fixture(t, posts = [post('1')]) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'classification-news-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const topics = new Map();
  const opts = {
    dates: [date], tax, model: 'offline-model', queueFile: path.join(tmp, 'queue.json'),
    loadDay: () => posts, topicsFor: (d) => topics.get(d) || null,
    plan: (d, taxonomy) => planDay(d, { tax: taxonomy, tweets: posts, prior: {}, resolve: () => null }),
    publish: (pl, out, model) => writeDay(pl, out, model, { pathFor: (d) => d, write: (d, data) => topics.set(d, data) }),
    hints: async (items) => items, refresh: async () => {}, log: () => {}, newsStore: store()
  };
  return { topics, opts };
}

test('public evidence survives request splitting with exact per-post manifest membership', () => {
  const { items } = withEvidence(Array.from({ length: 20 }, (_, i) => post(String(i + 1))), { store: store(3) });
  assert.ok(items.every((item) => item.evidence.length === 1));
  const requests = chunkRequests(items, tax, 'offline', '', { examples: [] });
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => linesOf(request).reduce((n, line) => n + line.evidence.length, 0) <= 12));
  assert.equal(requests.flatMap(linesOf).length, 20);
  const manifest = requestManifest(requests);
  assert.deepEqual(manifest['chunk-1'].evidenceByPost['20'], JSON.parse(classifierLine(items[19])).evidence);
  assert.equal(manifest['chunk-1'].contextVersions['20'], 3);
});

test('evidence citations cannot cross posts, name unseen sources, duplicate IDs or accept malformed uncertainty', () => {
  const out = emptyOut();
  const entry = { evidenceByPost: { 1: [{ id: 'n_one' }], 2: [{ id: 'n_two' }], 3: [{ id: 'n_one' }] }, contextVersions: { 1: 2 } };
  const status = mergeParsed({ assignments: [
    { id: '1', topics: [], evidence_used: ['n_one'], needs_context: true },
    { id: '2', topics: [], evidence_used: ['n_one'] },
    { id: '3', topics: [], evidence_used: ['n_one', 'n_one'] },
    { id: '4', topics: [], evidence_used: ['n_unseen'] },
    { id: '5', topics: [], needs_context: 'yes' }
  ] }, tax, out, ['1', '2', '3', '4', '5'], entry);
  assert.deepEqual(status.acceptedIds, ['1']);
  assert.deepEqual(status.retryIds, ['2', '3', '4', '5']);
  assert.deepEqual(out.provenance['1'].evidenceUsed, ['n_one']);
  assert.equal(out.provenance['1'].contextVersion, 2);
  assert.equal(out.needsContext['1'], true);
});

test('resumed batch validates and publishes its saved news snapshot even if the store changes', async (t) => {
  const { opts, topics } = fixture(t);
  let sent, ended = false, creates = 0;
  const client = { messages: { batches: {
    create: async ({ requests }) => { creates++; sent = requests; return { id: 'saved-context' }; },
    retrieve: async () => ({ processing_status: ended ? 'ended' : 'in_progress' }),
    results: async () => iterable(sent.map((request) => batchResult(request)))
  } } };
  assert.equal((await runClassification({ ...opts, client })).status, 'pending');
  assert.equal(readQueue(opts.queueFile).jobs[0].manifest[`${date}_chunk-0`].evidenceByPost['1'][0].id, 'n_dilley');
  ended = true;
  assert.equal((await runClassification({ ...opts, client, newsStore: { items: [], version: 99 }, resumeOnly: true })).status, 'complete');
  assert.equal(creates, 1);
  assert.equal(topics.get(date).provenance['1'].contextVersion, 1);
  assert.deepEqual(topics.get(date).provenance['1'].evidenceUsed, ['n_dilley']);
  assert.match(topics.get(date).provenance['1'].inputHash, /^[a-f0-9]{64}$/);
});

test('new relevant news reopens broad decisions once, retains invalid results as pending, and honors corrections', async (t) => {
  const posts = [post('1'), post('2')];
  const { opts, topics } = fixture(t, posts);
  topics.set(date, { assignments: { 1: [['immigration', null]], 2: [] }, corrected: { 2: { by: 'reviewer' } }, complete: true });
  let calls = 0;
  const client = { messages: { create: async (params) => {
    calls++;
    const lines = params.messages[0].content.split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line.id), ['1']);
    return reply(lines.map((line) => classifyRow(line, calls === 1 ? { evidence_used: ['n_forged'] } : {})));
  } } };
  assert.equal((await runClassification({ ...opts, client, sync: true })).status, 'partial');
  assert.deepEqual(topics.get(date).assignments['1'], [['immigration', null]]);
  assert.deepEqual(topics.get(date).pendingIds, ['1']);
  assert.equal((await runClassification({ ...opts, client, sync: true })).status, 'complete');
  assert.deepEqual(topics.get(date).assignments['1'], [['immigration', 'detention']]);
  assert.deepEqual(topics.get(date).assignments['2'], []);
  assert.equal((await runClassification({ ...opts, client, sync: true })).status, 'complete');
  assert.equal(calls, 2);
});

test('uncertain specific labels can be reconsidered, but unchanged or unrelated news cannot reopen them', () => {
  const previous = { assignments: { 1: [['immigration', 'detention']] }, needsContext: { 1: true }, provenance: { 1: { contextVersion: 1 } } };
  assert.deepEqual(newsReconsideration(previous, [post('1')], store(1)), []);
  assert.deepEqual(newsReconsideration(previous, [post('1')], store(2)), ['1']);
  assert.deepEqual(newsReconsideration(previous, [post('1')], { items: [article(2, { title: 'Music festival opens', passages: ['Concertgoers heard a band perform.'] })], version: 2 }), []);
  assert.deepEqual(newsReconsideration({ ...previous, corrected: { 1: { by: 'reviewer' } } }, [post('1')], store(2)), []);
});

test('human correction arriving during inference preserves its topics, incident state, emerging labels and provenance', async (t) => {
  const { opts, topics } = fixture(t);
  const reviewed = { assignments: { 1: [] }, incidents: {}, emerging: [{ label: 'Reviewed label', ids: ['1'] }], corrected: { 1: { by: 'reviewer' } }, provenance: { 1: { contextVersion: 0, evidenceUsed: [] } } };
  const client = { messages: { create: async (params) => {
    topics.set(date, reviewed);
    return reply([classifyRow(JSON.parse(params.messages[0].content), { incident: { kind: 'flooding', place: 'River County, TX' } })], [{ label: 'Model label', ids: ['1'] }]);
  } } };
  await runClassification({ ...opts, client, sync: true });
  assert.deepEqual(topics.get(date).assignments['1'], []);
  assert.deepEqual(topics.get(date).incidents, {});
  assert.deepEqual(topics.get(date).emerging, reviewed.emerging);
  assert.deepEqual(topics.get(date).provenance, reviewed.provenance);
});

test('live news reconsideration excludes pending batch IDs and does not let older nightly context replace fresh results', async (t) => {
  const posts = [post('1'), post('2')];
  const { opts } = fixture(t, posts);
  await submitJob({ messages: { batches: { create: async () => ({ id: 'in-flight' }) } } }, emptyQueue(), { requests: chunkRequests([post('1')], tax, 'offline', `${date}_`, { examples: [] }), dates: [date], model: 'offline', taxonomy: tax }, { file: opts.queueFile });
  const old = { assignments: { 1: [['immigration', null]], 2: [['immigration', null]] }, provenance: { 1: { contextVersion: 0 }, 2: { contextVersion: 0 } } };
  const files = new Map([[`nightly/${date}`, old]]);
  let calls = 0;
  const liveOpts = {
    tax, dates: [date], queueFile: opts.queueFile, load: () => posts,
    read: (f, fallback) => files.get(f) || fallback, write: (f, d) => files.set(f, d),
    livePath: (d) => `live/${d}`, nightlyPath: (d) => `nightly/${d}`,
    resolve: () => null, hints: async (items) => items, refresh: async () => {}, configured: () => true, warn: () => {}, newsStore: store(2),
    client: { messages: { create: async (params) => { calls++; const lines = params.messages[0].content.split('\n').map((line) => JSON.parse(line)); assert.deepEqual(lines.map((line) => line.id), ['2']); return reply(lines.map((line) => classifyRow(line))); } } }
  };
  await classifyLive([], liveOpts);
  const live = files.get(`live/${date}`);
  assert.equal(live.provenance['2'].contextVersion, 2);
  assert.deepEqual(combineInterpretations(live, old).assignments['2'], [['immigration', 'detention']]);
  await classifyLive([], liveOpts);
  assert.equal(calls, 1);
});

test('resume-only with an empty queue does not classify or request credentials', async (t) => {
  const { opts } = fixture(t);
  const result = await runClassification({ ...opts, resumeOnly: true, clientFactory: () => { throw new Error('must not authenticate'); } });
  assert.equal(result.status, 'idle');
  assert.equal(fs.existsSync(opts.queueFile), false);
});

test('a reconsidered original updates repost inheritance instead of retaining the old broad topic', () => {
  const posts = [post('1'), post('2', { type: 'retweet', refId: '1' })];
  const pl = planDay(date, { tax, tweets: posts, prior: { 1: [['immigration', null]] }, resolve: () => null });
  pl.previous = { assignments: { 1: [['immigration', null]], 2: [['immigration', null]] } };
  pl.reconsiderIds = ['1'];
  const provenance = { contextVersion: 2, evidenceUsed: ['n_dilley'], evidenceSupplied: [{ id: 'n_dilley' }] };
  const { day } = mergeDay(pl, { assignments: { 1: [['immigration', 'detention']] }, incidents: {}, emerging: [], provenance: { 1: provenance } }, { prior: { 1: [['immigration', null]] } });
  assert.deepEqual(day.assignments['2'], [['immigration', 'detention']]);
  assert.equal(day.provenance['2'].inheritedFrom, '1');
  assert.equal(day.provenance['2'].contextVersion, 2);
});
