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
  if (version > 6) throw new Error('This database requires a newer application version.');
  if (version < 2) atomic(db, () => db.exec(`
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
  if (version < 3) atomic(db, () => db.exec(`
    CREATE TABLE roster_snapshots (
      id TEXT PRIMARY KEY, published_on TEXT NOT NULL, retrieved_at TEXT NOT NULL,
      source_url TEXT NOT NULL, congress TEXT NOT NULL, member_count INTEGER NOT NULL,
      valid_until TEXT NOT NULL
    );
    CREATE TABLE roster_members (
      snapshot_id TEXT NOT NULL REFERENCES roster_snapshots(id), member_id TEXT NOT NULL,
      member_name TEXT NOT NULL, state TEXT NOT NULL, district TEXT NOT NULL,
      party TEXT NOT NULL, caucus TEXT NOT NULL, sworn_on TEXT,
      PRIMARY KEY(snapshot_id, member_id)
    );
    CREATE TABLE account_bindings (
      id TEXT PRIMARY KEY, author_id TEXT NOT NULL, member_id TEXT NOT NULL, handle TEXT NOT NULL,
      account_type TEXT NOT NULL, valid_from TEXT NOT NULL, valid_until TEXT NOT NULL,
      verified_at TEXT NOT NULL, evidence_json TEXT NOT NULL
    );
    CREATE INDEX account_bindings_author ON account_bindings(author_id, valid_from, valid_until);
    ALTER TABLE posts ADD COLUMN attribution_json TEXT;
    ALTER TABLE captured_posts ADD COLUMN promotion_attempted_at TEXT;
    CREATE TABLE analysis_runs (
      id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      source_hash TEXT NOT NULL, created_at TEXT NOT NULL, version TEXT NOT NULL,
      analysis_json TEXT NOT NULL
    );
    CREATE INDEX analysis_runs_post ON analysis_runs(post_id, created_at);
    UPDATE schema_version SET version=3;
  `));
  if (version < 4) atomic(db, () => db.exec(`
    CREATE TABLE list_inventory_runs (
      id TEXT PRIMARY KEY, list_id TEXT NOT NULL, status TEXT NOT NULL,
      page_size INTEGER NOT NULL, next_token TEXT, pages INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT, reason TEXT
    );
    CREATE UNIQUE INDEX one_active_inventory ON list_inventory_runs(list_id)
      WHERE status IN ('pending','review-required');
    CREATE TABLE list_inventory_accounts (
      run_id TEXT NOT NULL REFERENCES list_inventory_runs(id), author_id TEXT NOT NULL,
      username TEXT NOT NULL, display_name TEXT NOT NULL, protected INTEGER,
      observed_at TEXT NOT NULL, profile_json TEXT NOT NULL,
      PRIMARY KEY(run_id,author_id)
    );
    CREATE TABLE list_inventory_pages (
      run_id TEXT NOT NULL REFERENCES list_inventory_runs(id), page_number INTEGER NOT NULL,
      request_cursor TEXT, next_cursor TEXT, request_id TEXT NOT NULL REFERENCES budget_requests(id),
      PRIMARY KEY(run_id,page_number)
    );
    CREATE TABLE list_inventories (
      list_id TEXT PRIMARY KEY, current_run_id TEXT REFERENCES list_inventory_runs(id), completed_at TEXT
    );
    CREATE TABLE list_inventory_leases (list_id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_ms INTEGER NOT NULL);
    UPDATE schema_version SET version=4;
  `));
  if (version < 5) atomic(db, () => db.exec(`
    CREATE TABLE learning_holdouts (
      post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
      reserved_at TEXT NOT NULL
    );
    CREATE TABLE learning_holdout_sources (
      post_id TEXT NOT NULL REFERENCES learning_holdouts(post_id) ON DELETE CASCADE,
      text_key TEXT NOT NULL, related_ids_json TEXT NOT NULL,
      PRIMARY KEY(post_id,text_key)
    );
    CREATE TABLE evaluation_sets (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL,
      case_count INTEGER NOT NULL, contract_version TEXT NOT NULL
    );
    CREATE TABLE evaluation_cases (
      set_id TEXT NOT NULL REFERENCES evaluation_sets(id) ON DELETE CASCADE,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      source_hash TEXT NOT NULL, feedback_id TEXT NOT NULL,
      expected_json TEXT NOT NULL,
      PRIMARY KEY(set_id,post_id)
    );
    CREATE TABLE evaluation_runs (
      id TEXT PRIMARY KEY, set_id TEXT NOT NULL REFERENCES evaluation_sets(id) ON DELETE CASCADE,
      provider TEXT NOT NULL, model TEXT NOT NULL, started_at TEXT NOT NULL,
      finished_at TEXT, status TEXT NOT NULL
    );
    CREATE TABLE evaluation_results (
      run_id TEXT NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      status TEXT NOT NULL, source_hash TEXT NOT NULL, feedback_id TEXT NOT NULL,
      input_hash TEXT NOT NULL, example_ids_json TEXT NOT NULL,
      analysis_json TEXT, comparison_json TEXT,
      PRIMARY KEY(run_id,post_id)
    );
    CREATE INDEX evaluation_results_post ON evaluation_results(post_id);
    UPDATE schema_version SET version=5;
  `));
}
