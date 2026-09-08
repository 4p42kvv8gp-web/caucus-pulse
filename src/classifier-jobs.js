import { randomUUID } from 'node:crypto';
import { atomic } from './sqlite.js';
import { classifierFingerprint, localClassifierSpec, entityModelSpec, taxonomy, CLASSIFIER_PROMPT_VERSION } from './classifier-contract.js';
import { prepareAnalysis, commitSemanticAnalysis } from './intelligence.js';

const states = ['pending', 'running', 'completed', 'failed', 'skipped'];
const codes = ['CLASSIFIER_INPUT_LIMIT', 'CLASSIFIER_OUTPUT_LIMIT', 'CLASSIFIER_INVALID_OUTPUT', 'CLASSIFIER_TIMEOUT', 'CLASSIFIER_UNAVAILABLE', 'CLASSIFIER_BUSY', 'CLASSIFIER_ATTEMPT_LIMIT', 'CLASSIFIER_STALE'];
const failure = (message, code = 'CLASSIFIER_STALE') => Object.assign(new Error(message), { code });

export function migrateClassifier(db) {
  if (db.prepare('SELECT version FROM schema_version').get().version >= 8) return;
  atomic(db, () => db.exec(`
    CREATE TABLE classifier_profiles (fingerprint TEXT PRIMARY KEY, profile_json TEXT NOT NULL, registered_at TEXT NOT NULL);
    CREATE TABLE classifier_jobs (
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL REFERENCES classifier_profiles(fingerprint) ON DELETE CASCADE,
      source_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','skipped')),
      attempts INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_expires_ms INTEGER,
      updated_at TEXT NOT NULL, completed_at TEXT, last_error_code TEXT, run_id TEXT REFERENCES analysis_runs(id) ON DELETE SET NULL,
      PRIMARY KEY(post_id,profile_id)
    );
    CREATE INDEX classifier_queue ON classifier_jobs(profile_id,status,lease_expires_ms,post_id);
    CREATE TRIGGER classifier_post_insert AFTER INSERT ON posts BEGIN
      INSERT INTO classifier_jobs(post_id,profile_id,source_hash,status,updated_at)
        SELECT new.id,fingerprint,new.content_hash,'pending',new.captured_at FROM classifier_profiles;
    END;
    CREATE TRIGGER classifier_post_update AFTER UPDATE OF content_hash,text ON posts
      WHEN old.content_hash<>new.content_hash OR old.text<>new.text BEGIN
      UPDATE classifier_jobs SET source_hash=new.content_hash,status='pending',attempts=0,lease_owner=NULL,
        lease_expires_ms=NULL,updated_at=new.captured_at,completed_at=NULL,last_error_code=NULL,run_id=NULL WHERE post_id=new.id;
    END;
    UPDATE schema_version SET version=8;
  `));
}

export function classifierProfile() {
  return { fingerprint: classifierFingerprint, model: localClassifierSpec,entityModel:entityModelSpec,
    taxonomyVersion: taxonomy.version, promptVersion: CLASSIFIER_PROMPT_VERSION, inferenceLocation: localClassifierSpec.inferenceLocation??'local-apple-gpu' };
}

export function registerClassifier(store, now = Date.now()) {
  const profile = classifierProfile(), at = new Date(now).toISOString();
  atomic(store.db, () => {
    const inserted = store.db.prepare('INSERT OR IGNORE INTO classifier_profiles VALUES (?,?,?)').run(profile.fingerprint, JSON.stringify(profile), at).changes;
    if (inserted) store.db.prepare(`INSERT INTO classifier_jobs(post_id,profile_id,source_hash,status,updated_at)
      SELECT id,?,content_hash,'pending',? FROM posts`).run(profile.fingerprint, at);
  });
  return profile;
}

export function classificationStatus(store) {
  const counts = Object.fromEntries(states.map(s => [s, 0]));
  for (const row of store.db.prepare('SELECT status,COUNT(*) AS n FROM classifier_jobs WHERE profile_id=? GROUP BY status').all(classifierFingerprint)) counts[row.status] = row.n;
  return { profile: { fingerprint: classifierFingerprint, model: localClassifierSpec.name, revision: localClassifierSpec.revision,
      taxonomyVersion: taxonomy.version, promptVersion: CLASSIFIER_PROMPT_VERSION },
    registered: Boolean(store.db.prepare('SELECT 1 FROM classifier_profiles WHERE fingerprint=?').get(classifierFingerprint)), ...counts,
    archivePosts: store.db.prepare('SELECT COUNT(*) AS n FROM posts').get().n,
    lastCompletedAt: store.db.prepare('SELECT MAX(completed_at) AS at FROM classifier_jobs WHERE profile_id=?').get(classifierFingerprint).at,
    failureCodes: store.db.prepare(`SELECT last_error_code AS code,COUNT(*) AS count FROM classifier_jobs WHERE profile_id=? AND status IN ('failed','skipped') GROUP BY last_error_code`).all(classifierFingerprint),
    inferenceLocation: localClassifierSpec.inferenceLocation??'local-apple-gpu', outboundInferenceRequests: 0,
    note: 'Provisional source-grounded model output. Human corrections win. No model weights are trained from reviews.' };
}

export function queueClassification(store, postId, sourceHash, { now = Date.now() } = {}) {
  return atomic(store.db, () => {
    const row = store.db.prepare('SELECT content_hash FROM posts WHERE id=?').get(postId);
    if (!row) throw failure('Post not found.', 'CLASSIFIER_NOT_FOUND');
    if (row.content_hash !== sourceHash) throw failure('Source changed; reload before requesting analysis.');
    registerClassifier(store, now);
    const current = store.db.prepare('SELECT status,lease_expires_ms FROM classifier_jobs WHERE post_id=? AND profile_id=?').get(postId, classifierFingerprint);
    if (current.status === 'running' && current.lease_expires_ms > now) return { queued: false, status: 'running' };
    store.db.prepare(`UPDATE classifier_jobs SET source_hash=?,status='pending',attempts=0,lease_owner=NULL,lease_expires_ms=NULL,
      updated_at=?,completed_at=NULL,last_error_code=NULL,run_id=NULL WHERE post_id=? AND profile_id=?`)
      .run(sourceHash, new Date(now).toISOString(), postId, classifierFingerprint);
    return { queued: true, status: 'pending' };
  });
}

export function claimClassification(store, { now = Date.now(), leaseMs = 240000 } = {}) {
  if (!Number.isSafeInteger(now) || !Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 600000) throw new Error('Invalid classifier lease.');
  return atomic(store.db, () => {
    const row = store.db.prepare(`SELECT j.post_id,j.source_hash,j.attempts,n.analysis_json,
      CASE WHEN length(p.text)<=60000 THEN p.text ELSE NULL END AS text FROM classifier_jobs j
      JOIN posts p ON p.id=j.post_id AND p.content_hash=j.source_hash
      LEFT JOIN analyses n ON n.post_id=p.id AND n.source_hash=p.content_hash
      WHERE j.profile_id=? AND (j.status='pending' OR (j.status='running' AND j.lease_expires_ms<=?))
      ORDER BY p.created_at DESC,p.id DESC LIMIT 1`).get(classifierFingerprint, now);
    if (!row) return null;
    if (row.text === null || row.text.length > 60000 || !row.text.trim() || row.attempts >= 3) {
      store.db.prepare(`UPDATE classifier_jobs SET status='skipped',lease_owner=NULL,lease_expires_ms=NULL,updated_at=?,last_error_code=?
        WHERE post_id=? AND profile_id=?`).run(new Date(now).toISOString(), row.attempts >= 3 ? 'CLASSIFIER_ATTEMPT_LIMIT' : 'CLASSIFIER_INPUT_LIMIT', row.post_id, classifierFingerprint);
      return { postId: row.post_id, skipped: true };
    }
    const owner = randomUUID();
    store.db.prepare(`UPDATE classifier_jobs SET status='running',attempts=attempts+1,lease_owner=?,lease_expires_ms=?,updated_at=?,last_error_code=NULL
      WHERE post_id=? AND profile_id=?`).run(owner, now + leaseMs, new Date(now).toISOString(), row.post_id, classifierFingerprint);
    return { postId: row.post_id, sourceHash: row.source_hash, owner, expiresMs: now + leaseMs, priorAnalysis: row.analysis_json ?? null, profileId: classifierFingerprint };
  });
}

function assertClaim(store, claim, now) {
  const row = store.db.prepare(`SELECT j.*,p.content_hash,n.analysis_json FROM classifier_jobs j JOIN posts p ON p.id=j.post_id
    LEFT JOIN analyses n ON n.post_id=p.id AND n.source_hash=p.content_hash WHERE j.post_id=? AND j.profile_id=?`).get(claim.postId, claim.profileId);
  if (!row || row.status !== 'running' || row.lease_owner !== claim.owner || row.lease_expires_ms <= now ||
      row.content_hash !== claim.sourceHash || (row.analysis_json ?? null) !== claim.priorAnalysis) throw failure('Source, analysis or classifier lease changed.');
}

export function finishClassification(store, claim, request, output, now = Date.now()) {
  if (claim.profileId !== classifierFingerprint || request.input.postId !== claim.postId || request.input.sourceHash !== claim.sourceHash) throw failure('Classifier manifest changed.');
  return atomic(store.db, () => {
    const saved = commitSemanticAnalysis({ store, request, result: output.result, providerName: localClassifierSpec.engine==='political-debate-nli'?'Local Political DEBATE':'Local MLX', model: localClassifierSpec.name,
      provenance: { fingerprint: classifierFingerprint, modelRevision: localClassifierSpec.revision, taxonomyVersion: taxonomy.version,
        promptVersion: CLASSIFIER_PROMPT_VERSION, runtime: localClassifierSpec.runtime, entityModel:entityModelSpec?{name:entityModelSpec.name,repository:entityModelSpec.repository,revision:entityModelSpec.revision}:null, metrics: output.metrics, localOnly: true },
      now, guard: () => assertClaim(store, claim, now) });
    const at = new Date(now).toISOString();
    store.db.prepare(`UPDATE classifier_jobs SET status='completed',lease_owner=NULL,lease_expires_ms=NULL,updated_at=?,completed_at=?,last_error_code=NULL,run_id=?
      WHERE post_id=? AND profile_id=?`).run(at, at, saved.runId, claim.postId, classifierFingerprint);
    return { saved: true, postId: claim.postId, runId: saved.runId };
  });
}

export function failClassification(store, claim, code = 'CLASSIFIER_UNAVAILABLE', now = Date.now()) {
  return store.db.prepare(`UPDATE classifier_jobs SET status=?,lease_owner=NULL,lease_expires_ms=NULL,updated_at=?,last_error_code=?
    WHERE post_id=? AND profile_id=? AND status='running' AND lease_owner=? AND source_hash=? AND lease_expires_ms>?`).run(
    code === 'CLASSIFIER_INPUT_LIMIT' ? 'skipped' : 'failed', new Date(now).toISOString(), codes.includes(code) ? code : 'CLASSIFIER_UNAVAILABLE',
    claim.postId, claim.profileId, claim.owner, claim.sourceHash, now).changes;
}

export async function processClassificationJobs(store, runtime, { limit = 5, now = () => Date.now(), leaseMs = 240000, stopping = () => false } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 25 || runtime.fingerprint !== classifierFingerprint) throw new Error('Invalid classifier worker configuration.');
  registerClassifier(store, now());
  const counts = { completed: 0, failed: 0, skipped: 0, stale: 0 };
  for (let i = 0; i < limit && !stopping(); i++) {
    const claim = claimClassification(store, { now: now(), leaseMs });
    if (!claim) break;
    if (claim.skipped) { counts.skipped++; continue; }
    try {
      const request = prepareAnalysis(store, claim.postId, {providerUsesExamples:localClassifierSpec.engine!=='political-debate-nli'});
      const output = await runtime.classify(request);
      finishClassification(store, claim, request, output, now());
      counts.completed++;
    } catch (error) {
      const changed = failClassification(store, claim, error.code, now());
      if (!changed || error.code === 'CLASSIFIER_STALE') counts.stale++;
      else if (error.code === 'CLASSIFIER_INPUT_LIMIT') counts.skipped++; else counts.failed++;
    }
  }
  return counts;
}
