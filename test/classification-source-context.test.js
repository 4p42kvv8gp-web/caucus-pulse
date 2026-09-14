import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifierLine, chunkRequests, classifySync, collectResults, planDay, remainingPlan, mergeDay,
  writeDay, emptyOut, finishOut, runClassification, sourceReconsideration, sourceMetadataChanged } from '../src/classify.js';
import { requestManifest } from '../src/classification-queue.js';
import { sourceContextStatus, createRepostResolver } from '../src/source-context.js';

const date = '2026-09-14', tax = { transport: { label: 'Transportation', subtopics: {} } };
const topics = [['transport', null]];
const post = (extra = {}) => ({ id: '1', type: 'retweet', refId: '9', text: 'RT @rail: Service suspended…', createdAt: `${date}T12:00:00Z`, ...extra });
const original = { id: '9', authorId: '90', handle: 'rail', text: 'Service suspended between the two stations.', createdAt: `${date}T11:00:00Z` };
const plan = (posts, extra = {}) => planDay(date, { tax, tweets: posts, prior: {}, resolve: () => null, resolveRepost: createRepostResolver(), ...extra });
const message = { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ assignments: [{ id: '1', topics, needs_context: false }], emerging: [] }) }] };

test('incomplete source forces uncertainty identically in synchronous and saved batch results without losing accepted topics', async () => {
  const requests = chunkRequests([post()], tax, 'synthetic', '', { examples: [] });
  const manifest = requestManifest(requests);
  assert.equal(JSON.parse(classifierLine(post())).sourceContext.incomplete, true);
  assert.deepEqual(manifest['chunk-0'].sourceContextByPost['1'], sourceContextStatus(post()));
  const sync = await classifySync({ messages: { create: async () => message } }, requests, tax, { refresh: async () => {} });
  const batch = await collectResults({ messages: { batches: { results: async () => (async function* () {
    yield { custom_id: 'chunk-0', result: { type: 'succeeded', message } };
  })() } } }, 'synthetic', tax, manifest);
  for (const result of [sync, batch.get('')]) {
    assert.deepEqual(result.assignments['1'], topics); assert.equal(result.needsContext['1'], true);
    assert.deepEqual(result.requestStatus['chunk-0'].retryIds, []);
    assert.equal(result.provenance['1'].sourceContext.incomplete, true);
  }
});

test('matching stored originals are supplied intact and fingerprints survive serialization', () => {
  const pl = plan([post()], { resolveRepost: createRepostResolver({ quoted: { 9: original } }) });
  assert.equal(pl.toClassify[0].reposted.text, original.text);
  const input = JSON.parse(classifierLine(pl.toClassify[0]));
  assert.equal(input.reposting.authorId, '90');
  const request = chunkRequests(pl.toClassify, tax, 'synthetic', '', { examples: [] });
  assert.equal(requestManifest(request)['chunk-0'].sourceContextByPost['1'].fingerprint, sourceContextStatus(pl.tweets[0]).fingerprint);
});

test('inherited topics survive missing source while completeness and correction semantics remain separate', () => {
  const pl = plan([post()], { prior: { 9: topics } });
  const missing = mergeDay(pl, finishOut(emptyOut()), { prior: { 9: topics } }).day;
  assert.deepEqual(missing.assignments['1'], topics); assert.equal(missing.needsContext['1'], true);
  assert.deepEqual(missing.pendingIds, []); assert.equal(missing.complete, true);
  const complete = mergeDay(plan([post({ reposted: original })], { prior: { 9: topics } }), finishOut(emptyOut()), { prior: { 9: topics } }).day;
  assert.equal(complete.needsContext['1'], false);
  pl.previous = { assignments: { 1: [] }, needsContext: { 1: false }, corrected: { 1: { revision: 'reviewed' } }, provenance: { 1: { manual: true } } };
  const corrected = mergeDay(pl, finishOut(emptyOut()), { prior: { 9: topics } }).day;
  assert.deepEqual(corrected.assignments['1'], []); assert.equal(corrected.needsContext['1'], false);
  assert.deepEqual(corrected.provenance['1'], { manual: true });
});

test('a resumed batch preserves its submitted source fingerprint when the original changes during inference', async () => {
  const first = post({ reposted: original });
  const request = chunkRequests([first], tax, 'synthetic', '', { examples: [] });
  const result = await classifySync({ messages: { create: async () => message } }, request, tax, { refresh: async () => {} });
  const changed = post({ reposted: { ...original, text: 'Service restored; the earlier suspension ended.' } });
  const day = mergeDay(plan([changed]), result, { prior: {} }).day;
  assert.equal(day.provenance['1'].sourceContext.fingerprint, sourceContextStatus(first).fingerprint);
  assert.equal(day.provenance['1'].sourceContextObserved.fingerprint, sourceContextStatus(changed).fingerprint);
  assert.deepEqual(sourceReconsideration(day, [changed]), ['1']);
  const corrected = { ...day, corrected: { 1: true } };
  assert.deepEqual(sourceReconsideration(corrected, [changed]), []);
});

test('legacy accepted source gaps acquire metadata without provider calls or repeated nightly writes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-nightly-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tweets = [post()]; let saved = { assignments: { 1: [] }, needsContext: { 1: false }, pendingIds: [] }, writes = 0;
  const options = { dates: [date], tax, queueFile: path.join(dir, 'queue.json'), loadDay: () => tweets,
    topicsFor: () => saved, plan: () => plan(tweets), newsStore: { items: [], version: 0 },
    hints: async (items) => items, evidence: async (items) => ({ items }), log: () => {},
    clientFactory: async () => { throw Error('Metadata must not spend'); },
    publish: (pl, result, model) => writeDay(pl, result, model, { pathFor: () => 'synthetic', write: (_file, day) => { writes++; saved = day; } }) };
  assert.equal((await runClassification(options)).status, 'complete');
  assert.equal(writes, 1); assert.equal(saved.needsContext['1'], true); assert.deepEqual(saved.pendingIds, []);
  assert.equal(sourceMetadataChanged(saved, tweets), false);
  assert.equal((await runClassification(options)).status, 'complete'); assert.equal(writes, 1);
  const recovered = [post({ reposted: original })];
  assert.deepEqual(sourceReconsideration(saved, recovered), ['1']);
  const replanned = remainingPlan(plan(recovered), saved, { reconsiderIds: ['1'] });
  assert.equal(replanned.toClassify.length, 1);
});
