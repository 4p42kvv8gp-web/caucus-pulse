// Story drill-down helpers (site/ui.js) — pure functions, no DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitRowKey, findRow, decoratePost, rowPosts, rowHeader, parseRowHash, rowHash } from '../site/ui.js';

const scope = (n, m = n, eng = 0) => ({ n, eng, m });
const scopes = (all, cpc = 0, nd = 0, cbc = 0) => ({ All: scope(all), CPC: scope(cpc), NewDem: scope(nd), CBC: scope(cbc), CHC: scope(0), CAPAC: scope(0) });

const data = {
  today: '2026-09-10',
  labels: { immigration: 'Immigration', 'immigration/liam-ramos': 'Liam Ramos / Dilley', 'immigration/border-policy': 'Border policy', economy: 'Economy' },
  authorHandles: { u1: '@RepA', u2: '@RepB', u3: '@RepC' },
  members: {
    '@RepA': ['Rep A', 'CA-01', ['CPC']],
    '@RepB': ['Rep B', 'NY-02', ['NewDem', 'CBC']],
    '@RepC': ['Rep C', 'TX-03', []]
  },
  topics: [{
    key: 'immigration', name: 'Immigration',
    t: scopes(1, 1), w: scopes(4, 1, 2, 2),
    postIds: { t: ['p4'], w: ['p4', 'p3', 'p2', 'p1'] },
    subs: [
      { key: 'liam-ramos', t: scopes(1, 1), w: scopes(2, 1, 1, 1), lead: '@RepA', postIds: { t: ['p4'], w: ['p4', 'p2'] } },
      { key: 'border-policy', t: scopes(0), w: scopes(1, 0, 1, 1), lead: null, postIds: { t: [], w: ['p3'] } }
    ]
  }],
  feedAll: [
    { id: 'p4', authorId: 'u1', createdAt: '2026-09-10T12:00:00.000Z', type: 'tweet', text: 'today', engN: 5, topics: ['immigration/liam-ramos', 'immigration'] },
    { id: 'p3', authorId: 'u2', createdAt: '2026-09-09T12:00:00.000Z', type: 'quote', text: 'quoted', engN: 50, topics: ['immigration/border-policy', 'immigration', 'economy'], quoted: { handle: '@Someone', text: 'the original post' } },
    { id: 'p2', authorId: 'u2', createdAt: '2026-09-08T12:00:00.000Z', type: 'reply', text: 'reply', engN: 7, topics: ['immigration/liam-ramos', 'immigration'] },
    // p1 was trimmed from feedAll (size guard) — still listed on the row.
  ],
  feedAllTruncated: true
};

test('splitRowKey: macro vs macro/sub', () => {
  assert.deepEqual(splitRowKey('immigration'), { macro: 'immigration', sub: null });
  assert.deepEqual(splitRowKey('immigration/liam-ramos'), { macro: 'immigration', sub: 'liam-ramos' });
  assert.deepEqual(splitRowKey(''), { macro: null, sub: null });
});

test('findRow resolves macro and subtopic rows with labels', () => {
  const macro = findRow(data, 'immigration');
  assert.equal(macro.label, 'Immigration');
  assert.equal(macro.sub, null);
  assert.equal(macro.row, data.topics[0]);
  const sub = findRow(data, 'immigration/liam-ramos');
  assert.equal(sub.label, 'Liam Ramos / Dilley');
  assert.equal(sub.topic.key, 'immigration');
  assert.equal(sub.row.key, 'liam-ramos');
  assert.equal(findRow(data, 'immigration/nope'), null);
  assert.equal(findRow(data, 'healthcare'), null);
  assert.equal(findRow(data, null), null);
});

test('decoratePost resolves the author through authorHandles → members and maps type → kind', () => {
  const d = decoratePost(data, data.feedAll[2]);
  assert.equal(d.handle, '@RepB');
  assert.equal(d.member, 'Rep B');
  assert.equal(d.district, 'NY-02');
  assert.deepEqual(d.caucus, ['NewDem', 'CBC']);
  assert.equal(d.kind, 'reply');
  assert.equal(d.time, '2026-09-08T12:00:00.000Z');
  assert.equal(decoratePost(data, { authorId: 'u1', type: 'tweet' }).kind, 'original');
  assert.equal(decoratePost(data, { authorId: 'u1', type: 'retweet' }).kind, 'repost');
  // unknown author: handle falls back to the id, no caucus
  const unknown = decoratePost(data, { authorId: 'u9', type: 'tweet' });
  assert.equal(unknown.handle, 'u9');
  assert.deepEqual(unknown.caucus, []);
  // quoted context passes through untouched
  assert.deepEqual(decoratePost(data, data.feedAll[1]).quoted, { handle: '@Someone', text: 'the original post' });
});

test('rowPosts: every post on a row, newest first, per window', () => {
  assert.deepEqual(rowPosts(data, 'immigration', 'w').map((p) => p.id), ['p4', 'p3', 'p2']); // p1 trimmed → skipped, never faked
  assert.deepEqual(rowPosts(data, 'immigration', 't').map((p) => p.id), ['p4']);
  assert.deepEqual(rowPosts(data, 'immigration/liam-ramos', 'w').map((p) => p.id), ['p4', 'p2']);
  assert.deepEqual(rowPosts(data, 'immigration/liam-ramos', 't').map((p) => p.id), ['p4']);
  assert.deepEqual(rowPosts(data, 'immigration/border-policy', 't'), []);
  assert.deepEqual(rowPosts(data, 'nope', 'w'), []);
  assert.deepEqual(rowPosts(data, 'immigration/nope', 'w'), []);
});

test('rowPosts: caucus scope filters by the resolved member caucuses', () => {
  assert.deepEqual(rowPosts(data, 'immigration', 'w', 'CPC').map((p) => p.id), ['p4']);
  assert.deepEqual(rowPosts(data, 'immigration', 'w', 'NewDem').map((p) => p.id), ['p3', 'p2']);
  assert.deepEqual(rowPosts(data, 'immigration', 'w', 'CBC').map((p) => p.id), ['p3', 'p2']);
  assert.deepEqual(rowPosts(data, 'immigration', 'w', 'CHC'), []);
  assert.deepEqual(rowPosts(data, 'immigration/liam-ramos', 'w', 'NewDem').map((p) => p.id), ['p2']);
});

test('rowPosts: Top sorts by engagement, then newest; Newest ignores engagement', () => {
  assert.deepEqual(rowPosts(data, 'immigration', 'w', 'All', 'Top').map((p) => p.id), ['p3', 'p2', 'p4']);
  assert.deepEqual(rowPosts(data, 'immigration', 'w', 'All', 'Newest').map((p) => p.id), ['p4', 'p3', 'p2']);
  // out-of-order ids on a row still come back newest first
  const shuffled = { ...data, topics: [{ ...data.topics[0], postIds: { t: [], w: ['p2', 'p4', 'p3'] } }] };
  assert.deepEqual(rowPosts(shuffled, 'immigration', 'w').map((p) => p.id), ['p4', 'p3', 'p2']);
});

test('rowPosts returns decorated posts ready for the post card', () => {
  const [p] = rowPosts(data, 'immigration/liam-ramos', 't');
  assert.equal(p.handle, '@RepA');
  assert.equal(p.member, 'Rep A');
  assert.deepEqual(p.caucus, ['CPC']);
  assert.equal(p.kind, 'original');
  assert.equal(p.text, 'today');
});

test('rowHeader: "<label> · N posts · M members" with singulars', () => {
  assert.equal(rowHeader('Liam Ramos / Dilley', 15, 9), 'Liam Ramos / Dilley · 15 posts · 9 members');
  assert.equal(rowHeader('Border policy', 1, 1), 'Border policy · 1 post · 1 member');
  assert.equal(rowHeader('Empty', 0, 0), 'Empty · 0 posts · 0 members');
});

test('URL hash round-trips the selection; window and caucus only when non-default', () => {
  assert.equal(rowHash({ row: 'immigration/liam-ramos', win: 't', caucus: 'All' }), '#row=immigration/liam-ramos');
  assert.equal(rowHash({ row: 'immigration/liam-ramos', win: 'w', caucus: 'CPC' }), '#row=immigration/liam-ramos&win=w&caucus=CPC');
  assert.equal(rowHash({ row: null, win: 'w' }), '');
  assert.equal(rowHash(), '');
  assert.deepEqual(parseRowHash('#row=immigration/liam-ramos'), { row: 'immigration/liam-ramos', win: null, caucus: null });
  assert.deepEqual(parseRowHash('#row=immigration/liam-ramos&win=w&caucus=CPC'), { row: 'immigration/liam-ramos', win: 'w', caucus: 'CPC' });
  assert.deepEqual(parseRowHash('#row=immigration%2Fliam-ramos&win=bogus'), { row: 'immigration/liam-ramos', win: null, caucus: null });
  assert.deepEqual(parseRowHash(''), { row: null, win: null, caucus: null });
  assert.deepEqual(parseRowHash('#report'), { row: null, win: null, caucus: null });
  const sel = { row: 'immigration/liam-ramos', win: 'w', caucus: 'CBC' };
  assert.deepEqual(parseRowHash(rowHash(sel)), sel);
});
