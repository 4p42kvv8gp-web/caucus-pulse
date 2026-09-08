import { createHash } from 'node:crypto';
import { atomic } from './sqlite.js';

// Conservative duplicate detection, not a claim to detect paraphrases or shared media.
export function textKey(text) {
  return createHash('sha256').update(text.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim()).digest('hex');
}

function relatedIds(post) {
  return [...new Set([post.id, ...post.references.map(r => r.id),
    ...(post.raw?.edit_history_tweet_ids ?? post.raw?.edit_history_post_ids ?? [])].filter(id => typeof id === 'string'))];
}

export function rememberHoldoutSource(db, post) {
  if (!db.prepare('SELECT 1 FROM learning_holdouts WHERE post_id=?').get(post.id)) return;
  const key = textKey(post.text);
  const old = db.prepare('SELECT related_ids_json FROM learning_holdout_sources WHERE post_id=? AND text_key=?').get(post.id, key);
  const ids = [...new Set([...relatedIds(post), ...(old ? JSON.parse(old.related_ids_json) : [])])];
  db.prepare(`INSERT INTO learning_holdout_sources(post_id,text_key,related_ids_json) VALUES (?,?,?)
    ON CONFLICT(post_id,text_key) DO UPDATE SET related_ids_json=excluded.related_ids_json`).run(post.id, key, JSON.stringify(ids));
}

export function reserveHoldouts(store, postIds, { now = Date.now() } = {}) {
  if (!Array.isArray(postIds) || !postIds.length || postIds.length > 100 ||
    postIds.some(id => typeof id !== 'string') || new Set(postIds).size !== postIds.length) throw new Error('Invalid held-out post IDs.');
  return atomic(store.db, () => {
    for (const id of postIds) {
      const row = store.db.prepare('SELECT normalized_json FROM posts WHERE id=?').get(id);
      if (!row) throw new Error('Invalid held-out post: source is missing.');
      store.db.prepare('INSERT OR IGNORE INTO learning_holdouts(post_id,reserved_at) VALUES (?,?)').run(id, new Date(now).toISOString());
      rememberHoldoutSource(store.db, JSON.parse(row.normalized_json));
    }
    return { reserved: postIds.length, note: 'Reserved for evaluation. Existing model runs are unchanged; future example retrieval excludes these sources.' };
  });
}

export function exampleExclusions(store, target, holdoutIds = []) {
  if (!Array.isArray(holdoutIds) || holdoutIds.some(id => typeof id !== 'string')) throw new Error('Invalid holdout IDs.');
  const ids = new Set([target.id, ...holdoutIds]);
  const keys = new Set([textKey(target.text)]);
  for (const id of [...ids]) {
    const row = store.db.prepare('SELECT normalized_json FROM posts WHERE id=?').get(id);
    if (!row) continue;
    const post = JSON.parse(row.normalized_json);
    keys.add(textKey(post.text)); relatedIds(post).forEach(value => ids.add(value));
  }
  for (const row of store.db.prepare('SELECT * FROM learning_holdout_sources').all()) {
    keys.add(row.text_key); JSON.parse(row.related_ids_json).forEach(value => ids.add(value));
  }
  return post => {
    if (ids.has(post.id) || keys.has(textKey(post.text)) || relatedIds(post).some(id => ids.has(id))) return true;
    const row = store.db.prepare('SELECT normalized_json FROM posts WHERE id=?').get(post.id);
    return row ? relatedIds(JSON.parse(row.normalized_json)).some(id => ids.has(id)) : false;
  };
}

export function exampleValidity(store, feedbackIds) {
  return feedbackIds.map(id => {
    const row = store.db.prepare('SELECT post_id,source_hash FROM feedback WHERE id=?').get(id);
    if (!row) return { feedbackId: id, postId: null, status: 'removed' };
    const post = store.getPost(row.post_id);
    const latest = post?.feedback.find(f => f.appliesToCurrentText);
    const heldOut = post && exampleExclusions(store, { id: '', text: '', references: [] })(post);
    return { feedbackId: id, postId: row.post_id,
      status: !post || post.contentHash !== row.source_hash ? 'source-changed'
        : latest?.id !== id ? 'correction-superseded' : heldOut ? 'reserved-for-evaluation' : 'current' };
  });
}

export function learningStatus(store) {
  const db = store.db;
  return {
    reviewedPosts: db.prepare(`SELECT COUNT(DISTINCT f.post_id) AS n FROM feedback f JOIN posts p ON p.id=f.post_id AND p.content_hash=f.source_hash`).get().n,
    heldOutPosts: db.prepare('SELECT COUNT(*) AS n FROM learning_holdouts').get().n,
    evaluationSets: db.prepare('SELECT COUNT(*) AS n FROM evaluation_sets').get().n,
    evaluationRuns: db.prepare('SELECT COUNT(*) AS n FROM evaluation_runs').get().n,
    unfinishedEvaluationRuns: db.prepare("SELECT COUNT(*) AS n FROM evaluation_runs WHERE status='running'").get().n,
    note: 'Reviewed examples guide later requests. No model weights are trained and no general rule is automatically approved.'
  };
}

export function postLearningHistory(store, postId) {
  if (!store.getPost(postId)) throw new Error('Post not found.');
  return {
    role: store.db.prepare('SELECT 1 FROM learning_holdouts WHERE post_id=?').get(postId) ? 'evaluation' : 'teaching',
    runs: store.db.prepare('SELECT * FROM analysis_runs WHERE post_id=? ORDER BY created_at,id').all(postId).map(row => {
      const analysis = JSON.parse(row.analysis_json);
      return { runId: row.id, createdAt: row.created_at, sourceHash: row.source_hash, version: row.version,
        provider: analysis.provider, model: analysis.model, examples: exampleValidity(store, analysis.reviewedExampleIds ?? []),
        restoredFromRun: analysis.restoredFromRun ?? null };
    }),
    note: 'Examples were supplied to these requests. This records exposure, not proof that any one example caused a label.'
  };
}
