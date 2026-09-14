import test from 'node:test';
import assert from 'node:assert/strict';
import { runRepostAcquisition, validateAcquisitionState, serializeRepostResponse } from '../src/repost-acquisition-runner.js';
import { createRepostResolver } from '../src/source-context.js';

const NOW = '2026-09-14T21:00:00.000Z';
const post = (n = 1, original = String(n + 100)) => ({ id: String(n), type: 'retweet', refId: original,
  text: 'RT @Source: short preview…', createdAt: '2026-09-14T20:30:00Z', capturedAt: '2026-09-14T20:45:00Z' });
const original = (id) => ({ id, text: ' Complete original.\n' + 'Qualifications and details. '.repeat(100),
  authorId: '999', handle: 'Source', createdAt: '2026-09-14T20:00:00Z', metrics: { likes: 1 }, source: { raw: { id, text: 'preview', note_tweet: { text: 'full source envelope' } } } });
const response = (ids) => ({ tweetsById: new Map(ids.map((id) => [id, original(id)])),
  usage: ids.length, userReads: 1, errors: [], raw: { data: ids.map((id) => ({ id, note_tweet: { text: original(id).text } })) } });
const copy = (v) => structuredClone(v);
function rig({ lookup = async (ids) => response(ids), clock = NOW } = {}) {
  const disk = { state: { version: 1, receipts: {} }, quoted: {}, usage: { sinceId: '12345', usage: { '2026-09-14': { posts: 20, users: 3 } } } };
  const events = [];
  let durable = copy(disk), calls = 0;
  const deps = {
    loadQuoted: async () => copy(disk.quoted), saveQuoted: async (v) => { events.push('cache'); disk.quoted = copy(v); },
    loadUsage: async () => copy(disk.usage), saveUsage: async (v) => { events.push('usage'); disk.usage = copy(v); },
    save: async (v) => { events.push('save'); disk.state = copy(v); },
    checkpoint: async () => { events.push('checkpoint'); durable = copy(disk); },
    lookup: async (ids, options) => { calls++; events.push('lookup'); assert.deepEqual(options, { withText: true }); return lookup(ids); },
    now: () => clock, usageDay: (d) => d.slice(0, 10), remainingReads: () => 1000
  };
  return { disk, events, deps, get durable() { return durable; }, get calls() { return calls; },
    restartRemote: () => Object.assign(disk, copy(durable)),
    run: (posts = [post()], extra = {}) => runRepostAcquisition(posts, { ...deps, ...extra, state: copy(disk.state) }) };
}

test('one bounded batch checkpoints intent and raw response before derived stores and preserves complete source', async () => {
  const r = rig();
  const result = await r.run(Array.from({ length: 40 }, (_, i) => post(i + 1)));
  assert.equal(result.calls, 1); assert.equal(result.requested, 25); assert.equal(result.fetched, 25);
  assert.equal(r.calls, 1);
  assert.deepEqual(r.events.slice(0, 3), ['save', 'checkpoint', 'lookup']);
  assert.ok(r.events.indexOf('cache') > r.events.indexOf('lookup') + 2);
  const receipt = Object.values(r.disk.state.receipts)[0];
  assert.equal(receipt.status, 'applied');
  assert.equal(receipt.response.raw.data.length, 25);
  assert.equal(r.disk.quoted['101'].text, original('101').text);
  assert.deepEqual(r.disk.quoted['101'].source, original('101').source);
  assert.equal(r.disk.usage.usage['2026-09-14'].posts, 45);
  assert.equal(r.disk.usage.usage['2026-09-14'].users, 4);
  assert.equal(r.disk.usage.sinceId, '12345');
  assert.deepEqual(r.durable, r.disk);
});

test('intent publication failure makes no request; interrupted intent never resubmits blindly', async () => {
  const r = rig();
  await assert.rejects(r.run([post()], { checkpoint: async () => { throw new Error('publication failed'); } }), /publication failed/);
  assert.equal(r.calls, 0);
  const result = await r.run();
  assert.equal(result.calls, 0); assert.equal(result.uncertain, 1); assert.equal(result.outstanding, 1);
  assert.equal(Object.values(r.disk.state.receipts)[0].status, 'uncertain');
  const later = await r.run();
  assert.equal(later.uncertain, 0); assert.equal(later.outstanding, 1); assert.equal(r.calls, 0);
});

test('preflight rejection leaves no intent or consumed IDs', async () => {
  const r = rig();
  await assert.rejects(r.run([post()], { beforeLookup: async () => { throw new Error('auth unavailable'); } }), /auth unavailable/);
  assert.equal(r.calls, 0); assert.deepEqual(r.disk.state.receipts, {});
  assert.equal((await r.run()).fetched, 1);
});

test('transport error retains uncertain intent and does not become an unavailable original', async () => {
  const r = rig({ lookup: async () => { throw new Error('connection reset'); } });
  const first = await r.run();
  assert.equal(first.uncertain, 1); assert.equal(first.outstanding, 1); assert.deepEqual(r.disk.quoted, {});
  const again = await r.run();
  assert.equal(again.calls, 0); assert.equal(again.outstanding, 1); assert.equal(r.calls, 1);
});

test('response checkpoint failure replays saved local response with zero additional calls', async () => {
  const r = rig(); let checkpoints = 0;
  await assert.rejects(r.run([post()], { checkpoint: async () => {
    checkpoints++; if (checkpoints === 2) throw new Error('offline'); await r.deps.checkpoint();
  } }), /offline/);
  assert.equal(Object.values(r.disk.state.receipts)[0].status, 'response-saved');
  const again = await r.run();
  assert.equal(again.replayed, 1); assert.equal(again.calls, 0); assert.equal(r.calls, 1);
  assert.equal(r.disk.usage.usage['2026-09-14'].posts, 21);
});

test('ephemeral runner loss before response publication preserves intent and forbids rebilling', async () => {
  const r = rig(); let checkpoints = 0;
  await assert.rejects(r.run([post()], { checkpoint: async () => {
    if (++checkpoints === 2) throw new Error('lost runner'); await r.deps.checkpoint();
  } }), /lost runner/);
  r.restartRemote();
  const again = await r.run();
  assert.equal(again.uncertain, 1); assert.equal(again.calls, 0); assert.equal(r.calls, 1);
});

test('crash after usage atomic write replays cache and receipt without duplicate accounting on next day', async () => {
  const r = rig();
  await assert.rejects(r.run([post()], { saveUsage: async (value) => { await r.deps.saveUsage(value); throw new Error('crashed'); } }), /crashed/);
  assert.equal(r.disk.usage.usage['2026-09-14'].posts, 21);
  const again = await r.run([], { now: () => '2026-09-15T04:00:00Z' });
  assert.equal(again.replayed, 1); assert.equal(again.calls, 0);
  assert.equal(r.disk.usage.usage['2026-09-14'].posts, 21);
  assert.equal(r.disk.usage.usage['2026-09-15'], undefined);
  assert.equal(r.disk.quoted['101'].fetchedAt, NOW);
});

test('paid ambiguous omission stays unresolved without terminal caching or automatic retry', async () => {
  const r = rig({ lookup: async () => ({ tweetsById: new Map(), usage: 0, userReads: 0, errors: [], raw: {} }) });
  assert.equal((await r.run()).unresolved, 1);
  assert.deepEqual(r.disk.quoted, {});
  const again = await r.run();
  assert.equal(again.calls, 0); assert.equal(again.outstanding, 1);
});

test('definite rate limit defers IDs without marking unavailable and retries only after reset', async () => {
  const r = rig({ lookup: async () => ({ tweetsById: new Map(), usage: 0, userReads: 0, rateLimited: true, resetAt: Date.parse('2026-09-14T22:00:00Z') }) });
  const first = await r.run();
  assert.equal(first.rateLimited, 1); assert.equal(first.unresolved, 0);
  assert.equal(Object.values(r.disk.state.receipts)[0].status, 'rate-limited');
  assert.deepEqual(r.disk.quoted, {}); assert.equal(r.disk.usage.usage['2026-09-14'].posts, 20);
  const before = await r.run([post(), post(2)], { now: () => '2026-09-14T21:30:00Z' });
  assert.equal(before.calls, 0);
  const after = await r.run([post()], { now: () => '2026-09-14T22:01:00Z', lookup: async (ids) => response(ids) });
  assert.equal(after.calls, 1); assert.equal(after.fetched, 1);
  assert.doesNotThrow(() => validateAcquisitionState(r.disk.state));
});

test('embedded original on another wrapper becomes shared context without a lookup or ledger charge', async () => {
  const r = rig(); const embedded = { ...post(2, '101'), reposted: original('101') };
  const result = await r.run([post(), embedded]);
  assert.equal(result.calls, 0); assert.equal(result.localRecovered, 1);
  assert.equal(createRepostResolver({ quoted: r.disk.quoted })(post()).text, original('101').text);
  assert.equal(r.disk.quoted['101'].capturedAt, embedded.capturedAt);
  assert.equal(r.disk.usage.usage['2026-09-14'].posts, 20);
});

test('headroom accounts for author expansion and requested IDs, not sparse responses', async () => {
  const r = rig({ lookup: async () => ({ tweetsById: new Map(), usage: 0, userReads: 0, errors: [] }) });
  const result = await r.run(Array.from({ length: 20 }, (_, i) => post(i + 1)), { remainingReads: () => 7 });
  assert.equal(result.requested, 3); assert.equal(result.calls, 1); assert.equal(result.unresolved, 3);
});

test('tampered responses and missing accounting markers fail closed without calls', async () => {
  const r = rig(); await r.run();
  const bad = copy(r.disk.state); Object.values(bad.receipts)[0].response.tweets[0][1].text = 'changed';
  assert.throws(() => validateAcquisitionState(bad), /response changed/);
  delete r.disk.usage.repostAcquisitionUsage;
  await assert.rejects(r.run(), /no matching usage receipt/);
  assert.equal(r.calls, 1);
});

test('replayed omissions plus a new batch count outstanding IDs once', async () => {
  const r = rig({ lookup: async () => ({ tweetsById: new Map(), usage: 0, userReads: 0, errors: [] }) });
  await assert.rejects(r.run([post()], { saveQuoted: async () => { throw new Error('crash before application'); } }), /crash/);
  const result = await r.run([post(), post(2)]);
  assert.equal(result.replayed, 1); assert.equal(result.calls, 1);
  assert.equal(result.unresolved, 2); assert.equal(result.outstanding, 2);
});

test('serialized raw response is detached and keeps arbitrary public source text', () => {
  const raw = response(['101']); const saved = serializeRepostResponse(raw);
  raw.raw.data[0].note_tweet.text = 'mutated';
  assert.equal(saved.raw.data[0].note_tweet.text, original('101').text);
  assert.throws(() => serializeRepostResponse({ ...raw, usage: -1 }), /Invalid saved/);
});
