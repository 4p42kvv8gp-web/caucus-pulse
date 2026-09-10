import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Reservation, SpendLog } from '../src/intel-budget.js';
import { planLists, listEntries, authorInfo, resolveAuthors, probeOperators, isOfficial, officialSet } from '../src/intel-lists.js';
import { sampleStory, probeStory, countsPass, rankStories, evidencePath } from '../src/intel-search.js';
import { storyQueries } from '../src/intel-queries.js';
import { ROOT } from '../src/util.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'intel');
const load = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'intel-lists-'));
const NOW = new Date('2026-09-10T07:30:00Z');

function ctxFor(dir, { maxReads = Infinity, stageCaps = {} } = {}) {
  const state = { usage: {} };
  return { reservation: new Reservation({ nightlyCap: 2500, budget: 50000, storyCeiling: 300, storyWeekCeiling: 1000, maxReads, stageCaps }), spendLog: new SpendLog('2026-09-10', {}, { dir }), state, saveState: () => {}, cacheRoot: path.join(dir, 'cache'), date: '2026-09-10', log: () => {} };
}

// A fake X client that serves the recorded fixtures and records every call.
function fakeX(overrides = {}) {
  const calls = [];
  const toResult = (file) => { const b = load(file); return { rateLimited: false, resetAt: null, tweets: b.data, users: [], nextToken: b.meta?.next_token || null, usage: { posts: b.data.length, users: 0 } }; };
  return {
    calls,
    isConfigured: () => true,
    countsRecent: async (query, { granularity }) => { calls.push({ fn: 'countsRecent', query, granularity }); const b = load(granularity === 'hour' ? 'counts-hour.json' : /Congress OR/.test(query) ? 'counts-control.json' : 'counts-day.json'); return { rateLimited: false, resetAt: null, buckets: b.data.map((x) => ({ start: x.start, end: x.end, count: x.tweet_count })), total: b.meta.total_tweet_count, usage: { requests: 1 } }; },
    searchRecent: async (query, opts) => { calls.push({ fn: 'searchRecent', query, ...opts }); if (/^list:|^quotes_of_tweet_id:/.test(query)) { const e = new Error('X search recent 400: Invalid query'); e.status = 400; throw e; } const r = toResult(opts.sortOrder === 'relevancy' ? 'search-relevancy.json' : 'search-recency.json'); r.tweets = r.tweets.slice(0, opts.maxResults); r.usage.posts = r.tweets.length; return r; },
    quoteTweetsPage: async (id, opts) => { calls.push({ fn: 'quoteTweetsPage', id, ...opts }); const r = toResult('search-recency.json'); r.tweets = r.tweets.slice(0, 5); return { ...r, usage: 5 }; },
    lookupUsersByIds: async (ids) => { calls.push({ fn: 'lookupUsersByIds', ids }); return { rateLimited: false, users: ids.slice(0, 3).map((id, i) => ({ id, username: `resolved${i}`, name: 'R', verified_type: i === 0 ? 'government' : 'none', public_metrics: { followers_count: 100 * (i + 1) } })), usage: { users: Math.min(3, ids.length) } }; },
    listTweetsPage: async (listId, opts) => { calls.push({ fn: 'listTweetsPage', listId, ...opts }); return { rateLimited: false, tweets: load('list-page.json').data, nextToken: null, usage: load('list-page.json').data.length }; },
    listMembers: async () => ({ users: [], usage: 0, rateLimited: false }),
    toRecord: (t, capturedAt) => ({ id: t.id, authorId: t.author_id, createdAt: t.created_at, type: 'tweet', refId: null, lang: t.lang, text: t.text, capturedAt, metricsAtCapture: {} }),
    ...overrides
  };
}

test('planLists: scan:true Lists with ids and pages only; counts-only mode → one page; unavailable cursors skipped with the owner instruction', () => {
  const entries = listEntries();
  assert.ok(entries.find((e) => e.key === 'house-gop').scan);
  assert.equal(entries.find((e) => e.key === 'gop-leadership').id, '');
  const full = planLists({ mode: 'full', entries, cursors: { lists: { 'house-gop': { lastNewCount: 3, newestId: '5' }, 'ny-news': { unavailableUntil: '2099-01-01T00:00:00Z' } } }, now: NOW.getTime() });
  const gop = full.plan.find((l) => l.key === 'house-gop');
  assert.equal(gop.pages, 3);
  assert.equal(gop.firstPage, 6);                      // adaptivePageSize seeded from lastNewCount (2 × 3, floor 5)
  assert.equal(gop.expected, 6 + 200);
  assert.ok(full.skipped.some((s) => s.key === 'gop-leadership' && /no List id/.test(s.reason)));
  assert.ok(full.skipped.some((s) => s.key === 'ny-news' && /unavailable until/.test(s.reason)));
  assert.ok(full.skipped.some((s) => s.key === 'economists' && /scan:false/.test(s.reason)));
  const zeroPages = planLists({ mode: 'full', entries: entries.map((e) => (e.key === 'economists' ? { ...e, scan: true } : e)), cursors: { lists: {} }, now: NOW.getTime() });
  assert.ok(zeroPages.skipped.some((s) => s.key === 'economists' && /list_pages is 0/.test(s.reason)));
  assert.ok(full.expected <= 1400, `worst case ${full.expected} ≤ lists_cap`);
  const counts = planLists({ mode: 'counts-only', entries, cursors: { lists: {} }, now: NOW.getTime() });
  assert.ok(counts.plan.every((l) => l.pages === 1));
  assert.equal(planLists({ mode: 'off', entries, cursors: { lists: {} } }).plan.length, 0);
});

test('authorInfo resolves authors.json → rosters → carriers without spending; official-source tagging', () => {
  const authorsById = load('authors.json').byId;
  const rosterFile = load('rosters/cap-hill-reporters.json');
  const rosters = { byId: new Map(rosterFile.members.map((m) => [String(m.id), { id: String(m.id), handle: m.username, name: m.name, followers: m.followers, rosters: ['cap-hill-reporters'] }])) };
  const carriers = { byId: { '42': { handle: 'carrier42', name: 'C', followers: 9, verifiedType: 'government' } } };
  const member = Object.keys(authorsById)[0];
  assert.equal(authorInfo(member, { authorsById, rosters, carriers }).source, 'authors');
  const reporter = authorInfo(rosterFile.members[0].id, { authorsById, rosters, carriers });
  assert.equal(reporter.source, 'roster');
  assert.deepEqual(reporter.rosters, ['cap-hill-reporters']);
  assert.equal(authorInfo('42', { authorsById, rosters, carriers }).source, 'carriers');
  assert.equal(authorInfo('nope', { authorsById, rosters, carriers }), null);
  const official = officialSet({ handles: ['NWS'], verified_types: ['government'] });
  assert.equal(isOfficial({ handle: 'nws' }, official), true);
  assert.equal(isOfficial(authorInfo('42', { authorsById, rosters, carriers }), official), true);
  assert.equal(isOfficial(reporter, official), false);
});

test('resolveAuthors: free lookups first, one paid users call capped, carriers cached so the second call is free', async () => {
  const dir = tmp();
  const ctx = ctxFor(dir);
  const x = fakeX();
  const authorsById = load('authors.json').byId;
  const carriers = { byId: {} };
  const known = Object.keys(authorsById)[0];
  const r = await resolveAuthors([known, '1001', '1002', '1003', '1004', '1005'], { ctx, x, authorsById, rosters: { byId: new Map() }, carriers, cap: 4, story: 'epstein-files', now: NOW, save: false });
  assert.equal(x.calls.filter((c) => c.fn === 'lookupUsersByIds').length, 1);
  assert.deepEqual(x.calls[0].ids, ['1001', '1002', '1003', '1004']);                  // capped at 4, known id never sent
  assert.equal(r.resolved.size, 1 + 3);
  assert.deepEqual(r.unresolved.sort(), ['1004', '1005']);
  assert.equal(r.units, 6);                                                             // 3 users × 2
  assert.equal(ctx.reservation.byStory['epstein-files'], 6);
  assert.equal(carriers.byId['1001'].handle, 'resolved0');
  assert.equal(carriers.byId['1001'].firstSeenIn, 'epstein-files');
  assert.equal(ctx.state.usage[Object.keys(ctx.state.usage)[0]].intelUsers, 3);
  // same ids again on the same UTC day: served from the tool-result cache, no network, no units
  const again = await resolveAuthors(['1001', '1002', '1003', '1004'], { ctx, x, authorsById, rosters: { byId: new Map() }, carriers: { byId: {} }, cap: 4, story: 'epstein-files', now: NOW, save: false });
  assert.equal(x.calls.filter((c) => c.fn === 'lookupUsersByIds').length, 1);
  assert.equal(again.units, 0);
});

test('probeOperators: a 400 records false permanently at 0 units; results persist through the ctx', async () => {
  const dir = tmp();
  const ctx = ctxFor(dir);
  const x = fakeX();
  const probes = { listOperator: null, quotesOperator: null, probedAt: null };
  // save:false keeps the test off data/narratives/probes.json
  const r = await probeOperators({ ctx, x, listId: '1844074661119717599', tweetId: '2097923302371074536', probes: { ...probes }, now: NOW, save: false });
  assert.equal(r.probes.listOperator, false);
  assert.equal(r.probes.quotesOperator, false);
  assert.equal(r.ran.length, 2);
  assert.equal(ctx.reservation.spent, 0);
  assert.equal(x.calls.filter((c) => c.fn === 'searchRecent').every((c) => c.maxResults === 10), true);
  assert.equal(ctx.spendLog.data.calls.every((c) => c.error === 400 && c.units === 0), true);
  // a settled probe is never re-run
  const again = await probeOperators({ ctx, x, listId: '1844074661119717599', tweetId: '1', probes: r.probes, now: NOW, save: false });
  assert.equal(again.ran.length, 0);
});

test('sampleStory follows the fixed plan under a reservation: hourly counts, relevancy 100 → sized to what is left, recency, quotes via fallback, user resolution', async () => {
  const dir = tmp();
  const ctx = ctxFor(dir, { maxReads: 120 });
  const x = fakeX();
  const story = { key: 'epstein-files', label: 'Epstein files transparency', aliases: ['Epstein files', 'Massie'], ids: [] };
  story.queries = storyQueries(story);
  const out = await sampleStory(story, { ctx, x, now: NOW, probes: { listOperator: false, quotesOperator: false }, topPostId: '2094905288625446994', authorsById: {}, rosters: { byId: new Map() }, carriers: { byId: {} }, saveCarriers: false });
  const kinds = x.calls.map((c) => c.fn + (c.granularity ? `:${c.granularity}` : c.sortOrder ? `:${c.sortOrder}` : ''));
  assert.deepEqual(kinds.slice(0, 3), ['countsRecent:hour', 'searchRecent:relevancy', 'searchRecent:recency']);
  assert.equal(x.calls[1].maxResults, 100);
  assert.equal(x.calls[2].maxResults, Math.min(50, 120 - 1 - 20));                     // sized to the remaining reservation
  assert.equal(out.pages.length, 2);
  assert.equal(out.pages[0].n, 20);
  assert.ok(out.pages[0].oldest <= out.pages[0].newest);
  assert.ok(out.quotes && out.quotes.via === 'quote_tweets', 'quotes fall back to the endpoint when the operator probe failed');
  assert.ok(out.posts.length >= 25);
  assert.ok(out.posts.every((r) => typeof r.text === 'string' && r.text.length <= 280 && r.metrics));
  assert.ok(out.units <= 120, `units ${out.units}`);
  assert.equal(ctx.reservation.spent, out.units);
  assert.equal(out.units, ctx.spendLog.data.total);
  const q = x.calls.find((c) => c.fn === 'searchRecent');
  assert.match(q.query, /-is:retweet -from:grok$/);
});

test('probeStory is idempotent per ET date: the second call reuses the evidence file and spends nothing; --force resamples through the cache at 0 units', async () => {
  const dir = tmp();
  const key = `test-story-${process.pid}`;
  const file = evidencePath(key, '2026-09-10');
  try {
    const ctx = ctxFor(dir);
    const x = fakeX();
    const story = { key, label: 'Test story', aliases: ['Epstein files'], ids: [] };
    const counts = await countsPass([story], { ctx, x, now: NOW });
    assert.equal(counts.units, 3);
    const ranked = rankStories([story], counts, { now: NOW.getTime() });
    assert.equal(ranked[0].lift, 1.9);
    const first = await probeStory(story, { ctx, x, now: NOW, counts, probes: { quotesOperator: false }, topPostId: null, authorsById: {}, rosters: { byId: new Map() }, carriers: { byId: {} }, saveCarriers: false });
    assert.equal(first.skipped, null);
    assert.ok(fs.existsSync(file));
    assert.equal(first.evidence.counts.length, 3);                                     // organic, originals, hourly
    assert.equal(first.evidence.control.kind, 'control');
    const spentAfterFirst = ctx.reservation.spent;
    const second = await probeStory(story, { ctx, x, now: NOW, counts, probes: { quotesOperator: false } });
    assert.match(second.skipped, /sampled today already/);
    assert.equal(ctx.reservation.spent, spentAfterFirst);
    const before = x.calls.length;
    const forced = await probeStory(story, { ctx, x, now: NOW, force: true, counts, probes: { quotesOperator: false }, topPostId: null, authorsById: {}, rosters: { byId: new Map() }, carriers: { byId: {} }, saveCarriers: false });
    assert.equal(forced.skipped, null);
    assert.equal(x.calls.length, before, 'every forced call is a tool-result cache hit');
    assert.equal(ctx.reservation.spent, spentAfterFirst);
    assert.ok(forced.evidence.cacheHits >= 3);
    assert.ok(ctx.spendLog.data.calls.slice(-3).every((c) => c.cacheHit));
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('guard: intel writers never resolve into data/archive or data/authors.json', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'intel-lists.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'src', 'intel-search.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'src', 'intel.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'src', 'intel-budget.js'), 'utf8');
  assert.ok(!/appendToArchive|archivePath\(|authorsPath|'authors\.json'/.test(src));
  assert.ok(!/writeJSON\(p\('data', 'authors/.test(src));
  assert.ok(evidencePath('k', '2026-09-10').includes(path.join('data', 'narratives', 'k')));
});
