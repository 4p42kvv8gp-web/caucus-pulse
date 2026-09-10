import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  POOL, learnSettings, windowDates, loadWindow, poolsOf, existingShape, stableOrder,
  cosine, centroid, agglomerate, semanticClusters,
  assignPrompt, assignBatch, readPool, callsNeeded, cachedClusters,
  clusterEvidence, elevateDecision, namePrompt, parseNaming, nameClusters, rememberNaming, namedFromCache, foldSameAs,
  proposeForPool, retireProposals, capAuto,
  subtopicEntry, addSubtopics, setSubtopicFlags, addAliases, elevateMacro, renameSubtopic, applyProposals, proposalId,
  learnedSection
} from '../src/taxonomy-learn.js';
import { renderReport } from '../src/report.js';

const cfg = learnSettings({ min_posts: 8, min_members: 3, elevate_share: 0.6, elevate_factor: 3, elevate_min_share: 0.25, share_days: 7, retire_days: 21, max_per_night: 6, auto_apply: true, auto_elevate: false, sample_posts: 4, batch_posts: 5 });

// A post on `date` by `author` with `topics`.
const post = (id, date, authorId, text, topics = [], extra = {}) => ({ id: String(id), date, authorId: String(authorId), text, topics, type: 'tweet', metricsAtCapture: { likes: Number(id) % 7 }, ...extra });
const tax = {
  economy: { label: 'Economy & cost of living', subtopics: { 'prices-inflation': { label: 'Prices / inflation', aliases: ['cost of living'] }, housing: { label: 'Housing affordability' }, taxes: { label: 'Taxes' }, tariffs: { label: 'Tariffs' } } },
  democracy: { label: 'Democracy', subtopics: { 'voting-rights': { label: 'Voting rights' } } }
};

// A fake Anthropic client: `replies` are consumed in order; prompts are kept.
function stubClient(replies) {
  const prompts = [];
  return {
    prompts,
    messages: { create: async ({ messages }) => { prompts.push(messages[0].content); const r = replies.shift(); return { stop_reason: 'end_turn', content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r) }] }; } }
  };
}

// ── window + pools ───────────────────────────────────────────────────────

test('windowDates: the N ET dates before today, oldest first', () => {
  assert.deepEqual(windowDates(3, '2026-09-10'), ['2026-09-07', '2026-09-08', '2026-09-09']);
});

test('loadWindow keeps classified originals with their topics; retweets and unclassified days are left out', () => {
  const days = {
    '2026-09-08': [post(1, '2026-09-08', 'a', 'x'), { ...post(2, '2026-09-08', 'b', 'RT @a: x'), type: 'retweet' }, post(3, '2026-09-08', 'c', 'unassigned')],
    '2026-09-09': [post(4, '2026-09-09', 'a', 'y')]
  };
  const topics = { '2026-09-08': { assignments: { 1: [['economy', 'housing']], 2: [['economy', 'housing']], 3: [] } } };
  const { posts, classifiedDays } = loadWindow(['2026-09-08', '2026-09-09'], { loadDay: (d) => days[d] || [], topicsFor: (d) => topics[d] || null });
  assert.deepEqual(classifiedDays, ['2026-09-08']);
  assert.deepEqual([...posts.keys()], ['1', '3']);
  assert.deepEqual(posts.get('1').topics, [['economy', 'housing']]);
  assert.deepEqual(posts.get('3').topics, []);
});

test('poolsOf: a post sits in every macro it carries once; empty assignments form the unassigned pool', () => {
  const posts = new Map([
    ['1', post(1, '2026-09-08', 'a', 'x', [['economy', 'housing'], ['economy', 'taxes'], ['democracy', null]])],
    ['2', post(2, '2026-09-08', 'b', 'y', [])],
    ['3', post(3, '2026-09-08', 'b', 'z', [['gone', null]])]
  ]);
  const pools = poolsOf(posts, tax);
  assert.deepEqual(pools.get('economy').map((t) => t.id), ['1']);
  assert.deepEqual(pools.get('democracy').map((t) => t.id), ['1']);
  assert.deepEqual(pools.get(POOL).map((t) => t.id), ['2']);
});

test('existingShape counts macro totals and each subtopic over the window and the share window', () => {
  const posts = new Map([
    ['1', post(1, '2026-09-01', 'a', 'x', [['economy', 'housing']])],            // outside the share window
    ['2', post(2, '2026-09-08', 'a', 'y', [['economy', 'housing'], ['economy', 'taxes']])],
    ['3', post(3, '2026-09-09', 'b', 'z', [['economy', 'housing'], ['economy', null]])],
    ['4', post(4, '2026-09-09', 'c', 'w', [['economy', null]])]
  ]);
  const s = existingShape(posts, tax, { shareFrom: '2026-09-03' });
  assert.equal(s.economy.total, 4);
  assert.equal(s.economy.total7, 3);
  assert.deepEqual(s.economy.subs.housing, { posts: 3, posts7: 2, members7: 2, days7: 2, lastSeen: '2026-09-09' });
  assert.deepEqual(s.economy.subs.taxes, { posts: 1, posts7: 1, members7: 1, days7: 1, lastSeen: '2026-09-08' });
  assert.equal(s.economy.subs['prices-inflation'].posts, 0);
});

test('stableOrder is a fixed pseudo-random permutation by id', () => {
  const items = ['1', '2', '3', '4', '5'].map((id) => ({ id }));
  const a = stableOrder(items).map((t) => t.id);
  assert.deepEqual(stableOrder(items.slice().reverse()).map((t) => t.id), a);
  assert.notDeepEqual(a, ['1', '2', '3', '4', '5']);
  assert.deepEqual(a.slice().sort(), ['1', '2', '3', '4', '5']);
});

// ── semantic path ────────────────────────────────────────────────────────

test('agglomerate groups vectors by cosine at the threshold; centroids and cosine behave', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.deepEqual(centroid([[1, 0], [0, 1]]), [0.5, 0.5]);
  const vecs = [[1, 0, 0], [0.98, 0.1, 0], [0, 1, 0], [0.1, 0.98, 0], [0, 0, 1], [0.95, 0.05, 0.02]];
  assert.deepEqual(agglomerate(vecs, 0.9), [[0, 1, 5], [2, 3], [4]]);
  assert.deepEqual(agglomerate(vecs, 0.99999), [[0], [1], [2], [3], [4], [5]]);
  assert.deepEqual(agglomerate([], 0.5), []);
});

test('semanticClusters skips posts without a vector and keys clusters by content', () => {
  const posts = [post(1, '2026-09-09', 'a', 'x'), post(2, '2026-09-09', 'b', 'y'), post(3, '2026-09-09', 'c', 'z')];
  const index = { get: (id) => ({ 1: [1, 0], 2: [0.99, 0.05] }[id] || null) };
  const r = semanticClusters(posts, index, { threshold: 0.9 });
  assert.equal(r.missing, 1);
  assert.deepEqual(r.scanned, ['1', '2']);
  assert.equal(r.clusters.length, 1);
  assert.deepEqual(r.clusters[0].ids, ['1', '2']);
  assert.match(r.clusters[0].key, /^c-/);
  assert.equal(semanticClusters(posts, index, { threshold: 0.9 }).clusters[0].key, r.clusters[0].key);
});

// ── Claude path ──────────────────────────────────────────────────────────

test('assignBatch: prompt carries known subjects and posts (with quoted context); reply parses; unknown keys are dropped', async () => {
  const posts = [post(1, '2026-09-09', 'a', 'Gas is $4 again', [], { type: 'quote', refId: '9' }), post(2, '2026-09-09', 'b', 'Rent is up 20%'), post(3, '2026-09-09', 'c', 'Good morning!')];
  const client = stubClient([{ subjects: [{ key: 'Rent Costs', label: 'Rent', desc: 'rent going up' }, { key: 'none', label: 'x' }], assignments: [[1, 'gas-prices'], [2, 'rent-costs'], [3, 'none'], [3, 'rent-costs'], [7, 'gas-prices'], [1, 'ghost']] }]);
  const r = await assignBatch({ pool: 'economy', label: 'Economy', posts, subjects: { 'gas-prices': { label: 'Gas prices', desc: 'pump prices' } }, client, model: 'm', quoting: (t) => (t.id === '1' ? { handle: 'x', text: 'Prices at the pump hit a record' } : null) });
  assert.match(client.prompts[0], /filed under the topic "Economy" \(economy\)/);
  assert.match(client.prompts[0], /- gas-prices: Gas prices — pump prices/);
  assert.match(client.prompts[0], /1\. Gas is \$4 again \[quoting @x: Prices at the pump hit a record\]/);
  assert.match(client.prompts[0], /3\. Good morning!/);
  assert.deepEqual(r.subjects, { 'rent-costs': { label: 'Rent', desc: 'rent going up' } });
  assert.deepEqual(r.assignments, { 1: 'gas-prices', 2: 'rent-costs', 3: null });
  assert.match(assignPrompt({ pool: POOL, label: 'Unassigned', posts: [], subjects: {} }), /fit none of the taxonomy's topics/);
});

test('readPool reads unread posts in batches (sample first, then seeded), caches assignments, tolerates a failed call', async () => {
  const posts = Array.from({ length: 11 }, (_, i) => post(i + 1, '2026-09-09', `m${i}`, `post ${i + 1}`));
  const st = { subjects: {}, posts: { 11: 'old' } };
  const seen = [];
  const client = {
    messages: { create: async ({ messages }) => {
      const n = (messages[0].content.match(/^\d+\. /gm) || []).length;
      seen.push(n);
      if (seen.length === 3) throw new Error('boom');
      const body = seen.length === 1
        ? { subjects: [{ key: 'gas', label: 'Gas', desc: '' }], assignments: Array.from({ length: n }, (_, i) => [i + 1, i % 2 ? 'gas' : 'none']) }
        : { subjects: [], assignments: Array.from({ length: n }, (_, i) => [i + 1, 'gas']) };
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(body) }] };
    } }
  };
  const r = await readPool({ pool: 'economy', label: 'E', posts, st, cfg, scan: Infinity, client, model: 'm' });
  assert.deepEqual(seen, [4, 5, 1]);           // sample of 4, then a batch of 5, then the failing last batch
  assert.equal(r.calls, 3);
  assert.equal(r.read, 9);
  assert.equal(Object.keys(st.posts).length, 10); // 9 read + the cached one
  assert.ok(st.subjects.gas);
  assert.equal(callsNeeded(0, false, cfg), 1);
  assert.equal(callsNeeded(10, false, cfg), 1 + 2 + 1);
  assert.equal(callsNeeded(10, true, cfg), 2 + 1);
  const clusters = cachedClusters(posts, st);   // largest first; the cached 'old' subject still counts
  assert.deepEqual(clusters.map((c) => [c.key, c.ids.length]), [['gas', 7], ['old', 1]]);
});

// ── measure ──────────────────────────────────────────────────────────────

test('clusterEvidence measures posts/members/days/share and extrapolates only when the read was capped', () => {
  const posts = new Map([
    ['1', post(1, '2026-09-01', 'a', 'x')], ['2', post(2, '2026-09-08', 'a', 'y')], ['3', post(3, '2026-09-09', 'b', 'z')], ['4', post(4, '2026-09-09', 'c', 'w')]
  ]);
  const exact = clusterEvidence(['1', '2', '3', '4'], posts, { shareFrom: '2026-09-03', scanned7: 10, total7: 10 });
  assert.equal(exact.posts, 4);
  assert.equal(exact.hits7, 3);
  assert.equal(exact.posts7, 3);
  assert.equal(exact.estimated, false);
  assert.equal(exact.members, 3);
  assert.equal(exact.days, 3);
  assert.equal(exact.share, 0.3);
  assert.deepEqual([exact.firstSeen, exact.lastSeen], ['2026-09-01', '2026-09-09']);
  assert.equal(exact.sample_ids.length, 4);
  const capped = clusterEvidence(['2', '3'], posts, { shareFrom: '2026-09-03', scanned7: 10, total7: 100 });
  assert.equal(capped.estimated, true);
  assert.equal(capped.posts7, 20);
  assert.equal(capped.share, 0.2);
});

test('elevateDecision: the share rule, the median rule with its share floor, and not enough siblings', () => {
  assert.deepEqual(elevateDecision(0.61, 5, [], cfg).elevate, true);
  assert.equal(elevateDecision(0.61, 5, [], cfg).rule, 'share');
  // median of live siblings [2, 4, 10] = 4 → bar 12; 30 posts at 30% clears it
  const m = elevateDecision(0.3, 30, [0, 2, 10, 4], cfg);
  assert.equal(m.elevate, true);
  assert.equal(m.rule, 'median');
  assert.match(m.why, /30 posts over 7 days ≥ 3 × the macro's median live subtopic \(4\), 30% of the macro/);
  // same count at 10% share stays under the floor
  const low = elevateDecision(0.1, 30, [2, 10, 4], cfg);
  assert.equal(low.elevate, false);
  assert.match(low.why, /under the 25% floor/);
  assert.equal(elevateDecision(0.3, 11, [2, 10, 4], cfg).elevate, false);
  assert.match(elevateDecision(0.3, 30, [2, 10], cfg).why, /fewer than 3 live siblings/);
});

// ── naming ───────────────────────────────────────────────────────────────

const clustersFixture = (postsById) => [
  { key: 'gas', label: 'Gas prices', desc: 'pump prices', ids: ['1', '2', '3'], evidence: clusterEvidence(['1', '2', '3'], postsById, { shareFrom: '2026-09-03', scanned7: 3, total7: 3 }) },
  { key: 'col', label: 'Cost of living', desc: '', ids: ['4'], evidence: clusterEvidence(['4'], postsById, { shareFrom: '2026-09-03', scanned7: 3, total7: 3 }) }
];

test('nameClusters: prompt lists existing subtopics with counts and clusters with samples; reply parses, junk is normalised', async () => {
  const postsById = new Map([['1', post(1, '2026-09-08', 'a', 'Gas hit $4')], ['2', post(2, '2026-09-09', 'b', 'Pump prices')], ['3', post(3, '2026-09-09', 'c', 'Fill-up costs')], ['4', post(4, '2026-09-09', 'd', 'Everything costs more')]]);
  const existing = existingShape(new Map([['4', post(4, '2026-09-09', 'd', 'x', [['economy', 'prices-inflation']])]]), tax, { shareFrom: '2026-09-03' }).economy;
  const client = stubClient([{
    clusters: [
      { n: 1, label: 'Gas prices', key: 'Gas Prices', aliases: ['gas', '$4 gas', 'pump'], kind: 'subtopic', duplicate_of: null, reason: 'pump prices' },
      { n: 2, label: 'Cost of living', key: 'cost-of-living', aliases: [], kind: 'bogus', duplicate_of: 'prices-inflation', reason: 'same as prices' },
      { n: 9, label: 'ghost' }
    ],
    existing: [
      { key: 'prices-inflation', verdict: 'coarse', splits: ['gas-prices', 'grocery prices'], reason: 'lumps gas, groceries, utilities' },
      { key: 'housing', verdict: 'dead', reason: 'nothing here' },
      { key: 'taxes', verdict: 'duplicate', of: 'taxes', reason: 'self' },
      { key: 'tariffs', verdict: 'rename', label: 'Tariffs & trade war', reason: 'posts are about the trade war' },
      { key: 'nope', verdict: 'dead' }
    ]
  }]);
  const r = await nameClusters({ pool: 'economy', label: 'Economy', tax, clusters: clustersFixture(postsById), existing, postsById, client, model: 'm' });
  assert.match(client.prompts[0], /- prices-inflation: Prices \/ inflation — 1 posts over the window \(1 in the last week\)/);
  // samples are the most-engaged posts first (likes = id % 7 in the fixture)
  assert.match(client.prompts[0], /1\. "Gas prices" — pump prices \(3 posts, 3 members, 2 day\(s\)\)\n   samples: "Fill-up costs" \| "Pump prices" \| "Gas hit \$4"/);
  assert.equal(r.named.length, 2);
  assert.deepEqual(r.named[0].key, 'gas-prices');
  assert.deepEqual(r.named[0].aliases, ['gas', '$4 gas', 'pump']);
  assert.equal(r.named[0].kind, 'subtopic');
  assert.equal(r.named[0].macro, 'economy');
  assert.equal(r.named[1].kind, 'subtopic');
  assert.deepEqual(r.named[1].duplicateOf, { macro: 'economy', key: 'prices-inflation' });
  assert.deepEqual(r.existing.map((e) => [e.key, e.verdict, e.of, e.label]), [
    ['prices-inflation', 'coarse', null, null], ['housing', 'dead', null, null], ['taxes', 'duplicate', null, null], ['tariffs', 'rename', null, 'Tariffs & trade war']
  ]);
  assert.deepEqual(r.existing[0].splits, ['gas-prices', 'grocery prices']);
  // the unassigned pool: clusters must be placed under a macro; "macro/key" duplicates resolve across the taxonomy
  const pooled = parseNaming({ clusters: [{ n: 1, key: 'lake', label: 'Lake', macro: 'democracy', duplicate_of: 'economy/housing' }, { n: 2, key: 'x', label: 'X', macro: 'nowhere' }] }, { pool: POOL, tax, clusters: clustersFixture(postsById) });
  assert.equal(pooled.named[0].macro, 'democracy');
  assert.deepEqual(pooled.named[0].duplicateOf, { macro: 'economy', key: 'housing' });
  assert.equal(pooled.named[1].macro, null);
  assert.match(namePrompt({ pool: POOL, label: 'U', tax, clusters: [], existing: null, postsById }), /could not file under any topic/);
});

test('foldSameAs unions a cluster the model called the same subject into the earlier one and remeasures it; chains and self-references are safe', () => {
  const postsById = new Map([['1', post(1, '2026-09-09', 'a', 'x')], ['2', post(2, '2026-09-09', 'b', 'y')], ['3', post(3, '2026-09-09', 'c', 'z')]]);
  const evidenceFor = (ids) => clusterEvidence(ids, postsById, { shareFrom: '2026-09-03', scanned7: 3, total7: 3 });
  const parsed = parseNaming({ clusters: [
    { n: 1, key: 'gas', label: 'Gas prices' }, { n: 2, key: 'pump', label: 'Pump prices', same_as: 1 }, { n: 3, key: 'fuel', label: 'Fuel', same_as: 2 }, { n: 4, key: 'self', label: 'Self', same_as: 4 }
  ] }, { pool: 'economy', tax, clusters: [
    { key: 'g', label: 'g', ids: ['1'], evidence: evidenceFor(['1']) }, { key: 'p', label: 'p', ids: ['2'], evidence: evidenceFor(['2']) }, { key: 'f', label: 'f', ids: ['2', '3'], evidence: evidenceFor(['2', '3']) }, { key: 's', label: 's', ids: ['3'], evidence: evidenceFor(['3']) }
  ] });
  assert.deepEqual(parsed.named.map((n) => n.sameAs), [null, 'g', 'p', null]);
  const out = foldSameAs(parsed.named, evidenceFor);
  assert.deepEqual(out.map((n) => n.cluster), ['g', 's']);
  assert.deepEqual(out[0].ids, ['1', '2', '3']);
  assert.equal(out[0].evidence.posts, 3);
  assert.equal(out[0].evidence.members, 3);
  assert.deepEqual(out[0].foldedFrom.map((f) => f.cluster), ['p', 'f']);
  assert.equal(out[1].foldedFrom, undefined);
});

test('naming cache: a night without the model reuses last night\'s names, kinds and duplicate judgments; unnamed clusters keep working labels', () => {
  const postsById = new Map([['1', post(1, '2026-09-09', 'a', 'x')]]);
  const clusters = clustersFixture(postsById);
  const { named, existing } = parseNaming({
    clusters: [{ n: 1, key: 'gas-prices', label: 'Gas prices', aliases: ['gas'], kind: 'subtopic', duplicate_of: null, reason: 'pump prices' }, { n: 2, key: 'col', label: 'Cost of living', kind: 'noise', reason: 'generic' }],
    existing: [{ key: 'housing', verdict: 'dead', reason: 'nothing' }]
  }, { pool: 'economy', tax, clusters });
  assert.equal(named[0].cluster, 'gas');
  const st = { subjects: {}, posts: {} };
  rememberNaming(st, named, existing, '2026-09-10');
  assert.deepEqual(st.named.gas, { macro: 'economy', key: 'gas-prices', label: 'Gas prices', aliases: ['gas'], kind: 'subtopic', duplicateOf: null, sameAs: null, reason: 'pump prices', at: '2026-09-10' });
  assert.equal(st.named.col.kind, 'noise');
  assert.equal(st.namedAt, '2026-09-10');
  const later = namedFromCache([...clusters, { key: 'rent', label: 'Rent', ids: ['1'], evidence: clusters[0].evidence }], st, 'economy');
  assert.deepEqual(later.named.map((n) => [n.cluster, n.key, n.kind, n.reason]), [['gas', 'gas-prices', 'subtopic', 'pump prices (named 2026-09-10)'], ['col', 'col', 'noise', 'generic (named 2026-09-10)'], ['rent', 'rent', 'subtopic', '']]);
  assert.deepEqual(later.existing.map((v) => [v.key, v.verdict]), [['housing', 'dead']]);
  assert.equal(namedFromCache(clusters, { subjects: {}, posts: {} }, POOL).named[0].macro, null);
});

// ── cluster → proposal mapping ───────────────────────────────────────────

// Nine posts over the last week from 5 members about gas; 2 about rent.
function economyFixture() {
  const postsById = new Map();
  for (let i = 1; i <= 9; i++) postsById.set(String(i), post(i, i < 5 ? '2026-09-08' : '2026-09-09', `m${i % 5}`, `gas ${i}`, [['economy', null]]));
  postsById.set('10', post(10, '2026-09-09', 'r1', 'rent', [['economy', 'housing']]));
  postsById.set('11', post(11, '2026-09-09', 'r2', 'rent', [['economy', 'housing']]));
  postsById.set('12', post(12, '2026-09-09', 'r2', 'inflation', [['economy', 'prices-inflation']]));
  const ev = (ids) => clusterEvidence(ids, postsById, { shareFrom: '2026-09-03', scanned7: 12, total7: 12 });
  const gasIds = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  return { postsById, gasIds, ev, existing: existingShape(postsById, tax, { shareFrom: '2026-09-03' }).economy };
}

test('proposeForPool: a named cluster over the thresholds becomes an auto add; small ones are listed without auto; noise is dropped; duplicates merge', () => {
  const { postsById, gasIds, ev, existing } = economyFixture();
  const clusters = [
    { key: 'gas', label: 'Gas prices', aliases: ['gas'], kind: 'subtopic', macro: 'economy', duplicateOf: null, reason: 'pump prices', ids: gasIds, evidence: ev(gasIds) },
    { key: 'rent', label: 'Rent', aliases: [], kind: 'subtopic', macro: 'economy', duplicateOf: null, reason: 'rent', ids: ['10', '11'], evidence: ev(['10', '11']) },
    { key: 'hi', label: 'Greetings', aliases: [], kind: 'noise', macro: 'economy', duplicateOf: null, reason: '', ids: ['12'], evidence: ev(['12']) },
    { key: 'col', label: 'Cost of living', aliases: ['costs'], kind: 'subtopic', macro: 'economy', duplicateOf: { macro: 'economy', key: 'prices-inflation' }, reason: 'same', ids: ['12'], evidence: ev(['12']) },
    { key: 'homes', label: 'Housing affordability', aliases: [], kind: 'story', macro: 'economy', duplicateOf: null, reason: 'label matches an existing row', ids: ['10'], evidence: ev(['10']) }
  ];
  const out = proposeForPool({ pool: 'economy', tax, clusters, existing, verdicts: [{ key: 'prices-inflation', verdict: 'coarse', splits: ['gas'], reason: 'lumps' }], cfg });
  const gas = out.find((x) => x.type === 'add' && x.key === 'gas');
  assert.ok(gas.auto && gas.eligible);
  assert.equal(gas.evidence.posts, 9);
  assert.equal(gas.evidence.members, 5);
  assert.match(gas.reason, /pump prices — 9 posts, 5 members, 2 day\(s\), 75% of economy this week; splits economy\/prices-inflation \(too coarse\)/);
  assert.equal(gas.story, false);
  const rent = out.find((x) => x.type === 'add' && x.key === 'rent');
  assert.equal(rent.auto, false);
  assert.match(rent.reason, /below threshold: 2\/8 posts, 2\/3 members/);
  assert.ok(!out.some((x) => x.key === 'hi'));
  const merge = out.find((x) => x.type === 'merge' && x.from === 'col');
  assert.equal(merge.key, 'prices-inflation');
  assert.equal(merge.auto, false);
  assert.deepEqual(merge.aliases, ['costs']);
  const twin = out.find((x) => x.type === 'merge' && x.from === 'homes');
  assert.equal(twin.key, 'housing');
  // gas holds 75% of the macro this week → ELEVATE, dual-listed, never auto without auto_elevate
  const up = out.find((x) => x.type === 'elevate' && x.key === 'gas');
  assert.ok(up);
  assert.equal(up.dual, true);
  assert.equal(up.rule, 'share');
  assert.equal(up.auto, false);
  assert.match(up.reason, /75% of the macro over 7 days \(≥ 60%\).*dual-listed under economy/);
  assert.ok(!out.some((x) => x.type === 'elevate' && x.key === 'rent'));
  // with auto_elevate the same elevation is auto
  const auto = proposeForPool({ pool: 'economy', tax, clusters: [clusters[0]], existing, cfg: { ...cfg, auto_elevate: true } });
  assert.equal(auto.find((x) => x.type === 'elevate').auto, true);
});

test('proposeForPool: a story cluster carries story/since; the unassigned pool needs a macro or proposes a new bucket; verdicts yield merge/rename', () => {
  const { postsById, gasIds, ev, existing } = economyFixture();
  const story = { key: 'coxon', label: 'Coxon resignation', aliases: ['Coxon'], kind: 'story', macro: 'democracy', duplicateOf: null, reason: 'a named event', ids: gasIds, evidence: ev(gasIds) };
  const out = proposeForPool({ pool: POOL, tax, clusters: [story, { ...story, key: 'new-bucket', label: 'Agriculture', macro: null, kind: 'subtopic' }], existing: null, cfg });
  const add = out.find((x) => x.type === 'add');
  assert.equal(add.macro, 'democracy');
  assert.equal(add.story, true);
  assert.equal(add.since, '2026-09-08');
  assert.ok(add.auto);
  assert.match(add.reason, /all of them unfiled today/);
  const bucket = out.find((x) => x.type === 'elevate');
  assert.equal(bucket.macro, null);
  assert.equal(bucket.key, 'new-bucket');
  assert.equal(bucket.auto, false);
  assert.ok(!out.some((x) => x.type === 'elevate' && x.key === 'coxon'), 'pool clusters never elevate by share');
  // verdicts on existing rows
  const v = proposeForPool({ pool: 'economy', tax, clusters: [], existing, verdicts: [
    { key: 'taxes', verdict: 'duplicate', of: 'prices-inflation', reason: 'same posts', splits: [] },
    { key: 'tariffs', verdict: 'rename', label: 'Tariffs & trade war', reason: 'trade war', splits: [] },
    { key: 'housing', verdict: 'ok', reason: '', splits: [] }
  ], cfg });
  assert.deepEqual(v.map((x) => [x.type, x.key, x.from ?? null, x.auto]), [['merge', 'prices-inflation', 'taxes', false], ['rename', 'tariffs', null, false]]);
  assert.equal(v[1].label, 'Tariffs & trade war');
  // a story candidate from stories.json that shares the posts is noted
  const s = proposeForPool({ pool: 'economy', tax, clusters: [{ ...story, macro: 'economy', key: 'gas' }], existing, cfg, stories: { candidates: [{ key: 'gas-story', ids: gasIds.slice(0, 6), placement: { key: 'gas-prices-story' } }] } });
  assert.match(s.find((x) => x.type === 'add').reason, /overlaps story candidate gas-prices-story \(6 shared posts\)/);
});

test('proposeForPool: an existing subtopic that draws the macro is proposed for elevation on measured share', () => {
  const postsById = new Map();
  for (let i = 1; i <= 10; i++) postsById.set(String(i), post(i, '2026-09-09', `m${i}`, 'x', [['economy', i <= 7 ? 'housing' : 'taxes']]));
  const existing = existingShape(postsById, tax, { shareFrom: '2026-09-03' }).economy;
  const out = proposeForPool({ pool: 'economy', tax, clusters: [], existing, cfg: { ...cfg, min_posts: 5 } });
  assert.deepEqual(out.map((x) => [x.type, x.key, x.rule, x.auto]), [['elevate', 'housing', 'share', false]]);
  assert.equal(out[0].evidence.share, 0.7);
  assert.equal(out[0].evidence.posts7, 7);
});

// ── retire rule, cap and auto flags ──────────────────────────────────────

test('retireProposals: zero assignments over retire_days, with enough history; new, dual, anchored and retired rows are never proposed', () => {
  const t = {
    economy: { label: 'E', subtopics: {
      dead: { label: 'Dead' },
      alive: { label: 'Alive' },
      fresh: { label: 'Fresh', learned: '2026-09-01' },
      old: { label: 'Old', promoted: new Date('2026-08-01T00:00:00Z') },
      dual: { label: 'Dual', dual: true, of: 'dual' },
      anchored: { label: 'Anchored', story: true, anchors: ['1'] },
      gone: { label: 'Gone', retired: true }
    } }
  };
  const counts = new Map([['economy/alive', { posts: 2 }]]);
  const days = windowDates(21, '2026-09-10');
  const out = retireProposals(t, counts, { cfg, today: '2026-09-10', classifiedDays: days, verdicts: { economy: [{ key: 'dead', verdict: 'dead', reason: 'nothing about it' }, { key: 'old', verdict: 'ok', reason: 'fine label' }] } });
  assert.deepEqual(out.map((x) => [x.type, x.key, x.auto]), [['retire', 'dead', true], ['retire', 'old', true]]);
  assert.match(out[0].reason, /no assignments over the last 21 classified days — model agrees: nothing about it/);
  assert.match(out[1].reason, /\(model: ok, fine label\)/);
  assert.equal(out[0].evidence.days, 21);
  assert.deepEqual(retireProposals(t, counts, { cfg, today: '2026-09-10', classifiedDays: days.slice(1) }), [], 'fewer classified days than retire_days: not enough history');
  assert.equal(retireProposals(t, counts, { cfg: { ...cfg, auto_apply: false }, today: '2026-09-10', classifiedDays: days })[0].auto, false);
});

test('capAuto: at most max_per_night adds/retires stay auto (most posts first, retirements last); elevations, merges and renames only with auto_elevate', () => {
  const mk = (type, key, posts, auto = true, extra = {}) => ({ type, macro: 'e', key, evidence: { posts }, auto, eligible: true, reason: 'r', ...extra });
  const props = [mk('retire', 'r1', 0), mk('add', 'a1', 5), mk('add', 'a2', 50), mk('add', 'a3', 20, false), mk('elevate', 'e1', 60), mk('merge', 'm1', 9), mk('rename', 'n1', 9), mk('add', 'a4', 30)];
  capAuto(props, { ...cfg, max_per_night: 3 });
  assert.deepEqual(props.filter((x) => x.auto).map((x) => x.key), ['a1', 'a2', 'a4']);
  assert.match(props.find((x) => x.key === 'r1').reason, /waits: max_per_night 3/);
  assert.equal(props.find((x) => x.key === 'a3').reason, 'r');
  const again = [mk('elevate', 'e1', 60), mk('merge', 'm1', 9), mk('add', 'a1', 5)];
  capAuto(again, { ...cfg, auto_elevate: true, max_per_night: 2 });
  assert.deepEqual(again.map((x) => x.auto), [true, true, false]);
});

// ── YAML text edits ──────────────────────────────────────────────────────

const YAML = `# header comment stays
economy:
  label: Economy & cost of living
  # a note on prices
  subtopics:
    prices-inflation:
      label: Prices / inflation
      aliases: ["cost of living", "grocery prices"]
    housing:
      label: Housing affordability

constituent-services:
  label: District & constituent services
  subtopics: {}
`;

test('addSubtopics writes learned rows (provisional + learned; story rows carry story/since) and skips keys already present', () => {
  const out = addSubtopics(YAML, [
    { macro: 'economy', key: 'gas-prices', label: 'Gas prices', aliases: ['gas', '$4 gas'], learned: '2026-09-10' },
    { macro: 'constituent-services', key: 'coxon', label: 'Coxon "quits"', aliases: [], story: true, since: '2026-09-01', learned: new Date('2026-09-10T00:00:00Z') },
    { macro: 'economy', key: 'housing', label: 'Dup', aliases: [], learned: '2026-09-10' }
  ]);
  assert.ok(out.startsWith('# header comment stays\n'));
  assert.match(out, /economy:\n  label: Economy & cost of living\n  # a note on prices\n  subtopics:\n    gas-prices:\n      label: "Gas prices"\n      aliases: \["gas", "\$4 gas"\]\n      provisional: true\n      learned: 2026-09-10\n    prices-inflation:/);
  assert.match(out, /constituent-services:\n  label: District & constituent services\n  subtopics:\n    coxon:\n      label: "Coxon \\"quits\\""\n      story: true\n      since: 2026-09-01\n      provisional: true\n      learned: 2026-09-10\n$/);
  assert.ok(!out.includes('Dup'));
  const parsed = yaml.load(out);
  assert.equal(parsed.economy.subtopics['gas-prices'].provisional, true);
  assert.equal(parsed['constituent-services'].subtopics.coxon.story, true);
  assert.throws(() => addSubtopics(YAML, [{ macro: 'nope', key: 'x', label: 'x' }]), /not found/);
  assert.equal(subtopicEntry({ key: 'k', label: 'L', provisional: false }), '    k:\n      label: "L"\n');
});

test('elevateMacro on a temp copy: a new macro block is appended and the parent keeps a dual-listed row; replay is a no-op', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taxlearn-'));
  const file = path.join(dir, 'taxonomy.yaml');
  fs.writeFileSync(file, YAML);
  // an existing subtopic elevated: the row stays, flags appended
  let text = elevateMacro(fs.readFileSync(file, 'utf8'), { macro: 'economy', key: 'housing', label: 'Housing affordability', aliases: ['rent'], learned: '2026-09-10' });
  fs.writeFileSync(file, text);
  const t1 = yaml.load(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(t1.housing, { label: 'Housing affordability', aliases: ['rent'], provisional: true, learned: new Date('2026-09-10T00:00:00Z'), from: 'economy/housing', subtopics: {} });
  assert.deepEqual(t1.economy.subtopics.housing, { label: 'Housing affordability', dual: true, of: 'housing' });
  assert.ok(text.startsWith('# header comment stays\n'));
  assert.ok(text.includes('  # a note on prices\n'));
  assert.match(text, /\n\nhousing:\n  label: "Housing affordability"\n  aliases: \["rent"\]\n  provisional: true\n  learned: 2026-09-10\n  from: economy\/housing\n  subtopics: \{\}\n$/);
  assert.match(text, /    housing:\n      label: Housing affordability\n      dual: true\n      of: housing\n/);
  assert.equal(elevateMacro(text, { macro: 'economy', key: 'housing', label: 'Housing affordability', aliases: ['rent'], learned: '2026-09-10' }), text);
  // a proposed (not yet existing) subtopic elevated: the parent row is created with the dual flags
  text = elevateMacro(text, { macro: 'economy', key: 'gas-prices', label: 'Gas prices', aliases: ['gas'], learned: '2026-09-10' });
  const t2 = yaml.load(text);
  assert.deepEqual(t2.economy.subtopics['gas-prices'], { label: 'Gas prices', aliases: ['gas'], provisional: true, learned: new Date('2026-09-10T00:00:00Z'), dual: true, of: 'gas-prices' });
  assert.equal(t2['gas-prices'].from, 'economy/gas-prices');
  // a new bucket from the unassigned pool: no parent row
  text = elevateMacro(text, { macro: null, key: 'agriculture', label: 'Agriculture', aliases: [], learned: '2026-09-10' });
  const t3 = yaml.load(text);
  assert.deepEqual(t3.agriculture, { label: 'Agriculture', provisional: true, learned: new Date('2026-09-10T00:00:00Z'), subtopics: {} });
  assert.throws(() => elevateMacro(YAML, { macro: 'nope', key: 'x', label: 'x' }), /not found/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('setSubtopicFlags, addAliases and renameSubtopic edit one row and keep everything else byte-identical', () => {
  const flagged = setSubtopicFlags(YAML, 'economy', 'housing', { merged_into: 'prices-inflation', retired: 'true' });
  assert.equal(flagged, YAML.replace('      label: Housing affordability\n', '      label: Housing affordability\n      merged_into: prices-inflation\n      retired: true\n'));
  assert.equal(setSubtopicFlags(flagged, 'economy', 'housing', { retired: 'true' }), flagged);
  const aliased = addAliases(YAML, 'economy', 'prices-inflation', ['Grocery Prices', 'utility bills']);
  assert.equal(aliased, YAML.replace('aliases: ["cost of living", "grocery prices"]', 'aliases: ["cost of living", "grocery prices", "utility bills"]'));
  assert.equal(addAliases(YAML, 'economy', 'prices-inflation', ['COST OF LIVING']), YAML);
  assert.equal(addAliases(YAML, 'economy', 'housing', ['rent']), YAML.replace('      label: Housing affordability\n', '      label: Housing affordability\n      aliases: ["rent"]\n'));
  assert.equal(renameSubtopic(YAML, 'economy', 'housing', 'Rent & housing'), YAML.replace('      label: Housing affordability\n', '      label: "Rent & housing"\n'));
  assert.throws(() => setSubtopicFlags(YAML, 'economy', 'nope', { a: 1 }), /not found/);
  assert.throws(() => addAliases(YAML, 'nope', 'housing', ['x']), /not found/);
});

test('applyProposals writes adds, retirements, elevations, merges and renames; an add the taxonomy already covers is skipped', () => {
  const proposals = [
    { type: 'add', macro: 'economy', key: 'gas-prices', label: 'Gas prices', aliases: ['gas'], story: false, since: null },
    { type: 'add', macro: 'economy', key: 'cost-of-living', label: 'Cost of living', aliases: [], story: false },  // alias of prices-inflation → skipped
    { type: 'retire', macro: 'economy', key: 'housing' },
    { type: 'elevate', macro: 'economy', key: 'gas-prices', label: 'Gas prices', aliases: ['gas'], dual: true },
    { type: 'merge', macro: 'economy', key: 'prices-inflation', from: 'gas-prices', aliases: ['pump prices'] },
    { type: 'rename', macro: 'economy', key: 'prices-inflation', label: 'Affordability' },
    { type: 'bogus', macro: 'economy', key: 'x' }
  ];
  const { text, applied } = applyProposals(YAML, proposals, { night: '2026-09-10' });
  assert.deepEqual(applied, ['add economy/gas-prices', 'retire economy/housing', 'elevate economy/gas-prices', 'merge economy/prices-inflation ← gas-prices', 'rename economy/prices-inflation']);
  const t = yaml.load(text);
  assert.equal(t.economy.subtopics['gas-prices'].learned.toISOString().slice(0, 10), '2026-09-10');
  assert.equal(t.economy.subtopics['gas-prices'].dual, true);
  assert.equal(t.economy.subtopics['gas-prices'].merged_into, 'prices-inflation');
  assert.equal(t.economy.subtopics['gas-prices'].retired, true);
  assert.equal(t.economy.subtopics.housing.retired, true);
  assert.equal(t['gas-prices'].from, 'economy/gas-prices');
  assert.deepEqual(t.economy.subtopics['prices-inflation'].aliases, ['cost of living', 'grocery prices', 'pump prices']);
  assert.equal(t.economy.subtopics['prices-inflation'].label, 'Affordability');
  assert.ok(!t.economy.subtopics['cost-of-living']);
  assert.ok(text.startsWith('# header comment stays\n'));
  assert.equal(proposalId({ type: 'elevate', macro: null, key: 'agriculture' }), 'elevate -/agriculture');
});

// ── report section ───────────────────────────────────────────────────────

const proposalsFile = {
  generatedAt: '2026-09-10T08:00:00Z', night: '2026-09-10',
  window: { from: '2026-08-27', to: '2026-09-09', days: 14, shareDays: 7, retireDays: 21 },
  settings: { max_calls: 40 },
  coverage: { economy: { read: 1111, calls: 11 }, unassigned: { read: 907, calls: 9 } },
  deferred: [{ pool: 'democracy', posts: 844 }],
  proposals: [
    { type: 'add', macro: 'economy', key: 'gas-prices', label: 'Gas prices', kind: 'subtopic', evidence: { posts: 41, posts7: 30, members: 22, days: 9, share: 0.12, estimated: false }, reason: 'pump prices — 41 posts', auto: true },
    { type: 'add', macro: 'economy', key: 'coxon', label: 'Coxon resignation', kind: 'story', evidence: { posts: 9, posts7: 20, members: 5, days: 2, share: 0.05, estimated: true }, reason: 'a named event', auto: false },
    { type: 'elevate', macro: 'economy', key: 'gas-prices', label: 'Gas prices', kind: 'subtopic', dual: true, evidence: { posts: 41, posts7: 30, members: 22, days: 9, share: 0.61 }, reason: '61% of the macro', auto: false },
    { type: 'elevate', macro: null, key: 'agriculture', label: 'Agriculture', kind: 'subtopic', dual: false, evidence: { posts: 12, posts7: 8, members: 6, days: 4, share: 0 }, reason: 'no macro fits', auto: false },
    { type: 'merge', macro: 'economy', key: 'prices-inflation', from: 'cost-of-living', label: 'Prices / inflation', kind: 'subtopic', evidence: { posts: 30, posts7: 10, members: 12, days: 5, share: 0.2 }, reason: 'same subject', auto: false },
    { type: 'retire', macro: 'immigration', key: 'dreamers-daca', label: 'Dreamers / DACA', kind: 'subtopic', evidence: { posts: 0, days: 21, members: 0, share: 0 }, reason: 'no assignments over the last 21 classified days', auto: true }
  ],
  applied: ['add economy/gas-prices']
};

test('learnedSection lists every proposal with evidence and status, elevations first; only for the night it was generated', () => {
  const lines = learnedSection(proposalsFile, '2026-09-09', cfg);
  const md = lines.join('\n');
  assert.match(md, /^\n## Taxonomy learned tonight\n/);
  assert.match(md, /_Discovery read 2,018 posts across 2 pool\(s\) in 20 Claude call\(s\), window 2026-08-27 → 2026-09-09; share is each subject's part of its macro over the last 7 days\./);
  assert.match(md, /Applied rows carry `provisional: true` and `learned: <date>`/);
  const order = ['**ELEVATE** economy/gas-prices → new macro `gas-prices` (dual-listed)', '**ELEVATE** new macro `agriculture`', '**ADD** economy/gas-prices', '**ADD** economy/coxon', '**MERGE** economy/prices-inflation ← cost-of-living', '**RETIRE** immigration/dreamers-daca'];
  let last = -1;
  for (const s of order) { const i = md.indexOf(s); assert.ok(i > last, `expected "${s}" in order`); last = i; }
  assert.match(md, /- \*\*ADD\*\* economy\/gas-prices "Gas prices" — 41 posts, 22 members, 9 day\(s\), 12% share — pump prices — 41 posts — \*\*applied\*\*/);
  assert.match(md, /- \*\*ADD\*\* economy\/coxon "Coxon resignation" \[story\] — 9 posts read \(≈20\/wk\), 5 members, 2 day\(s\), 5% share — a named event — proposed/);
  assert.match(md, /- \*\*RETIRE\*\* immigration\/dreamers-daca "Dreamers \/ DACA" — 0 assignments in 21 days — no assignments over the last 21 classified days — auto — applies with `--apply`/);
  assert.match(md, /_Deferred to the next night \(max_calls 40\): democracy \(844 posts\)\._/);
  assert.deepEqual(learnedSection(proposalsFile, '2026-09-10', cfg).length > 0, true, 'the night stamp itself also matches');
  assert.deepEqual(learnedSection(proposalsFile, '2026-09-08', cfg), []);
  assert.deepEqual(learnedSection(null, '2026-09-09', cfg), []);
  const none = learnedSection({ ...proposalsFile, proposals: [], applied: [], deferred: [] }, '2026-09-09', cfg).join('\n');
  assert.match(none, /Nothing was written to config\/taxonomy.yaml/);
  assert.match(none, /_No proposals: the posts support the taxonomy as it stands._/);
});

test('the daily report carries the section from the injected proposals file and omits it otherwise', () => {
  const base = { rollups: null, syntax: null, topics: null, tweets: [], usage: null, budget: 1000, stories: null, tax: { d: { label: 'D', subtopics: {} } } };
  const md = renderReport('2026-09-09', { ...base, learned: proposalsFile });
  assert.match(md, /## Taxonomy learned tonight/);
  assert.match(md, /\*\*ADD\*\* economy\/gas-prices/);
  assert.ok(!renderReport('2026-09-09', { ...base, learned: null }).includes('Taxonomy learned'));
});
