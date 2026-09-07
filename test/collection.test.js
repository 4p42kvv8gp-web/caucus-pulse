import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/db.js';
import { createBudget } from '../src/budget.js';
import { collectOnce, registerListSource, restartInterval } from '../src/collect.js';
import { createXClient } from '../src/x-client.js';

const policy = { dailyCeilingUsd: 25, pilotCeilingUsd: 350, reserveUsd: 50,
  resourcePricesUsd: { post: 0.005, user: 0.01 }, balanceMaxAgeSeconds: 300 };
function setup({ path = ':memory:', ...options } = {}) {
  const store = openStore(path); let ms = Date.parse('2026-09-07T23:00:00Z');
  const clock = () => ms;
  const budget = createBudget(store.db, { ...policy, ...options }, { clock });
  function balance(usd = 400) { budget.recordBalance({ prepaidUsd: usd, readStartedAt: new Date(ms).toISOString() }); }
  balance();
  return { store, db: store.db, clock, budget, balance, advance: n => { ms += n; }, setTime: n => { ms = n; } };
}
const raw = id => ({ id: String(id), author_id: '101', created_at: '2026-09-07T22:30:00Z', text: `Synthetic capture record ${id}.` });
const page = (ids, token) => ({ data: ids.map(raw), meta: { result_count: ids.length, ...(token ? { next_token: token } : {}) } });
function sourceAt(db, checkpoint = '100') {
  const sourceId = registerListSource(db, '123456');
  if (checkpoint != null) db.prepare('UPDATE collection_sources SET checkpoint_id=?, initialized_at=? WHERE id=?').run(checkpoint, '2026-09-07T22:00:00Z', sourceId);
  return sourceId;
}
const checkpoint = (db, sourceId) => db.prepare('SELECT checkpoint_id FROM collection_sources WHERE id=?').get(sourceId).checkpoint_id;
const captured = db => db.prepare('SELECT id FROM captured_posts ORDER BY length(id),id').all().map(p => p.id);

test('budget refuses unverified, stale, and under-reserve balances before a request', () => {
  const c = setup();
  try {
    c.db.prepare('DELETE FROM balance_observations').run();
    assert.throws(() => c.budget.reserveRequest({ kind: 'post', maxResources: 100, purpose: 'new-posts' }), { code: 'balance-verification-required' });
    c.balance(50.49);
    assert.throws(() => c.budget.reserveRequest({ kind: 'post', maxResources: 100, purpose: 'new-posts' }), { code: 'budget-ceiling' });
    c.advance(301_000);
    assert.throws(() => c.budget.reserveRequest({ kind: 'post', maxResources: 1, purpose: 'new-posts' }), { code: 'balance-verification-required' });
    assert.equal(c.budget.state().requestCount, 0);
  } finally { c.store.close(); }
});

test('reservations apply before every page and never rely on soft duplicate billing discounts', () => {
  const c = setup({ dailyCeilingUsd: 0.5 });
  try {
    const first = c.budget.reserveRequest({ kind: 'post', maxResources: 100, purpose: 'new-posts' });
    assert.throws(() => c.budget.reserveRequest({ kind: 'post', maxResources: 1, purpose: 'new-posts' }), { code: 'budget-ceiling' });
    c.budget.settle(first.id, ['1', '2']);
    const second = c.budget.reserveRequest({ kind: 'post', maxResources: 98, purpose: 'new-posts' });
    c.budget.settle(second.id, ['1', '2']);
    assert.equal(c.budget.state().totalMicro, 20_000, 'Repeated resources still consume the conservative local allowance');
    assert.throws(() => c.budget.settle(second.id, []), /already been accounted/);
    assert.throws(() => c.budget.reserveRequest({ kind: 'post', maxResources: 1, purpose: 'history' }), { code: 'optional-work-disabled' });
  } finally { c.store.close(); }
});

test('crashed requests remain charged; midnight requests count conservatively in both days', () => {
  const c = setup({ dailyCeilingUsd: 0.5 });
  try {
    c.setTime(Date.parse('2026-09-07T23:59:59Z')); c.balance();
    const first = c.budget.reserveRequest({ kind: 'post', maxResources: 100, purpose: 'new-posts' });
    c.advance(2000);
    assert.throws(() => c.budget.reserveRequest({ kind: 'post', maxResources: 1, purpose: 'new-posts' }), { code: 'budget-ceiling' });
    c.budget.settle(first.id, Array.from({ length: 100 }, (_, i) => String(i)));
    assert.equal(c.budget.state().dailyMicro, 500_000);
    c.setTime(Date.parse('2026-09-09T00:00:01Z')); c.balance();
    assert.equal(c.budget.state().dailyMicro, 0); assert.equal(c.budget.state().totalMicro, 500_000);
  } finally { c.store.close(); }
});

test('total pilot limit persists across days; external balance changes protect the reserve', () => {
  const c = setup({ pilotCeilingUsd: 0.01 });
  try {
    const first = c.budget.reserveRequest({ kind: 'post', maxResources: 2, purpose: 'new-posts' }); c.budget.settle(first.id, ['1','2']);
    c.advance(86_400_000); c.balance();
    assert.throws(() => c.budget.reserveRequest({ kind: 'post', maxResources: 1, purpose: 'new-posts' }), { code: 'budget-ceiling' });
    c.balance(40); assert.equal(c.budget.state().remainingMicro, 0);
  } finally { c.store.close(); }
});

test('concurrent connections cannot reserve the same remaining allowance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-budget-')); const path = join(dir, 'test.sqlite');
  const c = setup({ path, dailyCeilingUsd: 0.5 }); const second = openStore(path);
  try {
    const other = createBudget(second.db, { ...policy, dailyCeilingUsd: 0.5 }, { clock: c.clock });
    c.budget.reserveRequest({ kind: 'post', maxResources: 100, purpose: 'new-posts' });
    assert.throws(() => other.reserveRequest({ kind: 'post', maxResources: 1, purpose: 'new-posts' }), { code: 'budget-ceiling' });
    c.store.close(); const reopened = openStore(path);
    try { assert.equal(createBudget(reopened.db, policy, { clock: c.clock }).state().unresolvedRequests, 1); }
    finally { reopened.close(); }
  } finally { second.close(); if (c.db.isOpen) c.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('unexpected billing volume freezes further requests instead of silently clipping cost', () => {
  const c = setup();
  try {
    const r = c.budget.reserveRequest({ kind: 'post', maxResources: 1, purpose: 'new-posts' });
    assert.equal(c.budget.settle(r.id, ['1','2']).fault, 'response-exceeded-reservation');
    assert.equal(c.budget.state().totalMicro, 10_000);
    assert.throws(() => c.budget.reserveRequest({ kind: 'post', maxResources: 1, purpose: 'new-posts' }), { code: 'billing-review-required' });
  } finally { c.store.close(); }
});

test('page cap and process restart keep the old checkpoint until all pages are stored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-capture-')); const path = join(dir, 'test.sqlite');
  const c = setup({ path }); const sourceId = sourceAt(c.db); let reopened;
  try {
    const first = await collectOnce({ ...c, sourceId, maxPages: 1, fetchPage: async () => page(['500','400'], 'older') });
    assert.equal(first.reason, 'page-limit'); assert.equal(checkpoint(c.db, sourceId), '100');
    assert.deepEqual(captured(c.db), ['400','500']); c.store.close(); reopened = openStore(path);
    const budget = createBudget(reopened.db, policy, { clock: c.clock });
    const result = await collectOnce({ db: reopened.db, budget, clock: c.clock, sourceId, fetchPage: async request => {
      assert.equal(request.paginationToken, 'older'); return page(['300','200','100']);
    } });
    assert.equal(result.status, 'complete'); assert.equal(checkpoint(reopened.db, sourceId), '500');
    assert.deepEqual(captured(reopened.db), ['100','200','300','400','500']);
    assert.equal(reopened.listPosts().length, 0, 'Unresolved authors are captured separately, never invented as House members');
  } finally { if (reopened) reopened.close(); else if (c.db.isOpen) c.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('network failure on page two preserves the resume token and conservative charge', async () => {
  const c = setup(); const sourceId = sourceAt(c.db); let calls = 0;
  try {
    const result = await collectOnce({ ...c, sourceId, fetchPage: async () => { if (calls++ === 0) return page(['500','400'], 'older'); throw new Error('Untrusted provider error'); } });
    assert.equal(result.reason, 'request-failed'); assert.equal(checkpoint(c.db, sourceId), '100');
    assert.equal(c.budget.state().unresolvedRequests, 1);
    await collectOnce({ ...c, sourceId, fetchPage: async request => { assert.equal(request.paginationToken, 'older'); return page(['300','100']); } });
    assert.equal(checkpoint(c.db, sourceId), '500');
  } finally { c.store.close(); }
});

test('budget exhaustion stops before page two and leaves resumable capture', async () => {
  const c = setup({ dailyCeilingUsd: 0.01 }); const sourceId = sourceAt(c.db); let calls = 0;
  try {
    const result = await collectOnce({ ...c, sourceId, pageSize: 2, fetchPage: async () => { calls++; return page(['500','400'], 'older'); } });
    assert.equal(calls, 1); assert.equal(result.reason, 'budget-ceiling');
    assert.equal(checkpoint(c.db, sourceId), '100');
  } finally { c.store.close(); }
});

test('a database failure cannot commit either half a page or its next checkpoint', async () => {
  const c = setup(); const sourceId = sourceAt(c.db);
  try {
    await collectOnce({ ...c, sourceId, maxPages: 1, fetchPage: async () => page(['500','400'], 'older') });
    c.db.exec("CREATE TRIGGER simulate_disk_error BEFORE INSERT ON captured_posts WHEN NEW.id='300' BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END");
    await assert.rejects(collectOnce({ ...c, sourceId, fetchPage: async () => page(['350','300','100']) }), /simulated write failure/);
    assert.deepEqual(captured(c.db), ['400','500']);
    assert.equal(checkpoint(c.db, sourceId), '100');
    assert.equal(c.budget.state().totalMicro, 25_000, 'Provider reads remain accounted for after failed storage');
    c.db.exec('DROP TRIGGER simulate_disk_error');
    await collectOnce({ ...c, sourceId, fetchPage: async request => { assert.equal(request.paginationToken, 'older'); return page(['350','300','100']); } });
    assert.equal(checkpoint(c.db, sourceId), '500');
  } finally { c.store.close(); }
});

test('oversized partial responses still freeze paid reads', async () => {
  const c = setup(); const sourceId = sourceAt(c.db);
  try {
    const result = await collectOnce({ ...c, sourceId, pageSize: 1, fetchPage: async () => ({ ...page(['500','400']), errors: [{ detail: 'partial' }] }) });
    assert.equal(result.reason, 'response-exceeded-reservation');
    assert.equal(c.budget.state().totalMicro, 10_000);
    assert.equal(checkpoint(c.db, sourceId), '100');
  } finally { c.store.close(); }
});

test('feed exhaustion, partial errors, and invalid ordering never claim complete coverage', async () => {
  for (const [response, reason] of [
    [page(['500','400']), 'feed-ended-before-checkpoint'],
    [{ ...page(['500','400'], 'next'), errors: [{ detail: 'Unavailable item' }] }, 'partial-response'],
    [page(['400','500'], 'next'), 'unexpected-order']
  ]) {
    const c = setup(); const sourceId = sourceAt(c.db);
    try {
      const result = await collectOnce({ ...c, sourceId, fetchPage: async () => response });
      assert.equal(result.reason, reason); assert.equal(checkpoint(c.db, sourceId), '100');
      assert.deepEqual(captured(c.db), ['400','500']);
      const next = await collectOnce({ ...c, sourceId, fetchPage: async () => { throw new Error('Must not fetch until recovery is selected'); } });
      assert.equal(next.pagesFetched, 0);
    } finally { c.store.close(); }
  }
});

test('expired cursor recovery keeps the fixed upper bound; new arrivals are captured next interval', async () => {
  const c = setup(); const sourceId = sourceAt(c.db);
  try {
    await collectOnce({ ...c, sourceId, maxPages: 1, fetchPage: async () => page(['500','400'], 'old-cursor') });
    restartInterval(c.db, sourceId, { clock: c.clock });
    let call = 0;
    await collectOnce({ ...c, sourceId, fetchPage: async () => call++ === 0 ? page(['600','500','400'], 'new-cursor') : page(['300','100']) });
    assert.equal(checkpoint(c.db, sourceId), '500');
    await collectOnce({ ...c, sourceId, fetchPage: async () => page(['600','500']) });
    assert.equal(checkpoint(c.db, sourceId), '600');
  } finally { c.store.close(); }
});

test('initial capture is explicitly a first-page sample; empty initialization does not lose later pages', async () => {
  const c = setup(); const sourceId = sourceAt(c.db, null);
  try {
    const initial = await collectOnce({ ...c, sourceId, fetchPage: async () => page([]) });
    assert.equal(initial.reason, 'initial-page-only'); assert.equal(checkpoint(c.db, sourceId), '0');
    let calls = 0;
    await collectOnce({ ...c, sourceId, fetchPage: async () => calls++ === 0 ? page(['500','400'], 'older') : page(['300']) });
    assert.equal(calls, 2); assert.equal(checkpoint(c.db, sourceId), '500');
  } finally { c.store.close(); }
});

test('source leases reject overlap and expired workers cannot advance another worker checkpoint', async () => {
  const c = setup(); const sourceId = sourceAt(c.db);
  try {
    let finish;
    const pending = collectOnce({ ...c, sourceId, fetchPage: () => new Promise(resolve => { finish = resolve; }) });
    const overlapping = await collectOnce({ ...c, sourceId, fetchPage: async () => page(['500','100']) });
    assert.equal(overlapping.status, 'busy');
    c.advance(121_000);
    await collectOnce({ ...c, sourceId, fetchPage: async () => page(['600','100']) });
    finish(page(['500','100']));
    await assert.rejects(pending, /lease expired/);
    assert.equal(checkpoint(c.db, sourceId), '600');
  } finally { c.store.close(); }
});

test('tombstoned source content is never reintroduced by collection', async () => {
  const c = setup(); const sourceId = sourceAt(c.db);
  try {
    c.store.removePost('500');
    await collectOnce({ ...c, sourceId, fetchPage: async () => page(['500','400','100']) });
    assert.deepEqual(captured(c.db), ['100','400']);
  } finally { c.store.close(); }
});

test('X adapter fixes the destination, avoids expansions/retries, and validates credit amounts', async () => {
  let calls = 0;
  const client = createXClient({ token: 'synthetic-test-token', fetchImpl: async (url, options) => {
    calls++; assert.equal(url.origin, 'https://api.x.com'); assert.equal(options.redirect, 'error');
    assert.equal(url.searchParams.has('expansions'), false);
    if (url.pathname === '/2/usage/credits') return { ok: true, json: async () => ({ data: { prepaid_balance: 400 } }) };
    assert.equal(url.searchParams.get('max_results'), '2'); assert.match(url.searchParams.get('tweet.fields'), /note_tweet/);
    return { ok: true, json: async () => ({ meta: { result_count: 0 } }) };
  } });
  assert.deepEqual(await client.creditBalance(), { prepaidUsd: 400 });
  assert.deepEqual((await client.listPosts({ listId: '123', maxResults: 2 })).data, []);
  assert.equal(calls, 2);
  const invalid = createXClient({ token: 'synthetic-test-token', fetchImpl: async () => ({ ok: true, json: async () => ({ data: { prepaid_balance: '400' } }) }) });
  await assert.rejects(invalid.creditBalance(), { code: 'invalid-credit-balance' });
  const failed = createXClient({ token: 'synthetic-test-token', fetchImpl: async () => { throw new Error('Untrusted request details'); } });
  await assert.rejects(failed.creditBalance(), error => !error.message.includes('Untrusted') && error.code === 'transport-failed');
});
