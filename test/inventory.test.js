import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/db.js';
import { createBudget } from '../src/budget.js';
import { syncListInventory, inventoryState, inventoryAccounts, abandonInventory } from '../src/list-inventory.js';

const policy = { dailyCeilingUsd: 25, pilotCeilingUsd: 350, reserveUsd: 50, resourcePricesUsd: { post: 0.005, user: 0.01 } };
function setup(path) {
  const store = openStore(path); let now = Date.parse('2026-09-08T01:00:00Z');
  const clock = () => now; const budget = createBudget(store.db, policy, { clock });
  budget.recordBalance({ prepaidUsd: 400, readStartedAt: new Date(now).toISOString() });
  return { store, db: store.db, budget, clock, listId: '123', pageSize: 2, advance: ms => { now += ms; } };
}
const page = (ids, next = null) => ({ data: ids.map(id => ({ id, username: `Test${id}`, name: `Synthetic user ${id}`, protected: false })), meta: { result_count: ids.length, ...(next ? { next_token: next } : {}) } });

test('unfinished List scans survive restart and never replace the completed account inventory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-inventory-')); const path = join(dir, 'test.sqlite');
  let c = setup(path);
  try {
    await syncListInventory({ ...c, fetchPage: async () => page(['1']) });
    await syncListInventory({ ...c, maxPages: 1, fetchPage: async () => page(['2'], 'next') });
    assert.deepEqual(inventoryAccounts(c.db, '123').map(a => a.authorId), ['1']);
    c.store.close(); c = setup(path);
    const result = await syncListInventory({ ...c, fetchPage: async request => {
      assert.equal(request.paginationToken, 'next'); assert.equal(request.maxResults, 2); return page(['3']);
    } });
    assert.equal(result.status, 'complete');
    assert.deepEqual(inventoryAccounts(c.db, '123').map(a => a.authorId), ['2','3']);
    assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 0, 'List profiles are not verified member bindings');
  } finally { c.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('partial, conflicting and invalid scans preserve the last complete inventory', async () => {
  const cases = [
    { ...page(['2']), errors: [{}] },
    { ...page(['2']), meta: { result_count: 2 } },
    page(['2','2']),
    { data: [{ id: '2', username: 'same', name: 'Synthetic A' }, { id: '3', username: 'same', name: 'Synthetic B' }] },
    { ...page(['2']), meta: { next_token: {} } },
    { ...page(['2']), errors: { unexpected: true } },
    { data: [{ id: '2', username: 'invalid handle', name: 'Synthetic A' }] }
  ];
  for (const response of cases) {
    const c = setup();
    try {
      await syncListInventory({ ...c, fetchPage: async () => page(['1']) });
      assert.equal((await syncListInventory({ ...c, fetchPage: async () => response })).status, 'review-required');
      assert.deepEqual(inventoryAccounts(c.db, '123').map(a => a.authorId), ['1']);
      let called = false;
      await syncListInventory({ ...c, fetchPage: async () => { called = true; return page([]); } });
      assert.equal(called, false, 'A failed scan cannot silently restart or spend again');
    } finally { c.store.close(); }
  }
});

test('cursor cycles and repeated accounts across pages cannot publish a misleading scan', async () => {
  for (const repeatedAccount of [false, true]) {
    const c = setup(); let call = 0;
    try {
      const result = await syncListInventory({ ...c, fetchPage: async () => ++call === 1 ? page(['1'], 'a')
        : call === 2 ? page([repeatedAccount ? '1' : '2'], 'b') : page(['3'], 'a') });
      assert.equal(result.status, 'review-required'); assert.equal(inventoryState(c.db, '123').current, null);
    } finally { c.store.close(); }
  }
});

test('a lost second-page response retains the cursor and conservative charge', async () => {
  const c = setup(); let call = 0;
  try {
    const result = await syncListInventory({ ...c, fetchPage: async () => {
      if (++call === 1) return page(['1','2'], 'next'); throw new Error('Synthetic timeout');
    } });
    assert.equal(result.reason, 'request-failed'); assert.equal(c.budget.state().totalMicro, 40_000);
    await syncListInventory({ ...c, fetchPage: async request => { assert.equal(request.paginationToken, 'next'); return page(['3']); } });
    assert.equal(c.budget.state().totalMicro, 50_000); assert.equal(c.budget.state().unresolvedRequests, 1);
  } finally { c.store.close(); }
});

test('a storage failure cannot publish half a scan or refund a completed read', async () => {
  const c = setup();
  try {
    c.db.exec("CREATE TRIGGER synthetic_inventory_failure BEFORE INSERT ON list_inventories BEGIN SELECT RAISE(ABORT,'Synthetic storage failure'); END");
    await assert.rejects(syncListInventory({ ...c, fetchPage: async () => page(['1']) }), /Synthetic storage failure/);
    assert.equal(inventoryState(c.db, '123').active.pages, 0); assert.equal(inventoryState(c.db, '123').active.accounts, 0);
    assert.equal(c.budget.state().totalMicro, 10_000);
    c.db.exec('DROP TRIGGER synthetic_inventory_failure');
    assert.equal((await syncListInventory({ ...c, fetchPage: async () => page(['1']) })).status, 'complete');
  } finally { c.store.close(); }
});

test('an expired worker cannot overwrite the inventory published by its replacement', async () => {
  const c = setup(); let finish;
  try {
    const running = syncListInventory({ ...c, fetchPage: () => new Promise(resolve => { finish = resolve; }) });
    assert.equal((await syncListInventory({ ...c, fetchPage: async () => page([]) })).status, 'busy');
    assert.throws(() => abandonInventory(c.db, '123', { clock: c.clock }), /still running/);
    c.advance(121_000);
    await syncListInventory({ ...c, fetchPage: async () => page(['2']) });
    finish(page(['1'])); await assert.rejects(running, /lease expired/);
    assert.deepEqual(inventoryAccounts(c.db, '123').map(a => a.authorId), ['2']);
  } finally { c.store.close(); }
});

test('stale scans and page-size changes require explicit recovery before further paid reads', async () => {
  const c = setup(); let calls = 0;
  try {
    await syncListInventory({ ...c, maxPages: 1, fetchPage: async () => page(['1'], 'next') });
    await assert.rejects(syncListInventory({ ...c, pageSize: 1, fetchPage: async () => { calls++; return page([]); } }), /resume page size/);
    c.advance(3_600_001);
    assert.equal((await syncListInventory({ ...c, fetchPage: async () => { calls++; return page([]); } })).reason, 'scan-expired');
    assert.equal(calls, 0); assert.equal(abandonInventory(c.db, '123', { clock: c.clock }), 1);
    c.budget.recordBalance({ prepaidUsd: 400, readStartedAt: new Date(c.clock()).toISOString() });
    await syncListInventory({ ...c, fetchPage: async () => page([]) });
    assert.equal(inventoryState(c.db, '123').current.accounts, 0);
  } finally { c.store.close(); }
});

test('each page is reserved first and oversized malformed responses freeze further paid reads', async () => {
  const c = setup();
  try {
    const result = await syncListInventory({ ...c, fetchPage: async () => {
      assert.equal(c.budget.state().totalMicro, 20_000);
      return { data: [{ id: '1' }, { id: '2' }, { id: null }] };
    } });
    assert.equal(result.reason, 'response-exceeded-reservation'); assert.equal(c.budget.state().totalMicro, 30_000);
    assert.equal(c.budget.state().remainingMicro, 0);
  } finally { c.store.close(); }
});
