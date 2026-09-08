import { randomUUID } from 'node:crypto';
import { atomic } from './sqlite.js';
import { normalizePost } from './normalize.js';

const iso = ms => new Date(ms).toISOString();
const isId = id => typeof id === 'string' && /^\d+$/.test(id);
const maxId = ids => ids.reduce((a, b) => a == null || BigInt(b) > BigInt(a) ? b : a, null);
const minId = ids => ids.reduce((a, b) => a == null || BigInt(b) < BigInt(a) ? b : a, null);

export function registerListSource(db, listId) {
  if (!isId(listId)) throw new Error('Invalid List ID.');
  const id = `list:${listId}`;
  db.prepare("INSERT OR IGNORE INTO collection_sources(id, kind, resource_id) VALUES (?, 'list', ?)").run(id, listId);
  return id;
}

export function collectionState(db) {
  return db.prepare(`SELECT s.id, s.kind, s.resource_id AS resourceId, s.checkpoint_id AS checkpointId,
    s.initialized_at AS initializedAt, s.last_complete_at AS lastCompleteAt,
    i.status, i.reason, i.pages, i.updated_at AS updatedAt
    FROM collection_sources s LEFT JOIN collection_intervals i ON s.active_interval_id=i.id ORDER BY s.id`).all();
}

export function restartInterval(db, sourceId, { clock = () => Date.now() } = {}) {
  atomic(db, () => {
    const lease = db.prepare('SELECT * FROM collection_leases WHERE source_id=?').get(sourceId);
    if (lease && lease.expires_ms > clock()) throw new Error('Collection is still running.');
    db.prepare(`UPDATE collection_intervals SET next_token=NULL, last_min_id=NULL, status='pending', reason='restarted-from-head', updated_at=?
      WHERE source_id=? AND status<>'complete'`).run(iso(clock()), sourceId);
  });
}

export async function collectOnce({ db, sourceId, fetchPage, budget, pageSize = 100, maxPages = 5, clock = () => Date.now() }) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error('Invalid collection page bounds.');
  const owner = randomUUID(); const leaseMs = 120_000;
  const source = db.prepare('SELECT * FROM collection_sources WHERE id=?').get(sourceId);
  if (!source) throw new Error('Collection source not found.');
  const acquired = atomic(db, () => {
    const held = db.prepare('SELECT * FROM collection_leases WHERE source_id=?').get(sourceId);
    if (held && held.expires_ms > clock()) return false;
    db.prepare(`INSERT INTO collection_leases(source_id, owner, expires_ms) VALUES (?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET owner=excluded.owner, expires_ms=excluded.expires_ms`).run(sourceId, owner, clock() + leaseMs);
    return true;
  });
  if (!acquired) return { status: 'busy', pagesFetched: 0 };
  function assertLease() {
    const held = db.prepare('SELECT * FROM collection_leases WHERE source_id=?').get(sourceId);
    if (!held || held.owner !== owner || held.expires_ms <= clock()) throw new Error('Collection lease expired.');
  }
  let interval;
  function mark(reason, status = 'pending') {
    atomic(db, () => {
      assertLease();
      db.prepare('UPDATE collection_intervals SET reason=?, status=?, updated_at=? WHERE id=?').run(reason, status, iso(clock()), interval.id);
    });
  }
  let pagesFetched = 0;
  try {
    interval = atomic(db, () => {
      assertLease();
      const existing = db.prepare("SELECT * FROM collection_intervals WHERE source_id=? AND status<>'complete'").get(sourceId);
      if (existing) return existing;
      const id = randomUUID(); const now = iso(clock());
      // Re-read inside the writer lock: another worker may have completed before this lease was acquired.
      const latest = db.prepare('SELECT * FROM collection_sources WHERE id=?').get(sourceId);
      const lowerId = latest.initialized_at ? latest.checkpoint_id ?? '0' : null;
      db.prepare(`INSERT INTO collection_intervals(id, source_id, lower_id, status, started_at, updated_at)
        VALUES (?, ?, ?, 'pending', ?, ?)`).run(id, sourceId, lowerId, now, now);
      db.prepare('UPDATE collection_sources SET active_interval_id=? WHERE id=?').run(id, sourceId);
      return db.prepare('SELECT * FROM collection_intervals WHERE id=?').get(id);
    });
    if (interval.status === 'reconciliation-required') return { status: interval.status, reason: interval.reason, pagesFetched };
    for (; pagesFetched < maxPages;) {
      atomic(db, () => { assertLease(); db.prepare('UPDATE collection_leases SET expires_ms=? WHERE source_id=? AND owner=?').run(clock() + leaseMs, sourceId, owner); });
      let reservation;
      try { reservation = budget.reserveRequest({ kind: 'post', maxResources: pageSize, purpose: 'new-posts' }); }
      catch (error) { mark(error.code ?? 'budget-unavailable'); return { status: 'paused', reason: error.code ?? 'budget-unavailable', pagesFetched }; }
      let response;
      try {
        response = await fetchPage({ listId: source.resource_id, paginationToken: interval.next_token, maxResults: pageSize });
        pagesFetched++;
      } catch {
        budget.uncertain(reservation.id); mark('request-failed');
        return { status: 'paused', reason: 'request-failed', pagesFetched };
      }
      const rows = response?.data;
      if (!Array.isArray(rows) || rows.some(p => !isId(p?.id))) {
        budget.uncertain(reservation.id); mark('invalid-response', 'reconciliation-required');
        return { status: 'reconciliation-required', reason: 'invalid-response', pagesFetched };
      }
      // Settlement is independent of page storage: a write failure cannot refund a completed provider read.
      const partial = Array.isArray(response.errors) && response.errors.length > 0;
      const charged = partial && rows.length <= pageSize ? (budget.uncertain(reservation.id), {}) : budget.settle(reservation.id, rows.map(p => p.id));
      if (charged.fault) { mark(charged.fault, 'reconciliation-required'); return { status: 'reconciliation-required', reason: charged.fault, pagesFetched }; }
      const token = response.meta?.next_token ?? null;
      const invalidToken = token != null && (typeof token !== 'string' || !token || token.length > 4096);
      let normalized;
      try { normalized = rows.map(raw => normalizePost(raw, { kind: 'x-list-capture', retrievedAt: iso(clock()), listId: source.resource_id })); }
      catch { mark('invalid-post-shape', 'reconciliation-required'); return { status: 'reconciliation-required', reason: 'invalid-post-shape', pagesFetched }; }
      const ids = rows.map(p => p.id);
      const unordered = ids.some((id, i) => i > 0 && BigInt(id) > BigInt(ids[i - 1]));
      const upper = interval.upper_id ?? maxId(ids);
      const minimum = minId(ids);
      const crossed = interval.lower_id != null && ids.some(id => BigInt(id) <= BigInt(interval.lower_id));
      const bootstrap = interval.lower_id == null;
      const stalled = !bootstrap && !crossed && interval.last_min_id != null && minimum != null && BigInt(minimum) >= BigInt(interval.last_min_id);
      let reason = partial ? 'partial-response' : invalidToken ? 'invalid-cursor' : unordered ? 'unexpected-order' : stalled ? 'pagination-stalled' : null;
      let complete = !reason && (bootstrap || crossed || (interval.lower_id === '0' && !token));
      if (!reason && !complete && !token) reason = 'feed-ended-before-checkpoint';
      if (!reason && !complete && token === interval.next_token) reason = 'repeated-cursor';
      atomic(db, () => {
        assertLease();
        for (const post of normalized) {
          if (db.prepare('SELECT 1 FROM tombstones WHERE post_id=?').get(post.id)) continue;
          db.prepare(`INSERT INTO captured_posts(id, author_id, created_at, captured_at, normalized_json) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET captured_at=excluded.captured_at, normalized_json=excluded.normalized_json,
            promotion_attempted_at=CASE WHEN json_extract(captured_posts.normalized_json,'$.contentHash')<>json_extract(excluded.normalized_json,'$.contentHash') THEN NULL ELSE captured_posts.promotion_attempted_at END,
            status=CASE WHEN json_extract(captured_posts.normalized_json,'$.contentHash')<>json_extract(excluded.normalized_json,'$.contentHash') THEN 'awaiting-roster' ELSE captured_posts.status END`).run(
            post.id, post.authorId, post.createdAt, post.capturedAt, JSON.stringify(post));
          db.prepare('INSERT OR IGNORE INTO collection_deliveries(interval_id, post_id) VALUES (?, ?)').run(interval.id, post.id);
        }
        // On partial/unordered responses, save what arrived but do not move the cursor or upper boundary.
        db.prepare(`UPDATE collection_intervals SET upper_id=?, next_token=?, last_min_id=?, pages=pages+1,
          status=?, reason=?, updated_at=? WHERE id=?`).run(reason ? interval.upper_id : upper,
          reason ? interval.next_token : token, reason ? interval.last_min_id : minimum,
          reason ? 'reconciliation-required' : complete ? 'complete' : 'pending',
          reason ?? (complete ? bootstrap ? 'initial-page-only' : 'checkpoint-reached' : null), iso(clock()), interval.id);
        if (complete) {
          db.prepare(`UPDATE collection_sources SET checkpoint_id=?, initialized_at=COALESCE(initialized_at, ?), last_complete_at=? WHERE id=?`).run(
            upper ?? interval.lower_id ?? '0', iso(clock()), iso(clock()), sourceId);
        }
      });
      interval = db.prepare('SELECT * FROM collection_intervals WHERE id=?').get(interval.id);
      if (complete || reason) return { status: interval.status, reason: interval.reason, pagesFetched };
    }
    mark('page-limit');
    return { status: 'paused', reason: 'page-limit', pagesFetched };
  } finally {
    db.prepare('DELETE FROM collection_leases WHERE source_id=? AND owner=?').run(sourceId, owner);
  }
}
