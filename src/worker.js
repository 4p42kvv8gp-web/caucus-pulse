import { createBudget } from './budget.js';
import { registerListSource, collectOnce, collectionState, restartInterval } from './collect.js';
import { syncListInventory, inventoryState, abandonInventory } from './list-inventory.js';
import { rosterStatus, promoteCaptured } from './roster.js';

export function passPlan(settings, { mode, trial = false, pageSize, maxPages, fieldDialect } = {}) {
  if (!['inventory','posts'].includes(mode)) throw new Error('Invalid worker mode. Choose inventory or posts.');
  if (typeof trial !== 'boolean' || !/^\d{1,25}$/.test(settings.listId ?? '')) throw new Error('Invalid worker configuration.');
  if (mode === 'posts' && !['tweet','post'].includes(fieldDialect)) throw new Error('Invalid field dialect: explicitly choose tweet or post for a post trial.');
  const size = pageSize ?? (mode === 'inventory' ? 100 : 5);
  const pages = maxPages ?? (mode === 'inventory' ? 3 : 1);
  if (!Number.isInteger(size) || size < 1 || size > 100 || !Number.isInteger(pages) || pages < 1 || pages > 10) throw new Error('Invalid pass limits.');
  if (mode === 'posts' && trial && (size > 20 || pages > 2)) throw new Error('Invalid trial limits: use at most 20 posts per page and two pages.');
  const kind = mode === 'inventory' ? 'user' : 'post';
  const unit = settings.budget?.resourcePricesUsd?.[kind];
  if (typeof unit !== 'number' || !Number.isFinite(unit) || unit <= 0) throw new Error('Invalid configured resource price.');
  return { mode, trial, listId: settings.listId, pageSize: size, maxPages: pages, fieldDialect: fieldDialect ?? null,
    maximumReadCostUsd: Math.round(size * pages * unit * 1_000_000) / 1_000_000,
    note: 'One bounded pass. Preview makes no requests. Execution refreshes prepaid balance and reserves each paid page; no scheduler or automatic top-up is started.' };
}

export function workerReadiness(store, settings, { clock = () => Date.now() } = {}) {
  return { inventory: inventoryState(store.db, settings.listId, { clock }), roster: rosterStatus(store.db, { now: clock() }),
    sources: collectionState(store.db), budget: createBudget(store.db, settings.budget, { clock }).state() };
}

export async function runWorkerPass({ store, settings, options, client, execute = false, clock = () => Date.now() }) {
  const plan = passPlan(settings, options);
  const readiness = workerReadiness(store, settings, { clock });
  if (!execute) return { status: 'preview', plan, readiness };
  if (!client || typeof client.creditBalance !== 'function') throw new Error('Private X access is not configured.');
  if (plan.mode === 'posts' && !plan.trial) {
    if (settings.collectionEnabled !== true) throw new Error('Live collection is disabled; use an explicit bounded trial.');
    if (!readiness.inventory.fresh || !readiness.roster.snapshot?.fresh || !readiness.roster.activeAccountBindings) throw new Error('Fresh inventory, roster, and verified account bindings are required before a live pass.');
  }
  const fetchPage = plan.mode === 'inventory' ? client.listMembers : client.listPosts;
  if (typeof fetchPage !== 'function') throw new Error('X adapter does not support the selected operation.');
  const budget = createBudget(store.db, settings.budget, { clock });
  const readStartedAt = new Date(clock()).toISOString();
  let balance;
  try { balance = await client.creditBalance(); } catch { return { status: 'paused', reason: 'balance-verification-failed', plan }; }
  budget.recordBalance({ ...balance, readStartedAt });
  const result = plan.mode === 'inventory'
    ? await syncListInventory({ db: store.db, listId: plan.listId, fetchPage, budget, pageSize: plan.pageSize, maxPages: plan.maxPages, clock })
    : await collectOnce({ db: store.db, sourceId: registerListSource(store.db, plan.listId), fetchPage,
      budget, pageSize: plan.pageSize, maxPages: plan.maxPages, clock });
  const promoted = promoteCaptured(store, { now: clock() });
  store.analyzePending();
  return { ...result, plan, processing: promoted, readiness: workerReadiness(store, settings, { clock }) };
}

export function restartPass(store, settings, mode, { clock = () => Date.now() } = {}) {
  if (mode === 'inventory') return { restarted: abandonInventory(store.db, settings.listId, { clock }), mode };
  if (mode === 'posts') { restartInterval(store.db, `list:${settings.listId}`, { clock }); return { restarted: true, mode }; }
  throw new Error('Invalid recovery mode.');
}
