import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../src/db.js';
import { normalizePost } from '../src/normalize.js';
import { prepareAnalysis, runSemanticAnalysis } from '../src/intelligence.js';
import { classifierMessages, classifierEvidenceCatalog, parseClassifierOutput, classifierFingerprint } from '../src/classifier-contract.js';
import { registerClassifier, classificationStatus, queueClassification, claimClassification, finishClassification, failClassification, processClassificationJobs } from '../src/classifier-jobs.js';
import { createLocalClassifierClient } from '../src/classifier-client.js';
import { createServer } from '../src/server.js';

const source = '🚨 Flooding closed River Road in my district. A shelter is open at North School.';
function setup(path = ':memory:') {
  const store = openStore(path);
  store.upsertAccount({ authorId: '1', memberId: 'synthetic', memberName: 'Synthetic Member', handle: 'Synthetic' });
  return store;
}
function add(store, id = '10', text = source) {
  store.ingest(normalizePost({ id, author_id: '1', text, created_at: '2026-09-08T00:00:00Z' }));
  store.analyzePending(); return store.getPost(id);
}
function wire(text = source) {
  const sentence = text.slice(0, text.indexOf('.') + 1);
  return { labels: [{ topic: 'Disaster response', subtopic: 'Flooding', explanation: 'Synthetic evidence-based reason.', quoteIds: ['p1'] }],
    entities: [{ kind: 'location', name: 'River Road', contextId: 'p1' }],
    events: [{ description: 'The author reports a road closure due to flooding.', development: 'reported-incident',
      location: { name: 'River Road', contextId: 'p1' }, districtRelation: 'explicitly-stated', districtQuoteIds: ['p1'], quoteIds: ['p1'] }],
    functions: [{ function: 'constituent-service', explanation: 'The source provides shelter information.', quoteIds: ['p2'] }],
    summary: 'The author reports flooding and a shelter.', limitations: ['Synthetic engineering output.'] };
}
function output(request) { return { result: parseClassifierOutput(request, JSON.stringify(wire(request.input.text))), metrics: { promptTokens: 100, outputTokens: 100, elapsedMs: 1, peakMemoryBytes: 100, finishReason: 'stop' } }; }
const runtime = (classify = async request => output(request)) => ({ fingerprint: classifierFingerprint, classify });

test('local classifier maps selected source passages to original UTF-16 offsets and observed entity contexts', () => {
  const store = setup();
  try {
    add(store); const request = prepareAnalysis(store, '10'), result = output(request).result;
    assert.equal(result.labels[0].evidence[0].start, 0);
    assert.equal(result.entities[0].evidence[0].start, source.indexOf('River Road'));
    assert.equal(result.entities[0].evidence[0].text, 'River Road');
    assert.equal(result.events[0].districtEvidence[0].text, source.slice(0, source.indexOf('.') + 2));
    assert.equal(result.functions[0].function, 'constituent-service');
    assert.equal(result.postId, '10');
    assert.equal(result.sourceHash, request.input.sourceHash);
    assert.ok(classifierMessages(request)[1].content.includes(JSON.stringify(classifierEvidenceCatalog(source).map(({id,text})=>({id,text})))));
    assert.throws(() => classifierMessages({ input: { text: 'x'.repeat(60001) } }), e => e.code === 'CLASSIFIER_INPUT_LIMIT');
  } finally { store.close(); }
});

test('source passage IDs preserve curly punctuation, repeated sentences, blank lines and long source coverage',()=>{
  const text='We won’t stop. \n\nWe won’t stop.\n'+('🚨'.repeat(650))+' Late detail remains here.';
  const catalog=classifierEvidenceCatalog(text);
  assert.equal(catalog.map(p=>p.text).join(''),text);
  assert.ok(catalog.every(p=>p.text.length<=1200));
  assert.ok(catalog.every((p,i)=>p.start===(i?catalog[i-1].end:0)&&text.slice(p.start,p.end)===p.text));
  const request={input:{postId:'1',sourceHash:'a'.repeat(64),text,postType:'original',contextCoverage:'Synthetic text only.'}};
  const repeated=catalog.find(p=>p.start>0&&p.text.includes('won’t'));
  const wire={labels:[],entities:[],events:[],functions:[{function:'other',explanation:'Synthetic passage selection.',quoteIds:[repeated.id]}],summary:'Synthetic.',limitations:[]};
  const result=parseClassifierOutput(request,JSON.stringify(wire));
  assert.equal(result.functions[0].evidence[0].start,repeated.start);
  assert.ok(result.functions[0].evidence[0].text.includes('won’t'));
  wire.functions[0].quoteIds=[repeated.id,repeated.id];assert.throws(()=>parseClassifierOutput(request,JSON.stringify(wire)),/Duplicate/);
});

test('invented evidence IDs, ambiguous names, unknown topics/functions and malformed output are rejected without repair', () => {
  const store = setup();
  try {
    add(store); const request = prepareAnalysis(store, '10');
    for (const mutate of [
      v => { v.labels[0].quoteIds = ['p999']; },
      v => { v.labels[0].topic = 'Invented broad taxonomy'; },
      v => { v.functions[0].function = 'good-politician'; },
      v => { v.entities[0].name = 'River Street'; },
      v => { v.events[0].location = { name: null, contextId: null }; },
      v => { v.events[0].districtQuoteIds = []; },
      v => { v.events[0].districtRelation = 'not-established'; },
      v => { v.score = 100; }
    ]) { const v = wire(); mutate(v); assert.throws(() => parseClassifierOutput(request, JSON.stringify(v))); }
    assert.throws(() => parseClassifierOutput(request, '```json\n' + JSON.stringify(wire()) + '\n```'));
    const duplicated = { input: { ...request.input, text: source + '\n' + source } };
    assert.equal(parseClassifierOutput(duplicated, JSON.stringify(wire())).labels[0].evidence[0].start,0,'Distinct IDs disambiguate repeated text without guessing offsets');
    const repeatedName = { input: { ...request.input, text: 'River Road is closed. River Road is now open.' } };
    const v = { labels: [], entities: [{ kind: 'location', name: 'River Road', contextId: 'p2' }], events: [], functions: [], summary: 'Synthetic.', limitations: [] };
    assert.equal(parseClassifierOutput(repeatedName, JSON.stringify(v)).entities[0].evidence[0].start, 22);
  } finally { store.close(); }
});

test('registering a classifier backfills durable jobs, new sources queue and content edits reset old claims', () => {
  const store = setup();
  try {
    add(store); assert.equal(classificationStatus(store).registered, false);
    registerClassifier(store, 1000); registerClassifier(store, 1000);
    assert.equal(classificationStatus(store).pending, 1);
    add(store, '11'); assert.equal(classificationStatus(store).pending, 2);
    const claim = claimClassification(store, { now: 1000 });
    add(store, claim.postId, source + ' Updated.');
    const job = store.db.prepare('SELECT * FROM classifier_jobs WHERE post_id=?').get(claim.postId);
    assert.equal(job.status, 'pending'); assert.equal(job.attempts, 0); assert.equal(job.lease_owner, null);
    assert.notEqual(job.source_hash, claim.sourceHash);
    assert.equal(failClassification(store, claim, 'CLASSIFIER_UNAVAILABLE', 1001), 0);
  } finally { store.close(); }
});

test('local worker saves validated provenance atomically while accepted human labels retain precedence', async () => {
  const store = setup();
  try {
    add(store);
    store.saveFeedback('10', { labels: [{ topic: 'Synthetic human topic' }], reason: 'Synthetic review.' }, 'synthetic-reviewer');
    assert.deepEqual(await processClassificationJobs(store, runtime(), { now: () => 1000 }), { completed: 1, failed: 0, skipped: 0, stale: 0, deferred:0 });
    const post = store.getPost('10');
    assert.equal(post.labels[0].topic, 'Synthetic human topic');
    assert.equal(post.analysis.labels[0].topic, 'Disaster response');
    assert.equal(post.analysis.provenance.fingerprint, classifierFingerprint);
    assert.equal(post.analysis.functions[0].function, 'constituent-service');
    assert.equal(classificationStatus(store).completed, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM analysis_runs').get().n, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM budget_requests').get().n, 0);
    assert.equal(await processClassificationJobs(store, runtime()).then(r => r.completed), 0);
  } finally { store.close(); }
});

test('expired, superseded and removed claims cannot publish late output or overwrite newer analysis', async () => {
  const store = setup();
  try {
    add(store); registerClassifier(store, 1000);
    const first = claimClassification(store, { now: 1000, leaseMs: 1000 }), request = prepareAnalysis(store, '10');
    assert.equal(claimClassification(store, { now: 1500 }), null);
    assert.throws(() => finishClassification(store, first, request, output(request), 2000), /lease changed/);
    const replacement = claimClassification(store, { now: 2000 });
    assert.throws(() => finishClassification(store, first, request, output(request), 2001), /lease changed/);
    await runSemanticAnalysis({ store, postId: '10', provider: async () => output(request).result, providerName: 'Synthetic alternative', model: 'fixture' });
    assert.throws(() => finishClassification(store, replacement, request, output(request), 2001), /analysis or classifier lease changed/);
    queueClassification(store, '10', request.input.sourceHash, { now: 300000 });
    const removed = claimClassification(store, { now: 300000 }); store.removePost('10');
    assert.throws(() => finishClassification(store, removed, request, output(request), 300001), /Source changed/);
    assert.equal(classificationStatus(store).archivePosts, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM classifier_jobs').get().n, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM analysis_runs').get().n, 0);
  } finally { store.close(); }
});

test('failures retain source and baseline, bounded attempts do not loop and manual retry binds source version', async () => {
  const store = setup();
  try {
    const post = add(store);
    const failed = await processClassificationJobs(store, runtime(async () => { throw Object.assign(new Error('Synthetic private diagnostic'), { code: 'CLASSIFIER_INVALID_OUTPUT' }); }), { now: () => 1000 });
    assert.equal(failed.failed, 1); assert.equal(classificationStatus(store).failed, 1);
    assert.equal(store.getPost('10').analysis.version, post.analysis.version);
    assert.equal(store.getPost('10').text, source);
    assert.equal(claimClassification(store, { now: 500000 }), null);
    assert.equal(JSON.stringify(classificationStatus(store)).includes('private diagnostic'), false);
    assert.throws(() => queueClassification(store, '10', 'outdated'), e => e.code === 'CLASSIFIER_STALE');
    queueClassification(store, '10', post.contentHash, { now: 1000 });
    for (const now of [1000, 2000, 3000]) assert.ok(claimClassification(store, { now, leaseMs: 1000 }));
    assert.equal(claimClassification(store, { now: 4000 }).skipped, true);
    assert.equal(classificationStatus(store).failureCodes[0].code, 'CLASSIFIER_ATTEMPT_LIMIT');
    add(store, '11', 'x'.repeat(60001));
    assert.equal(claimClassification(store, { now: 5000 }).skipped, true);
    assert.equal(store.getPost('11').text.length, 60001);
  } finally { store.close(); }
});

test('a storage error cannot publish analysis without completing its durable job', () => {
  const store = setup();
  try {
    const before = add(store); registerClassifier(store, 1000);
    const claim = claimClassification(store, { now: 1000 }), request = prepareAnalysis(store, '10');
    store.db.exec("CREATE TRIGGER synthetic_failure BEFORE UPDATE OF status ON classifier_jobs WHEN new.status='completed' BEGIN SELECT RAISE(ABORT,'Synthetic storage failure'); END;");
    assert.throws(() => finishClassification(store, claim, request, output(request), 1001), /Synthetic storage failure/);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM analysis_runs').get().n, 0);
    assert.equal(store.getPost('10').analysis.version, before.analysis.version);
    assert.equal(classificationStatus(store).running, 1);
  } finally { store.close(); }
});

test('classifier migration and unfinished jobs survive reopening without requiring a local model', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-classifier-')); let store = setup(join(dir, 'test.sqlite'));
  try {
    add(store);
    store.db.exec('DROP TABLE incident_case_history; DROP TABLE incident_case_posts; DROP TABLE incident_cases; DROP TABLE incident_reviews; DROP TRIGGER classifier_post_insert; DROP TRIGGER classifier_post_update; DROP TABLE classifier_jobs; DROP TABLE classifier_profiles; UPDATE schema_version SET version=7;');
    store.close(); store = openStore(join(dir, 'test.sqlite'));
    assert.equal(store.db.prepare('SELECT version FROM schema_version').get().version, 11);
    registerClassifier(store, 1000); claimClassification(store, { now: 1000 });
    store.close(); store = openStore(join(dir, 'test.sqlite'));
    assert.equal(classificationStatus(store).running, 1);
    assert.equal(store.getPost('10').text, source);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('an absent local classifier runtime reports unavailable without downloading or starting an endpoint', async () => {
  await assert.rejects(createLocalClassifierClient({ python: '/nonexistent/caucus-pulse-python', timeoutMs: 1000 }), e => e.code === 'CLASSIFIER_UNAVAILABLE');
});

test('feedback rejects a changed displayed prediction even when its source text is unchanged', async () => {
  const store=setup();
  try {
    const before=add(store),request=prepareAnalysis(store,'10');
    await runSemanticAnalysis({store,postId:'10',provider:async()=>output(request).result,providerName:'Synthetic',model:'fixture'});
    assert.throws(()=>store.saveFeedback('10',{sourceHash:before.contentHash,predictionHash:before.analysisHash,labels:[{topic:'Disaster response'}],reason:'Synthetic.'}),e=>e.code==='PREDICTION_CHANGED');
    assert.equal(store.getPost('10').feedback.length,0);
    const current=store.getPost('10');
    store.saveFeedback('10',{sourceHash:current.contentHash,predictionHash:current.analysisHash,labels:[{topic:'Disaster response'}],reason:'Synthetic.'},'synthetic-reviewer');
    assert.equal(store.getPost('10').feedback[0].predictionAtReview.analysisHash,current.analysisHash);
  }finally{store.close();}
});

test('classification API exposes readiness, validates reanalysis and never invents a completed run',async()=>{
  const store=setup();const post=add(store);let processCalls=0;
  const classifier={state:'ready',runtime:{status:()=>({ready:true,busy:false,queued:0})},process:()=>processCalls++};
  const server=createServer(store,{classifier,credentials:{status:()=>({configured:false})}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const send=body=>fetch(`${base}/api/posts/10/classification`,{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(body)});
  try{
    assert.equal((await (await fetch(base+'/api/classification')).json()).completed,0);
    assert.equal((await send({sourceHash:'wrong'})).status,400);
    assert.equal((await send({sourceHash:'a'.repeat(64)})).status,409);
    assert.equal((await send({sourceHash:post.contentHash,extra:true})).status,400);
    assert.equal((await send({sourceHash:post.contentHash})).status,202);
    assert.equal(processCalls,1);assert.equal(classificationStatus(store).pending,1);
    assert.equal(store.getPost('10').feedback.length,0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM analysis_runs').get().n,0);
    classifier.runtime.status=()=>({ready:false,busy:false,queued:0});
    assert.equal((await send({sourceHash:post.contentHash})).status,503);
    const hostile=await fetch(`${base}/api/posts/10/classification`,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://example.invalid'},body:JSON.stringify({sourceHash:post.contentHash})});
    assert.equal(hostile.status,403);
  }finally{await new Promise(resolve=>server.close(resolve));store.close();}
});
