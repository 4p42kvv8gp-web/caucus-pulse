import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { classifierLine, planChunkRequests, chunkRequests, runClassification, planDay, writeDay, mergeDay, emptyOut, finishOut, mergeParsed } from '../src/classify.js';
import { readQueue } from '../src/classification-queue.js';

const date = '2026-09-12';
const tax = { weather: { label: 'Weather', subtopics: { storm: { label: 'Storm' } } } };
const post = (id, text = 'Storm observation') => ({ id, type: 'tweet', text, createdAt: `${date}T16:00:00Z` });
const large = () => ({ ...post('2', 'A member quoting a long source'), quoting: { id: '900', text: 'Complete source wording. '.repeat(6000) } });
const lines = (request) => request.params.messages[0].content.split('\n').map((line) => JSON.parse(line));
const reply = (ids) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ assignments: ids.map((id) => ({ id, topics: [] })), emerging: [] }) }] });
const digest = (value) => createHash('sha256').update(value).digest('hex');

function fixture(t, posts) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'classification-input-bounds-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const topics = new Map();
  const opts = {
    dates: [date], tax, model: 'offline-model', queueFile: path.join(tmp, 'queue.json'),
    loadDay: () => posts, topicsFor: (d) => topics.get(d) || null,
    plan: (d, taxonomy) => planDay(d, { tax: taxonomy, tweets: posts, prior: {}, resolve: () => null, resolveRepost: () => null }),
    publish: (pl, out, model) => writeDay(pl, out, model, { pathFor: (d) => d, write: (d, value) => topics.set(d, value) }),
    hints: async (items) => items, evidence: (items) => ({ items, contextVersion: 0 }),
    newsStore: { items: [], version: 0 }, refresh: async () => {}, log: () => {}
  };
  return { topics, opts };
}

test('exact serialized JSONL length includes separators and accepts the precise boundary', () => {
  const posts = [post('1', 'First \"quote\"\nline 😀'), post('2', 'Second source')];
  const exact = posts.map(classifierLine).join('\n');
  const planned = planChunkRequests(posts, tax, 'offline', '', { examples: [], inputCharsCap: exact.length });
  assert.equal(planned.requests.length, 1);
  assert.deepEqual(planned.inputBlocks, {});
  assert.equal(planned.requests[0].params.messages[0].content, exact);
  assert.equal(planChunkRequests(posts, tax, 'offline', '', { examples: [], inputCharsCap: exact.length - 1 }).requests.length, 2);
  const one = classifierLine(posts[0]);
  assert.equal(planChunkRequests([posts[0]], tax, 'offline', '', { examples: [], inputCharsCap: one.length }).requests[0].params.messages[0].content, one);
  const blocked = planChunkRequests([posts[0]], tax, 'offline', '', { examples: [], inputCharsCap: one.length - 1 });
  assert.equal(blocked.requests.length, 0);
  assert.deepEqual(blocked.inputBlocks['1'], { reason: 'input-too-large', inputChars: one.length, limit: one.length - 1, inputHash: digest(one) });
});

test('each input is serialized once and oversized quoted source remains whole while neighboring inputs proceed', () => {
  let reads = 0;
  const observed = { id: '1', get text() { reads++; return reads === 1 ? 'Original wording' : 'Changed wording'; } };
  const huge = large();
  const original = structuredClone(huge);
  const planned = planChunkRequests([observed, huge, post('3')], tax, 'offline', '', { examples: [], inputCharsCap: 200_000 });
  assert.equal(reads, 1);
  assert.deepEqual(planned.requests.flatMap(lines).map((row) => row.id), ['1', '3']);
  assert.equal(planned.requests.flatMap(lines)[0].text, 'Original wording');
  assert.equal(planned.inputBlocks['2'].limit, 120_000, 'the production maximum cannot be raised through options');
  assert.equal(planned.inputBlocks['2'].inputHash, digest(classifierLine(huge)));
  assert.deepEqual(huge, original);
  assert.throws(() => chunkRequests([post('1'), huge], tax, 'offline', '', { examples: [] }), (error) => error.inputBlocks['2'].reason === 'input-too-large');
});

test('complete long quote text, escapes, Unicode and trailing whitespace reach the request unchanged', () => {
  const quote = 'Opening \"quotation\"\n' + 'Word 😀 '.repeat(3000) + '\nFinal qualification.  ';
  const item = { ...post('1', 'Member comment'), quoting: { id: '900', authorId: '100', handle: 'source', createdAt: `${date}T15:00:00Z`, text: quote } };
  const planned = planChunkRequests([item], tax, 'offline', '', { examples: [] });
  assert.equal(planned.requests.length, 1);
  assert.equal(lines(planned.requests[0])[0].quoting.text, quote);
  assert.equal(planned.requests[0].params.messages[0].content, classifierLine(item));
});

test('mixed synchronous inputs persist the blocked reason before the only provider call and do not retry settled neighbors', async (t) => {
  const { topics, opts } = fixture(t, [post('1'), large()]);
  let calls = 0;
  const client = { messages: { create: async (params) => {
    calls++;
    assert.equal(topics.get(date).inputBlocks['2'].reason, 'input-too-large');
    const submitted = params.messages[0].content.split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(submitted.map((row) => row.id), ['1']);
    return reply(['1']);
  } } };
  assert.equal((await runClassification({ ...opts, client, sync: true })).status, 'partial');
  assert.deepEqual(topics.get(date).assignments, { 1: [] });
  assert.deepEqual(topics.get(date).pendingIds, ['2']);
  assert.equal(topics.get(date).inputBlocks['2'].reason, 'input-too-large');
  assert.equal((await runClassification({ ...opts, clientFactory: () => { throw new Error('no authentication for blocked-only input'); }, sync: true })).status, 'partial');
  assert.equal(calls, 1);
});

test('mixed batch inputs save blocked diagnostics before submission and preserve them across manifest-only resume', async (t) => {
  const { topics, opts } = fixture(t, [post('1'), large()]);
  let calls = 0, ended = false, submitted;
  const client = { messages: { batches: {
    create: async ({ requests }) => {
      calls++; submitted = requests;
      assert.equal(topics.get(date).inputBlocks['2'].reason, 'input-too-large');
      assert.deepEqual(requests.flatMap(lines).map((row) => row.id), ['1']);
      return { id: 'bounded-batch' };
    },
    retrieve: async () => ({ processing_status: ended ? 'ended' : 'in_progress' }),
    results: async () => (async function* () {
      for (const request of submitted) yield { custom_id: request.custom_id, result: { type: 'succeeded', message: reply(['1']) } };
    })()
  } } };
  assert.equal((await runClassification({ ...opts, client })).status, 'pending');
  assert.deepEqual(Object.values(readQueue(opts.queueFile).jobs[0].manifest).flatMap((entry) => entry.ids), ['1']);
  const diagnostic = structuredClone(topics.get(date).inputBlocks['2']);
  ended = true;
  assert.equal((await runClassification({ ...opts, client, resumeOnly: true })).status, 'partial');
  assert.equal(calls, 1);
  assert.deepEqual(topics.get(date).assignments, { 1: [] });
  assert.deepEqual(topics.get(date).pendingIds, ['2']);
  assert.deepEqual(topics.get(date).inputBlocks['2'], diagnostic);
  assert.deepEqual(readQueue(opts.queueFile).jobs, []);
});

test('all oversized inputs publish pending reasons with zero authentication or provider calls in batch and sync modes', async (t) => {
  for (const sync of [false, true]) {
    const { topics, opts } = fixture(t, [large()]);
    let authenticated = 0;
    const result = await runClassification({ ...opts, sync, clientFactory: () => { authenticated++; throw new Error('must not authenticate'); } });
    assert.equal(result.status, 'partial');
    assert.equal(authenticated, 0);
    assert.deepEqual(topics.get(date).pendingIds, ['2']);
    assert.deepEqual(topics.get(date).assignments, {});
    assert.equal(topics.get(date).inputBlocks['2'].reason, 'input-too-large');
    assert.equal(fs.existsSync(opts.queueFile), false);
  }
});

test('remeasured input within the limit clears an old size block even when inference fails and remains pending', async (t) => {
  const posts = [large()];
  const { topics, opts } = fixture(t, posts);
  await runClassification({ ...opts, sync: true, clientFactory: () => { throw new Error('no client needed'); } });
  assert.equal(topics.get(date).inputBlocks['2'].reason, 'input-too-large');
  posts[0] = post('2', 'A complete replacement now fits.');
  let calls = 0;
  const result = await runClassification({ ...opts, sync: true, client: { messages: { create: async () => {
    calls++;
    assert.deepEqual(topics.get(date).inputBlocks, {}, 'new input measurement is persisted before the request');
    throw new Error('provider temporarily unavailable');
  } } } });
  assert.equal(calls, 1);
  assert.equal(result.status, 'partial');
  assert.deepEqual(topics.get(date).pendingIds, ['2']);
  assert.deepEqual(topics.get(date).inputBlocks, {});
  assert.equal(topics.get(date).failedChunks, 1);
});

test('a correction on the only blocked source persists diagnostic cleanup with no unrelated work or provider call', async (t) => {
  const { topics, opts } = fixture(t, [large()]);
  await runClassification({ ...opts, sync: true, clientFactory: () => { throw new Error('no client needed'); } });
  topics.get(date).assignments['2'] = [];
  topics.get(date).corrected = { 2: { by: 'reviewer' } };
  const result = await runClassification({ ...opts, clientFactory: () => { throw new Error('correction must not authenticate'); } });
  assert.equal(result.status, 'complete');
  assert.deepEqual(topics.get(date).inputBlocks, {});
  assert.deepEqual(topics.get(date).pendingIds, []);
  assert.deepEqual(topics.get(date).assignments['2'], []);
});

test('diagnostics remain day-scoped and disappear after acceptance or a reviewed correction', () => {
  const block = { reason: 'input-too-large', inputChars: 120001, limit: 120000, inputHash: 'a'.repeat(64) };
  const pl = planDay(date, { tax, tweets: [post('1'), post('2')], prior: {}, resolve: () => null, resolveRepost: () => null });
  pl.previous = { assignments: { 1: [], 2: [] }, pendingIds: ['1', '2'], inputBlocks: { 1: block, 2: block, 900: block }, corrected: { 2: { by: 'reviewer' } } };
  pl.inputBlocks = { 1: block, 2: block, 901: block };
  const out = finishOut(emptyOut());
  out.inputBlocks = { 902: block };
  const partial = mergeDay(pl, out).day;
  assert.deepEqual(partial.inputBlocks, { 1: block });
  assert.deepEqual(partial.assignments['2'], []);
  const accepted = mergeDay({ ...pl, previous: partial }, { ...out, assignments: { 1: [] } }).day;
  assert.deepEqual(accepted.inputBlocks, {});
  assert.deepEqual(accepted.pendingIds, []);
});

test('accepted provenance retains exact quoted-source manifest identity instead of model-invented metadata', () => {
  const quotedContext = { id: '900', authorId: '100', handle: 'source', createdAt: `${date}T15:00:00Z`, textHash: digest('Full quotation.'), textChars: 15 };
  const out = emptyOut();
  mergeParsed({ assignments: [{ id: '1', topics: [], quotedContext: { id: 'invented' } }] }, tax, out, ['1'], { quotedContextByPost: { 1: quotedContext }, inputHash: 'request-hash' });
  assert.deepEqual(out.provenance['1'].quotedContext, quotedContext);
  assert.equal(out.provenance['1'].inputHash, 'request-hash');
});
