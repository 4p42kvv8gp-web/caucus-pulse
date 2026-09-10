import { randomUUID } from 'node:crypto';
import { atomic } from './sqlite.js';

const iso = ms => new Date(ms).toISOString();
const validId = id => typeof id === 'string' && /^\d{1,25}$/.test(id);
const validToken = token => token === null || (typeof token === 'string' && token.length > 0 && token.length <= 4096);
const leaseMs = 120_000;
const scanMaxAgeMs = 3_600_000;

export function inventoryState(db, listId, { clock = () => Date.now() } = {}) {
  const current = db.prepare(`SELECT r.* FROM list_inventories i JOIN list_inventory_runs r ON r.id=i.current_run_id
    WHERE i.list_id=?`).get(listId);
  const active = db.prepare("SELECT * FROM list_inventory_runs WHERE list_id=? AND status IN ('pending','review-required')").get(listId);
  const describe = run => run ? { id: run.id, status: run.status, pages: run.pages, pageSize: run.page_size, startedAt: run.started_at,
    completedAt: run.completed_at, updatedAt: run.updated_at, reason: run.reason,
    accounts: db.prepare('SELECT COUNT(*) AS n FROM list_inventory_accounts WHERE run_id=?').get(run.id).n } : null;
  return { listId, current: describe(current), active: describe(active),
    fresh: Boolean(current && clock() >= Date.parse(current.completed_at) && clock() - Date.parse(current.started_at) <= 86_400_000),
    note: 'A completed pagination scan is an observed List inventory, not proof of member identity or an atomic snapshot of a changing List.' };
}

export function inventoryAccounts(db, listId) {
  return db.prepare(`SELECT a.author_id AS authorId, a.username, a.display_name AS displayName,
    a.protected, a.observed_at AS observedAt, a.run_id AS inventoryRunId
    FROM list_inventories i JOIN list_inventory_accounts a ON a.run_id=i.current_run_id
    WHERE i.list_id=? ORDER BY a.username COLLATE NOCASE,a.author_id`).all(listId);
}

export function abandonInventory(db, listId, { clock = () => Date.now() } = {}) {
  return atomic(db, () => {
    const lease = db.prepare('SELECT * FROM list_inventory_leases WHERE list_id=?').get(listId);
    if (lease && lease.expires_ms > clock()) throw new Error('List inventory is still running.');
    return db.prepare(`UPDATE list_inventory_runs SET status='abandoned',reason='operator-restart',updated_at=?
      WHERE list_id=? AND status IN ('pending','review-required')`).run(iso(clock()), listId).changes;
  });
}

export async function syncListInventory({ db, listId, fetchPage, budget, pageSize = 100, maxPages = 3, clock = () => Date.now() }) {
  if (!validId(listId) || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
    !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10 || typeof fetchPage !== 'function') throw new Error('Invalid inventory request bounds.');
  const owner = randomUUID();
  const acquired = atomic(db, () => {
    const lease = db.prepare('SELECT * FROM list_inventory_leases WHERE list_id=?').get(listId);
    if (lease && lease.expires_ms > clock()) return false;
    db.prepare(`INSERT INTO list_inventory_leases(list_id,owner,expires_ms) VALUES (?,?,?)
      ON CONFLICT(list_id) DO UPDATE SET owner=excluded.owner,expires_ms=excluded.expires_ms`).run(listId, owner, clock() + leaseMs);
    return true;
  });
  if (!acquired) return { status: 'busy', pagesFetched: 0 };
  function assertLease() {
    const lease = db.prepare('SELECT * FROM list_inventory_leases WHERE list_id=?').get(listId);
    if (!lease || lease.owner !== owner || lease.expires_ms <= clock()) throw new Error('List inventory lease expired.');
  }
  let run; let pagesFetched = 0;
  function mark(reason, status = 'pending') {
    atomic(db, () => { assertLease(); db.prepare('UPDATE list_inventory_runs SET status=?,reason=?,updated_at=? WHERE id=?').run(status, reason, iso(clock()), run.id); });
    return { status: status === 'pending' ? 'paused' : status, reason, pagesFetched };
  }
  try {
    run = atomic(db, () => {
      assertLease();
      const existing = db.prepare("SELECT * FROM list_inventory_runs WHERE list_id=? AND status IN ('pending','review-required')").get(listId);
      if (existing) return existing;
      const id = randomUUID(); const now = iso(clock());
      db.prepare(`INSERT INTO list_inventory_runs(id,list_id,status,page_size,started_at,updated_at)
        VALUES (?,?,'pending',?,?,?)`).run(id, listId, pageSize, now, now);
      return db.prepare('SELECT * FROM list_inventory_runs WHERE id=?').get(id);
    });
    if (run.status === 'review-required') return { status: run.status, reason: run.reason, pagesFetched };
    if (run.page_size !== pageSize) throw new Error('Invalid resume page size. Use the original scan page size or explicitly restart the inventory.');
    // The original page size is retained for a resumed provider cursor.
    while (pagesFetched < maxPages) {
      if (clock() - Date.parse(run.started_at) > scanMaxAgeMs) return mark('scan-expired', 'review-required');
      atomic(db, () => { assertLease(); db.prepare('UPDATE list_inventory_leases SET expires_ms=? WHERE list_id=? AND owner=?').run(clock() + leaseMs, listId, owner); });
      let reservation;
      try { reservation = budget.reserveRequest({ kind: 'user', maxResources: run.page_size, purpose: 'roster' }); }
      catch (error) { return mark(error.code ?? 'budget-unavailable'); }
      let response;
      try {
        response = await fetchPage({ listId, paginationToken: run.next_token, maxResults: run.page_size });
        pagesFetched++;
      } catch { budget.uncertain(reservation.id); return mark('request-failed'); }
      const rows = response?.data;
      const invalidIds = !Array.isArray(rows) || rows.some(row => !validId(row?.id));
      const partial = response?.errors != null && (!Array.isArray(response.errors) || response.errors.length > 0);
      // Account for a read before storing it; malformed or partial responses retain the maximum reservation.
      const charged = invalidIds || partial
        ? budget.uncertain(reservation.id, { observedResources: Array.isArray(rows) ? rows.length : null })
        : budget.settle(reservation.id, rows.map(row => row.id));
      if (charged.fault) return mark(charged.fault, 'review-required');
      if (invalidIds) return mark('invalid-profile-ids', 'review-required');
      if (rows.some(row => typeof row.username !== 'string' || !/^[A-Za-z0-9_]{1,15}$/.test(row.username) || typeof row.name !== 'string' ||
        !row.name.trim() || row.name.length > 200 || (row.protected != null && typeof row.protected !== 'boolean'))) return mark('invalid-profile-shape', 'review-required');
      const token = response.meta?.next_token ?? null;
      let reason = partial ? 'partial-response' : !validToken(token) ? 'invalid-cursor'
        : response.meta?.result_count != null && response.meta.result_count !== rows.length ? 'inconsistent-result-count'
        : !rows.length && token !== null ? 'empty-page-with-cursor' : null;
      atomic(db, () => {
        assertLease();
        // A List can change during pagination. Repeated accounts, conflicting handles, or cursor cycles
        // retain diagnostic observations but cannot replace the last complete inventory.
        const priorIds = new Set(db.prepare('SELECT author_id FROM list_inventory_accounts WHERE run_id=?').all(run.id).map(r => r.author_id));
        const priorHandles = new Map(db.prepare('SELECT author_id,username FROM list_inventory_accounts WHERE run_id=?').all(run.id).map(r => [r.username.toLowerCase(),r.author_id]));
        for (const row of rows) {
          if (priorIds.has(row.id)) reason ??= 'repeated-account-during-scan';
          const handleOwner = priorHandles.get(row.username.toLowerCase());
          if (handleOwner && handleOwner !== row.id) reason ??= 'conflicting-profile-handles';
          priorIds.add(row.id); priorHandles.set(row.username.toLowerCase(), row.id);
          const profile = { id: row.id, username: row.username, name: row.name, protected: row.protected ?? null };
          db.prepare(`INSERT OR IGNORE INTO list_inventory_accounts(run_id,author_id,username,display_name,protected,observed_at,profile_json)
            VALUES (?,?,?,?,?,?,?)`).run(run.id, row.id, row.username, row.name, row.protected == null ? null : Number(row.protected), iso(clock()), JSON.stringify(profile));
        }
        if (validToken(token) && token !== null && (token === run.next_token || db.prepare('SELECT 1 FROM list_inventory_pages WHERE run_id=? AND request_cursor=?').get(run.id, token))) reason ??= 'cursor-cycle';
        if (clock() - Date.parse(run.started_at) > scanMaxAgeMs) reason ??= 'scan-expired';
        db.prepare(`INSERT INTO list_inventory_pages(run_id,page_number,request_cursor,next_cursor,request_id) VALUES (?,?,?,?,?)`)
          .run(run.id, run.pages + 1, run.next_token, validToken(token) ? token : null, reservation.id);
        const complete = !reason && token === null; const now = iso(clock());
        db.prepare(`UPDATE list_inventory_runs SET pages=pages+1,status=?,reason=?,next_token=?,updated_at=?,completed_at=? WHERE id=?`)
          .run(reason ? 'review-required' : complete ? 'complete' : 'pending', reason, reason ? run.next_token : token, now, complete ? now : null, run.id);
        if (complete) db.prepare(`INSERT INTO list_inventories(list_id,current_run_id,completed_at) VALUES (?,?,?)
          ON CONFLICT(list_id) DO UPDATE SET current_run_id=excluded.current_run_id,completed_at=excluded.completed_at`).run(listId, run.id, now);
      });
      run = db.prepare('SELECT * FROM list_inventory_runs WHERE id=?').get(run.id);
      if (run.status !== 'pending') return { status: run.status, reason: run.reason, pagesFetched };
    }
    return mark('page-limit');
  } finally { db.prepare('DELETE FROM list_inventory_leases WHERE list_id=? AND owner=?').run(listId, owner); }
}
