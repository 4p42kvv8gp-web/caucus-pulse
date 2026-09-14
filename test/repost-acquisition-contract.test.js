import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRepostReferences, applyRepostResponse, MAX_REPOST_REFERENCES } from '../src/repost-acquisition-contract.js';

const now = Date.parse('2026-09-14T22:00:00Z');
const fetchedAt = new Date(now).toISOString();
const post = (id, refId, extra = {}) => ({ id, refId, type: 'retweet',
  createdAt: '2026-09-14T21:00:00Z', text: 'RT @reporter: captured wrapper…', ...extra });
const original = (id, extra = {}) => ({ id, text: 'An original source statement.', authorId: '99', ...extra });
const response = (tweets = [], errors = []) => ({ tweets, errors, usage: tweets.length, userReads: 0, raw: { data: [] } });
const terminal = (id, extra = {}) => ({ resource_id: id, resource_type: 'tweet', parameter: 'ids',
  type: 'https://api.x.com/2/problems/resource-not-found', ...extra });

test('selection counts unique recent reposts, orders by support then exact numeric ID, and excludes the 24h boundary', () => {
  const posts = [post('1', '20'), post('2', '20'), post('2', '20'), post('3', '10'), post('4', '2'),
    post('5', '30', { createdAt: '2026-09-13T22:00:00Z' }),
    post('6', '31', { createdAt: '2026-09-14T22:00:00.001Z' }),
    post('7', '32', { createdAt: 'invalid' }), post('8', '33', { type: 'quote' }),
    post('9', 'malformed'), post('not-an-id', '34'), post('11', '35', { createdAt: '2026-09-14T22:00:00Z' })];
  assert.deepEqual(selectRepostReferences(posts, { now }), [
    { id: '20', n: 2 }, { id: '2', n: 1 }, { id: '10', n: 1 }, { id: '35', n: 1 }
  ]);
  assert.deepEqual(selectRepostReferences([...posts].reverse(), { now }), selectRepostReferences(posts, { now }));
});

test('selection skips usable cache/archive, legacy unavailable, lifetime attempts, and originals embedded with other posts', () => {
  const posts = ['10', '20', '30', '40', '50', '60', '70', '80'].map((id, i) => post(String(i + 1), id));
  posts.push(post('90', '50', { createdAt: '2026-09-01T00:00:00Z', reposted: original('50') }));
  posts.push(post('91', '60', { reposted: original('61') })); // matching identity is required
  const quoted = { '10': { text: 'Legacy usable cache has identity from its key.' },
    '20': { unavailable: true }, '70': original('71'), '80': original('80', { text: ' ' }) };
  const calls = [];
  const result = selectRepostReferences(posts, { quoted, now, attemptedIds: new Set(['40']),
    archive: (id) => { calls.push(id); return id === '30' ? original('30') : null; } });
  assert.deepEqual(result, [{ id: '60', n: 2 }, { id: '70', n: 1 }, { id: '80', n: 1 }]);
  assert.ok(!calls.includes('10') && !calls.includes('20') && !calls.includes('40') && !calls.includes('50'));
  assert.equal(calls.filter((id) => id === '60').length, 1, 'archive lookup is cached per original reference');
});

test('selection enforces the hard 25-reference ceiling and propagates local corruption before any acquisition', () => {
  const posts = Array.from({ length: 40 }, (_, i) => post(String(i + 1), String(i + 100)));
  assert.equal(MAX_REPOST_REFERENCES, 25);
  for (const limit of [25, 50, Infinity]) assert.equal(selectRepostReferences(posts, { now, limit }).length, 25);
  assert.equal(selectRepostReferences(posts, { now, limit: 2.9 }).length, 2);
  assert.deepEqual(selectRepostReferences(posts, { now, limit: -1 }), []);
  assert.deepEqual(selectRepostReferences(posts, { now, limit: NaN }), []);
  assert.throws(() => selectRepostReferences(posts, { now, archive: () => { throw new Error('corrupt archive'); } }), /corrupt archive/);
  assert.throws(() => selectRepostReferences(posts, { now: NaN }), /Invalid/);
});

test('applying a response retains full original wording, provenance and timestamps without mutating inputs', () => {
  const text = 'First line.\n' + 'Long-form punctuation and words… '.repeat(300);
  const source = { version: 1, raw: { id: '10', text: 'Short legacy text.', note_tweet: { text } },
    references: [{ id: '90', type: 'quoted' }], urls: [{ expandedUrl: 'https://example.com/source' }] };
  const record = original('10', { text, handle: 'Reporter', createdAt: '2026-09-14T20:00:00Z',
    capturedAt: '2026-09-14T21:59:00Z', source, metrics: { likes: 11, retweets: 7 }, unrelated: 'do not copy' });
  const quoted = { '90': original('90') };
  const saved = response([['10', record], ['999', original('999')]]);
  const before = JSON.stringify({ quoted, saved });
  const result = applyRepostResponse(quoted, ['10', '10', '20'], saved, { fetchedAt });
  assert.deepEqual(result.fetched, ['10']); assert.deepEqual(result.unavailable, []); assert.deepEqual(result.unresolved, ['20']);
  assert.equal(result.quoted['10'].text, text);
  assert.deepEqual(result.quoted['10'].source, source);
  assert.deepEqual(result.quoted['10'].metrics, record.metrics);
  assert.equal(result.quoted['10'].createdAt, record.createdAt);
  assert.equal(result.quoted['10'].capturedAt, record.capturedAt);
  assert.equal(result.quoted['10'].fetchedAt, fetchedAt);
  assert.equal(result.quoted['10'].authorId, '99'); assert.equal(result.quoted['10'].handle, 'Reporter');
  assert.ok(!Object.hasOwn(result.quoted, '999')); assert.ok(!Object.hasOwn(result.quoted['10'], 'unrelated'));
  result.quoted['10'].source.raw.text = 'changed in result'; result.quoted['90'].text = 'changed cached result';
  assert.equal(JSON.stringify({ quoted, saved }), before);
});

test('ambiguous, malformed, mismatched and contradictory rows stay unresolved rather than invented or unavailable', () => {
  const saved = response([
    ['10', original('11')], ['20', original('20', { text: '  ' })], ['30', original('30')],
    ['30', original('30', { text: 'Conflicting original source.' })],
    ['40', { text: 'No exact source ID.' }], ['50', original('50', { unavailable: true })]
  ], [terminal('30')]);
  const result = applyRepostResponse({}, ['10', '20', '30', '40', '50', '60'], saved, { fetchedAt });
  assert.deepEqual(result.fetched, []); assert.deepEqual(result.unavailable, []);
  assert.deepEqual(result.unresolved, ['10', '20', '30', '40', '50', '60']);
  assert.deepEqual(result.quoted, {});
});

test('only explicit per-ID terminal problem types mark observed unavailability; missing parameters are permitted', () => {
  const errors = [terminal('10'), terminal('20', { parameter: undefined }),
    terminal('30', { type: 'https://api.twitter.com/2/problems/not-authorized-for-resource' }),
    terminal('40', { parameter: 'user.fields' }), terminal('50', { resource_type: 'user' }),
    terminal('60', { type: 'https://untrusted.example/2/problems/resource-not-found' }),
    { title: 'Not Found Error', detail: 'Tweet 70 not found' },
    { type: 'https://api.x.com/2/problems/resource-not-found', resource_type: 'tweet', parameter: 'ids', value: '80' }];
  const result = applyRepostResponse({}, ['10', '20', '30', '40', '50', '60', '70', '80'], response([], errors), { fetchedAt });
  assert.deepEqual(result.unavailable, ['10', '20', '30']);
  assert.deepEqual(result.unresolved, ['40', '50', '60', '70', '80']);
  for (const id of result.unavailable) assert.deepEqual(result.quoted[id], { id, unavailable: true, fetchedAt });
});

test('a terminal error accompanied by an ambiguous or transient error for the same ID stays unresolved', () => {
  const errors = [terminal('10'), { resource_id: '10', type: 'https://api.x.com/2/problems/service-unavailable' },
    terminal('20'), { parameter: 'ids', value: '20', detail: 'Temporary failure' },
    terminal('30'), terminal('30', { type: 'https://api.x.com/2/problems/not-authorized-for-resource' })];
  const result = applyRepostResponse({}, ['10', '20', '30'], response([], errors), { fetchedAt });
  assert.deepEqual(result.unresolved, ['10', '20']);
  assert.deepEqual(result.unavailable, ['30']);
});

test('existing complete source cache survives shorter responses, missing rows and terminal errors', () => {
  const quoted = { '10': original('10', { text: 'Existing full original wording.' }),
    '20': { text: 'Legacy cache has no id field but a valid numeric key.' }, '30': original('30') };
  const before = structuredClone(quoted);
  const result = applyRepostResponse(quoted, ['10', '20', '30'],
    response([['10', original('10', { text: 'Shorter…' })]], [terminal('20')]), { fetchedAt });
  assert.deepEqual(result.quoted, before);
  assert.deepEqual(result.fetched, []); assert.deepEqual(result.unavailable, []); assert.deepEqual(result.unresolved, []);
});

test('an empty or mismatched returned row contradicts a terminal error instead of proving unavailability', () => {
  const result = applyRepostResponse({}, ['10', '20'], response([
    ['10', original('10', { text: '' })], ['20', original('999')]
  ], [terminal('10'), terminal('20')]), { fetchedAt });
  assert.deepEqual(result.unavailable, []);
  assert.deepEqual(result.unresolved, ['10', '20']);
});

test('saved-response application requires valid requested IDs and an explicit acquisition timestamp', () => {
  assert.throws(() => applyRepostResponse({}, ['not-a-source-id'], response(), { fetchedAt }), /Invalid/);
  assert.throws(() => applyRepostResponse({}, ['10'], response(), {}), /Invalid/);
  assert.throws(() => applyRepostResponse({}, ['10'], { tweets: {} }, { fetchedAt }), /Invalid/);
  const result = applyRepostResponse({}, ['10'], response([['10', original('10')]]), { fetchedAt });
  assert.equal(result.quoted['10'].capturedAt, fetchedAt);
});
