import test from 'node:test';
import assert from 'node:assert/strict';
import { attachRelated } from '../src/sitedata.js';

// The semantic layer is a stub: it returns a fixed ranked list per story or
// seed and honours the exclude predicate the site builder hands it, which
// is what the builder's window / retweet / already-labeled rules rely on.
function stubSemantic({ stories = {}, byStory = {}, bySeed = () => [], throwFor = null } = {}) {
  const calls = [];
  const filter = (hits, { k, minSim, exclude }) => hits
    .filter((h) => h.sim >= minSim && !(exclude instanceof Set ? exclude.has(h.id) : exclude?.(h.id)))
    .slice(0, k);
  return {
    calls,
    story: (key) => stories[key] || null,
    storyKeyFor(macro, sub) {
      if (stories[`${macro}/${sub}`]) return `${macro}/${sub}`;
      return stories[sub]?.macro === macro ? sub : null;
    },
    relatedPosts(key, opts) {
      calls.push({ fn: 'relatedPosts', key, opts });
      if (key === throwFor) throw new Error('boom');
      return filter(byStory[key] || [], opts);
    },
    nearSeed(ids, opts) {
      calls.push({ fn: 'nearSeed', ids, opts });
      return { hits: filter(bySeed(ids), opts) };
    }
  };
}

const tax = {
  tech: { label: 'Technology', subtopics: { 'ai-policy': { label: 'AI policy' }, 'coxon-resignation': { label: 'Coxon resignation', story: true } } },
  democracy: { label: 'Democracy', subtopics: { 'epstein-files': { label: 'Epstein files', story: true } } }
};

const long = 'x'.repeat(230);
const posts = [
  { id: 'w1', authorId: 'u1', type: 'quote', createdAt: '2026-09-09T20:58:00.000Z', text: 'Another AI wakeup call for Congress', topics: [['tech', null]] },
  { id: 'w2', authorId: 'u2', type: 'tweet', createdAt: '2026-09-09T21:00:00.000Z', text: `${long} tail`, topics: [] },
  { id: 'rt', authorId: 'u3', type: 'retweet', createdAt: '2026-09-09T21:01:00.000Z', text: 'RT @u1: Another AI wakeup call', topics: [['tech', null]] },
  { id: 'lab', authorId: 'u4', type: 'tweet', createdAt: '2026-09-09T21:02:00.000Z', text: 'live-tagged with the story already', topics: [['tech', 'coxon-resignation']] },
  { id: 'd1', authorId: 'u5', type: 'tweet', createdAt: '2026-09-09T21:03:00.000Z', text: 'Dolly was a phenomenal Tennessean', topics: [] }
];
const handleOf = (a) => ({ u1: '@one', u2: '@two', u4: '@four', u5: '@five' })[a] || null;

function fixture() {
  return {
    clusters: [
      { label: 'Dolly Parton tribute', suggest: 'dolly-parton-tribute', kind: 'story', macro: null },
      { label: 'Data centers', suggest: 'data-centers', kind: 'gap', macro: 'economy' }
    ],
    topics: [
      { key: 'tech', subs: [{ key: 'ai-policy' }, { key: 'coxon-resignation' }] },
      { key: 'democracy', subs: [{ key: 'epstein-files' }] },
      { key: 'economy', subs: [] }
    ]
  };
}

test('attachRelated decorates emerging cards and story rows from the window, excluding retweets, out-of-window and already-labeled posts', () => {
  const { clusters, topics } = fixture();
  const seeds = new Map([[clusters[1], ['g1', 'g2']]]);
  const sem = stubSemantic({
    stories: { 'dolly-parton-tribute': { key: 'dolly-parton-tribute', macro: null }, 'coxon-resignation': { key: 'coxon-resignation', macro: 'tech' } },
    byStory: {
      'coxon-resignation': [{ id: 'w1', sim: 0.9123 }, { id: 'rt', sim: 0.9 }, { id: 'lab', sim: 0.89 }, { id: 'old', sim: 0.88 }, { id: 'w2', sim: 0.81 }, { id: 'd1', sim: 0.5 }],
      'dolly-parton-tribute': [{ id: 'd1', sim: 0.95 }, { id: 'rt', sim: 0.9 }]
    },
    bySeed: (ids) => ids.join() === 'g1,g2' ? [{ id: 'w2', sim: 0.86 }, { id: 'nope', sim: 0.85 }] : []
  });
  const warnings = [];
  const counts = attachRelated({ clusters, seeds, topics, tax, posts, semantic: sem, k: 5, minSim: 0.8, handleOf, warn: (m) => warnings.push(m) });
  assert.deepEqual(counts, { clusters: 2, subs: 1 });
  assert.deepEqual(warnings, []);

  // story cluster → relatedPosts on the story; gap cluster → nearSeed on its own posts
  assert.deepEqual(clusters[0].related, [{ id: 'd1', sim: 0.95, handle: '@five', text: 'Dolly was a phenomenal Tennessean', time: '2026-09-09T21:03:00.000Z', topics: [] }]);
  assert.deepEqual(clusters[1].related.map((r) => r.id), ['w2']);
  assert.equal(clusters[1].related[0].text.length, 200);                 // trimmed on a word boundary + ellipsis
  assert.ok(clusters[1].related[0].text.endsWith('…'));
  assert.deepEqual(sem.calls.find((c) => c.fn === 'nearSeed').ids, ['g1', 'g2']);
  assert.equal(sem.calls.find((c) => c.fn === 'nearSeed').opts.k, 5);

  // story row: the retweet, the out-of-window id and the already-labeled post are gone; the bare-macro post stays
  const coxon = topics[0].subs[1];
  assert.deepEqual(coxon.related.map((r) => r.id), ['w1', 'w2']);
  assert.deepEqual(coxon.related[0], { id: 'w1', sim: 0.9123, handle: '@one', text: 'Another AI wakeup call for Congress', time: '2026-09-09T20:58:00.000Z', topics: ['tech'] });
  // a generic subtopic and a story the layer does not know get nothing
  assert.equal(topics[0].subs[0].related, undefined);
  assert.equal(topics[1].subs[0].related, undefined);
  // nothing besides `related` was added to the objects the dashboard reads
  assert.deepEqual(Object.keys(clusters[0]), ['label', 'suggest', 'kind', 'macro', 'related']);
});

test('attachRelated is a no-op without the layer and survives a failing story', () => {
  const { clusters, topics } = fixture();
  assert.deepEqual(attachRelated({ clusters, topics, tax, posts, semantic: null }), { clusters: 0, subs: 0 });
  assert.equal(clusters[0].related, undefined);
  assert.equal(topics[0].subs[1].related, undefined);

  const sem = stubSemantic({
    stories: { 'coxon-resignation': { key: 'coxon-resignation', macro: 'tech' } },
    throwFor: 'coxon-resignation'
  });
  const warnings = [];
  const counts = attachRelated({ clusters, seeds: new Map(), topics, tax, posts, semantic: sem, handleOf, warn: (m) => warnings.push(m) });
  assert.deepEqual(counts, { clusters: 0, subs: 0 });
  assert.deepEqual(topics[0].subs[1].related, []);
  assert.deepEqual(clusters.map((c) => c.related), [[], []]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /tech\/coxon-resignation skipped: boom/);
  // k = 0 attaches nothing
  const again = fixture();
  assert.deepEqual(attachRelated({ ...again, posts, semantic: sem, k: 0 }), { clusters: 0, subs: 0 });
  assert.equal(again.clusters[0].related, undefined);
});
