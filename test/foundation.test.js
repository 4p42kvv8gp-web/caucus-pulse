import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePost, exactOccurrences } from '../src/normalize.js';
import { baselineClassify } from '../src/classify.js';
import { openStore } from '../src/db.js';
import { dashboardData, phraseData } from '../src/dashboard.js';
import { createServer } from '../src/server.js';

const settings = { mode: 'test', budget: {} };
function account(store, id = '101', memberId = 'member-one') {
  store.upsertAccount({ authorId: id, memberId, memberName: 'Synthetic Test Member', handle: `test${id}` });
}
function post(id = '9007199254740993001', text = 'We will not be silent.', extra = {}) {
  return normalizePost({ id, author_id: '101', created_at: '2026-09-07T03:55:00Z', text, ...extra });
}

test('long text, negation, original offsets, and references survive normalization', () => {
  const full = 'We will not be silent.\n\n' + 'Complete source wording. '.repeat(100);
  const p = post(undefined, 'truncated…', { note_tweet: { text: full }, conversation_id: '22', referenced_tweets: [{ type: 'quoted', id: '33' }] });
  assert.equal(p.text, full); assert.equal(p.type, 'quote'); assert.equal(p.conversationId, '22');
  assert.equal(p.raw.note_tweet.text, full); assert.equal(p.references[0].id, '33');
  assert.deepEqual(exactOccurrences(p.text, 'We will not be silent'), [{ start: 0, end: 21, text: 'We will not be silent' }]);
  assert.equal(post(undefined, 'short', { note_post: { text: full } }).text, full);
  assert.throws(() => normalizePost({ id: 9007199254740993001 }), /numeric string ID/);
});

test('baseline preserves separate facility labels and does not invent events', () => {
  const a = baselineClassify(post(undefined, 'A statement about Delaney Hall and Medicaid.'));
  assert.deepEqual(a.labels.map(l => [l.topic, l.subtopic]), [['Immigration', 'Delaney Hall detention facility'], ['Health care', 'Medicaid']]);
  assert.equal(a.labels.some(l => /Dilley/.test(l.subtopic)), false);
  assert.deepEqual(a.events, []);
  assert.equal(baselineClassify(post(undefined, 'There is a hospitalwide notice.')).labels.length, 0);
  for (const label of a.labels) for (const span of label.evidence) assert.equal('A statement about Delaney Hall and Medicaid.'.slice(span.start, span.end), span.text);
});

test('replay is idempotent; classification failure leaves captured source visible', () => {
  const store = openStore(); account(store);
  try {
    assert.equal(store.ingest(post()).inserted, true);
    assert.equal(store.ingest(post()).duplicate, true);
    store.analyzePending({ classifier() { throw new Error('Provider unavailable'); } });
    assert.equal(store.listPosts().length, 1);
    assert.equal(store.listPosts()[0].analysis.status, 'pending');
    assert.equal(store.db.prepare('SELECT status FROM analysis_jobs').get().status, 'failed');
  } finally { store.close(); }
});

test('multiple accounts map to one member; parent topic counts deduplicate', () => {
  const store = openStore(); account(store); account(store, '102');
  try {
    store.ingest(post('1', 'Medicare and Medicaid.'));
    store.ingest(post('2', 'Medicaid.', { author_id: '102' }));
    store.analyzePending();
    const data = dashboardData(store, {}, settings);
    assert.equal(data.topics[0].posts, 2); assert.equal(data.topics[0].members, 1);
    assert.equal(dashboardData(store, { query: 'Medicare' }, settings).topics[0].posts, 1);
  } finally { store.close(); }
});

test('exact longer phrasing crosses midnight and excludes repost amplification', () => {
  const store = openStore(); account(store); account(store, '102', 'member-two');
  try {
    store.ingest(post('1'));
    store.ingest(post('2', 'We will not be silent.', { author_id: '102', created_at: '2026-09-07T04:05:00Z' }));
    store.ingest(post('3', 'We will not be silent.', { referenced_tweets: [{ type: 'retweeted', id: '1' }] }));
    const result = phraseData(store, 'We will not be silent', { since: '2026-09-07T03:50:00.000Z', until: '2026-09-07T04:10:00.000Z' });
    assert.equal(result.matchingPosts, 2); assert.equal(result.distinctMembers, 2);
    assert.equal(result.firstObservedInSelection, '2026-09-07T03:55:00.000Z');
  } finally { store.close(); }
});

test('feedback persists, general rules stay proposed, and edits invalidate old corrections', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-test-')); const file = join(dir, 'test.sqlite');
  let store = openStore(file); account(store);
  try {
    store.ingest(post('1', 'A library opening.')); store.analyzePending();
    store.saveFeedback('1', { labels: [{ topic: 'District services', subtopic: 'Library opening' }], reason: 'A new local service.', ruleProposal: 'Test whether library openings belong here.' }, 'test-reviewer');
    store.close(); store = openStore(file);
    assert.equal(store.getPost('1').labels[0].topic, 'District services');
    assert.equal(store.getPost('1').reviewStatus, 'reviewed');
    store.ingest(post('2', 'Another library opening.')); store.analyzePending();
    assert.equal(store.getPost('2').labels.length, 0, 'Proposed rule must not silently apply to other posts');
    store.ingest(post('1', 'A library opening.', { public_metrics: { like_count: 100 } }));
    assert.equal(store.getPost('1').reviewStatus, 'reviewed', 'Engagement changes do not change source wording');
    store.ingest(post('1', 'A different statement.')); store.analyzePending();
    assert.equal(store.getPost('1').reviewStatus, 'awaiting-review');
    assert.equal(store.getPost('1').feedback[0].appliesToCurrentText, false);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('content removal cascades into analysis/reviews and replay does not restore it', () => {
  const store = openStore(); account(store);
  try {
    store.ingest(post('1')); store.analyzePending();
    store.saveFeedback('1', { labels: [], reason: 'Synthetic test only.' }, 'test-reviewer');
    store.removePost('1');
    assert.equal(store.getPost('1'), null);
    for (const table of ['feedback', 'analyses', 'analysis_jobs']) assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
    assert.equal(store.ingest(post('1')).removed, true);
  } finally { store.close(); }
});

test('local HTTP flow validates feedback and rejects cross-origin mutations', async () => {
  const store = openStore(); account(store); store.ingest(post('1')); store.analyzePending();
  const server = createServer(store);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const homepage = await fetch(url); assert.equal(homepage.status, 200);
    assert.match(homepage.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const dashboard = await (await fetch(`${url}/api/dashboard`)).json(); assert.equal(dashboard.posts.length, 1);
    assert.equal(dashboard.operations.learning.reviewedPosts, 0);
    assert.equal((await (await fetch(`${url}/api/learning`)).json()).evaluationRuns, 0);
    assert.deepEqual((await (await fetch(`${url}/api/posts/1/learning`)).json()).runs, []);
    assert.equal((await fetch(`${url}/api/posts/999/learning`)).status, 404);
    const hostile = await fetch(`${url}/api/posts/1/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://unrelated.example' }, body: '{}' });
    assert.equal(hostile.status, 403);
    const invalid = await fetch(`${url}/api/posts/1/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ labels: [], reason: '' }) });
    assert.equal(invalid.status, 400);
    const stale = await fetch(`${url}/api/posts/1/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceHash: 'outdated', labels: [], reason: 'Synthetic stale review.' }) });
    assert.equal(stale.status, 400);
    assert.equal((await (await fetch(`${url}/api/learning`)).json()).reviewedPosts, 0);
    const correction = await fetch(`${url}/api/posts/1/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceHash:dashboard.posts[0].contentHash,predictionHash:dashboard.posts[0].analysisHash,reviewId:dashboard.posts[0].reviewId,labels: [], reason: 'Synthetic test only.' }) });
    assert.equal(correction.status, 200); assert.equal((await correction.json()).reviewStatus, 'reviewed');
    assert.equal((await (await fetch(`${url}/api/learning`)).json()).reviewedPosts, 1);
  } finally { await new Promise(resolve => server.close(resolve)); store.close(); }
});

test('concurrent topic reviews require the displayed review and bounded history retains the current decision',()=>{
  const store=openStore();
  store.upsertAccount({authorId:'1',memberId:'synthetic',memberName:'Synthetic',handle:'Synthetic'});
  try{
    store.ingest(normalizePost({id:'999',author_id:'1',created_at:'2026-09-08T00:00:00Z',text:'Synthetic source wording.'}));store.analyzePending();
    const original=store.getPost('999');
    const value={sourceHash:original.contentHash,predictionHash:original.analysisHash,reviewId:original.reviewId,labels:[],decision:'no-supported-topic',reason:'Synthetic isolated review.'};
    store.saveFeedback('999',value);
    assert.throws(()=>store.saveFeedback('999',value),e=>e.code==='REVIEW_CHANGED');
    for(let i=0;i<55;i++)store.saveFeedback('999',{labels:[],decision:'needs-context',reason:`Synthetic history ${i}.`});
    const current=store.getPost('999');assert.equal(current.feedback.length,50);assert.equal(current.feedbackCount,56);assert.equal(current.feedbackOmitted,6);
    assert.equal(current.reviewId,current.feedback[0].id);assert.equal(current.feedback[0].decision,'needs-context');
  }finally{store.close();}
});
