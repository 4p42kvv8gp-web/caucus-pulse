import { randomUUID } from 'node:crypto';
import { atomic } from './sqlite.js';

export class BudgetStop extends Error {
  constructor(code, message) { super(message); this.name = 'BudgetStop'; this.code = code; }
}
export function microDollars(usd) {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0 || usd > 1_000_000) throw new Error('Invalid dollar amount.');
  const value = Math.round(usd * 1_000_000);
  if (Math.abs(value / 1_000_000 - usd) > 1e-9) throw new Error('Amounts support at most six decimal places.');
  return value;
}
const iso = value => new Date(value).toISOString();

export function createBudget(db, policy, { clock = () => Date.now() } = {}) {
  const daily = microDollars(policy.dailyCeilingUsd);
  const total = microDollars(policy.pilotCeilingUsd);
  const reserve = microDollars(policy.reserveUsd);
  if (!daily || daily > 25_000_000 || !total || total > 350_000_000 || reserve < 50_000_000) {
    throw new Error('Budget policy exceeds the authorized pilot limits or reduces its reserve.');
  }
  const prices = Object.fromEntries(Object.entries(policy.resourcePricesUsd).map(([kind, price]) => [kind, microDollars(price)]));
  if (!prices.post || !prices.user) throw new Error('Post and user read prices must be configured.');
  const freshnessMs = Math.min(policy.balanceMaxAgeSeconds ?? 300, 300) * 1000;
  if (!(freshnessMs > 0)) throw new Error('Invalid balance freshness setting.');

  function recordBalance({ prepaidUsd, readStartedAt, observedAt = iso(clock()) }) {
    // Free credits can expire; the guard uses verified prepaid credit only.
    if (typeof prepaidUsd !== 'number' || !Number.isFinite(prepaidUsd)) throw new Error('Invalid prepaid balance.');
    const available = microDollars(Math.max(0, prepaidUsd));
    const start = Date.parse(readStartedAt); const end = Date.parse(observedAt); const now = clock();
    if (![start, end].every(Number.isFinite) || end < start || end > now || now - start > freshnessMs) throw new Error('Invalid or stale balance observation.');
    db.prepare(`INSERT INTO balance_observations(available_micro, read_started_at, observed_at, source)
      VALUES (?, ?, ?, 'x-usage-credits')`).run(available, iso(start), iso(end));
  }

  function state() {
    const now = iso(clock()); const day = now.slice(0, 10);
    const observation = db.prepare('SELECT * FROM balance_observations ORDER BY sequence DESC LIMIT 1').get();
    const all = db.prepare('SELECT COALESCE(SUM(accounted_micro),0) AS used FROM budget_requests').get().used;
    const today = db.prepare(`SELECT COALESCE(SUM(accounted_micro),0) AS used FROM budget_requests
      WHERE billing_day=? OR settlement_day=? OR status<>'settled'`).get(day, day).used;
    // Also subtract requests that were in flight during the balance read. This may over-reserve,
    // but cannot assume that a response already includes a concurrent provider charge.
    const afterBalance = observation ? db.prepare(`SELECT COALESCE(SUM(accounted_micro),0) AS used FROM budget_requests
      WHERE started_at>=? OR settled_at>=? OR status<>'settled'`).get(observation.read_started_at, observation.read_started_at).used : 0;
    const fresh = Boolean(observation && clock() - Date.parse(observation.read_started_at) <= freshnessMs && clock() >= Date.parse(observation.observed_at));
    const fault = db.prepare('SELECT code FROM operation_faults WHERE resolved_at IS NULL ORDER BY created_at LIMIT 1').get()?.code ?? null;
    const remainingWallet = observation ? Math.max(0, observation.available_micro - afterBalance - reserve) : 0;
    return { day, totalMicro: all, dailyMicro: today, remainingMicro: fresh && !fault
      ? Math.max(0, Math.min(total - all, daily - today, remainingWallet)) : 0,
      balanceFresh: fresh, balanceVerifiedAt: observation?.observed_at ?? null,
      verifiedPrepaidUsd: observation ? observation.available_micro / 1_000_000 : null,
      fault, requestCount: db.prepare('SELECT COUNT(*) AS n FROM budget_requests').get().n,
      unresolvedRequests: db.prepare("SELECT COUNT(*) AS n FROM budget_requests WHERE status<>'settled'").get().n };
  }

  function reserveRequest({ kind, maxResources, purpose }) {
    if (!Number.isSafeInteger(maxResources) || maxResources < 1 || maxResources > 1000 || !prices[kind]) throw new Error('Invalid resource reservation.');
    if (!['new-posts', 'reconciliation', 'roster'].includes(purpose)) throw new BudgetStop('optional-work-disabled', 'Optional paid enrichment is disabled during this pilot.');
    return atomic(db, () => {
      const s = state();
      if (s.fault) throw new BudgetStop('billing-review-required', 'A billing discrepancy needs review before further requests.');
      if (!s.balanceFresh) throw new BudgetStop('balance-verification-required', 'Refresh the prepaid credit balance before making paid requests.');
      const amount = prices[kind] * maxResources;
      if (amount > s.remainingMicro) throw new BudgetStop('budget-ceiling', 'This request would cross the daily limit, pilot limit, or protected credit reserve.');
      const id = randomUUID(); const now = iso(clock());
      db.prepare(`INSERT INTO budget_requests(id, kind, purpose, max_resources, unit_micro, reserved_micro,
        accounted_micro, status, started_at, billing_day) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`).run(
        id, kind, purpose, maxResources, prices[kind], amount, amount, now, now.slice(0, 10));
      return { id, reservedMicro: amount };
    });
  }

  function settle(id, resourceIds) {
    if (!Array.isArray(resourceIds) || resourceIds.some(id => typeof id !== 'string' || !/^\d+$/.test(id))) throw new Error('Invalid resource result.');
    return atomic(db, () => {
      const request = db.prepare('SELECT * FROM budget_requests WHERE id=?').get(id);
      if (!request) throw new Error('Reservation not found.');
      if (request.status !== 'reserved') throw new Error('Reservation has already been accounted for.');
      const actual = resourceIds.length * request.unit_micro;
      const now = iso(clock());
      if (actual > request.reserved_micro) {
        db.prepare(`UPDATE budget_requests SET status='uncertain', accounted_micro=?, settled_at=?, settlement_day=? WHERE id=?`).run(actual, now, now.slice(0, 10), id);
        db.prepare('INSERT INTO operation_faults(id, code, created_at) VALUES (?, ?, ?)').run(randomUUID(), 'response-exceeded-reservation', now);
        return { fault: 'response-exceeded-reservation' };
      }
      db.prepare(`UPDATE budget_requests SET status='settled', accounted_micro=?, settled_at=?, settlement_day=? WHERE id=?`).run(actual, now, now.slice(0, 10), id);
      for (const resourceId of resourceIds) db.prepare(`INSERT OR IGNORE INTO budget_resources(request_id, kind, resource_id, billing_day) VALUES (?, ?, ?, ?)`).run(id, request.kind, resourceId, request.billing_day);
      return { accountedMicro: actual };
    });
  }

  function uncertain(id, { observedResources = null } = {}) {
    if (observedResources !== null && (!Number.isSafeInteger(observedResources) || observedResources < 0)) throw new Error('Invalid observed resource count.');
    return atomic(db, () => {
      const request = db.prepare('SELECT * FROM budget_requests WHERE id=?').get(id);
      if (!request || request.status !== 'reserved') throw new Error('Reservation is not awaiting accounting.');
      const now = iso(clock());
      const accounted = Math.max(request.reserved_micro, (observedResources ?? 0) * request.unit_micro);
      if (!Number.isSafeInteger(accounted)) throw new Error('Observed cost is outside accounting bounds.');
      db.prepare(`UPDATE budget_requests SET status='uncertain', accounted_micro=?, settled_at=?, settlement_day=? WHERE id=?`).run(accounted, now, now.slice(0, 10), id);
      if (accounted > request.reserved_micro) {
        db.prepare('INSERT INTO operation_faults(id, code, created_at) VALUES (?, ?, ?)').run(randomUUID(), 'response-exceeded-reservation', now);
        return { fault: 'response-exceeded-reservation' };
      }
      return {};
    });
    // Ambiguous requests retain their entire reservation. There is no automatic quota reset/refund.
  }
  return { recordBalance, reserveRequest, settle, uncertain, state };
}
