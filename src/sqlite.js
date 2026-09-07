import { randomUUID } from 'node:crypto';

export function atomic(db, fn) {
  const nested = db.isTransaction;
  const savepoint = `s${randomUUID().replaceAll('-', '')}`;
  db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  try {
    const result = fn();
    if (result && typeof result.then === 'function') throw new Error('Database transactions must be synchronous.');
    db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
    return result;
  } catch (error) {
    if (nested) db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
    else db.exec('ROLLBACK');
    throw error;
  }
}

export function migrateOperations(db) {
  const version = db.prepare('SELECT version FROM schema_version').get().version;
  if (version > 2) throw new Error('This database requires a newer application version.');
  if (version === 2) return;
  atomic(db, () => db.exec(`
    CREATE TABLE budget_requests (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
      kind TEXT NOT NULL, purpose TEXT NOT NULL, max_resources INTEGER NOT NULL,
      unit_micro INTEGER NOT NULL, reserved_micro INTEGER NOT NULL, accounted_micro INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('reserved','settled','uncertain')),
      started_at TEXT NOT NULL, settled_at TEXT, billing_day TEXT NOT NULL, settlement_day TEXT
    );
    CREATE TABLE budget_resources (
      request_id TEXT NOT NULL REFERENCES budget_requests(id), kind TEXT NOT NULL,
      resource_id TEXT NOT NULL, billing_day TEXT NOT NULL,
      PRIMARY KEY(request_id, resource_id, kind)
    );
    CREATE TABLE balance_observations (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, available_micro INTEGER NOT NULL,
      read_started_at TEXT NOT NULL, observed_at TEXT NOT NULL, source TEXT NOT NULL
    );
    CREATE TABLE operation_faults (
      id TEXT PRIMARY KEY, code TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT
    );
    CREATE TABLE collection_sources (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind='list'), resource_id TEXT NOT NULL,
      checkpoint_id TEXT, initialized_at TEXT, last_complete_at TEXT, active_interval_id TEXT
    );
    CREATE TABLE collection_intervals (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES collection_sources(id),
      lower_id TEXT, upper_id TEXT, next_token TEXT, last_min_id TEXT,
      pages INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, reason TEXT,
      started_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX one_pending_interval ON collection_intervals(source_id) WHERE status <> 'complete';
    CREATE TABLE collection_leases (
      source_id TEXT PRIMARY KEY REFERENCES collection_sources(id), owner TEXT NOT NULL, expires_ms INTEGER NOT NULL
    );
    CREATE TABLE captured_posts (
      id TEXT PRIMARY KEY, author_id TEXT NOT NULL, created_at TEXT NOT NULL,
      captured_at TEXT NOT NULL, normalized_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'awaiting-roster'
    );
    CREATE TABLE collection_deliveries (
      interval_id TEXT NOT NULL REFERENCES collection_intervals(id), post_id TEXT NOT NULL,
      PRIMARY KEY(interval_id, post_id)
    );
    UPDATE schema_version SET version=2;
  `));
}
