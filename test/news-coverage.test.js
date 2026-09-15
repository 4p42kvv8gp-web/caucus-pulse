import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { buildNewsCoverage } from '../src/news-coverage.js';
import { esc, fmt, etWhen, publicUrl, newsEvidence } from '../site/ui.js';

const now = Date.parse('2026-09-14T22:00:00Z');
const ago = (hours) => new Date(now - hours * 3_600_000).toISOString();
const source = (id) => ({ id, publisher: `Publisher ${id}`, url: `https://${id}.example.com/feed`, allowed_hosts: [`${id}.example.com`] });
const sources = ['current', 'stale', 'missing'].map(source);
const item = (id, extra = {}) => ({ id, sourceId: 'current', publisher: 'Publisher current',
  url: `https://current.example.com/${id}`, title: `Headline ${id}`, publishedAt: ago(1),
  extract: 'headline-only', summary: 'A public feed summary.', passages: [], version: 1, ...extra });
const status = { sources: { current: { ok: true, lastFetchAt: ago(0.5), httpStatus: 200 },
  stale: { ok: true, lastFetchAt: ago(0.5), httpStatus: 200 } } };

test('coverage counts latest item versions and separates excerpts from headline/summary and empty records', () => {
  const items = [item('1', { extract: 'body', passages: ['A readable public passage.'] }),
    item('2', { extract: 'body', passages: ['Old article passage.'] }),
    item('2', { extract: 'failed', version: 2 }),
    item('3', { extract: 'body', passages: ['   ', null, 42] }),
    item('4', { title: '', summary: '' })];
  const before = JSON.stringify({ items, sources, status });
  const result = buildNewsCoverage({ items, sources, status, now });
  assert.equal(result.eligibleItems, 4);
  assert.equal(result.withExcerpts, 1);
  assert.equal(result.headlineOrSummary, 2);
  assert.equal(result.withoutReadableText, 1);
  assert.equal(result.sourcesWithRecentItems, 1);
  assert.equal(result.sourcesWithoutRecentItems, 2);
  assert.equal(result.windowDays, 14);
  assert.equal(result.windowStart, ago(14 * 24));
  assert.equal(JSON.stringify({ items, sources, status }), before);
});

test('publication bounds and publisher filters match current retrieval, including the exact 14-day boundary', () => {
  const items = [item('1', { publishedAt: ago(14 * 24) }), item('2', { publishedAt: ago(14 * 24 + 0.001) }),
    item('3', { publishedAt: ago(-0.001) }), item('4', { publishedAt: null }),
    item('5', { url: 'https://advertiser.example.com/promotion' }), item('6', { sourceId: 'not-configured' }),
    item('7', { url: 'https://secret:password@current.example.com/path' })];
  const result = buildNewsCoverage({ items, sources, status, now });
  assert.equal(result.eligibleItems, 1);
  assert.equal(result.sources[0].latestPublishedAt, ago(14 * 24));
  assert.equal(result.sources[0].latestItem.url, 'https://current.example.com/1');
  assert.equal(result.sources[1].latestPublishedAt, null);
  assert.equal(result.sources[2].lastFetchOutcome, 'not-observed');
  assert.equal(result.sources[2].lastFetchAt, null);
});

test('a rejected newest version cannot revive an older version and tie observations do not duplicate items', () => {
  const items = [item('1'), item('1', { version: 2, url: 'https://other.example.com/1' }),
    item('2'), item('2', { extract: 'body', passages: ['Updated same-version observation.'] })];
  const result = buildNewsCoverage({ items, sources, status, now });
  assert.equal(result.eligibleItems, 1);
  assert.equal(result.withExcerpts, 1);
});

test('successful fetch with stale sources is visibly different from failed fetch with retained recent evidence', () => {
  const items = [item('1', { extract: 'body', passages: ['Saved before the failed fetch.'] }),
    item('2', { sourceId: 'stale', url: 'https://stale.example.com/2', publishedAt: '2024-06-14T04:13:26Z' })];
  const result = buildNewsCoverage({ items, sources, now,
    status: { sources: { ...status.sources, current: { ok: false, lastFetchAt: ago(0.25), error: 'private diagnostic' } } } });
  assert.equal(result.sources[0].lastFetchOutcome, 'failed');
  assert.equal(result.sources[0].eligibleItems, 1);
  assert.equal(result.sources[0].withExcerpts, 1);
  assert.equal(result.sources[1].lastFetchOutcome, 'succeeded');
  assert.equal(result.sources[1].eligibleItems, 0);
  assert.equal(result.sources[1].latestPublishedAt, '2024-06-14T04:13:26.000Z');
  assert.equal(result.failedSources, 1);
  assert.ok(!JSON.stringify(result).includes('private diagnostic'));
});

test('coverage expires against each build time without a new fetch and publishes no private metadata', () => {
  const items = [item('1', { sender: 'private@example.com', subject: 'Private subject', threadId: 'private-thread' })];
  const dirtyStatus = { ...status, inbox: 'private inbox', sources: { ...status.sources,
    current: { ...status.sources.current, error: 'private error detail', sender: 'private@example.com' } } };
  const first = buildNewsCoverage({ items, sources, status: dirtyStatus, now });
  const later = buildNewsCoverage({ items, sources, status: dirtyStatus, now: now + 15 * 86_400_000 });
  assert.equal(first.eligibleItems, 1); assert.equal(later.eligibleItems, 0);
  assert.equal(later.sources[0].lastFetchOutcome, 'succeeded');
  assert.equal(later.sources[0].latestPublishedAt, first.sources[0].latestPublishedAt);
  assert.ok(!JSON.stringify(first).includes('private'));
  assert.throws(() => buildNewsCoverage({ now: NaN }), /Invalid/);
});

// Exercise the actual inline panel renderer without booting the dashboard or
// accessing the network. It uses only the shared production HTML helpers.
const html = fs.readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
const begin = html.indexOf('function renderNewsPanel(data) {');
const end = html.indexOf('\nfunction render() {', begin);
assert.ok(begin >= 0 && end > begin, 'dashboard has a separate public-news renderer');
const renderNewsPanel = vm.runInNewContext(`(${html.slice(begin, end).trim()})`, { esc, fmt, etWhen, publicUrl, newsEvidence });

test('news panel labels empty current coverage, retains failure context and links real source items', () => {
  const coverage = buildNewsCoverage({ items: [item('1'), item('2', {
    sourceId: 'stale', url: 'https://stale.example.com/2', publishedAt: '2024-06-14T04:13:26Z'
  })], sources, now, status: { sources: { ...status.sources, current: { ok: false, lastFetchAt: ago(0.5) } } } });
  const rendered = renderNewsPanel({ today: '2026-09-14', news: { coverage, latest: [] } });
  assert.match(rendered, /1 item in 14 days/);
  assert.match(rendered, /2 sources without recent items/);
  assert.match(rendered, /Fetch failed; saved items retained/);
  assert.match(rendered, /No recent items/);
  assert.match(rendered, /2024/);
  assert.match(rendered, /https:\/\/stale\.example\.com\/2/);
  assert.match(rendered, /Headline\/summary items have no saved article passage/);
});

test('news panel escapes source labels, rejects unsafe links and handles older data without invented counts', () => {
  const coverage = buildNewsCoverage({ sources, items: [], status, now });
  coverage.sources[0].publisher = '<img src=x onerror=alert(1)>';
  coverage.sources[0].sourceUrl = 'javascript:alert(1)';
  coverage.sources[0].latestItem = { url: 'javascript:alert(2)', title: '" onmouseover="alert(3)' };
  const rendered = renderNewsPanel({ today: '2026-09-14', news: { coverage } });
  assert.ok(!rendered.includes('<img'));
  assert.ok(!rendered.includes('href="javascript:'));
  assert.match(rendered, /&lt;img/);
  const old = renderNewsPanel({ today: '2026-09-14', news: { items: 200 } });
  assert.match(old, /Coverage details unavailable/);
  assert.ok(!old.includes('0 items'));
});

test('official floor evidence is labeled as a floor agenda, with its original citation', () => {
  const rendered = newsEvidence([{ id: 'floor-1', kind: 'floor-agenda', publisher: 'Office of the Clerk',
    url: 'https://docs.house.gov/floor/', text: 'Scheduled bill consideration.', publishedAt: '2026-09-14T12:00:00Z' }]);
  assert.match(rendered, /Floor agenda/);
  assert.ok(!rendered.includes('headline lead'));
  assert.match(rendered, /https:\/\/docs\.house\.gov\/floor\//);
});
