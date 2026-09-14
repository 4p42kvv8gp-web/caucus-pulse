import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceContextStatus, createRepostResolver } from '../src/source-context.js';

const post = (extra = {}) => ({ id: '100', type: 'retweet', refId: '900',
  text: 'RT @original: exact abbreviated wrapper…', capturedAt: '2026-09-14T12:00:00Z', ...extra });
const original = (extra = {}) => ({ id: '900', text: 'Exact original wording.\nIncluding punctuation…',
  authorId: '901', handle: 'original', createdAt: '2026-09-14T11:00:00Z', ...extra });

test('only reposts require original context; missing and invalid references are explicit', () => {
  for (const value of [null, { type: 'tweet', text: 'A complete sentence…' }, { type: 'quote' }, { type: 'reply' }]) {
    const status = sourceContextStatus(value);
    assert.equal(status.incomplete, false); assert.equal(status.reason, null); assert.equal(status.referenceId, null);
  }
  assert.equal(sourceContextStatus(post()).reason, 'repost-original-unavailable');
  for (const refId of [null, undefined, '', '9wrong', 900]) {
    const status = sourceContextStatus(post({ refId }), original());
    assert.equal(status.incomplete, true); assert.equal(status.reason, 'repost-reference-invalid'); assert.equal(status.referenceId, null);
  }
});

test('matching IDs and actual text are required, without inferring truncation from ellipses', () => {
  assert.equal(sourceContextStatus(post(), original({ id: '901' })).reason, 'repost-original-mismatch');
  assert.equal(sourceContextStatus(post(), original({ id: null })).reason, 'repost-original-mismatch');
  assert.equal(sourceContextStatus(post(), original({ unavailable: true })).reason, 'repost-original-unavailable');
  for (const text of ['', '  \n', null, 42]) assert.equal(sourceContextStatus(post(), original({ text })).reason, 'repost-original-empty');
  const status = sourceContextStatus(post(), original());
  assert.equal(status.incomplete, false); assert.equal(status.reason, null); assert.equal(status.referenceId, '900');
  assert.match(status.fingerprint, /^[a-f0-9]{64}$/);
});

test('valid embedded originals take precedence; invalid embedded context can use a matching fallback', () => {
  const embedded = original({ text: 'Captured original.' });
  const fallback = original({ text: 'Other saved version.' });
  assert.equal(sourceContextStatus(post({ reposted: embedded }), fallback).fingerprint,
    sourceContextStatus(post(), embedded).fingerprint);
  assert.equal(sourceContextStatus(post({ reposted: original({ id: '899' }) }), fallback).incomplete, false);
  assert.equal(sourceContextStatus(post({ reposted: original({ unavailable: true }) }), fallback).incomplete, false);
});

test('fingerprints track source identity and wording but ignore engagement and clocks', () => {
  const p = post(), o = original(), before = sourceContextStatus(p, o).fingerprint;
  assert.equal(sourceContextStatus({ ...p, capturedAt: 'later', metricsAtCapture: { likes: 900 } },
    { ...o, capturedAt: 'later', fetchedAt: 'later', createdAt: 'later', metrics: { likes: 900 }, source: { raw: 'ignored' } }).fingerprint, before);
  for (const changed of [original({ text: 'Changed wording.' }), original({ authorId: '902' }), original({ handle: 'different' }), original({ id: '901' })]) {
    assert.notEqual(sourceContextStatus(p, changed).fingerprint, before);
  }
  assert.notEqual(sourceContextStatus(post({ text: 'Changed wrapper.' }), o).fingerprint, before);
  assert.notEqual(sourceContextStatus(post({ refId: '902' }), original({ id: '902' })).fingerprint, before);
  assert.notEqual(sourceContextStatus(p).fingerprint, before);
});

test('request JSONL projection preserves fingerprints for durable manifest reconstruction', () => {
  const p = post({ reposted: original({ metrics: { likes: 700 }, source: { raw: 'not serialized' } }) });
  const line = JSON.parse(JSON.stringify({ id: p.id, type: p.type, refId: p.refId, text: p.text,
    reposting: { id: p.reposted.id, authorId: p.reposted.authorId, handle: p.reposted.handle,
      text: p.reposted.text, createdAt: p.reposted.createdAt } }));
  assert.equal(sourceContextStatus({ ...line, reposted: line.reposting }).fingerprint,
    sourceContextStatus(p).fingerprint);
  const missingLine = JSON.parse(JSON.stringify({ id: p.id, type: p.type, refId: p.refId, text: p.text }));
  assert.equal(sourceContextStatus(missingLine).fingerprint, sourceContextStatus(post()).fingerprint);
  for (const invalid of [original({ id: '999' }), original({ text: '' }), original({ unavailable: true })]) {
    assert.equal(sourceContextStatus(missingLine).fingerprint, sourceContextStatus(post({ reposted: invalid })).fingerprint,
      'omitting unusable context cannot create a new paid interpretation revision');
  }
});

test('resolver uses embedded, keyed quoted cache, then archive without mutating sources', () => {
  const embedded = original({ text: 'Embedded.', privatePayload: 'omit' });
  const cached = { text: 'Cached.\nFull exact wording.', authorId: '901', handle: 'cached', fetchedAt: '2026-09-14T12:01:00Z', privatePayload: 'omit' };
  const archived = original({ text: 'Archived.', capturedAt: '2026-09-14T12:02:00Z' });
  const quoted = { '900': cached }, p = post({ reposted: embedded });
  const before = JSON.stringify({ quoted, p, archived });
  const lookedUp = [];
  const resolve = createRepostResolver({ quoted, archive: (id) => { lookedUp.push(id); return archived; } });
  const first = resolve(p);
  assert.equal(first.text, embedded.text); assert.equal(first.capturedAt, p.capturedAt); assert.deepEqual(lookedUp, []);
  const second = resolve(post());
  assert.equal(second.id, '900'); assert.equal(second.text, cached.text); assert.equal(second.fetchedAt, cached.fetchedAt); assert.deepEqual(lookedUp, []);
  const third = createRepostResolver({ quoted: {}, archive: (id) => { lookedUp.push(id); return archived; } })(post());
  assert.equal(third.text, archived.text); assert.equal(third.capturedAt, archived.capturedAt); assert.deepEqual(lookedUp, ['900']);
  assert.ok(!('privatePayload' in first)); assert.ok(!('privatePayload' in second));
  first.text = 'Local projection edit';
  assert.equal(JSON.stringify({ quoted, p, archived }), before);
});

test('resolver rejects unavailable, mismatched and empty entries and never reads for non-reposts', () => {
  for (const cached of [original({ id: '901' }), original({ unavailable: true }), original({ text: '' })]) {
    const resolve = createRepostResolver({ quoted: { '900': cached }, archive: () => null });
    assert.equal(resolve(post()), null);
  }
  const fallback = createRepostResolver({ quoted: { '900': original({ unavailable: true }) }, archive: () => original() });
  assert.equal(fallback(post()).id, '900');
  const resolve = createRepostResolver({ archive: () => { throw new Error('must not read'); } });
  assert.equal(resolve(post({ type: 'tweet' })), null); assert.equal(resolve(post({ refId: 'bad' })), null);
  assert.throws(() => createRepostResolver({ archive: null }), /Invalid repost resolver dependencies/);
  assert.throws(() => createRepostResolver({ quoted: null }), /Invalid repost resolver dependencies/);
});

test('archive corruption propagates instead of pretending a source is absent', () => {
  const resolve = createRepostResolver({ archive: () => { throw new Error('corrupt archive'); } });
  assert.throws(() => resolve(post()), /corrupt archive/);
});
