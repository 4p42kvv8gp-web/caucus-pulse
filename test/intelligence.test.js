import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/db.js';
import { normalizePost } from '../src/normalize.js';
import { validateSemanticResult, runSemanticAnalysis, restoreAnalysisRun, prepareAnalysis } from '../src/intelligence.js';

const text = 'The library in my district reopens tomorrow.';
const evidence = (value, source = text) => ({ start: source.indexOf(value), end: source.indexOf(value) + value.length, text: value });
function setup() {
  const store = openStore();
  store.upsertAccount({ authorId: '123', memberId: 'synthetic-member', memberName: 'Synthetic Member', handle: 'SyntheticTest' });
  const post = normalizePost({ id: '900', author_id: '123', created_at: '2026-09-07T12:00:00Z', text });
  store.ingest(post); store.analyzePending();
  return { store, post: store.getPost('900') };
}
function result(post) {
  return { postId: post.id, sourceHash: post.contentHash,
    labels: [{ topic: 'Constituent services', subtopic: 'Library reopening', explanation: 'The post reports a library reopening.', evidence: [evidence('library')] }],
    entities: [{ kind: 'facility', name: 'Library', canonicalId: null, evidence: [evidence('library')] }],
    events: [{ description: 'The author reports that a library will reopen tomorrow.', development: 'update', location: null,
      districtRelation: 'explicitly-stated', districtEvidence: [evidence('my district')], evidence: [evidence('reopens tomorrow')] }],
    summary: 'The author reports a library reopening in their district.', limitations: ['The library is not named.'] };
}

test('semantic contract requires exact evidence and rejects scores and invented approval', () => {
  const { store, post } = setup();
  try {
    assert.equal(validateSemanticResult(post, result(post)).events[0].status, 'candidate');
    const bad = result(post); bad.labels[0].evidence[0].text = 'not in source';
    assert.throws(() => validateSemanticResult(post, bad), /exactly match/);
    assert.throws(() => validateSemanticResult(post, { ...result(post), score: null }), /shape/);
    assert.throws(() => validateSemanticResult(post, { ...result(post), status: 'human-approved' }), /shape/);
    const unsupported = result(post); unsupported.events[0].districtEvidence = [];
    assert.throws(() => validateSemanticResult(post, unsupported), /Evidence is required/);
    const unknownId = result(post); unknownId.postId = '901';
    assert.throws(() => validateSemanticResult(post, unknownId), /input manifest/);
    const wrongEntity = result(post); wrongEntity.entities[0].name = 'A different library';
    assert.throws(() => validateSemanticResult(post, wrongEntity), /Entity names/);
    const wrongPlace = result(post); wrongPlace.events[0].location = { name: 'An unnamed town', evidence: [evidence('district')] };
    assert.throws(() => validateSemanticResult(post, wrongPlace), /location must be named/);
  } finally { store.close(); }
});

test('asynchronous providers cannot create empty analysis through the synchronous baseline queue', async () => {
  const { store, post } = setup();
  try {
    store.db.prepare("UPDATE analysis_jobs SET status='pending' WHERE post_id=?").run(post.id);
    store.analyzePending({ classifier: async () => { throw new Error('Synthetic asynchronous failure'); } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.getPost(post.id).analysis.version, post.analysis.version);
    assert.equal(store.db.prepare('SELECT status FROM analysis_jobs WHERE post_id=?').get(post.id).status, 'failed');
  } finally { store.close(); }
});

test('semantic runs persist and can be restored without overriding a human correction', async () => {
  const { store, post } = setup();
  try {
    const first = await runSemanticAnalysis({ store, postId: post.id, provider: async () => result(post), providerName: 'Synthetic test provider', model: 'fixture-v1' });
    store.saveFeedback(post.id, { labels: [{ topic: 'Community services', subtopic: null }], reason: 'Synthetic test review.' }, 'test-reviewer');
    const changed = result(post); changed.labels[0].topic = 'Local facilities';
    await runSemanticAnalysis({ store, postId: post.id, provider: async () => changed, providerName: 'Synthetic test provider', model: 'fixture-v2' });
    restoreAnalysisRun(store, first.runId);
    assert.equal(store.getPost(post.id).analysis.labels[0].topic, 'Constituent services');
    assert.equal(store.getPost(post.id).labels[0].topic, 'Community services');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM analysis_runs').get().n, 3);
  } finally { store.close(); }
});

test('late provider output cannot overwrite edited source text', async () => {
  const { store, post } = setup();
  try {
    await assert.rejects(runSemanticAnalysis({ store, postId: post.id, providerName: 'Synthetic test provider', model: 'fixture', provider: async () => {
      store.ingest(normalizePost({ id: post.id, author_id: '123', created_at: post.createdAt, text: 'The library is closed.' }));
      return result(post);
    } }), /Source changed/);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM analysis_runs').get().n, 0);
  } finally { store.close(); }
});

test('reviewed examples exclude evaluation posts, the target, and proposed general rules', () => {
  const { store, post } = setup();
  try {
    store.ingest(normalizePost({ id: '901', author_id: '123', created_at: '2026-09-07T11:00:00Z', text: 'A library notice.' }));
    store.saveFeedback('901', { labels: [{ topic: 'library', subtopic: null }], reason: 'Synthetic source review.', ruleProposal: 'Unapproved generalization.' }, 'test-reviewer');
    const request = prepareAnalysis(store, post.id);
    assert.equal(request.input.reviewedExamples.length, 1);
    assert.equal(JSON.stringify(request.input).includes('Unapproved generalization'), false);
    assert.equal(prepareAnalysis(store, post.id, { holdoutIds: ['901'] }).input.reviewedExamples.length, 0);
    assert.match(request.instructions, /untrusted data/);
    assert.equal(request.responseSchema.properties.postId.const, post.id);
  } finally { store.close(); }
});

test('provider failures preserve the baseline; removal cleans all stored semantic runs', async () => {
  const { store, post } = setup();
  try {
    const version = post.analysis.version;
    await assert.rejects(runSemanticAnalysis({ store, postId: post.id, providerName: 'Synthetic test provider', model: 'fixture', provider: async () => { throw new Error('Synthetic outage'); } }), /Semantic provider request failed/);
    assert.equal(store.getPost(post.id).analysis.version, version);
    await runSemanticAnalysis({ store, postId: post.id, providerName: 'Synthetic test provider', model: 'fixture', provider: async () => result(post) });
    store.removePost(post.id);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM analysis_runs').get().n, 0);
  } finally { store.close(); }
});
