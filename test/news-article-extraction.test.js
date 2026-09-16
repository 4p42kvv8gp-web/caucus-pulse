import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractArticle, itemId, contentHash } from '../src/news-context.js';
import { refreshSource } from '../src/context-refresh.js';

const fixture = (name) => fs.readFileSync(new URL(`fixtures/news/${name}.html`, import.meta.url), 'utf8');
const audioUrl = 'https://www.npr.org/2026/09/15/nx-s1-5968682/trump-says-developing-ai-is-a-critical-race-downplaying-fears';
const source = { id: 'npr-politics', publisher: 'NPR', url: 'https://feeds.npr.org/1014/rss.xml', bodies: true, allowed_hosts: ['npr.org'] };
const cfg = { fetch: { pace_ms: 0, body_refresh_hours: 6, max_bodies_per_source: 2 } };
const feed = `<rss><channel><item><title>Synthetic audio fixture title</title><link>${audioUrl}</link><pubDate>Tue, 15 Sep 2026 10:42:20 GMT</pubDate><description>A short description from the public audio feed.</description></item></channel></rss>`;
const old = { id: itemId(audioUrl), sourceId: source.id, publisher: 'NPR', url: audioUrl, feedLink: audioUrl, extract: 'body', passages: ['A summary incorrectly treated as an article, followed by a publisher anti-fraud notice.'], publishedAt: '2026-09-15T10:42:20.000Z', fetchedAt: '2026-09-15T12:00:00.000Z', bodyFetchedAt: '2026-09-15T12:00:00.000Z', bodyAttemptedAt: '2026-09-15T12:00:00.000Z' };
function fetcher(page, status = 200) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (url.endsWith('/robots.txt')) return { ok: true, status: 200, url, text: async () => 'User-agent: *\nDisallow:' };
    if (url === source.url) return { ok: true, status: 200, url, text: async () => feed };
    if (page instanceof Error) throw page;
    return { ok: status === 200, status, url, text: async () => page };
  };
  impl.calls = calls;
  return impl;
}

test('observed NPR audio-only layout does not turn summary or anti-fraud notice into a readable report', () => {
  const art = extractArticle(fixture('npr-audio-summary'), { url: audioUrl });
  assert.equal(art.extract, 'headline-only');
  assert.equal(art.extractReason, 'public-audio-summary-only');
  assert.deepEqual(art.passages, []);
  assert.equal(art.canonical, audioUrl);
  assert.equal(art.publishedAt, old.publishedAt);
});

test('observed NPR transcript implicit paragraphs preserve separate speakers and exclude boilerplate', () => {
  const art = extractArticle(fixture('npr-transcript'), { url: 'https://www.npr.org/story' });
  assert.equal(art.extract, 'body');
  assert.equal(art.passages.length, 3);
  assert.match(art.passages[0], /^MORGAN EXAMPLE, HOST: Synthetic opening/);
  assert.match(art.passages[1], /^TAYLOR SAMPLE:/);
  assert.match(art.passages[2], /^EXAMPLE: This synthetic follow-up/);
  assert.ok(!art.passages.join(' ').match(/Synthetic disclaimer|synthetic permissions|summary omitted|anti-fraud/));
  assert.ok(art.passages.every((p) => p.length <= 600));
});

test('observed NPR written story retains actual body paragraphs rather than a photo caption', () => {
  const art = extractArticle(fixture('npr-written-story'), { url: 'https://www.npr.org/story' });
  assert.equal(art.extract, 'body');
  assert.match(art.passages[0], /^Synthetic first paragraph:/);
  assert.match(art.passages[2], /Example District/);
  assert.ok(!art.passages.join(' ').match(/Synthetic hide caption|Synthetic Photo Credit|Synthetic image caption/));
});

test('NPR selection is based on the fetched publisher host, not an untrusted canonical or a lookalike domain', () => {
  const html = fixture('npr-audio-summary');
  for (const url of ['https://npr.org.example.test/story', 'https://other.test/story']) {
    const art = extractArticle(html, { url });
    assert.equal(art.extractReason, undefined);
  }
});

test('unknown NPR layout cannot promote a site notice to a report or authorize a downgrade', () => {
  const art = extractArticle('<html><body><p>A site notice with enough characters to pass the old paragraph threshold.</p></body></html>', { url: audioUrl });
  assert.equal(art.extract, 'headline-only');
  assert.deepEqual(art.passages, []);
  assert.equal(art.extractReason, undefined);
});

test('the summary-only correction replaces earlier false-body content while retaining the feed and source provenance', async () => {
  const fetchImpl = fetcher(fixture('npr-audio-summary'));
  const result = await refreshSource(source, { cfg, fetchImpl, known: new Map([[old.id, old]]), now: '2026-09-16T01:00:00.000Z' });
  const item = result.items[0];
  assert.equal(item.extract, 'headline-only');
  assert.equal(item.extractReason, 'public-audio-summary-only');
  assert.deepEqual(item.passages, []);
  assert.equal(item.summary, 'A short description from the public audio feed.');
  assert.equal(item.url, audioUrl);
  assert.equal(item.publisher, 'NPR');
  assert.equal(item.publishedAt, old.publishedAt);
  assert.equal(item.bodyFetchedAt, '2026-09-16T01:00:00.000Z');
  assert.equal(item.fetchError, null);
  assert.notEqual(contentHash(item), contentHash(old), 'the correction is a new content version');
});

test('timeout, HTTP failure and unknown layout still retain a previous readable excerpt', async () => {
  for (const [page, status] of [[new Error('timeout'), 200], ['', 503], ['<html><body><p>Unknown publisher layout with a site notice only.</p></body></html>', 200]]) {
    const result = await refreshSource(source, { cfg, fetchImpl: fetcher(page, status), known: new Map([[old.id, old]]), now: '2026-09-16T01:00:00.000Z' });
    assert.equal(result.items[0].extract, 'body');
    assert.deepEqual(result.items[0].passages, old.passages);
    assert.ok(result.items[0].fetchError);
  }
});

test('public audio summaries are checked again at the normal body refresh interval for a newly published transcript', async () => {
  const prior = { ...old, extract: 'headline-only', extractReason: 'public-audio-summary-only', passages: [] };
  const fetchImpl = fetcher(fixture('npr-transcript'));
  const result = await refreshSource(source, { cfg, fetchImpl, known: new Map([[old.id, prior]]), now: '2026-09-15T18:01:00.000Z' });
  assert.ok(fetchImpl.calls.includes(audioUrl));
  assert.equal(result.items[0].extract, 'body');
  assert.equal(result.items[0].extractReason, null);
  assert.match(result.items[0].passages[0], /^MORGAN EXAMPLE, HOST:/);
});

test('a summary-only quality reason survives a not-due refresh', async () => {
  const prior = { ...old, extract: 'headline-only', extractReason: 'public-audio-summary-only', passages: [] };
  const fetchImpl = fetcher(fixture('npr-audio-summary'));
  const result = await refreshSource(source, { cfg, fetchImpl, known: new Map([[old.id, prior]]), now: '2026-09-15T13:00:00.000Z' });
  assert.equal(result.items[0].extractReason, 'public-audio-summary-only');
  assert.ok(!fetchImpl.calls.includes(audioUrl));
});

test('a later explicit transcript speaker cannot inherit an earlier stranded speaker label', () => {
  const html = `<html><body><div class="transcript storytext"><p>HOST:<p>(SOUNDBITE OF ARCHIVED RECORDING)<p>OTHER SPEAKER: This is a separate speaker with a complete sentence for the excerpt.</div></body></html>`;
  const art = extractArticle(html, { url: audioUrl });
  assert.deepEqual(art.passages, ['OTHER SPEAKER: This is a separate speaker with a complete sentence for the excerpt.']);
});

test('the excerpt character and passage limits still apply to the transcript scope', () => {
  const art = extractArticle(fixture('npr-transcript'), { url: audioUrl, passageChars: 100, maxPassages: 2 });
  assert.equal(art.passages.length, 2);
  assert.ok(art.passages.every((p) => p.length <= 100));
  assert.match(art.passages[0], /^MORGAN EXAMPLE, HOST:/);
  assert.ok(art.passages[0].endsWith('…'));
});

test('audio template classes alone cannot authorize removal of prose beyond the declared summary', () => {
  const html = fixture('npr-audio-summary').replace('</p>', '</p><p>Additional article prose is present beyond the publisher description and must remain available.</p>');
  const art = extractArticle(html, { url: audioUrl });
  assert.equal(art.extractReason, undefined);
  assert.equal(art.extract, 'body');
  assert.match(art.passages.join(' '), /Additional article prose/);
});
