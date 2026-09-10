import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverLanguage, languageData } from '../src/language.js';
import { openStore } from '../src/db.js';
import { normalizePost } from '../src/normalize.js';
import { createServer } from '../src/server.js';

function post(id, text, extra = {}) {
  return { ...normalizePost({ id, author_id: '123', created_at: '2026-09-07T23:50:00Z', text }),
    memberId: `synthetic-${id}`, memberName: 'Synthetic Test Member', ...extra };
}
function phrases(result) { return result.groups.map(g => g.phrase).sort(); }
function verifySpans(result) {
  const sources = new Map(result.sources.map(s => [s.id, s]));
  for (const group of result.groups) for (const occurrence of group.occurrences) {
    const source = sources.get(occurrence.postId);
    assert.equal(source.text.slice(occurrence.start, occurrence.end), group.phrase);
    assert.equal(source.sourceHash, occurrence.sourceHash);
  }
}

test('automatic discovery preserves longer wording, negation, punctuation and Unicode offsets', () => {
  const phrase = 'We will not be silent about the library — our doors remain open';
  const result = discoverLanguage([post('1', `📰 ${phrase}.`), post('2', `Update: ${phrase}!`)]);
  assert.ok(phrases(result).includes(phrase));
  assert.ok(result.groups.find(g => g.phrase === phrase).wordCount > 4);
  assert.equal(result.coverage.partial, false);
  verifySpans(result);
  const long = 'These complete words remain in the source. '.repeat(200) + 'End of this repeated passage';
  const longer = discoverLanguage([post('3', long), post('4', long)]);
  assert.ok(longer.groups.some(g => g.phrase.length > 2000));
  verifySpans(longer);
});

test('different spacing, case, punctuation and negation are never silently normalized into agreement', () => {
  const a = 'We will not close the library';
  const b = 'We will close the library';
  const result = discoverLanguage([post('1', a), post('2', b)]);
  assert.equal(phrases(result).includes(a), false);
  assert.ok(phrases(result).includes('close the library'));
  assert.match(result.note, /not agreement/);
  assert.deepEqual(phrases(discoverLanguage([post('1', 'Red blue green'), post('2', 'red blue green')])), []);
  assert.deepEqual(phrases(discoverLanguage([post('1', 'red blue green'), post('2', 'red  blue green')])), []);
  assert.deepEqual(phrases(discoverLanguage([post('1', 'red, blue green'), post('2', 'red; blue green')])), []);
  verifySpans(result);
});

test('longer common passages suppress redundant suffixes while a shorter phrase with wider use remains', () => {
  const result = discoverLanguage([post('1', 'The library opens for everyone today.'),
    post('2', 'The library opens for everyone today!'), post('3', 'Notice: library opens for everyone tomorrow.')]);
  assert.ok(phrases(result).includes('The library opens for everyone today'));
  assert.ok(phrases(result).includes('library opens for everyone'));
  assert.equal(phrases(result).includes('opens for everyone'), false);
  assert.equal(result.groups.find(g => g.phrase === 'library opens for everyone').matchingPosts, 3);
  verifySpans(result);
});

test('duplicate delivery and repeated occurrences do not inflate post or member counts; reposts stay separate', () => {
  const one = post('1', 'Our library doors stay open. Our library doors stay open.', { memberId: 'same-member' });
  const two = post('2', 'Notice: Our library doors stay open.', { memberId: 'same-member', type: 'quote' });
  const result = discoverLanguage([one, one, two, post('3', two.text, { type: 'repost' })]);
  const group = result.groups.find(g => g.phrase === 'Our library doors stay open');
  assert.equal(group.matchingPosts, 2); assert.equal(group.distinctMembers, 1); assert.equal(group.occurrenceCount, 3);
  assert.equal(result.coverage.excludedReposts, 1);
  assert.ok(group.occurrences.some(o => o.wordingRole === 'quote-post-caption'));
  assert.equal(discoverLanguage([one, two], { minMembers: 2 }).groups.length, 0);
  assert.equal(discoverLanguage([one, one]).groups.length, 0);
  assert.equal(discoverLanguage([one, post('3', two.text, { type: 'repost' })]).groups.length, 0);
  verifySpans(result);
});

test('discovery does not invent phrases across links or source boundaries; full text keeps links', () => {
  const result = discoverLanguage([post('1', 'red blue https://example.test/same green yellow'), post('2', 'red blue https://example.test/same green yellow')]);
  assert.deepEqual(phrases(result), []);
  assert.match(result.sources[0].text, /https:/);
  const boundaries = discoverLanguage([post('1', 'red blue'), post('2', 'green yellow'), post('3', 'red blue green yellow')]);
  assert.deepEqual(phrases(boundaries), []);
});

test('work limits omit whole posts or unfinished groups and explicitly disclose incomplete discovery', () => {
  const posts = [post('1', 'Our library doors stay open.'), post('2', 'Our library doors stay open.'), post('3', 'Our library doors stay open.')];
  const limited = discoverLanguage(posts, { limits: { posts: 2 } });
  assert.equal(limited.coverage.omittedPosts, 1); assert.equal(limited.coverage.partial, true);
  assert.equal(limited.groups[0].matchingPosts, 2);
  assert.equal(limited.sources[0].text, posts[0].text);
  const tiny = discoverLanguage(posts, { limits: { tokens: 2 } });
  assert.equal(tiny.coverage.omittedPosts, 3); assert.deepEqual(tiny.groups, []);
  const stopped = discoverLanguage(posts, { limits: { scanCharacters: 5 } });
  assert.equal(stopped.coverage.scanLimitReached, true); assert.deepEqual(stopped.groups, []);
  const occurrences = discoverLanguage(posts, { limits: { occurrencesPerGroup: 1 } });
  assert.equal(occurrences.groups[0].occurrenceCount, 3);
  assert.equal(occurrences.groups[0].occurrencesOmitted, 2);
  const outputLimited = discoverLanguage(posts, { limits: { responseCharacters: 20 } });
  assert.equal(outputLimited.coverage.responseLimitReached, true);
  assert.deepEqual(outputLimited.sources, []); assert.deepEqual(outputLimited.groups, []);
  assert.throws(() => discoverLanguage(posts, { limits: { posts: 10000 } }), /resource limit/);
  assert.throws(() => discoverLanguage(posts, { limit: 101 }), /phrase limit/);
});

test('database discovery limits memory without truncating source storage', () => {
  const store = openStore();
  try {
    store.upsertAccount({ authorId:'123', memberId:'synthetic', memberName:'Synthetic Member', handle:'SyntheticOnly' });
    const huge = 'Extensive source wording. '.repeat(40000);
    store.ingest(normalizePost({ id:'1', author_id:'123', created_at:'2026-09-07T12:00:00Z', text:huge }));
    const result = languageData(store, {}, { now:Date.parse('2026-09-07T13:00:00Z') });
    assert.equal(result.coverage.omittedPosts, 1); assert.equal(result.coverage.partial, true);
    assert.deepEqual(result.sources, []);
    assert.equal(store.db.prepare('SELECT text FROM posts WHERE id=?').get('1').text, huge);
  } finally { store.close(); }
});

test('a rolling selection crosses midnight and uses stored member attribution and current corrections', () => {
  const store = openStore();
  try {
    store.upsertAccount({ authorId: '123', memberId: 'one-member', memberName: 'Synthetic Member', handle: 'SyntheticOnly' });
    store.upsertAccount({ authorId: '124', memberId: 'one-member', memberName: 'Synthetic Member', handle: 'SyntheticSecond' });
    const text = 'Our library doors stay open.';
    for (const [id, at, author] of [['1','2026-09-07T23:50:00Z','123'],['2','2026-09-08T00:10:00Z','124'],['3','2026-09-06T10:00:00Z','123']])
      store.ingest(normalizePost({ id, author_id: author, created_at: at, text }));
    store.analyzePending();
    const now = Date.parse('2026-09-08T00:30:00Z');
    const result = languageData(store, {}, { now });
    assert.equal(result.coverage.selectedPosts, 2);
    assert.equal(result.groups[0].distinctMembers, 1);
    assert.equal(result.groups[0].firstObservedInSelection, '2026-09-07T23:50:00.000Z');
    assert.deepEqual(result.groups[0].occurrences.map(o => o.postId), ['1','2']);
    assert.equal(languageData(store, { since:'2026-09-08T00:00:00Z' }, { now }).groups.length, 0);
    store.saveFeedback('1', { labels: [{ topic:'Community services', subtopic:'Library' }], reason:'Synthetic review only.' }, 'synthetic-reviewer');
    store.saveFeedback('2', { labels: [{ topic:'Community services', subtopic:'Library' }], reason:'Synthetic review only.' }, 'synthetic-reviewer');
    assert.equal(languageData(store, { topic:'Community services', subtopic:'Library' }, { now }).groups.length, 1);
    assert.equal(languageData(store, { subtopic:'Different facility' }, { now }).groups.length, 0);
    assert.equal(languageData(store, { query: "' OR 1=1 --" }, { now }).coverage.selectedPosts, 0);
    assert.throws(() => languageData(store, { since:'2025-01-01' }, { now }), /date window/);
  } finally { store.close(); }
});

test('edited and removed sources disappear from recomputed groups without a stale phrase cache', () => {
  const store = openStore();
  try {
    store.upsertAccount({ authorId:'123', memberId:'synthetic', memberName:'Synthetic Member', handle:'SyntheticOnly' });
    for (const id of ['1','2']) store.ingest(normalizePost({ id, author_id:'123', created_at:'2026-09-07T12:00:00Z', text:'Our library doors stay open.' }));
    const now = Date.parse('2026-09-07T13:00:00Z');
    assert.equal(languageData(store, {}, { now }).groups.length, 1);
    store.ingest(normalizePost({ id:'2', author_id:'123', created_at:'2026-09-07T12:00:00Z', text:'An unrelated notice.' }));
    assert.equal(languageData(store, {}, { now }).groups.length, 0);
    store.removePost('1');
    assert.equal(languageData(store, {}, { now }).sources.some(s => s.id === '1'), false);
  } finally { store.close(); }
});

test('maximal passages agree with an exhaustive small-corpus oracle', () => {
  let seed = 42;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let trial = 0; trial < 70; trial++) {
    const posts = Array.from({ length: 3 }, (_, i) => post(String(i + 1), Array.from({ length: 7 }, () => ['red','blue','green'][random(3)]).join([' ', '  ', ', '][random(3)])));
    const all = new Map();
    for (const p of posts) {
      const words = [...p.text.matchAll(/[a-z]+/g)];
      for (let i = 0; i < words.length; i++) for (let j = i + 1; j < words.length; j++) {
        const end = words[j].index + words[j][0].length;
        const phrase = p.text.slice(words[i].index, end);
        const occurrence = { id:p.id,
          left:i ? p.text.slice(words[i - 1].index, words[i].index) : `start-${p.id}`,
          right:j + 1 < words.length ? p.text.slice(end, words[j + 1].index + words[j + 1][0].length) : `end-${p.id}` };
        if (!all.has(phrase)) all.set(phrase, []); all.get(phrase).push(occurrence);
      }
    }
    const expected = [...all].filter(([, list]) => new Set(list.map(o => o.id)).size >= 2 &&
      new Set(list.map(o => o.left)).size >= 2 && new Set(list.map(o => o.right)).size >= 2).map(([phrase]) => phrase).sort();
    const actual = discoverLanguage(posts, { minWords:2, limit:100 });
    assert.deepEqual(phrases(actual), expected, `Synthetic trial ${trial}`);
    verifySpans(actual);
  }
});

test('the local language endpoint supplies source spans and rejects invalid or oversized options', async () => {
  const store = openStore();
  store.upsertAccount({ authorId:'123', memberId:'synthetic', memberName:'Synthetic Member', handle:'SyntheticOnly' });
  for (const id of ['1','2']) store.ingest(normalizePost({ id, author_id:'123', created_at:'2026-09-07T12:00:00Z', text:'Our library doors stay open.' }));
  const server = createServer(store);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  try {
    const params = new URLSearchParams({ since:'2026-09-07T00:00:00Z', until:'2026-09-08T00:00:00Z' });
    const response = await fetch(`${root}/api/language?${params}`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.groups[0].matchingPosts, 2); verifySpans(data);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    for (const query of ['minWords=0','limit=101','windowHours=10000','minMembers=abc','since=bad','type=unknown']) {
      assert.equal((await fetch(`${root}/api/language?${query}`)).status, 400);
    }
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM budget_requests').get().n, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM feedback').get().n, 0);
  } finally { await new Promise(resolve => server.close(resolve)); store.close(); }
});
