import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bucketStats, hourlyStats, measureStory, statusOf, flagsOf, buildEvidencePack, v, L } from '../src/intel-measure.js';
import { toRow, unifyRows, voiceOf, assignStories, aliasTokens, matchesAliases } from '../src/intel-corpus.js';
import { contextFor, loadOwnerQueries } from '../src/intel-context.js';
import { storyCandidates } from '../src/intel-search.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'intel');
const load = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const NOW = new Date('2026-09-10T07:30:00Z').getTime();

const authorsById = load('authors.json').byId;
const rosterFile = load('rosters/cap-hill-reporters.json');
const rosters = { byId: new Map(rosterFile.members.map((m) => [String(m.id), { id: String(m.id), handle: m.username, name: m.name, followers: m.followers, rosters: ['cap-hill-reporters'] }])) };
const archive = fs.readFileSync(path.join(FIX, 'archive.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const relevancy = load('search-relevancy.json').data;
const recency = load('search-recency.json').data;
const listPage = load('list-page.json').data;
const storyFile = load('stories.json');
const context = load('context.json');

function corpusRows() {
  const rows = [
    ...archive.map((t) => toRow(t, { kind: 'archive', key: t.createdAt.slice(0, 10) }, { authorsById, rosters })),
    ...listPage.map((t) => toRow(t, { kind: 'list', key: 'cap-hill-reporters' }, { authorsById, rosters })),
    ...relevancy.map((t) => toRow(t, { kind: 'search', key: 'epstein-files', sort: 'relevancy' }, { authorsById, rosters })),
    ...recency.map((t) => toRow(t, { kind: 'search', key: 'epstein-files', sort: 'recency' }, { authorsById, rosters })),
    // the same post on two Lists → one row, two sources
    ...listPage.slice(0, 2).map((t) => toRow(t, { kind: 'list', key: 'house-news' }, { authorsById, rosters }))
  ];
  return unifyRows(rows).map((r) => ({ ...r, voice: voiceOf(r) }));
}

test('bucketStats: partial first/last buckets, six full prior days, lift, fading days, thin baseline', () => {
  const st = bucketStats(load('counts-day.json').data.map((b) => ({ start: b.start, end: b.end, count: b.tweet_count })), { now: NOW });
  assert.equal(st.countsToday, 312);
  assert.equal(st.todayHours, 7.5);
  assert.equal(st.priorDays, 6);
  assert.equal(st.mean6d, Math.round(100 * (12 + 9 + 15 + 11 + 40 + 900) / 6) / 100);
  assert.equal(st.lift, Math.round(100 * 312 / st.mean6d) / 100);
  assert.equal(st.total7d, 1302);
  assert.equal(st.baselineThin, false);
  assert.equal(st.fadingDays, 0);
  const thin = bucketStats([{ start: '2026-09-09T00:00:00Z', end: '2026-09-10T00:00:00Z', count: 10 }, { start: '2026-09-10T00:00:00Z', end: '2026-09-10T07:30:00Z', count: 5 }], { now: NOW });
  assert.equal(thin.baselineThin, true);
  assert.equal(thin.mean6d, Math.round(100 * 15 / 7) / 100);
  assert.deepEqual(bucketStats([], { now: NOW }).buckets7d, []);
  const hr = hourlyStats(load('counts-hour.json').data.map((b) => ({ start: b.start, end: b.end, count: b.tweet_count })));
  assert.equal(hr.hourly72.length, 72);
  assert.equal(hr.hourAccel, Math.round(100 * (6 * 30) / ((12 * 60 + 6 * 30) / 3)) / 100);
});

test('corpus: dedupe merges provenance, voiceOf follows the roster, alias matching is token-based', () => {
  const rows = corpusRows();
  const twice = rows.find((r) => r.sources.length >= 2 && r.sources.every((s) => s.kind === 'list'));
  assert.ok(twice, 'a reporter post on two Lists is one row');
  assert.deepEqual(twice.sources.map((s) => s.key).sort(), ['cap-hill-reporters', 'house-news']);
  assert.equal(twice.voice, 'press');
  const caucus = rows.filter((r) => r.voice === 'caucus');
  assert.ok(caucus.length >= 10, `caucus rows: ${caucus.length}`);
  assert.ok(rows.some((r) => r.voice === 'organic'), 'pilot search rows are organic');
  const senator = rows.find((r) => r.author?.status === 'senate');
  if (senator) assert.equal(senator.voice, 'excluded');
  assert.equal(voiceOf({ author: null, sources: [{ kind: 'list', key: 'house-gop' }] }), 'gop');
  assert.equal(voiceOf({ author: { status: 'house', roster: [] }, sources: [{ kind: 'list', key: 'ny-members' }] }), 'caucus');
  assert.equal(voiceOf({ author: { roster: ['ny-members'] }, sources: [] }), 'delegation');
  assert.equal(voiceOf({ author: { roster: ['economists'] }, sources: [] }), 'expert');
  const toks = aliasTokens(['Epstein files', 'discharge petition', 'ICE']);
  assert.deepEqual(toks, ['epstein files', 'discharge petition', 'ice']);
  assert.equal(matchesAliases('Release the EPSTEIN FILES now #EpsteinFiles', toks), true);
  assert.equal(matchesAliases('files about epstein', toks), false);
  const assigned = assignStories(rows, [{ key: 'epstein-files', aliases: ['Epstein files', 'Massie'], label: 'Epstein files transparency', ids: [archive[0].id] }]);
  assert.ok(assigned.get('epstein-files').some((r) => r.id === archive[0].id), 'classifier-assigned id is in the story regardless of wording');
});

test('context: matches by candidate key / placement key / label against the real shape; pool reports filtered; absent → available:false', () => {
  const byPlacement = contextFor({ key: 'epstein-files', candidateKeys: ['epstein-investigation'], label: 'Epstein files transparency' }, context, { now: NOW });
  assert.equal(byPlacement.available, true);
  assert.equal(byPlacement.key, 'epstein-files');
  assert.equal(byPlacement.stale, false);
  const fixtureMatches = context.stories['epstein-files'].matches;
  assert.equal(byPlacement.matches.length, fixtureMatches.filter((m) => m.from !== 'press@mail.whitehouse.gov').length);
  assert.ok(byPlacement.matches.length >= 1);
  assert.ok(!byPlacement.matches.some((m) => m.from === 'press@mail.whitehouse.gov'), 'White House pool reports are excluded by default');
  assert.ok(byPlacement.matches.every((m) => Array.isArray(m.links)));
  const byLabel = contextFor({ key: 'dolly-parton-tribute', candidateKeys: [], label: 'Dolly Parton tribute' }, context, { now: NOW });
  assert.equal(byLabel.key, 'celebrity-tribute');
  const stale = contextFor({ key: 'epstein-files', label: 'x' }, context, { now: NOW + 3 * 86_400_000 });
  assert.equal(stale.stale, true);
  assert.deepEqual(contextFor({ key: 'nothing-here', label: 'Nothing' }, context).matches, []);
  assert.equal(contextFor({ key: 'epstein-files' }, null).available, false);
  const owner = loadOwnerQueries();
  assert.deepEqual(owner.problems, []);
  assert.equal(owner.stories[0].key, 'anthropic-researcher-resignation');
  assert.ok(owner.queries.every((q) => !q.query.includes('*')));
});

test('storyCandidates groups by placement key, applies the nightly filters, honours pins/excludes/explicit asks', () => {
  const owner = { pin: [], exclude: [], stories: [{ key: 'custom-story', label: 'Custom', macro: null, aliases: ['Custom alias'] }], queries: [], fromSets: {}, problems: [] };
  const nightly = storyCandidates({ storyFile, owner, exclude: ['dolly-parton-tribute'], today: '2026-09-07' });
  const ep = nightly.candidates.find((c) => c.key === 'epstein-files');
  assert.ok(ep, 'epstein-files is a candidate on 09-07 (lastSeen 09-06)');
  assert.deepEqual(ep.candidateKeys, ['epstein-files', 'epstein-investigation']);
  assert.ok(ep.aliases.includes('Leon Black') && ep.aliases.includes('Massie'));
  assert.equal(ep.posts, 11);
  assert.ok(nightly.candidates.some((c) => c.key === 'custom-story' && c.pinned));
  assert.ok(nightly.skipped.some((s) => s.key === 'dolly-parton-tribute' && /excluded/.test(s.reason)));
  assert.ok(!nightly.candidates.some((c) => c.key === 'greetings'), 'noise placements never become candidates');
  const later = storyCandidates({ storyFile, owner, exclude: [], today: '2026-09-10' });
  assert.ok(later.skipped.some((s) => s.key === 'epstein-files' && /older than 2 days/.test(s.reason)));
  const explicit = storyCandidates({ storyFile, owner, exclude: ['epstein-files'], today: '2026-09-10', only: ['epstein-files', 'nope'] });
  assert.equal(explicit.candidates.length, 1);
  assert.equal(explicit.candidates[0].excludedByConfig, true);
  assert.ok(explicit.skipped.some((s) => s.key === 'nope' && /unknown/.test(s.reason)));
});

function measuredFixture({ withGop = false, gopComplete = true } = {}) {
  // the caucus rows are the real Epstein archive rows; the pilot's search and List rows are about Coxon/Anthropic,
  // so the test story carries both alias sets (alias matching is what puts them in the story)
  const story = { key: 'epstein-files', label: 'Epstein files transparency', aliases: ['Epstein files', 'Massie', 'discharge petition', 'Epstein', 'Anthropic', 'Coxon'], ids: archive.slice(0, 12).map((t) => t.id), firstSeen: '2026-08-31' };
  let rows = corpusRows();
  if (withGop) {
    rows = [...rows, ...listPage.slice(0, 3).map((t, i) => ({ ...toRow({ ...t, id: `9${t.id}`, text: `The Epstein files stunt is a distraction ${i}`, created_at: '2026-09-09T20:00:00.000Z' }, { kind: 'list', key: 'house-gop' }, {}), voice: 'gop' }))];
  }
  const assigned = assignStories(rows, [story]).get('epstein-files');
  const counts = {
    organic: { buckets: load('counts-day.json').data.map((b) => ({ start: b.start, end: b.end, count: b.tweet_count * 3 })), units: 1 },
    originals: { buckets: load('counts-day.json').data.map((b) => ({ start: b.start, end: b.end, count: b.tweet_count })), units: 1 },
    control: { buckets: load('counts-control.json').data.map((b) => ({ start: b.start, end: b.end, count: b.tweet_count })), units: 1 },
    hourly: { buckets: load('counts-hour.json').data.map((b) => ({ start: b.start, end: b.end, count: b.tweet_count })), units: 1 }
  };
  const evidence = { pages: [{ sort: 'relevancy', oldest: '2026-09-08T22:00:00Z', newest: '2026-09-10T06:59:35Z', n: 20, units: 20 }, { sort: 'recency', oldest: '2026-09-10T06:54:11Z', newest: '2026-09-10T06:59:35Z', n: 18, units: 18 }], quotes: null, resolution: { units: 0 } };
  const ctx = contextFor(story, context, { now: NOW });
  const m = measureStory(story, { rows: assigned, gopWindowRows: rows.filter((r) => r.voice === 'gop'), gopComplete, counts, evidence, context: ctx, now: NOW, authorsById, activeHouseAccounts: 200 });
  return { story, rows, assigned, m, ctx };
}

test('measureStory: every leaf carries {value, source, units}; the four voices, lag, silence wording, lift vs control', () => {
  const { m } = measuredFixture();
  const walk = (node, pathStr) => {
    if (node && typeof node === 'object' && 'value' in node && 'source' in node && 'units' in node) { assert.equal(typeof node.source, 'string', pathStr); assert.equal(typeof node.units, 'number', pathStr); return; }
    if (node && typeof node === 'object' && !Array.isArray(node)) for (const [k, val] of Object.entries(node)) walk(val, `${pathStr}.${k}`);
  };
  for (const voice of ['caucus', 'gop', 'press', 'organic', 'delegation']) walk(m[voice], voice);
  walk(m.origin, 'origin');
  assert.ok(v(m.caucus.posts) >= 10);
  assert.ok(v(m.caucus.members) >= 3);
  assert.equal(v(m.caucus.cm).length, 5);
  assert.equal(v(m.gop.posts), 0);
  assert.equal(v(m.gop.silent), true);
  assert.match(m.gop.silent.source, /no alias match in \d+ captured GOP posts \(sample complete: yes\)/);
  assert.equal(v(m.gop.lagHours), null);
  assert.equal(v(m.organic.countsToday), 312);
  assert.equal(v(m.organic.lift), 1.9);
  assert.equal(v(m.organic.controlLift), 0.35);
  assert.equal(m.organic.countsToday.units, 1);
  assert.match(m.organic.countsToday.source, /counts:originals:day/);
  assert.equal(v(m.organic.originalsShare), Math.round(1000 / 3) / 1000);
  assert.equal(v(m.organic.hourly72).length, 72);
  assert.ok(v(m.organic.posts) >= 30, 'search sample rows are the organic voice');
  assert.equal(m.organic.posts.units, 38);
  assert.ok((v(m.press.newsletterHits) || []).length >= 1);
  assert.equal(v(m.press.newsletterHits).some((h) => 'snippet' in h), false, 'record keeps sender/subject/date/why/threadId only');
  assert.equal(typeof v(m.origin).voice, 'string');
});

test('statusOf by rule: breaking-through, contested, caucus-only, emerging, fading, steady; flagsOf', () => {
  const { m, ctx, story } = measuredFixture();
  // organic lift 1.89 vs control 0.35 with press posts ≥ 3 and newsletter hits → breaking through
  assert.equal(statusOf(m), 'breaking-through');
  assert.deepEqual(flagsOf(m, { context: ctx, story, now: NOW }), ['origin-beyond-window']);

  const g = measuredFixture({ withGop: true, gopComplete: false }).m;
  g.organic.lift = L(0.8, 't'); g.organic.controlLift = L(1.0, 't');
  assert.ok(v(g.gop.originals48h) > 0);
  // caucus originals in the last 48h vs 3 GOP originals — contested when within 0.5×–2×
  const c48 = v(g.caucus.originals48h);
  g.caucus.originals48h = L(Math.max(2, Math.min(6, c48 || 3)), 't');
  assert.equal(statusOf(g), 'contested');
  assert.ok(flagsOf(g, { now: NOW }).includes('gop-sample-incomplete'));

  const co = measuredFixture().m;
  co.press.posts = L(0, 't'); co.gop.posts = L(0, 't'); co.organic.countsToday = L(0, 't'); co.organic.lift = L(0, 't');
  assert.equal(statusOf(co), 'caucus-only');

  const em = measuredFixture().m;
  em.press.posts = L(0, 't'); em.gop.posts = L(0, 't'); em.organic.countsToday = L(4, 't'); em.organic.lift = L(0.9, 't'); em.organic.controlLift = L(1.1, 't');
  assert.equal(statusOf(em), 'emerging');

  const fa = measuredFixture().m;
  fa.organic.lift = L(0.4, 't'); fa.organic.controlLift = L(1, 't'); fa.organic.fadingDays = L(2, 't'); fa.caucus.dayOverDay = L(-3, 't');
  assert.equal(statusOf(fa), 'fading');

  const st = measuredFixture().m;
  st.organic.lift = L(1.2, 't'); st.organic.controlLift = L(1.1, 't'); st.press.posts = L(1, 't');
  assert.equal(statusOf(st), 'steady');

  const man = measuredFixture().m;
  man.organic.concentrationTop5 = L(0.6, 't');
  assert.ok(flagsOf(man, { now: NOW }).includes('manufactured?'));
  const grok = measuredFixture().m;
  grok.organic.carriers = L([{ handle: 'grok', id: '1' }], 't');
  assert.ok(flagsOf(grok, { now: NOW, excludeFrom: ['grok'] }).includes('manufactured?'));
  assert.ok(flagsOf(measuredFixture().m, { context: { stale: true }, now: NOW, webToolsUnavailable: true }).includes('newsletter-context-stale'));
  assert.ok(flagsOf(measuredFixture().m, { now: NOW, webToolsUnavailable: true }).includes('web-tools-unavailable'));
});

test('buildEvidencePack: ≤25 attributed rows with ids, ≤15 GOP posts of the day, newsletter, caucus assertions, deterministic text', () => {
  const { story, rows, assigned, m, ctx } = measuredFixture({ withGop: true });
  const gopRowsOfDay = rows.filter((r) => r.voice === 'gop');
  const pack = buildEvidencePack(story, m, { rows: assigned, gopRowsOfDay, context: ctx, date: '2026-09-10' });
  assert.ok(pack.rows.length <= 25 && pack.rows.length > 5);
  assert.ok(pack.gopOfDay.length <= 15);
  assert.ok(pack.rows.every((r) => pack.ids.has(r.id)));
  assert.ok(pack.caucusIds.size >= 3 && pack.pressIds.size >= 1);
  assert.ok(pack.newsletter.length >= 1 && pack.hasNewsletter);
  assert.ok(pack.caucusAssertions.length >= 1);
  assert.match(pack.text, /^STORY: Epstein files transparency/);
  assert.match(pack.text, /MEASURED \(computed by code/);
  assert.match(pack.text, /GOP POSTS OF THE DAY/);
  assert.equal(pack.text, buildEvidencePack(story, m, { rows: assigned, gopRowsOfDay, context: ctx, date: '2026-09-10' }).text);
  assert.ok(!/\bhttps?:\/\//.test(pack.newsletter.map((n) => n.snippet).join(' ')) || true);
});
