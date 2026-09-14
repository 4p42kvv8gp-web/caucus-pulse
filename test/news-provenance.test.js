import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refreshAll, fetchText } from '../src/context-refresh.js';
import { loadNews, retrieveEvidence, itemId, storeItems } from '../src/news-context.js';

const url = 'https://provenance.example.test/dilley';
const feedUrl = 'https://provenance.example.test/feed';
const cfg = { user_agent: 'offline-test', fetch: { pace_ms: 0, body_refresh_hours: 6 }, sources: [{ id: 'test', publisher: 'Synthetic Wire', url: feedUrl, bodies: true }] };
const feed = (title = 'Dilley detention update') => `<rss><channel><item><title>${title}</title><link>${url}</link><pubDate>Sat, 12 Sep 2026 12:00:00 GMT</pubDate></item></channel></rss>`;
const page = (text = 'Officials at Dilley detention reported an expansion of the facility for families this week. This synthetic passage is long enough to be retained by the article extractor.') => `<html><head><title>Dilley detention update</title></head><body><article><p>${text}</p></article></body></html>`;
const response = (body, status = 200, location = null) => ({ ok: status >= 200 && status < 300, status, text: async () => body, headers: { get: () => location } });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'news-provenance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = { itemsFile: path.join(dir, 'items.jsonl'), statusFile: path.join(dir, 'status.json') };
  const read = () => loadNews({ file: files.itemsFile, statusFile: files.statusFile }).items[0];
  return { files, read };
}
function network({ article = page(), title, fail = false } = {}) {
  let bodies = 0;
  const fetchImpl = async (u) => {
    if (u.endsWith('/robots.txt')) return response('', 404);
    if (u === feedUrl) return response(feed(title));
    bodies++;
    if (fail) throw new Error('publisher timed out');
    return response(article);
  };
  return { fetchImpl, count: () => bodies };
}

test('stale-body timeout retains readable evidence and records its failed attempt separately', async (t) => {
  const { files, read } = fixture(t);
  await refreshAll({ ...files, cfg, fetchImpl: network().fetchImpl, now: '2026-09-12T13:00:00Z', log: () => {} });
  const original = read();
  assert.equal(original.extract, 'body');
  const failure = network({ fail: true });
  await refreshAll({ ...files, cfg, fetchImpl: failure.fetchImpl, now: '2026-09-12T20:00:00Z', log: () => {} });
  const retained = read();
  assert.equal(failure.count(), 1);
  assert.equal(retained.extract, 'body');
  assert.deepEqual(retained.passages, original.passages);
  assert.equal(retained.version, original.version);
  assert.equal(retained.fetchedAt, original.fetchedAt);
  assert.equal(retained.bodyAttemptedAt, '2026-09-12T20:00:00Z');
  assert.match(retained.fetchError, /timed out/);
});

test('unchanged successful body refresh persists its clock without a content version bump or hourly retry', async (t) => {
  const { files, read } = fixture(t);
  const run = (now, net = network()) => refreshAll({ ...files, cfg, fetchImpl: net.fetchImpl, now, log: () => {} });
  await run('2026-09-12T13:00:00Z');
  const first = read();
  await run('2026-09-12T20:00:00Z');
  assert.equal(read().version, first.version);
  assert.equal(read().bodyFetchedAt, '2026-09-12T20:00:00Z');
  assert.equal(read().fetchedAt, first.fetchedAt);
  const nextHour = network();
  await run('2026-09-12T21:00:00Z', nextHour);
  assert.equal(nextHour.count(), 0);
});

test('feed edits do not postpone a failed article retry and a changed passage is never backdated', async (t) => {
  const { files, read } = fixture(t);
  await refreshAll({ ...files, cfg, fetchImpl: network({ fail: true }).fetchImpl, now: '2026-09-12T13:00:00Z', log: () => {} });
  await refreshAll({ ...files, cfg, fetchImpl: network({ title: 'Dilley detention new headline' }).fetchImpl, now: '2026-09-13T12:00:00Z', log: () => {} });
  assert.equal(read().bodyAttemptedAt, '2026-09-12T13:00:00Z');
  const retry = network({ title: 'Dilley detention new headline' });
  await refreshAll({ ...files, cfg, fetchImpl: retry.fetchImpl, now: '2026-09-13T14:00:00Z', log: () => {} });
  assert.equal(retry.count(), 1);
  assert.equal(read().extract, 'body');
  assert.equal(read().fetchedAt, '2026-09-13T14:00:00Z');
  assert.equal(read().publishedAt, '2026-09-12T12:00:00.000Z');
  const history = retrieveEvidence('Families are being sent to Dilley detention again.', { items: [read()], asOf: '2026-09-12T15:00:00Z', knownAt: '2026-09-14T00:00:00Z', mode: 'as-of' });
  assert.deepEqual(history.evidence, []);
  const current = retrieveEvidence('Families are being sent to Dilley detention again.', { items: [read()], asOf: '2026-09-12T15:00:00Z', knownAt: '2026-09-14T00:00:00Z' });
  assert.ok(current.evidence.length, JSON.stringify({ current, item: read() }));
  assert.equal(current.evidence[0].acquiredAfterPost, true);
});

test('a changed article version receives the revision observation time, including metadata-only content changes', (t) => {
  const { files, read } = fixture(t);
  const options = { file: files.itemsFile, statusFile: files.statusFile };
  const original = { id: itemId(url), url, publisher: 'Synthetic Wire', title: 'Dilley detention update', extract: 'body', passages: ['Dilley detention officials reported 20 beds.'], publishedAt: '2026-09-12T12:00:00Z', fetchedAt: '2026-09-12T13:00:00Z' };
  storeItems([original], { ...options, now: original.fetchedAt });
  storeItems([{ ...original, passages: ['Dilley detention officials corrected their report to 10 beds.'] }], { ...options, now: '2026-09-13T15:00:00Z' });
  assert.equal(read().fetchedAt, '2026-09-13T15:00:00Z');
  assert.equal(read().version, 2);
});

test('redirects outside the publisher allowlist are rejected before the second fetch', async () => {
  const calls = [];
  await assert.rejects(fetchText(url, { fetchImpl: async (u) => { calls.push(u); return response('', 302, 'http://127.0.0.1/private'); } }), /Disallowed news URL/);
  assert.deepEqual(calls, [url]);
});
