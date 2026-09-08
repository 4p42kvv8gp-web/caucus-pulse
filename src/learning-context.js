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
  const latest=`WITH latest AS (SELECT f.post_id,f.feedback_json FROM feedback f JOIN posts p ON p.id=f.post_id AND p.content_hash=f.source_hash
    WHERE f.sequence=(SELECT sequence FROM feedback newer WHERE newer.post_id=f.post_id AND newer.source_hash=f.source_hash ORDER BY sequence DESC LIMIT 1)),
    decisions AS (SELECT *,COALESCE(json_extract(feedback_json,'$.decision'),CASE WHEN json_array_length(feedback_json,'$.labels')>0 THEN 'classified' ELSE 'needs-context' END) AS decision FROM latest)`;
  const decisions=db.prepare(`${latest} SELECT COUNT(*) AS reviewedPosts,
    COALESCE(SUM(decision='classified'),0) AS classifiedReviews,COALESCE(SUM(decision='no-supported-topic'),0) AS explicitEmptyReviews,
    COALESCE(SUM(decision='needs-context'),0) AS unresolvedReviews,
    COALESCE(SUM(length(trim(COALESCE(json_extract(feedback_json,'$.ruleProposal'),'')))>0),0) AS proposedRules FROM decisions`).get();
  const labels=`FROM decisions d,json_each(CASE WHEN d.decision='classified' THEN json_extract(d.feedback_json,'$.labels') ELSE '[]' END) label`;
  const topicCoverage=db.prepare(`${latest} SELECT json_extract(label.value,'$.topic') AS topic,COUNT(DISTINCT d.post_id) AS reviewedPosts ${labels}
    GROUP BY topic ORDER BY reviewedPosts DESC,topic LIMIT 25`).all();
  const topicCount=db.prepare(`${latest} SELECT COUNT(DISTINCT json_extract(label.value,'$.topic')) AS n ${labels}`).get().n;
  return {
    ...decisions,topicCoverage,topicCount,topicsOmitted:Math.max(0,topicCount-topicCoverage.length),
    heldOutPosts: db.prepare('SELECT COUNT(*) AS n FROM learning_holdouts').get().n,
    evaluationSets: db.prepare('SELECT COUNT(*) AS n FROM evaluation_sets').get().n,
    evaluationRuns: db.prepare('SELECT COUNT(*) AS n FROM evaluation_runs').get().n,
    unfinishedEvaluationRuns: db.prepare("SELECT COUNT(*) AS n FROM evaluation_runs WHERE status='running'").get().n,
    automaticTraining:false,
    note: 'Saved decisions update their source posts. The selected fixed-hypothesis classifier does not consume reviewed examples or retrain itself. Broader changes need separate evaluation; review counts alone do not establish training readiness.'
  };
}

export function postLearningHistory(store, postId) {
  if (!store.getPost(postId)) throw new Error('Post not found.');
  const runCount=store.db.prepare('SELECT COUNT(*) AS n FROM analysis_runs WHERE post_id=?').get(postId).n;
  return {
    role: store.db.prepare('SELECT 1 FROM learning_holdouts WHERE post_id=?').get(postId) ? 'evaluation' : 'teaching',
    runCount,runsOmitted:Math.max(0,runCount-50),
    runs: store.db.prepare('SELECT * FROM analysis_runs WHERE post_id=? ORDER BY created_at DESC,id DESC LIMIT 50').all(postId).map(row => {
      const analysis = JSON.parse(row.analysis_json);
      return { runId: row.id, createdAt: row.created_at, sourceHash: row.source_hash, version: row.version,
        provider: analysis.provider, model: analysis.model, examples: exampleValidity(store, analysis.reviewedExampleIds ?? []),
        restoredFromRun: analysis.restoredFromRun ?? null };
    }),
    note: 'Up to 50 newest semantic runs. Example lists record what a request received; an empty list means no reviewed examples were supplied. Exposure is not proof of a causal effect on a label.'
  };
}
