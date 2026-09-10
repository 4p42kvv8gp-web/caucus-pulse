import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/db.js';
import { passPlan, runWorkerPass } from '../src/worker.js';
import { createXClient } from '../src/x-client.js';

const settings = { listId: '123', collectionEnabled: false, budget: { dailyCeilingUsd: 25, pilotCeilingUsd: 350,
  reserveUsd: 50, resourcePricesUsd: { post: 0.005, user: 0.01 } } };
const clock = () => Date.parse('2026-09-08T01:00:00Z');

test('worker preview is entirely offline and advertises bounded reads', async () => {
  const store = openStore(); let calls = 0;
  try {
    const result = await runWorkerPass({ store, settings, options: { mode: 'inventory' }, clock,
      client: { creditBalance: async () => { calls++; throw new Error('Must not call'); } } });
    assert.equal(result.status, 'preview'); assert.equal(result.plan.maximumReadCostUsd, 3); assert.equal(calls, 0);
    assert.equal(result.readiness.budget.requestCount, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM list_inventory_runs').get().n, 0);
  } finally { store.close(); }
});

test('live and oversized trial passes fail before checking balance or making paid requests', async () => {
  const store = openStore(); let calls = 0;
  const client = { creditBalance: async () => { calls++; return { prepaidUsd: 400 }; } };
  try {
    await assert.rejects(runWorkerPass({ store, settings, execute: true, client, clock, options: { mode: 'posts', fieldDialect: 'tweet' } }), /Live collection is disabled/);
    await assert.rejects(runWorkerPass({ store, settings: { ...settings, collectionEnabled: true }, execute: true, client, clock, options: { mode: 'posts', fieldDialect: 'tweet' } }), /Fresh inventory/);
    assert.throws(() => passPlan(settings, { mode: 'posts', trial: true, fieldDialect: 'tweet', pageSize: 100 }), /trial limits/);
    assert.throws(() => passPlan(settings, { mode: 'posts', trial: true }), /field dialect/);
    assert.equal(calls, 0);
  } finally { store.close(); }
});

test('balance failures stop execution without paid reads or initialized scans', async () => {
  const store = openStore(); let paidCalls = 0;
  try {
    const result = await runWorkerPass({ store, settings, execute: true, clock, options: { mode: 'inventory' },
      client: { creditBalance: async () => { throw new Error('Synthetic failure'); }, listMembers: async () => { paidCalls++; } } });
    assert.equal(result.reason, 'balance-verification-failed'); assert.equal(paidCalls, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM budget_requests').get().n, 0);
  } finally { store.close(); }
});

test('an explicit trial stores unverified source text without labeling its author as a member', async () => {
  const store = openStore();
  try {
    const result = await runWorkerPass({ store, settings, execute: true, clock,
      options: { mode: 'posts', trial: true, fieldDialect: 'tweet' }, client: {
        creditBalance: async () => ({ prepaidUsd: 400 }),
        listPosts: async () => ({ data: [{ id: '900', author_id: '456', text: 'Synthetic library notice.', created_at: '2026-09-08T00:59:00Z' }], meta: { result_count: 1 } })
      } });
    assert.equal(result.reason, 'initial-page-only'); assert.equal(result.processing.awaitingVerification, 1);
    assert.equal(store.listPosts().length, 0); assert.equal(result.readiness.budget.totalMicro, 5000);
    assert.equal(store.db.prepare('SELECT status FROM captured_posts').get().status, 'awaiting-account-verification');
  } finally { store.close(); }
});

test('List member adapter requests only bounded public profile identity fields', async () => {
  const client = createXClient({ token: 'synthetic-token-for-testing', fetchImpl: async (url, options) => {
    assert.equal(url.origin, 'https://api.x.com'); assert.equal(url.pathname, '/2/lists/123/members');
    assert.equal(url.searchParams.get('pagination_token'), 'next'); assert.equal(url.searchParams.get('max_results'), '2');
    assert.equal(url.searchParams.get('user.fields'), 'id,username,name,protected');
    assert.equal(url.searchParams.has('expansions'), false); assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => ({ meta: { result_count: 0 } }) };
  } });
  assert.deepEqual((await client.listMembers({ listId: '123', maxResults: 2, paginationToken: 'next' })).data, []);
});
