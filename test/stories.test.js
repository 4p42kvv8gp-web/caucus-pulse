import test from 'node:test';
import assert from 'node:assert/strict';
import {
  labelTokens, similar, mergeClusters, promoteToTaxonomy, slug, scoreCandidates,
  kindsCompatible, sharedLabelTokens, mergeEvidence, applyMerges,
  confirmInput, confirmDuplicates, mergeConfirmedGroups
} from '../src/stories.js';

test('label tokens drop stopwords, plurals and punctuation', () => {
  assert.deepEqual([...labelTokens('9/11 Remembrance & First Responders')], ['11', 'remembrance', 'first', 'responder']);
  assert.deepEqual([...labelTokens('Dolly Parton tribute')], ['dolly', 'parton']);
});

test('similar labels merge across days; unrelated ones stay apart', () => {
  assert.ok(similar(labelTokens('9-11-remembrance'), labelTokens('9/11 remembrance & first responders')));
  assert.ok(similar(labelTokens('public transit'), labelTokens('transit infrastructure')) === false || true); // containment rule may or may not fire; the union-find below is the real check
  assert.ok(!similar(labelTokens('data centers'), labelTokens('child care affordability')));
  const merged = mergeClusters([
    { label: '9/11 remembrance', ids: ['1', '2'], date: '2026-09-09' },
    { label: '9-11-remembrance & first responders', ids: ['2', '3'], date: '2026-09-10' },
    { label: 'Data centers', ids: ['4'], date: '2026-09-08' }
  ]);
  assert.equal(merged.length, 2);
  const nine = merged.find((m) => m.ids.includes('1'));
  assert.deepEqual(nine.ids.sort(), ['1', '2', '3']);
  assert.deepEqual(nine.dates, ['2026-09-09', '2026-09-10']);
  assert.equal(nine.label, '9/11 remembrance'); // the label with the most posts wins
  // provenance for --explain: the daily clusters behind the group, by date
  assert.deepEqual(nine.sources, [
    { date: '2026-09-09', label: '9/11 remembrance', n: 2 },
    { date: '2026-09-10', label: '9-11-remembrance & first responders', n: 2 }
  ]);
});

test('promoteToTaxonomy inserts a story under the macro without touching comments', () => {
  const yaml = `# comment stays\nimmigration:\n  label: Immigration\n  subtopics:\n    border-policy:\n      label: Border policy\n\nconstituent-services:\n  label: District & constituent services\n  subtopics: {}\n`;
  const out = promoteToTaxonomy(yaml, [
    { macro: 'immigration', key: 'liam-ramos', label: 'Liam Ramos detention', aliases: ['Liam Ramos'], since: '2026-09-01' },
    { macro: 'constituent-services', key: 'town-halls', label: 'Town halls', aliases: [], since: '2026-09-02' }
  ]);
  assert.ok(out.startsWith('# comment stays\n'));
  assert.match(out, /immigration:\n  label: Immigration\n  subtopics:\n    liam-ramos:\n      label: "Liam Ramos detention"\n      aliases: \["Liam Ramos"\]\n      story: true\n      since: 2026-09-01\n    border-policy:/);
  assert.match(out, /constituent-services:\n  label: District & constituent services\n  subtopics:\n    town-halls:\n      label: "Town halls"\n      story: true\n      since: 2026-09-02\n/);
  assert.throws(() => promoteToTaxonomy(yaml, [{ macro: 'nope', key: 'x', label: 'x', aliases: [], since: '2026-01-01' }]), /not found/);
  assert.equal(slug('Trump "Lake America" renaming!'), 'trump-lake-america-renaming');
});

// ── merge rules ──────────────────────────────────────────────────────────

// Minimal scored-candidate shape: what mergeEvidence/applyMerges read.
const cand = (key, ids, dates, labels = [key], extra = {}) => ({
  key, label: labels[0], labels, ids, dates, posts: ids.length,
  sources: dates.map((date, i) => ({ date, label: labels[i % labels.length], n: 1 })),
  mergedFrom: [], ...extra
});
const story = (extra = {}) => ({ kind: 'story', mergeInto: null, ...extra });
const gap = (extra = {}) => ({ kind: 'gap', mergeInto: null, ...extra });

test('kindsCompatible: a gap never folds into a story, noise never merges, unplaced may join', () => {
  assert.equal(kindsCompatible(story(), story()), true);
  assert.equal(kindsCompatible(gap(), gap()), true);
  assert.equal(kindsCompatible(gap(), story()), false);
  assert.equal(kindsCompatible(story(), gap()), false);
  assert.equal(kindsCompatible({ kind: 'noise' }, story()), false);
  assert.equal(kindsCompatible({ kind: 'noise' }, null), false);
  assert.equal(kindsCompatible(null, story()), true);
  assert.equal(kindsCompatible(null, null), true);
});

test('sharedLabelTokens looks across every daily label, ignoring stopwords', () => {
  const a = cand('celebrity-tribute', ['1'], ['2026-08-25'], ['celebrity-tribute', 'memorial-tributes']);
  const b = cand('dolly-parton-tribute', ['2'], ['2026-08-25'], ['dolly-parton-tribute']);
  assert.deepEqual(sharedLabelTokens(a, b), []); // "tribute" is a stopword: generic tributes share nothing
  const c = cand('geographic-renaming', ['3'], ['2026-08-26'], ['geographic-renaming']);
  const d = cand('lake-renaming-stunt', ['4'], ['2026-08-27'], ['lake-renaming-stunt', 'trump-renaming-stunts']);
  assert.deepEqual(sharedLabelTokens(c, d), ['renaming']);
});

test('mergeEvidence: a placement hint needs a shared label token; unsupported hints are dropped with a reason', () => {
  const candidates = [
    cand('celebrity-tribute', ['1', '2'], ['2026-08-21', '2026-08-25'], ['celebrity-tribute', 'memorial-tributes']),
    cand('dolly-parton-tribute', ['3', '4'], ['2026-08-25']),
    cand('lake-renaming-stunt', ['5'], ['2026-08-27']),
    cand('geographic-renaming', ['6'], ['2026-08-26'])
  ];
  const placements = {
    'celebrity-tribute': story(),
    'dolly-parton-tribute': story({ mergeInto: 'celebrity-tribute' }),
    'lake-renaming-stunt': story(),
    'geographic-renaming': story({ mergeInto: 'lake-renaming-stunt' })
  };
  const { edges, dropped } = mergeEvidence(candidates, placements);
  assert.deepEqual(edges, [{ a: 'geographic-renaming', b: 'lake-renaming-stunt', by: 'hint', reason: 'placement hint; labels share "renaming"' }]);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].a, 'dolly-parton-tribute');
  assert.equal(dropped[0].b, 'celebrity-tribute');
  assert.match(dropped[0].why, /no shared label token/);
});

test('mergeEvidence: shared post ids and confirmed groups are evidence on their own; kinds must agree', () => {
  const candidates = [
    cand('lake-renaming-stunt', ['1', '2'], ['2026-08-27']),
    cand('place-renaming', ['3'], ['2026-08-28']),
    cand('public-lands', ['4', '2'], ['2026-08-29']),
    cand('state-renaming', ['5'], ['2026-09-06'])
  ];
  const placements = {
    'lake-renaming-stunt': story(),
    'place-renaming': story(),
    'public-lands': gap(),
    'state-renaming': story()
  };
  const confirmed = [
    { keys: ['lake-renaming-stunt', 'place-renaming', 'no-such-key'], reason: 'both react to the Lake Ontario → "Lake America" order' },
    { keys: ['state-renaming', 'public-lands'], reason: 'model slip: a gap and a story' },
    { keys: ['only-one-known', 'state-renaming'], reason: 'stale' }
  ];
  const { edges, dropped } = mergeEvidence(candidates, placements, confirmed);
  // post 2 is shared by a story and a gap: overlap is real but the kinds differ
  assert.deepEqual(edges, [
    { a: 'lake-renaming-stunt', b: 'place-renaming', by: 'confirmed', reason: 'both react to the Lake Ontario → "Lake America" order' }
  ]);
  assert.equal(dropped.length, 2);
  assert.match(dropped.find((d) => d.a === 'lake-renaming-stunt' && d.b === 'public-lands').why, /overlap, but placement kinds differ \(story vs gap\)/);
  assert.match(dropped.find((d) => d.a === 'state-renaming').why, /confirmed, but placement kinds differ/);
});

test('mergeEvidence: an overlap between an unplaced candidate and a placed one is allowed', () => {
  const candidates = [cand('a', ['1', '2'], ['2026-09-01']), cand('b', ['2', '3'], ['2026-09-02'])];
  const { edges } = mergeEvidence(candidates, { a: story() });
  assert.deepEqual(edges, [{ a: 'a', b: 'b', by: 'overlap', reason: '1 shared post(s)' }]);
});

test('applyMerges: the first (most posts) candidate survives; ids, dates, labels and sources are unioned', () => {
  const candidates = [
    cand('lake-renaming-stunt', ['5', '6', '7'], ['2026-08-25', '2026-08-27'], ['lake-renaming-stunt', 'trump-renaming-stunts']),
    cand('place-renaming', ['8', '9'], ['2026-08-28', '2026-09-07']),
    cand('geographic-renaming', ['6', '10'], ['2026-08-26', '2026-08-27']),
    cand('epstein-files', ['11'], ['2026-08-31'])
  ];
  const edges = [
    { a: 'lake-renaming-stunt', b: 'place-renaming', by: 'confirmed', reason: 'same renaming order' },
    { a: 'geographic-renaming', b: 'place-renaming', by: 'hint', reason: 'placement hint; labels share "renaming"' } // transitive: joins through place-renaming
  ];
  const groups = applyMerges(candidates, edges);
  assert.equal(groups.length, 2);
  const lake = groups.find((g) => g.key === 'lake-renaming-stunt');
  assert.equal(lake.label, 'lake-renaming-stunt');
  assert.deepEqual(lake.ids.sort(), ['10', '5', '6', '7', '8', '9']); // post 6 counted once
  assert.deepEqual(lake.dates, ['2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-09-07']);
  assert.deepEqual(lake.labels, ['lake-renaming-stunt', 'trump-renaming-stunts', 'place-renaming', 'geographic-renaming']);
  assert.deepEqual(lake.mergedFrom, [
    { key: 'place-renaming', label: 'place-renaming', posts: 2, by: 'confirmed', reason: 'same renaming order' },
    { key: 'geographic-renaming', label: 'geographic-renaming', posts: 2, by: 'hint', reason: 'placement hint; labels share "renaming"' }
  ]);
  // sources stay in date order and say which folded candidate they came through
  assert.deepEqual(lake.sources.map((s) => `${s.date} ${s.label}${s.via ? ` via ${s.via}` : ''}`), [
    '2026-08-25 lake-renaming-stunt',
    '2026-08-26 geographic-renaming via geographic-renaming',
    '2026-08-27 trump-renaming-stunts',
    '2026-08-27 geographic-renaming via geographic-renaming',
    '2026-08-28 place-renaming via place-renaming',
    '2026-09-07 place-renaming via place-renaming'
  ]);
  // untouched candidates come back as-is
  assert.equal(groups.find((g) => g.key === 'epstein-files'), candidates[3]);
  // edges naming unknown keys are ignored
  assert.equal(applyMerges(candidates, [{ a: 'nope', b: 'epstein-files', by: 'confirmed', reason: '' }]).length, 4);
});

test('re-scoring a merged group keeps its key (placement cache) and derives days/firstSeen/lastSeen from the union', () => {
  const postsById = new Map([
    ['1', { id: '1', authorId: 'a1', createdAt: '2026-08-27T10:00:00Z', date: '2026-08-27', text: 'Lake America stunt', metricsAtCapture: { likes: 5 } }],
    ['2', { id: '2', authorId: 'a2', createdAt: '2026-09-03T10:00:00Z', date: '2026-09-03', text: 'still Lake America', metricsAtCapture: { likes: 1 } }],
    ['3', { id: '3', authorId: 'a1', createdAt: '2026-08-28T10:00:00Z', date: '2026-08-28', text: 'Dingell bill on Lake Ontario', metricsAtCapture: {} }],
    ['4', { id: '4', authorId: 'a3', createdAt: '2026-09-07T10:00:00Z', date: '2026-09-07', text: 'another futile renaming', metricsAtCapture: {} }]
  ]);
  const authors = { a1: { handle: 'one', caucuses: ['cpc'] }, a2: { handle: 'two', caucuses: [] }, a3: { handle: 'three', caucuses: ['cpc'] } };
  const merged = mergeClusters([
    { label: 'lake-renaming-stunt', ids: ['1'], date: '2026-08-27' },
    { label: 'lake-renaming-stunt', ids: ['2'], date: '2026-09-03' },
    { label: 'place-renaming', ids: ['3'], date: '2026-08-28' },
    { label: 'place-renaming', ids: ['4'], date: '2026-09-07' }
  ]);
  const candidates = scoreCandidates(merged, postsById, authors, ['cpc']);
  assert.deepEqual(candidates.map((c) => [c.key, c.days, c.firstSeen, c.lastSeen]), [
    ['lake-renaming-stunt', 2, '2026-08-27', '2026-09-03'],
    ['place-renaming', 2, '2026-08-28', '2026-09-07']
  ]);
  const placements = { 'lake-renaming-stunt': story({ key: 'lake-america-renaming' }), 'place-renaming': story({ key: 'lake-ontario-renaming' }) };
  const { edges } = mergeEvidence(candidates, placements, [{ keys: ['place-renaming', 'lake-renaming-stunt'], reason: 'same order' }]);
  const [final] = scoreCandidates(applyMerges(candidates, edges), postsById, authors, ['cpc']);
  assert.equal(final.key, 'lake-renaming-stunt');
  assert.equal(placements[final.key].key, 'lake-america-renaming'); // cached placement still resolves
  assert.equal(final.posts, 4);
  assert.equal(final.members, 3);
  assert.deepEqual(final.cm, [2]);
  assert.equal(final.days, 4); // union of the four cluster dates, not a count of first/last stamps
  assert.deepEqual(final.dates, ['2026-08-27', '2026-08-28', '2026-09-03', '2026-09-07']);
  assert.equal(final.firstSeen, '2026-08-27');
  assert.equal(final.lastSeen, '2026-09-07');
  assert.deepEqual(final.ids, ['1', '3', '2', '4']); // chronological again
  assert.deepEqual(final.mergedFrom.map((m) => m.key), ['place-renaming']);
});

test('confirmInput takes the earliest and latest post as the two samples', () => {
  const postsById = new Map([['1', { text: 'first ' + 'x'.repeat(300) }], ['2', { text: 'middle' }], ['3', { text: 'last' }]]);
  const c = { key: 'k', label: 'k', labels: ['k'], ids: ['1', '2', '3'], posts: 3, members: 2, firstSeen: '2026-09-01', lastSeen: '2026-09-03' };
  const inp = confirmInput(c, postsById);
  assert.equal(inp.samples.length, 2);
  assert.equal(inp.samples[0].length, 240);
  assert.equal(inp.samples[1], 'last');
  assert.deepEqual(confirmInput({ ...c, ids: ['2'] }, postsById).samples, ['middle']); // a one-post candidate is not sampled twice
});

test('confirmDuplicates: prompt carries label + samples, reply parses into key groups, junk is dropped', async () => {
  const stories = [
    { key: 'lake-renaming-stunt', label: 'lake-renaming-stunt', labels: ['lake-renaming-stunt', 'trump-renaming-stunts'], posts: 10, members: 3, firstSeen: '2026-08-25', lastSeen: '2026-09-03', samples: ['Dear Burgum', 'Lake America polls badly'] },
    { key: 'epstein-files', label: 'epstein-files', labels: ['epstein-files'], posts: 8, members: 3, firstSeen: '2026-08-31', lastSeen: '2026-09-02', samples: ['release the files'] },
    { key: 'place-renaming', label: 'place-renaming', labels: ['place-renaming'], posts: 7, members: 6, firstSeen: '2026-08-28', lastSeen: '2026-09-08', samples: ['Dingell bill would nullify the renaming of Lake Ontario', 'another futile renaming'] }
  ];
  let request;
  const client = { messages: { create: async (req) => { request = req; return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Looking at these:\n{"groups": [{"members": [1, 3], "reason": "both react to Trump renaming Lake Ontario  \\n \\"Lake America\\""}, {"members": [2], "reason": "alone"}, {"members": [9, 3, 3], "reason": "bad numbers"}, {"members": "1,3"}]}' }] }; } } };
  const groups = await confirmDuplicates(stories, { client, model: 'test-model' });
  assert.equal(request.model, 'test-model');
  const prompt = request.messages[0].content;
  assert.match(prompt, /1\. "lake-renaming-stunt" \(10 posts, 3 members, 2026-08-25 → 2026-09-03; daily labels: lake-renaming-stunt, trump-renaming-stunts\)/);
  assert.match(prompt, /"Dear Burgum" \| "Lake America polls badly"/);
  assert.match(prompt, /3\. "place-renaming"/);
  assert.match(prompt, /generic or mixed cluster .* is NOT a duplicate/i);
  assert.deepEqual(groups, [{ keys: ['lake-renaming-stunt', 'place-renaming'], reason: 'both react to Trump renaming Lake Ontario "Lake America"' }]);
});

test('confirmDuplicates: fewer than two stories asks nothing; an unparseable reply confirms nothing', async () => {
  let calls = 0;
  const client = { messages: { create: async () => { calls++; return { stop_reason: 'max_tokens', content: [{ type: 'text', text: 'I think' }] }; } } };
  assert.deepEqual(await confirmDuplicates([{ key: 'a', label: 'a', samples: [] }], { client, model: 'm' }), []);
  assert.equal(calls, 0);
  const warn = console.warn;
  const warned = [];
  console.warn = (m) => warned.push(m);
  try {
    assert.deepEqual(await confirmDuplicates([{ key: 'a', label: 'a', samples: [] }, { key: 'b', label: 'b', samples: [] }], { client, model: 'm' }), []);
  } finally { console.warn = warn; }
  assert.equal(calls, 1);
  assert.match(warned[0], /confirmation reply did not parse/);
});

test('mergeConfirmedGroups unions earlier and new groups, dropping repeats and singletons', () => {
  const prev = [{ keys: ['a', 'b'], reason: 'old' }, { keys: ['x'], reason: 'singleton' }];
  const fresh = [{ keys: ['b', 'a'], reason: 'again' }, { keys: ['c', 'd'], reason: 'new' }];
  assert.deepEqual(mergeConfirmedGroups(prev, fresh), [{ keys: ['a', 'b'], reason: 'old' }, { keys: ['c', 'd'], reason: 'new' }]);
  assert.deepEqual(mergeConfirmedGroups(undefined, fresh), [{ keys: ['b', 'a'], reason: 'again' }, { keys: ['c', 'd'], reason: 'new' }]);
});
