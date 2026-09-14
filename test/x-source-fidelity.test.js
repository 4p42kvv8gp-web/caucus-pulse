import test from 'node:test';
import assert from 'node:assert/strict';
import { textOf, sourceEnvelope, toRecord, quotedFromIncludes, lookupTweets, listTweetsPage, userTweetsPage, searchRecent } from '../src/x.js';
const capturedAt = '2026-09-14T14:00:00Z';
const createdAt = '2026-09-14T13:00:00Z';
const longText = `  A complete statement with Unicode: niño 🏛️.\n${'Details and qualifications. '.repeat(90)}Final sentence: the allegation is unverified.  `;
const link = { start: 42, end: 65, url: 'https://t.co/abc', expanded_url: 'https://example.org/story?x=1&y=2', unwound_url: 'https://example.org/story', display_url: 'example.org/story', title: 'A linked article', description: 'A source description' };
const raw = (extra = {}) => ({ id: '123', author_id: '456', text: 'Short preview… https://t.co/abc', created_at: createdAt, lang: 'en', public_metrics: { like_count: 3 }, ...extra });

test('long-form text preserves every character while retaining the exact short source and entity metadata', () => {
  const input = raw({ note_tweet: { text: longText, entities: { urls: [link], hashtags: [{ tag: 'Evidence', start: 0, end: 9 }] } }, entities: { urls: [link] }, conversation_id: '100', edit_history_tweet_ids: ['122', '123'] });
  const before = structuredClone(input);
  const record = toRecord(input, capturedAt);
  assert.equal(record.text, longText);
  assert.equal(record.source.textField, 'note_tweet.text');
  assert.equal(record.source.url, 'https://x.com/i/web/status/123');
  assert.deepEqual(record.source.raw.note_tweet, input.note_tweet);
  assert.deepEqual(record.source.raw.entities, input.entities);
  assert.equal(record.source.raw.text, input.text);
  assert.equal(record.source.raw.conversation_id, '100');
  assert.deepEqual(record.source.raw.edit_history_tweet_ids, ['122', '123']);
  assert.equal(record.source.urls.find((u) => u.field === 'note_tweet.entities').expandedUrl, link.expanded_url);
  assert.deepEqual(input, before);
  input.note_tweet.entities.urls[0].expanded_url = 'https://example.net/changed';
  assert.equal(record.source.raw.note_tweet.entities.urls[0].expanded_url, 'https://example.org/story?x=1&y=2');
});

test('short posts retain legacy field values and need no archive migration', () => {
  const record = toRecord(raw({ text: 'ordinary short post' }), capturedAt);
  const { source, ...legacy } = record;
  assert.deepEqual(legacy, { id: '123', authorId: '456', createdAt, type: 'tweet', refId: null, lang: 'en', text: 'ordinary short post', capturedAt, metricsAtCapture: { likes: 3, retweets: 0, replies: 0, quotes: 0 } });
  assert.equal(source.textField, 'text');
  assert.equal(source.raw.text, legacy.text);
});

test('missing, empty, or malformed long text falls back without string coercion', () => {
  for (const note_tweet of [undefined, null, {}, [], 'wrong shape', { text: 123 }, { text: '' }, { text: ' \n ' }]) {
    const record = toRecord(raw({ note_tweet }), capturedAt);
    assert.equal(record.text, raw().text);
    assert.equal(record.source.textField, 'text');
  }
  assert.equal(textOf({ text: { content: 'not text' } }), '');
  assert.equal(textOf(raw({ note_tweet: { text: 'valid old dialect' }, note_post: { text: 'new dialect' } })), 'valid old dialect');
  const alternate = toRecord(raw({ note_post: { text: longText } }), capturedAt);
  assert.equal(alternate.text, longText);
  assert.equal(alternate.source.textField, 'note_post.text');
});

for (const type of ['quoted', 'replied_to']) test(`${type} preserves the referenced author's full wording and actual timestamp separately`, () => {
  const original = raw({ id: '100', author_id: '200', created_at: '2026-09-14T10:00:00Z', note_tweet: { text: longText, entities: { urls: [link] } } });
  const includes = { tweets: [original], users: [{ id: '200', username: 'SourceAccount' }] };
  const record = toRecord(raw({ text: 'My own reaction.', referenced_tweets: [{ type, id: '100' }] }), capturedAt, includes);
  assert.equal(record.text, 'My own reaction.');
  assert.equal(record.quoted.text, longText);
  assert.equal(record.quoted.createdAt, original.created_at);
  assert.equal(record.quoted.source.raw.note_tweet.text, longText);
  assert.equal(record.source.references[0].createdAt, original.created_at);
  assert.equal(record.source.references[0].source.raw.note_tweet.text, longText);
  assert.equal(record.source.references[0].source.references.length, 0);
  assert.equal(record.quoted.source.urls[0].expandedUrl, link.expanded_url);
});

test('all direct references survive even when the legacy record chooses a single primary reference', () => {
  const includes = { tweets: [raw({ id: '100', note_tweet: { text: longText }, referenced_tweets: [{ type: 'quoted', id: '123' }] }), raw({ id: '101' })] };
  const refs = [{ type: 'retweeted', id: '100' }, { type: 'quoted', id: '101' }];
  const record = toRecord(raw({ referenced_tweets: refs, text: 'RT @SourceAccount: preview…', note_tweet: { text: 'Do not replace the RT display text' } }), capturedAt, includes);
  assert.equal(record.type, 'retweet');
  assert.equal(record.refId, '100');
  assert.equal(record.quoted, undefined);
  assert.equal(record.text, 'RT @SourceAccount: preview…');
  assert.equal(record.source.textField, 'text');
  assert.equal(record.reposted.id, '100');
  assert.equal(record.reposted.text, longText);
  assert.equal(record.reposted.createdAt, createdAt);
  assert.equal(record.reposted.source.raw.note_tweet.text, longText);
  assert.deepEqual(record.source.raw.referenced_tweets, refs);
  assert.deepEqual(record.source.references.map((r) => r.id), ['100', '101']);
  assert.equal(record.source.references[0].source.raw.note_tweet.text, longText);
  assert.equal(record.source.references[0].source.references[0].source, undefined);
});

test('hostile URL metadata remains inert raw evidence and is omitted from the navigable URL projection', () => {
  const bad = [{ url: 'javascript:alert(1)', expanded_url: 'data:text/html,<script>x</script>' }, { url: 'https://user:password@example.org/' }, { expanded_url: '//example.org/path' }, { url: 'https://example.org/\ninjected' }, { url: 'https://t.co/good', expanded_url: 'https://example.org/story', title: '<img src=x onerror=alert(1)>' }];
  const input = JSON.parse(JSON.stringify(raw({ entities: { urls: bad, __ignored: 'data' } })));
  const record = toRecord(input, capturedAt);
  assert.deepEqual(record.source.raw.entities.urls, bad);
  assert.equal(record.source.urls.length, 1);
  assert.equal(record.source.urls[0].url, 'https://t.co/good');
  assert.ok(record.source.warnings.some((w) => w.startsWith('invalid-entities-')));
  assert.equal(sourceEnvelope({ id: '123<script>' }).url, null);
});

test('malformed optional structures neither crash nor execute accessors/toJSON', () => {
  for (const optional of [{ entities: 'wrong', referenced_tweets: {} }, { entities: { urls: [null, 4, []] }, referenced_tweets: [null, {}, { type: 'quoted' }] }]) {
    assert.equal(toRecord(raw(optional), capturedAt, { tweets: {}, users: {} }).text, raw().text);
  }
  const note = { text: longText };
  note.self = note;
  const cyclic = toRecord(raw({ note_tweet: note }), capturedAt);
  assert.equal(cyclic.text, longText);
  assert.equal(cyclic.source.textField, 'note_tweet.text');
  assert.ok(cyclic.source.warnings.includes('unserializable-note_tweet'));
  let invoked = false;
  const input = raw({ entities: { toJSON() { invoked = true; throw new Error('must not run'); } } });
  Object.defineProperty(input, 'note_tweet', { get() { invoked = true; throw new Error('must not run'); }, enumerable: true });
  assert.equal(toRecord(input, capturedAt).text, raw().text);
  assert.equal(invoked, false);
  assert.equal(quotedFromIncludes('missing', { tweets: {}, users: null }), null);
  const malformedDate = quotedFromIncludes('123', { tweets: [raw({ created_at: 'not a timestamp' })] });
  assert.equal(malformedDate.createdAt, undefined);
  assert.equal(malformedDate.source.raw.created_at, 'not a timestamp');
});

test('JSON prototype keys are preserved as data without modifying object prototypes', () => {
  const entities = JSON.parse('{"__proto__":{"polluted":true},"urls":[]}');
  const record = toRecord(raw({ entities }), capturedAt);
  assert.equal(Object.getPrototypeOf(record.source.raw.entities), Object.prototype);
  assert.equal(record.source.raw.entities.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(record.source.raw.entities.__proto__.polluted, true);
});

async function withStub(body, fn) {
  const previous = { fetch: globalThis.fetch, token: process.env.X_BEARER_TOKEN, proxy: process.env.X_PROXY_AUTH };
  delete process.env.X_BEARER_TOKEN; process.env.X_PROXY_AUTH = '1';
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(new URL(url)); return new Response(JSON.stringify(body), { status: 200 }); };
  try { await fn(calls); } finally {
    globalThis.fetch = previous.fetch;
    for (const [key, value] of [['X_BEARER_TOKEN', previous.token], ['X_PROXY_AUTH', previous.proxy]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('timeline/search and text lookup request long-form fields; metrics-only lookup remains metrics-only', async () => {
  const post = raw({ note_tweet: { text: longText, entities: { urls: [link] } } });
  await withStub({ data: [post], includes: { users: [{ id: '456', username: 'Member' }] } }, async (calls) => {
    await listTweetsPage('1', { includeReferenced: true });
    await userTweetsPage('456');
    await searchRecent('test');
    const lookup = await lookupTweets(['123'], { withText: true });
    for (const url of calls) {
      const fields = url.searchParams.get('tweet.fields').split(',');
      assert.ok(fields.includes('note_tweet'));
      assert.ok(fields.includes('entities'));
      assert.ok(fields.includes('edit_history_tweet_ids'));
    }
    assert.equal(lookup.tweetsById.get('123').text, longText);
    assert.equal(lookup.tweetsById.get('123').source.raw.note_tweet.entities.urls[0].expanded_url, link.expanded_url);
    assert.equal(lookup.usage, 1);
    assert.equal(lookup.userReads, 1);
    assert.deepEqual(lookup.raw, { data: [post], includes: { users: [{ id: '456', username: 'Member' }] } });
    await lookupTweets(['123']);
    assert.equal(calls.at(-1).searchParams.get('tweet.fields'), 'public_metrics');
    assert.equal(calls.at(-1).searchParams.get('expansions'), null);
  });
});
