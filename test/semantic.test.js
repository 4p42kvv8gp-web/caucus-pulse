import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndex, cosine } from '../src/embedding-index.js';
import { normalise } from '../src/embeddings.js';
import { centroid, effectivePlacement, buildStories, createSemantic } from '../src/semantic.js';

// embed() is stubbed throughout: no model download, no network.
const unit = (...xs) => normalise(Float32Array.from(xs));

test('centroid is the normalised mean and ignores missing vectors', () => {
  const c = centroid([unit(1, 0, 0, 0), unit(0, 1, 0, 0), null]);
  assert.ok(Math.abs(c[0] - Math.SQRT1_2) < 1e-6 && Math.abs(c[1] - Math.SQRT1_2) < 1e-6);
  assert.equal(c[2], 0);
  assert.equal(centroid([]), null);
  assert.equal(centroid([null]), null);
  // three copies of the same vector do not move the centroid
  assert.ok(cosine(centroid([unit(3, 4, 0, 0), unit(3, 4, 0, 0), unit(3, 4, 0, 0)]), unit(3, 4, 0, 0)) > 0.99999);
});

test('effectivePlacement follows mergeInto chains and tolerates cycles', () => {
  const placements = {
    a: { key: 'a', kind: 'story', mergeInto: 'b' },
    b: { key: 'b-story', kind: 'story', mergeInto: null },
    x: { key: 'x', kind: 'gap', mergeInto: 'y' },
    y: { key: 'y', kind: 'gap', mergeInto: 'x' }
  };
  assert.equal(effectivePlacement(placements, 'a').key, 'b-story');
  assert.equal(effectivePlacement(placements, 'b').key, 'b-story');
  assert.ok(['x', 'y'].includes(effectivePlacement(placements, 'x').key));
  assert.equal(effectivePlacement(placements, 'nope'), null);
  assert.equal(effectivePlacement(undefined, 'a'), null);
});

test('buildStories merges taxonomy story rows (assignments + anchors) with story candidates', () => {
  const taxonomy = {
    tech: { label: 'Technology', subtopics: {
      'ai-policy': { label: 'AI policy' },
      'coxon-resignation': { label: 'Coxon resignation', story: true, since: '2026-09-09', anchors: ['2097476196791709843'] }
    } },
    immigration: { label: 'Immigration', subtopics: { 'liam-ramos': { label: 'Liam Ramos', story: true } } }
  };
  const topics = [
    { date: '2026-09-09', assignments: {
      p1: [['tech', 'coxon-resignation']],
      p2: [['tech', 'ai-policy']],                       // generic sibling, not the story
      p3: [['immigration', 'liam-ramos'], ['tech', null]],
      p4: [['tech', 'coxon-resignation'], ['tech', 'coxon-resignation']]
    } }
  ];
  const posts = [
    { id: 'q1', refId: '2097476196791709843', text: 'quote of the anchor without naming anyone' },
    { id: '2097476196791709843', refId: null, text: 'the anchor itself, if captured' },
    { id: 'p2', refId: 'other', text: '' }
  ];
  const stories = {
    placements: {
      'celebrity-tribute': { key: 'dolly-parton-tribute', label: 'Dolly Parton tribute', kind: 'story', macro: null, mergeInto: null },
      'dolly-parton-death': { key: 'dolly-parton-death', label: 'Dolly death', kind: 'story', mergeInto: 'celebrity-tribute' },
      'data-centers': { key: 'data-centers', label: 'Data centers', kind: 'gap', mergeInto: null },
      'tiny': { key: 'tiny', label: 'Tiny', kind: 'story', mergeInto: null }
    },
    candidates: [
      { key: 'celebrity-tribute', ids: ['d1', 'd2', 'd3'] },
      { key: 'dolly-parton-death', ids: ['d3', 'd4', 'd5'] },
      { key: 'data-centers', ids: ['g1', 'g2', 'g3', 'g4'] },   // a gap is not a story
      { key: 'tiny', ids: ['t1', 't2'] },                        // below the floor
      { key: 'unplaced', ids: ['u1', 'u2', 'u3'] }
    ]
  };
  const out = buildStories({ taxonomy, stories, topics, posts, minCandidatePosts: 3 });
  assert.deepEqual([...out.keys()].sort(), ['coxon-resignation', 'dolly-parton-tribute', 'liam-ramos']);
  const coxon = out.get('coxon-resignation');
  assert.equal(coxon.macro, 'tech');
  assert.equal(coxon.since, '2026-09-09');
  assert.deepEqual([...coxon.source], ['taxonomy']);
  assert.deepEqual([...coxon.ids].sort(), ['2097476196791709843', 'p1', 'p4', 'q1']);
  assert.deepEqual([...out.get('liam-ramos').ids], ['p3']);
  const dolly = out.get('dolly-parton-tribute');
  assert.equal(dolly.label, 'Dolly Parton tribute');
  assert.deepEqual([...dolly.source], ['candidate']);
  assert.deepEqual([...dolly.ids].sort(), ['d1', 'd2', 'd3', 'd4', 'd5']);
  // no sources at all is fine
  assert.equal(buildStories({}).size, 0);
});

function fixture() {
  // 4-d toy space: axis 0 = AI safety, axis 1 = tributes, axis 2 = immigration.
  const index = createIndex({ dim: 4, model: 'stub' });
  index.upsert(
    ['ai1', 'ai2', 'ai-miss', 'ai-far', 'trib1', 'trib2', 'imm1'],
    [unit(1, 0, 0, 0), unit(0.95, 0.05, 0, 0), unit(0.9, 0, 0.1, 0), unit(0.6, 0, 0.8, 0), unit(0, 1, 0, 0), unit(0.05, 0.95, 0, 0), unit(0, 0, 1, 0)]
  );
  const stories = new Map([
    ['coxon', { key: 'coxon', label: 'Coxon resignation', macro: 'tech', since: null, source: new Set(['taxonomy']), ids: new Set(['ai1', 'ai2', 'not-indexed']), anchors: new Set() }],
    ['dolly', { key: 'dolly', label: 'Dolly Parton tribute', macro: null, since: null, source: new Set(['candidate']), ids: new Set(['trib1', 'trib2']), anchors: new Set() }],
    ['empty', { key: 'empty', label: 'No indexed posts', macro: null, since: null, source: new Set(), ids: new Set(['nope']), anchors: new Set() }]
  ]);
  const posts = [
    { id: 'ai-miss', authorId: 'u1', createdAt: '2026-09-09T20:58:00.000Z', type: 'quote', refId: 'x', text: 'Another AI wakeup call for Congress' },
    { id: 'ai-far', authorId: 'u2', createdAt: '2026-09-08T00:00:00.000Z', type: 'tweet', refId: null, text: 'AI data centers and utility bills' },
    { id: '2097000000000000099', authorId: 'u3', createdAt: '2026-09-10T00:00:00.000Z', type: 'tweet', refId: null, text: 'fresh post about AI safety' }
  ];
  const calls = [];
  const embed = async (texts, opts = {}) => {
    calls.push({ texts, opts });
    return texts.map((t) => (/AI/.test(t) ? unit(1, 0, 0, 0) : unit(0, 1, 0, 0)));
  };
  return { sem: createSemantic({ index, stories, posts, embed }), calls };
}

test('relatedPosts returns near posts that are NOT assigned, decorated from the archive', () => {
  const { sem } = fixture();
  const hits = sem.relatedPosts('coxon', { k: 10, minSim: 0.5 });
  assert.deepEqual(hits.map((h) => h.id), ['ai-miss', 'ai-far']);   // ai1/ai2 excluded: assigned
  assert.ok(hits[0].sim > hits[1].sim);
  assert.equal(hits[0].text, 'Another AI wakeup call for Congress');
  assert.equal(hits[0].createdAt, '2026-09-09T20:58:00.000Z');
  // a tighter threshold drops the far one
  assert.deepEqual(sem.relatedPosts('coxon', { minSim: 0.9 }).map((h) => h.id), ['ai-miss']);
  // excludeAssigned: false ranks the assigned posts themselves first
  assert.deepEqual(sem.relatedPosts('coxon', { minSim: 0.5, excludeAssigned: false }).map((h) => h.id).slice(0, 2).sort(), ['ai1', 'ai2']);
  // k caps
  assert.equal(sem.relatedPosts('coxon', { k: 1, minSim: 0 }).length, 1);
  // no indexed posts → no centroid → nothing, not a crash
  assert.deepEqual(sem.relatedPosts('empty'), []);
  assert.throws(() => sem.relatedPosts('nonexistent'), /unknown story/);
  // list() reports assigned vs indexed counts
  const row = sem.list().find((s) => s.key === 'coxon');
  assert.equal(row.posts, 3);
  assert.equal(row.indexed, 2);
});

test('relatedStories accepts an indexed id, an archived-but-unindexed id, a vector, or free text', async () => {
  const { sem, calls } = fixture();
  // indexed id: no embed call
  let hits = await sem.relatedStories('ai-miss', { minSim: 0.5 });
  assert.deepEqual(hits.map((h) => h.story), ['coxon']);
  assert.equal(calls.length, 0);
  // an archived id that is not in the index yet is embedded from its text
  hits = await sem.relatedStories('2097000000000000099', { minSim: 0.5 });
  assert.equal(hits[0].story, 'coxon');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.query, undefined);
  // free text goes through the query instruction
  hits = await sem.relatedStories('remembering a country music legend', { k: 3, minSim: 0.5 });
  assert.equal(hits[0].story, 'dolly');
  assert.equal(calls[1].opts.query, true);
  // a raw vector works and ranks both stories when the threshold allows
  hits = await sem.relatedStories([1, 1, 0, 0], { minSim: 0 });
  assert.deepEqual(hits.map((h) => h.story).sort(), ['coxon', 'dolly']);
  assert.equal(hits.find((h) => h.story === 'coxon').posts, 3);
  // k and minSim
  assert.equal((await sem.relatedStories([1, 1, 0, 0], { k: 1, minSim: 0 })).length, 1);
  assert.deepEqual(await sem.relatedStories([0, 0, 0, 1], { minSim: 0.5 }), []);
  await assert.rejects(() => sem.relatedStories('99999999999999999999'), /neither in the index nor the archive/);
});

test('nearSeed excludes the seed itself and any extra exclusions', () => {
  const { sem } = fixture();
  const r = sem.nearSeed(['ai1', 'ai2', 'missing'], { k: 5, minSim: 0.5 });
  assert.equal(r.indexed, 2);
  assert.deepEqual(r.hits.map((h) => h.id), ['ai-miss', 'ai-far']);
  const r2 = sem.nearSeed(['ai1'], { k: 5, minSim: 0.5, exclude: new Set(['ai-far']) });
  assert.deepEqual(r2.hits.map((h) => h.id), ['ai2', 'ai-miss']);
  assert.deepEqual(sem.nearSeed(['missing']).hits, []);
});
