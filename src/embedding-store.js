import { randomUUID } from 'node:crypto';
import { atomic } from './sqlite.js';
import { embeddingModel } from './embedding-models.js';

export function migrateEmbeddings(db) {
  if (db.prepare('SELECT version FROM schema_version').get().version >= 7) return;
  atomic(db, () => db.exec(`
    CREATE TABLE embedding_models (
      fingerprint TEXT PRIMARY KEY, model_json TEXT NOT NULL, registered_at TEXT NOT NULL
    );
    CREATE TABLE embedding_jobs (
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL REFERENCES embedding_models(fingerprint) ON DELETE CASCADE,
      source_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','skipped')),
      attempts INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_expires_ms INTEGER,
      updated_at TEXT NOT NULL, completed_at TEXT, last_error TEXT, detail_omitted INTEGER NOT NULL DEFAULT 0,
      detail_duplicates INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(post_id,model_id)
    );
    CREATE INDEX embedding_queue ON embedding_jobs(model_id,status,lease_expires_ms,post_id);
    CREATE TABLE embedding_passages (
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL REFERENCES embedding_models(fingerprint) ON DELETE CASCADE,
      source_hash TEXT NOT NULL, passage_index INTEGER NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
      token_count INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('context-window','sentence')),
      vector BLOB NOT NULL CHECK(length(vector)=1536),
      PRIMARY KEY(post_id,model_id,passage_index)
    );
    CREATE INDEX embedding_model_passages ON embedding_passages(model_id,post_id,source_hash);
    CREATE TRIGGER embedding_post_insert AFTER INSERT ON posts BEGIN
      INSERT INTO embedding_jobs(post_id,model_id,source_hash,status,updated_at)
        SELECT new.id,fingerprint,new.content_hash,'pending',new.captured_at FROM embedding_models;
    END;
    CREATE TRIGGER embedding_post_update AFTER UPDATE OF content_hash,text ON posts
      WHEN old.content_hash<>new.content_hash OR old.text<>new.text BEGIN
      DELETE FROM embedding_passages WHERE post_id=new.id;
      UPDATE embedding_jobs SET source_hash=new.content_hash,status='pending',attempts=0,lease_owner=NULL,
        lease_expires_ms=NULL,updated_at=new.captured_at,completed_at=NULL,last_error=NULL,detail_omitted=0,detail_duplicates=0 WHERE post_id=new.id;
    END;
    UPDATE schema_version SET version=7;
  `));
}

export function registerEmbeddingModel(store, candidate = embeddingModel(), now = Date.now()) {
  const model = embeddingModel(candidate.name);
  if (candidate.fingerprint !== model.fingerprint) throw new Error('Invalid embedding model identity.');
  const at = new Date(now).toISOString();
  return atomic(store.db, () => {
    const inserted = store.db.prepare('INSERT OR IGNORE INTO embedding_models VALUES (?,?,?)')
      .run(model.fingerprint,JSON.stringify(model),at).changes;
    if (inserted) store.db.prepare(`INSERT INTO embedding_jobs(post_id,model_id,source_hash,status,updated_at)
      SELECT id,?,content_hash,'pending',? FROM posts`).run(model.fingerprint,at);
    return model;
  });
}

export function embeddingStatus(store, name = 'minilm') {
  const model = embeddingModel(name), db = store.db;
  const counts = Object.fromEntries(['pending','running','completed','failed','skipped'].map(s => [s,0]));
  for (const row of db.prepare('SELECT status,COUNT(*) AS n FROM embedding_jobs WHERE model_id=? GROUP BY status').all(model.fingerprint)) counts[row.status]=row.n;
  const details = db.prepare(`SELECT COUNT(*) AS passages,COUNT(DISTINCT e.post_id) AS indexedPosts FROM embedding_passages e
    JOIN posts p ON p.id=e.post_id AND p.content_hash=e.source_hash WHERE model_id=?`).get(model.fingerprint);
  return { model: { name:model.name,repository:model.repository,revision:model.revision,fingerprint:model.fingerprint,
    dimensions:model.dimensions,passageVersion:model.passageVersion },
    registered:Boolean(db.prepare('SELECT 1 FROM embedding_models WHERE fingerprint=?').get(model.fingerprint)),
    ...counts,...details,archivePosts:db.prepare('SELECT COUNT(*) AS n FROM posts').get().n,
    lastCompletedAt:db.prepare('SELECT MAX(completed_at) AS at FROM embedding_jobs WHERE model_id=?').get(model.fingerprint).at,
    inferenceLocation:'local-cpu',outboundInferenceRequests:0 };
}

export function claimEmbeddingJob(store, model = embeddingModel(), { now = Date.now(),leaseMs = 120000 } = {}) {
  if (!Number.isSafeInteger(now) || !Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 600000) throw new Error('Invalid embedding lease.');
  return atomic(store.db, () => {
    const row = store.db.prepare(`SELECT j.post_id,j.source_hash,j.attempts,
      CASE WHEN length(p.text)<=? THEN p.text ELSE NULL END AS text FROM embedding_jobs j
      JOIN posts p ON p.id=j.post_id AND p.content_hash=j.source_hash
      WHERE j.model_id=? AND (j.status='pending' OR (j.status='running' AND j.lease_expires_ms<=?))
      ORDER BY p.created_at DESC,p.id DESC LIMIT 1`).get(model.maxCharacters,model.fingerprint,now);
    if (!row) return null;
    const owner=randomUUID(),at=new Date(now).toISOString();
    if (row.text === null || row.text.length > model.maxCharacters || !row.text.trim() || row.attempts >= 3) {
      const reason=row.attempts >= 3 ? 'Attempt limit reached; inspect before retrying.' : 'Source exceeds local embedding limits or contains no text.';
      store.db.prepare(`UPDATE embedding_jobs SET status='skipped',lease_owner=NULL,lease_expires_ms=NULL,updated_at=?,last_error=?
        WHERE post_id=? AND model_id=?`).run(at,reason,row.post_id,model.fingerprint);
      return { postId:row.post_id,skipped:true };
    }
    store.db.prepare(`UPDATE embedding_jobs SET status='running',attempts=attempts+1,lease_owner=?,lease_expires_ms=?,updated_at=?,last_error=NULL
      WHERE post_id=? AND model_id=?`).run(owner,now+leaseMs,at,row.post_id,model.fingerprint);
    return { postId:row.post_id,sourceHash:row.source_hash,text:row.text,owner,modelFingerprint:model.fingerprint,expiresMs:now+leaseMs };
  });
}

function encodeVector(vector, dimensions) {
  if (!Array.isArray(vector) || vector.length !== dimensions || vector.some(v => !Number.isFinite(v))) throw new Error('Invalid embedding vector.');
  const norm=Math.sqrt(vector.reduce((n,v) => n+v*v,0));
  if (Math.abs(norm-1)>0.001) throw new Error('Invalid embedding vector normalization.');
  const bytes=Buffer.alloc(dimensions*4);
  vector.forEach((value,i) => bytes.writeFloatLE(value,i*4));
  return bytes;
}

export function finishEmbeddingJob(store, claim, result, model = embeddingModel(), now = Date.now()) {
  const duplicates=result?.detailDuplicateOccurrences??0;
  if (!claim || claim.modelFingerprint !== model.fingerprint || result?.modelFingerprint !== model.fingerprint ||
      result.textLength !== claim.text.length || result.coveredCharacters !== claim.text.length || !Number.isInteger(result.detailOmitted) || result.detailOmitted<0 ||
      !Number.isInteger(duplicates) || duplicates<0 ||
      !Array.isArray(result.passages) || !result.passages.length || result.passages.length > model.maxPassages) throw new Error('Invalid embedding result manifest.');
  let covered=0, previousStart=-1;
  const rows=result.passages.map((p,index) => {
    if (p.index !== index || !Number.isInteger(p.start) || !Number.isInteger(p.end) || p.start<0 || p.end<=p.start || p.end>claim.text.length ||
        p.start>covered || p.start<previousStart || p.text!==claim.text.slice(p.start,p.end) || !p.text.isWellFormed() ||
        !Number.isInteger(p.tokenCount) || p.tokenCount<1 || p.tokenCount>model.maxTokens || !['context-window','sentence'].includes(p.kind)) throw new Error('Invalid or incomplete embedding passage coverage.');
    previousStart=p.start; covered=Math.max(covered,p.end);
    return {...p,bytes:encodeVector(p.vector,model.dimensions)};
  });
  if (covered!==claim.text.length) throw new Error('Invalid or incomplete embedding passage coverage.');
  return atomic(store.db, () => {
    const current=store.db.prepare(`SELECT j.status,j.lease_owner,j.lease_expires_ms,p.content_hash FROM embedding_jobs j
      JOIN posts p ON p.id=j.post_id WHERE j.post_id=? AND j.model_id=?`).get(claim.postId,model.fingerprint);
    if (!current || current.status!=='running' || current.lease_owner!==claim.owner || current.lease_expires_ms<=now || current.content_hash!==claim.sourceHash) return { saved:false,reason:'stale-source-or-lease' };
    store.db.prepare('DELETE FROM embedding_passages WHERE post_id=? AND model_id=?').run(claim.postId,model.fingerprint);
    const insert=store.db.prepare('INSERT INTO embedding_passages VALUES (?,?,?,?,?,?,?,?,?)');
    for (const p of rows) insert.run(claim.postId,model.fingerprint,claim.sourceHash,p.index,p.start,p.end,p.tokenCount,p.kind,p.bytes);
    const at=new Date(now).toISOString();
    store.db.prepare(`UPDATE embedding_jobs SET status='completed',lease_owner=NULL,lease_expires_ms=NULL,updated_at=?,completed_at=?,last_error=NULL,detail_omitted=?,detail_duplicates=?
      WHERE post_id=? AND model_id=?`).run(at,at,result.detailOmitted,duplicates,claim.postId,model.fingerprint);
    return { saved:true,postId:claim.postId,passages:rows.length };
  });
}

export function failEmbeddingJob(store,claim,{now=Date.now(),limitExceeded=false}={}) {
  return store.db.prepare(`UPDATE embedding_jobs SET status=?,lease_owner=NULL,lease_expires_ms=NULL,updated_at=?,last_error=?
    WHERE post_id=? AND model_id=? AND status='running' AND lease_owner=? AND source_hash=? AND lease_expires_ms>?`).run(
    limitExceeded?'skipped':'failed',new Date(now).toISOString(),
    limitExceeded?'Source exceeds local embedding limits; full text remains archived.':'Local embedding failed; source retained. Inspect before retrying.',
    claim.postId,claim.modelFingerprint,claim.owner,claim.sourceHash,now).changes;
}

export async function processEmbeddingJobs(store,runtime,{limit=25,now=()=>Date.now(),leaseMs=120000}={}) {
  if (!Number.isInteger(limit) || limit<1 || limit>100) throw new Error('Invalid embedding worker limit.');
  const model=registerEmbeddingModel(store,runtime.model,now());
  const counts={completed:0,failed:0,skipped:0,stale:0};
  for (let i=0;i<limit;i++) {
    const claim=claimEmbeddingJob(store,model,{now:now(),leaseMs});
    if (!claim) break;
    if (claim.skipped) { counts.skipped++; continue; }
    try {
      const result=await runtime.embedPost(claim.text);
      const saved=finishEmbeddingJob(store,claim,result,model,now());
      if (saved.saved) counts.completed++; else counts.stale++;
    } catch (error) {
      const limitExceeded=/^Source exceeds the embedding (character|passage) limit\.$/.test(error.message);
      const changed=failEmbeddingJob(store,claim,{now:now(),limitExceeded});
      if (!changed) counts.stale++;
      else if (limitExceeded) counts.skipped++; else counts.failed++;
    }
  }
  return counts;
}
