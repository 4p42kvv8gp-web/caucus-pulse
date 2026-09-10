import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/db.js';
import { normalizePost } from '../src/normalize.js';
import { prepareAnalysis, runSemanticAnalysis } from '../src/intelligence.js';
import { reserveHoldouts, learningStatus, postLearningHistory } from '../src/learning-context.js';
import { createEvaluationSet, evaluationSet, runEvaluation, evaluateBaseline, evaluationReport, compareLabels } from '../src/evaluation.js';

function setup(path) {
  const store = openStore(path);
  store.upsertAccount({ authorId: '123', memberId: 'synthetic', memberName: 'Synthetic Test Member', handle: 'SyntheticOnly' });
  return store;
}
function add(store, id, text = 'A Medicaid announcement.', extra = {}) {
  store.ingest(normalizePost({ id, author_id: '123', created_at: '2026-09-07T12:00:00Z', text, ...extra }));
  store.analyzePending();
  return store.getPost(id);
}
const expected = [{ topic: 'Health care', subtopic: 'Medicaid' }];
function review(store, id, labels = expected, extra = {}) {
  return store.saveFeedback(id, { labels, reason: 'Synthetic reviewed distinction.', ...extra }, 'synthetic-test-reviewer');
}
function result(request, labels = expected) {
  return { postId: request.input.postId, sourceHash: request.input.sourceHash,
    labels: labels.map(l => ({ ...l, explanation: 'Synthetic evidence explanation.',
      evidence: [{ start: 0, end: request.input.text.length, text: request.input.text }] })),
    entities: [], events: [], summary: 'Synthetic classification output.', limitations: [] };
}
function fixtureSet(store) {
  add(store, '100'); review(store, '100');
  return createEvaluationSet(store, { title: 'Synthetic review session', postIds: ['100'] });
}

test('review preserves the displayed prediction and source version; unresolved labels are not answers', () => {
  const store = setup();
  try {
    const post = add(store, '100');
    const first = review(store, '100', [{ topic: 'Synthetic alternative', subtopic: null }]).feedback[0];
    assert.deepEqual(first.predictionAtReview.labels, post.analysis.labels);
    assert.equal(first.scope, 'post-specific');
    const second = review(store, '100').feedback[0];
    assert.deepEqual(second.previousAcceptedLabels, first.labels);
    assert.throws(() => review(store, '100', expected, { sourceHash: 'outdated' }), /source version/);
    review(store, '100', []);
    assert.throws(() => createEvaluationSet(store, { title: 'No answer', postIds: ['100'] }), /unresolved interpretation/);
    assert.equal(learningStatus(store).heldOutPosts, 0);
    review(store, '100', [], { decision: 'no-supported-topic' });
    assert.deepEqual(createEvaluationSet(store, { title: 'Explicit answer', postIds: ['100'] }).cases[0].expected, []);
  } finally { store.close(); }
});

test('evaluation sets require real saved review records and are atomic when one case is missing', () => {
  const store = setup();
  try {
    add(store, '100'); add(store, '101'); review(store, '100');
    assert.throws(() => createEvaluationSet(store, { title: 'Incomplete', postIds: ['100','101'] }), /saved human correction/);
    assert.equal(learningStatus(store).heldOutPosts, 0);
    assert.equal(learningStatus(store).evaluationSets, 0);
    assert.throws(() => reserveHoldouts(store, ['100','999']), /source is missing/);
    assert.equal(learningStatus(store).heldOutPosts, 0);
    assert.throws(() => createEvaluationSet(store, { title: 'Duplicate', postIds: ['100','100'] }), /distinct reviewed/);
  } finally { store.close(); }
});

test('held-out sources, whitespace copies, direct references and edit siblings stay out after restart and edits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-learning-'));
  const path = join(dir, 'test.sqlite');
  let store = setup(path);
  try {
    add(store, '100', 'Medicaid is discussed.'); review(store, '100');
    add(store, '101', '  MEDICAID\n is discussed.  '); review(store, '101');
    add(store, '102', 'Other Medicaid information.', { referenced_tweets: [{ type: 'quoted', id: '100' }] }); review(store, '102');
    add(store, '103', 'Edited Medicaid information.', { edit_history_tweet_ids: ['100','103'] }); review(store, '103');
    add(store, '104', 'Different Medicaid statement.'); review(store, '104');
    add(store, '105', 'Another Medicaid statement.');
    reserveHoldouts(store, ['100']);
    store.close(); store = setup(path);
    assert.deepEqual(prepareAnalysis(store, '105').input.reviewedExamples.map(e => e.postId), ['104']);
    add(store, '100', 'Medicaid has a new notice.');
    assert.deepEqual(prepareAnalysis(store, '105').input.reviewedExamples.map(e => e.postId), ['104']);
    add(store, '106', 'Medicaid has a new notice.'); review(store, '106');
    assert.deepEqual(prepareAnalysis(store, '105').input.reviewedExamples.map(e => e.postId), ['104']);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the target and duplicate target text cannot supply its own answer without an explicit holdout', () => {
  const store = setup();
  try {
    add(store, '100'); review(store, '100'); add(store, '101'); review(store, '101');
    assert.deepEqual(prepareAnalysis(store, '100').input.reviewedExamples, []);
  } finally { store.close(); }
});

test('explicitly rejected topics can teach abstention while uncertain reviews are excluded', () => {
  const store = setup();
  try {
    add(store, '100', 'Medicaid notice on a sign.');
    review(store, '100', [], { decision: 'no-supported-topic' });
    add(store, '101', 'A separate Medicaid notice.');
    const request = prepareAnalysis(store, '101');
    assert.equal(request.input.reviewedExamples.length, 1);
    assert.deepEqual(request.input.reviewedExamples[0].labels, []);
    assert.equal(request.input.reviewedExamples[0].decision, 'no-supported-topic');
    review(store, '100', expected, { decision: 'needs-context' });
    assert.deepEqual(prepareAnalysis(store, '101').input.reviewedExamples, []);
  } finally { store.close(); }
});

test('evaluation keeps answers out of requests, preserves dashboard analysis, and exposes disagreements', async () => {
  const store = setup();
  try {
    const set = fixtureSet(store);
    const before = store.getPost('100');
    const baseline = await evaluateBaseline(store, set.id);
    assert.equal(baseline.counts.exactMatches, 1);
    const candidate = await runEvaluation({ store, setId: set.id, providerName: 'Synthetic', model: 'fixture', provider: async request => {
      assert.deepEqual(request.input.reviewedExamples, []);
      assert.equal(JSON.stringify(request).includes('Synthetic reviewed distinction'), false);
      assert.equal(Object.hasOwn(request.input, 'expected'), false);
      return result(request, [{ topic: 'Health care', subtopic: null }]);
    } });
    assert.equal(candidate.counts.disagreements, 1);
    assert.deepEqual(candidate.cases[0].comparison.missing, expected);
    assert.deepEqual(candidate.cases[0].comparison.extra, [{ topic: 'Health care', subtopic: null }]);
    assert.deepEqual(store.getPost('100').analysis, before.analysis);
    assert.deepEqual(store.getPost('100').labels, before.labels);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM analysis_runs').get().n, 0);
    assert.equal(evaluationReport(store, baseline.runId).counts.exactMatches, 1);
    assert.equal(learningStatus(store).evaluationRuns, 2);
    assert.deepEqual(compareLabels([], []), { exactMatch: true, missing: [], extra: [] });
    assert.equal(compareLabels(expected, [...expected].reverse()).exactMatch, true);
  } finally { store.close(); }
});

test('provider failures and invalid evidence never count as correct and exception contents are discarded', async () => {
  const store = setup();
  try {
    const set = fixtureSet(store);
    const failed = await runEvaluation({ store, setId: set.id, providerName: 'Synthetic', model: 'fixture', provider: async () => { throw new Error('Synthetic private exception text'); } });
    assert.equal(failed.counts.failed, 1); assert.equal(failed.counts.usable, 0);
    assert.equal(JSON.stringify(failed).includes('private exception'), false);
    const invalid = await runEvaluation({ store, setId: set.id, providerName: 'Synthetic', model: 'fixture', provider: async request => {
      const output = result(request); output.labels[0].evidence[0].text = 'Made-up evidence'; return output;
    } });
    assert.equal(invalid.counts.failed, 1); assert.equal(invalid.cases[0].status, 'invalid-output');
    assert.equal(invalid.cases[0].analysis, null);
  } finally { store.close(); }
});

test('source and review changes reject stale evaluation sets and late output without overwriting old results', async () => {
  const store = setup();
  try {
    const set = fixtureSet(store);
    const first = await evaluateBaseline(store, set.id);
    review(store, '100', [{ topic: 'Synthetic new correction', subtopic: null }]);
    assert.equal(evaluationReport(store, first.runId).counts.stale, 1);
    assert.equal(evaluationReport(store, first.runId).counts.usable, 0);
    let calls = 0;
    await assert.rejects(runEvaluation({ store, setId: set.id, providerName: 'Synthetic', model: 'fixture', provider: async () => { calls++; } }), /create a new version/);
    assert.equal(calls, 0);
    const next = createEvaluationSet(store, { title: 'Updated review', postIds: ['100'] });
    const late = await runEvaluation({ store, setId: next.id, providerName: 'Synthetic', model: 'fixture', provider: async request => {
      add(store, '100', 'The Medicaid notice was corrected.'); return result(request);
    } });
    assert.equal(late.counts.stale, 1); assert.equal(late.cases[0].status, 'stale-input');
    assert.equal(late.cases[0].analysis, null);
    assert.equal(evaluationSet(store, next.id).cases[0].state, 'source-changed');
  } finally { store.close(); }
});

test('source removal during evaluation deletes case content and late responses cannot resurrect it', async () => {
  const store = setup();
  try {
    const set = fixtureSet(store);
    const report = await runEvaluation({ store, setId: set.id, providerName: 'Synthetic', model: 'fixture', provider: async request => {
      store.removePost('100'); return result(request);
    } });
    assert.equal(report.counts.planned, 1); assert.equal(report.counts.removed, 1);
    assert.equal(report.counts.usable, 0); assert.deepEqual(report.cases, []);
    for (const table of ['evaluation_cases','evaluation_results','learning_holdouts','learning_holdout_sources']) {
      assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
    }
    assert.equal(add(store, '100'), null);
  } finally { store.close(); }
});

test('learning history distinguishes example exposure from superseded lessons and rejects changed in-flight examples', async () => {
  const store = setup();
  try {
    add(store, '100', 'Medicaid first notice.'); review(store, '100');
    add(store, '101', 'Medicaid later notice.');
    await runSemanticAnalysis({ store, postId: '101', providerName: 'Synthetic', model: 'fixture', provider: async request => result(request) });
    assert.equal(postLearningHistory(store, '101').runs[0].examples[0].status, 'current');
    review(store, '100');
    assert.equal(postLearningHistory(store, '101').runs[0].examples[0].status, 'correction-superseded');
    await assert.rejects(runSemanticAnalysis({ store, postId: '101', providerName: 'Synthetic', model: 'fixture', provider: async request => {
      reserveHoldouts(store, ['100']); return result(request);
    } }), /Reviewed examples changed/);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM analysis_runs').get().n, 1);
    store.removePost('100');
    assert.equal(postLearningHistory(store, '101').runs[0].examples[0].status, 'removed');
  } finally { store.close(); }
});

test('an in-flight evaluation records pending work durably and catches changed teaching examples', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-evaluation-'));
  const path = join(dir, 'test.sqlite');
  const store = setup(path);
  try {
    const set = fixtureSet(store);
    add(store, '101', 'A different Medicaid statement.'); review(store, '101');
    const report = await runEvaluation({ store, setId: set.id, providerName: 'Synthetic', model: 'fixture', provider: async request => {
      const second = setup(path);
      try {
        assert.equal(learningStatus(second).unfinishedEvaluationRuns, 1);
        const id = second.db.prepare('SELECT id FROM evaluation_runs').get().id;
        assert.equal(evaluationReport(second, id).counts.unfinished, 1);
        review(second, '101');
      } finally { second.close(); }
      assert.equal(request.input.reviewedExamples.length, 1);
      return result(request);
    } });
    assert.equal(report.cases[0].status, 'stale-input'); assert.equal(report.counts.usable, 0);
    assert.equal(report.counts.stale, 1);
    assert.equal(learningStatus(store).unfinishedEvaluationRuns, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
