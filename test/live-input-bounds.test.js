import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { classifyLive } from '../src/classify-live.js';
import { quotedResolver } from '../src/quoted.js';
import { emptyQueue, prepareJob, readQueue, saveQueue } from '../src/classification-queue.js';
import { planChunkRequests } from '../src/classify.js';

const date = '2026-09-14';
const tax = { climate: { label: 'Climate', subtopics: { disasters: { label: 'Disasters' } } } };
const post = (id, text = 'A public statement.') => ({ id, type: 'tweet', text, createdAt: `${date}T20:00:00Z` });
const reply = (ids) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ assignments: ids.map((id) => ({ id, topics: [], needs_context: false })), emerging: [] }) }] });
function fixture(t, posts) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-input-bounds-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const files = new Map(); const requests = []; let factories = 0;
  const opts = { enabled: true, configured: () => true, tax, model: 'offline-test', dates: [date],
    queueFile: path.join(tmp, 'queue.json'), load: () => posts,
    read: (file, fallback) => files.get(file) || fallback, write: (file, value) => files.set(file, structuredClone(value)),
    livePath: (d) => `live/${d}`, nightlyPath: (d) => `nightly/${d}`,
    resolve: () => null, resolveRepost: () => null, hints: async (items) => items,
    evidence: async (items) => ({ items, contextVersion: 0 }), newsStore: { items: [], version: 0 },
    refresh: async () => {}, warn: () => {}, now: () => `${date}T21:00:00Z`,
    clientFactory: async () => { factories++; return { messages: { create: async (params) => {
      requests.push(params); return reply(params.messages[0].content.split('\n').map((line) => JSON.parse(line).id));
    } } }; }, requestOptions: { examples: [] } };
  return { files, requests, opts, live: () => files.get(`live/${date}`), factories: () => factories };
}

test('oversized source remains explicitly pending while a later ordinary post uses the full live allowance', async (t) => {
  const posts = [post('1', 'x'.repeat(130_000)), post('2'), post('3')];
  const f = fixture(t, posts);
  const first = await classifyLive([], { ...f.opts, maxPosts: 1 });
  assert.equal(first.tagged, 1); assert.equal(first.pending, 2);
  assert.deepEqual(Object.keys(f.live().assignments), ['2']);
  assert.equal(f.live().inputBlocks['1'].reason, 'input-too-large');
  assert.ok(f.live().inputBlocks['1'].inputChars > 120_000);
  assert.equal(f.requests.length, 1);
  const second = await classifyLive([], { ...f.opts, maxPosts: 1 });
  assert.equal(second.tagged, 1); assert.equal(second.pending, 1);
  assert.deepEqual(Object.keys(f.live().assignments).sort(), ['2', '3']);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests.some((req) => req.messages[0].content.includes('xxxxx')), false);
  assert.equal(f.live().complete, false);
});

test('a batch of only oversized sources never constructs or calls an API client', async (t) => {
  const f = fixture(t, [post('1', 'x'.repeat(130_000))]);
  const result = await classifyLive([], f.opts);
  assert.equal(result.pending, 1); assert.equal(f.factories(), 0);
  assert.deepEqual(f.requests, []); assert.equal(f.live().inputBlocks['1'].limit, 120_000);
  assert.equal(f.live().inputBlocks['1'].reason, 'input-too-large');
});

test('added evidence exceeding the bound does not consume the allowance or starve a later ordinary source', async (t) => {
  const f = fixture(t, [post('1'), post('2')]);
  const result = await classifyLive([], { ...f.opts, maxPosts: 1,
    requestOptions: { examples: [], inputCharsCap: 500 },
    evidence: async (items) => ({ items: items.map((item) => item.id === '1' ? { ...item,
      evidence: [{ id: 'n_long', publisher: 'Public source', publishedAt: `${date}T19:00:00Z`, kind: 'report', url: 'https://example.org/article', passage: 'f'.repeat(600) }] } : item), contextVersion: 1 }) });
  assert.equal(result.tagged, 1); assert.equal(result.pending, 1);
  assert.deepEqual(Object.keys(f.live().assignments), ['2']);
  assert.equal(f.live().inputBlocks['1'].reason, 'input-too-large');
});

test('a human correction clears an input block without submission, and a source reduced under the cap becomes eligible', async (t) => {
  const posts = [post('1', 'x'.repeat(130_000)), post('2', 'y'.repeat(130_000))];
  const f = fixture(t, posts); await classifyLive([], f.opts);
  const live = f.live();
  live.assignments['1'] = [['climate', 'disasters']]; live.corrected = { 1: { by: 'reviewer' } };
  posts[1] = post('2', 'Full replacement source is now within the bound.');
  const result = await classifyLive([], f.opts);
  assert.equal(result.pending, 0); assert.equal(f.requests.length, 1);
  assert.deepEqual(f.live().assignments['1'], [['climate', 'disasters']]);
  assert.deepEqual(f.live().inputBlocks, {});
});

test('full quoted wording and its older date reach inference and the saved source receipt exactly', async (t) => {
  const text = 'Public report details. '.repeat(50) + ' FINAL QUALIFICATION.';
  const original = { id: '900', authorId: '200', handle: 'PublicSource', text, createdAt: '2026-08-25T12:00:00Z', metrics: {} };
  const posts = [{ ...post('1', 'New report worth reading.'), type: 'quote', refId: '900', quoted: original }];
  const f = fixture(t, posts);
  const resolve = quotedResolver({ quoted: {}, archive: () => null, authorsById: {}, metricsFor: () => ({}) });
  await classifyLive([], { ...f.opts, resolve });
  const line = JSON.parse(f.requests[0].messages[0].content);
  assert.equal(line.quoting.text, text); assert.equal(line.quoting.createdAt, original.createdAt);
  assert.equal(line.quoting.id, '900'); assert.equal(line.createdAt, posts[0].createdAt);
  const receipt = f.live().provenance['1'].quotedContext;
  assert.equal(receipt.textChars, text.length);
  assert.equal(receipt.textHash, createHash('sha256').update(text).digest('hex'));
  assert.equal(receipt.createdAt, original.createdAt); assert.equal(receipt.id, '900');
  assert.equal(receipt.text, undefined);
  assert.equal(f.live().needsContext['1'], false);
});

test('a source that now fits loses its obsolete size diagnostic even if inference fails', async (t) => {
  const posts = [post('1', 'x'.repeat(130_000))]; const f = fixture(t, posts);
  await classifyLive([], f.opts);
  assert.equal(f.live().inputBlocks['1'].reason, 'input-too-large');
  posts[0] = post('1', 'Corrected source within the input bound.');
  const result = await classifyLive([], { ...f.opts, client: { messages: { create: async () => { throw new Error('provider unavailable'); } } } });
  assert.equal(result.pending, 1); assert.equal(f.live().complete, false);
  assert.deepEqual(f.live().inputBlocks, {});
  assert.match(f.live().requestStatus['live_chunk-0'].error, /provider unavailable/);
});

test('credential setup failure remains explicit through later metadata-only publication without losing pending sources', async (t) => {
  const f = fixture(t, [post('1'), post('2')]);
  const result = await classifyLive([], { ...f.opts, clientFactory: async () => {
    throw Object.assign(new Error('Token exchange failed'), { status: 401 });
  } });
  assert.equal(result.pending, 2); assert.deepEqual(f.live().pendingIds, ['1', '2']);
  assert.equal(f.live().inference.lastAttempt.reasonCode, 'provider-auth');
  assert.equal(f.live().inference.lastSuccess, null);
  const receipt = structuredClone(f.live().inference);
  await classifyLive([], { ...f.opts, enabled: false, now: () => `${date}T22:00:00Z` });
  assert.deepEqual(f.live().inference, receipt, 'publishing later cannot manufacture a request or accepted result');
});

test('local evidence preparation failure is not a new auth or inference attempt', async (t) => {
  const f = fixture(t, [post('1')]);
  await classifyLive([], { ...f.opts, clientFactory: async () => { throw Object.assign(new Error('Token exchange failed'), { status: 401 }); } });
  const prior = structuredClone(f.live().inference);
  await classifyLive([], { ...f.opts, now: () => `${date}T23:00:00Z`, evidence: async () => { throw new Error('local evidence file malformed'); } });
  assert.deepEqual(f.live().inference, prior);
  assert.deepEqual(f.live().pendingIds, ['1']); assert.equal(f.factories(), 0);
});

test('correcting the only blocked source clears stale diagnostics without constructing a client', async (t) => {
  const f = fixture(t, [post('1', 'x'.repeat(130_000))]);
  await classifyLive([], f.opts);
  f.live().assignments['1'] = [];
  f.live().corrected = { 1: { by: 'reviewer' } };
  const result = await classifyLive([], f.opts);
  assert.equal(result.pending, 0); assert.deepEqual(f.live().inputBlocks, {});
  assert.equal(f.factories(), 0);
});

test('quoted source receipt survives the durable queue and rejects malformed source identity', (t) => {
  const f = fixture(t, []);
  const item = { ...post('1'), quoting: { id: '900', authorId: '200', handle: 'Public', text: 'A full source', createdAt: null } };
  const { requests } = planChunkRequests([item], tax, 'offline', `${date}_`, { examples: [] });
  const queue = emptyQueue();
  prepareJob(queue, { requests, dates: [date], model: 'offline', taxonomy: tax });
  saveQueue(queue, f.opts.queueFile);
  const entry = readQueue(f.opts.queueFile).jobs[0].manifest[`${date}_chunk-0`];
  assert.equal(entry.quotedContextByPost['1'].id, '900');
  queue.jobs[0].manifest[`${date}_chunk-0`].quotedContextByPost['1'].id = 'invented';
  saveQueue(queue, f.opts.queueFile);
  assert.throws(() => readQueue(f.opts.queueFile), /Invalid quoted source manifest/);
});
