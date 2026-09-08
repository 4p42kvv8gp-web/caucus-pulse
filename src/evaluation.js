import { randomUUID } from 'node:crypto';
import { atomic } from './sqlite.js';
import { baselineClassify, BASELINE_VERSION } from './classify.js';
import { prepareAnalysis, validateSemanticResult, INTELLIGENCE_VERSION } from './intelligence.js';
import { reserveHoldouts, exampleValidity } from './learning-context.js';

const MAX_CASES = 25;
function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 120) throw new Error('Invalid evaluation name or model.');
  return value.trim();
}
function latestReview(post) { return post?.feedback.find(f => f.appliesToCurrentText); }
function caseState(store, row) {
  const post = store.getPost(row.post_id);
  return !post ? 'source-removed' : post.contentHash !== row.source_hash ? 'source-changed'
    : latestReview(post)?.id !== row.feedback_id ? 'correction-superseded' : 'current';
}

export function createEvaluationSet(store, { title, postIds, now = Date.now() }) {
  name(title);
  if (!Array.isArray(postIds) || !postIds.length || postIds.length > MAX_CASES ||
      new Set(postIds).size !== postIds.length || postIds.some(id => typeof id !== 'string')) throw new Error('Invalid evaluation cases: choose 1–25 distinct reviewed posts.');
  return atomic(store.db, () => {
    const cases = postIds.map(id => {
      const post = store.getPost(id);
      const review = latestReview(post);
      if (!post || !review) throw new Error('Invalid evaluation case: each current source needs a saved human correction.');
      if (review.decision === 'needs-context' || (!review.labels.length && review.decision !== 'no-supported-topic'))
        throw new Error('Invalid evaluation case: an unresolved interpretation is not an expected answer.');
      return { post, review };
    });
    reserveHoldouts(store, postIds, { now });
    const id = randomUUID();
    store.db.prepare('INSERT INTO evaluation_sets(id,name,created_at,case_count,contract_version) VALUES (?,?,?,?,?)')
      .run(id, title.trim(), new Date(now).toISOString(), cases.length, INTELLIGENCE_VERSION);
    for (const { post, review } of cases) store.db.prepare(`INSERT INTO evaluation_cases
      (set_id,post_id,source_hash,feedback_id,expected_json) VALUES (?,?,?,?,?)`)
      .run(id, post.id, post.contentHash, review.id, JSON.stringify(review.labels));
    return evaluationSet(store, id);
  });
}

export function evaluationSet(store, setId) {
  const row = store.db.prepare('SELECT * FROM evaluation_sets WHERE id=?').get(setId);
  if (!row) throw new Error('Invalid evaluation set.');
  const cases = store.db.prepare('SELECT * FROM evaluation_cases WHERE set_id=? ORDER BY post_id').all(setId);
  return { id: row.id, title: row.name, createdAt: row.created_at, contractVersion: row.contract_version,
    originalCases: row.case_count, removedCases: row.case_count - cases.length,
    cases: cases.map(c => ({ postId: c.post_id, sourceHash: c.source_hash, feedbackId: c.feedback_id,
      expected: JSON.parse(c.expected_json), state: caseState(store, c) })),
    note: 'Frozen topic/subtopic corrections. This does not evaluate stance, event location, novelty, or explanation quality.' };
}

// Exact label-set agreement evaluates the classifier, never the member or their position.
export function compareLabels(expected, actual) {
  const key = label => JSON.stringify([label.topic, label.subtopic ?? null]);
  const expectedMap = new Map(expected.map(l => [key(l), { topic: l.topic, subtopic: l.subtopic ?? null }]));
  const actualMap = new Map(actual.map(l => [key(l), { topic: l.topic, subtopic: l.subtopic ?? null }]));
  const missing = [...expectedMap].filter(([k]) => !actualMap.has(k)).map(([, v]) => v);
  const extra = [...actualMap].filter(([k]) => !expectedMap.has(k)).map(([, v]) => v);
  return { exactMatch: missing.length === 0 && extra.length === 0, missing, extra };
}

export function evaluationReport(store, runId) {
  const run = store.db.prepare('SELECT * FROM evaluation_runs WHERE id=?').get(runId);
  if (!run) throw new Error('Invalid evaluation run.');
  const set = evaluationSet(store, run.set_id);
  const casesById = new Map(set.cases.map(c => [c.postId, c]));
  const cases = store.db.prepare('SELECT * FROM evaluation_results WHERE run_id=? ORDER BY post_id').all(runId).map(r => {
    const examples = exampleValidity(store, JSON.parse(r.example_ids_json));
    const validity = casesById.get(r.post_id)?.state ?? 'source-removed';
    return { postId: r.post_id, sourceHash: r.source_hash, feedbackId: r.feedback_id, status: r.status,
      validity: validity !== 'current' ? validity : examples.some(e => e.status !== 'current') ? 'examples-changed' : 'current',
      inputHash: r.input_hash, examples,
      expected: casesById.get(r.post_id)?.expected ?? null,
      analysis: r.analysis_json ? JSON.parse(r.analysis_json) : null,
      comparison: r.comparison_json ? JSON.parse(r.comparison_json) : null };
  });
  const usable = cases.filter(c => c.status === 'completed' && c.validity === 'current');
  return { runId, setId: run.set_id, title: set.title, provider: run.provider, model: run.model,
    status: run.status, startedAt: run.started_at, finishedAt: run.finished_at,
    counts: { planned: set.originalCases, removed: set.removedCases, usable: usable.length,
      exactMatches: usable.filter(c => c.comparison.exactMatch).length,
      disagreements: usable.filter(c => !c.comparison.exactMatch).length,
      failed: cases.filter(c => ['provider-failed','invalid-output'].includes(c.status)).length,
      stale: cases.filter(c => c.validity !== 'current').length,
      unfinished: cases.filter(c => c.status === 'pending').length },
    cases, note: 'Exact subject-label comparison only. Missing, failed, removed, or outdated cases are never counted as correct. Results do not change the dashboard or approve a model.' };
}

export async function runEvaluation({ store, setId, provider, providerName, model, now = () => Date.now() }) {
  if (typeof provider !== 'function') throw new Error('An evaluation provider must be explicitly connected.');
  name(providerName); name(model);
  const runId = randomUUID();
  // Snapshot every input in one transaction; held-out answers are not part of the provider input.
  const plan = atomic(store.db, () => {
    const set = evaluationSet(store, setId);
    if (set.removedCases || set.cases.some(c => c.state !== 'current')) throw new Error('Invalid evaluation set: source or correction changed; create a new version.');
    if (set.contractVersion !== INTELLIGENCE_VERSION) throw new Error('Invalid evaluation set: classification contract changed; create a new version.');
    const items = set.cases.map(c => {
      const request = prepareAnalysis(store, c.postId, { holdoutIds: set.cases.map(c => c.postId) });
      return { ...c, request, post: store.getPost(c.postId) };
    });
    store.db.prepare(`INSERT INTO evaluation_runs(id,set_id,provider,model,started_at,status) VALUES (?,?,?,?,?,'running')`)
      .run(runId, setId, providerName, model, new Date(now()).toISOString());
    for (const item of items) store.db.prepare(`INSERT INTO evaluation_results
      (run_id,post_id,status,source_hash,feedback_id,input_hash,example_ids_json) VALUES (?,?,'pending',?,?,?,?)`)
      .run(runId, item.postId, item.sourceHash, item.feedbackId, item.request.inputHash,
        JSON.stringify(item.request.input.reviewedExamples.map(e => e.feedbackId)));
    return items;
  });
  function stillCurrent(item) {
    const post = store.getPost(item.postId);
    return post?.contentHash === item.sourceHash && latestReview(post)?.id === item.feedbackId &&
      exampleValidity(store, item.request.input.reviewedExamples.map(e => e.feedbackId)).every(e => e.status === 'current');
  }
  for (const item of plan) {
    let status = 'stale-input', analysis = null, comparison = null;
    if (stillCurrent(item)) {
      let result;
      try { result = await provider(structuredClone(item.request)); }
      catch { status = 'provider-failed'; }
      if (status !== 'provider-failed') {
        try {
          analysis = validateSemanticResult(item.post, result);
          comparison = compareLabels(item.expected, analysis.labels);
          status = 'completed';
        } catch { status = 'invalid-output'; analysis = null; comparison = null; }
      }
    }
    atomic(store.db, () => {
      // Removal cascades the result. Do not resurrect or retain a late copy of removed text.
      if (!store.getPost(item.postId)) return;
      if (!stillCurrent(item)) { status = 'stale-input'; analysis = null; comparison = null; }
      store.db.prepare(`UPDATE evaluation_results SET status=?,analysis_json=?,comparison_json=? WHERE run_id=? AND post_id=?`)
        .run(status, analysis ? JSON.stringify(analysis) : null, comparison ? JSON.stringify(comparison) : null, runId, item.postId);
    });
  }
  store.db.prepare("UPDATE evaluation_runs SET status='finished',finished_at=? WHERE id=?").run(new Date(now()).toISOString(), runId);
  return evaluationReport(store, runId);
}

export function evaluateBaseline(store, setId) {
  return runEvaluation({ store, setId, providerName: 'Local literal baseline', model: BASELINE_VERSION,
    provider: async request => {
      const value = baselineClassify({ text: request.input.text, type: request.input.postType, contextCoverage: request.input.contextCoverage });
      return { postId: request.input.postId, sourceHash: request.input.sourceHash, labels: value.labels,
        entities: [], events: [], summary: value.explanation, limitations: value.limitations };
    } });
}
