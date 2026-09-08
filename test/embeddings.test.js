import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../src/db.js';
import { normalizePost } from '../src/normalize.js';
import { atomic } from '../src/sqlite.js';
import { embeddingModel } from '../src/embedding-models.js';
import { claimEmbeddingJob,finishEmbeddingJob,failEmbeddingJob,processEmbeddingJobs,registerEmbeddingModel,embeddingStatus } from '../src/embedding-store.js';
import { semanticSearch } from '../src/semantic-search.js';
import { createEmbeddingClient } from '../src/embedding-client.js';
import { createServer } from '../src/server.js';

const model=embeddingModel();
const vector=(position=0,sign=1)=>Array.from({length:384},(_,i)=>i===position?sign:0);
const query={modelFingerprint:model.fingerprint,vector:vector()};
function setup(path) {
  const store=openStore(path);
  store.upsertAccount({authorId:'101',memberId:'synthetic-one',memberName:'Synthetic One',handle:'SyntheticOne',accountType:'official'});
  store.upsertAccount({authorId:'102',memberId:'synthetic-two',memberName:'Synthetic Two',handle:'SyntheticTwo',accountType:'personal'});
  return store;
}
function add(store,id,text='Synthetic flood notice.',extra={}) {
  const post=normalizePost({id:String(id),author_id:'101',created_at:'2026-09-07T23:50:00Z',text,...extra},{kind:'historical-calibration'});
  store.ingest(post);return post;
}
function result(text,value=vector()) {
  return {modelFingerprint:model.fingerprint,textLength:text.length,coveredCharacters:text.length,detailOmitted:0,
    passages:[{index:0,start:0,end:text.length,text,tokenCount:12,kind:'context-window',vector:value}]};
}
function syntheticRuntime(embed=text=>result(text)) {return {model,embedPost:async text=>embed(text)};}

test('registration backfills jobs, duplicate imports reuse vectors, and edits invalidate them atomically', async()=>{
  const store=setup();
  try {
    add(store,'1');store.analyzePending();
    registerEmbeddingModel(store);
    assert.equal(embeddingStatus(store).pending,1);
    await processEmbeddingJobs(store,syntheticRuntime());
    assert.equal(embeddingStatus(store).completed,1);
    const baseline=store.getPost('1').analysis.version;
    add(store,'1');registerEmbeddingModel(store);
    assert.equal(embeddingStatus(store).pending,0);
    assert.equal(embeddingStatus(store).passages,1);
    assert.throws(()=>atomic(store.db,()=>{add(store,'1','Rolled back edit.');throw new Error('Rollback');}),/Rollback/);
    assert.equal(embeddingStatus(store).passages,1);
    add(store,'1','Changed flood notice.');
    assert.equal(embeddingStatus(store).passages,0);
    assert.equal(embeddingStatus(store).pending,1);
    add(store,'2','Another notice.');
    assert.equal(embeddingStatus(store).pending,2);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM budget_requests').get().n,0);
    assert.ok(baseline);
  } finally {store.close();}
});

test('leases fence concurrent workers, expired completions and removed or edited sources',()=>{
  const store=setup();
  try {
    add(store,'1');registerEmbeddingModel(store);
    const first=claimEmbeddingJob(store,model,{now:10000,leaseMs:1000});
    assert.equal(claimEmbeddingJob(store,model,{now:10001,leaseMs:1000}),null);
    assert.equal(finishEmbeddingJob(store,first,result(first.text),model,11000).saved,false);
    assert.equal(failEmbeddingJob(store,first,{now:11000}),0);
    const second=claimEmbeddingJob(store,model,{now:11001,leaseMs:1000});
    assert.notEqual(first.owner,second.owner);
    assert.equal(finishEmbeddingJob(store,first,result(first.text),model,11002).saved,false);
    add(store,'1','Edited source.');
    assert.equal(finishEmbeddingJob(store,second,result(second.text),model,11003).saved,false);
    const third=claimEmbeddingJob(store,model,{now:11004,leaseMs:1000});
    store.removePost('1');
    assert.equal(finishEmbeddingJob(store,third,result(third.text),model,11005).saved,false);
    assert.equal(embeddingStatus(store).passages,0);
    assert.equal(embeddingStatus(store).running,0);
    assert.equal(add(store,'1').id,'1');
    assert.equal(store.getPost('1'),null);
  }finally{store.close();}
});

test('bad model identity, coverage, offsets and vectors never partially commit',()=>{
  const store=setup();
  try {
    add(store,'1','📰 Café will NOT close.');registerEmbeddingModel(store);
    const claim=claimEmbeddingJob(store);
    const variants=[r=>r.modelFingerprint='wrong',r=>r.coveredCharacters--,r=>r.passages[0].start=2,
      r=>r.passages[0].text='Different text',r=>r.passages[0].vector[0]=Infinity,
      r=>r.passages[0].vector=vector(0,2),r=>r.passages[0].tokenCount=1000];
    for(const mutate of variants){const invalid=result(claim.text);mutate(invalid);assert.throws(()=>finishEmbeddingJob(store,claim,invalid),/Invalid/);}
    assert.equal(embeddingStatus(store).passages,0);
    assert.equal(finishEmbeddingJob(store,claim,result(claim.text)).saved,true);
    assert.equal(embeddingStatus(store).passages,1);
    assert.throws(()=>registerEmbeddingModel(store,{...model,fingerprint:'different'}),/Invalid/);
  }finally{store.close();}
});

test('failed or oversized embedding jobs retain full sources and do not invent classification or reviews',async()=>{
  const store=setup();
  try{
    add(store,'1');add(store,'2','a'.repeat(100001));store.analyzePending();
    const before=store.getPost('1').analysis;
    const counts=await processEmbeddingJobs(store,syntheticRuntime(()=>{throw new Error('Synthetic private payload: never persist this.');}));
    assert.deepEqual(counts,{completed:0,failed:1,skipped:1,stale:0});
    assert.equal(store.getPost('2').text.length,100001);
    assert.deepEqual(store.getPost('1').analysis,before);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM feedback').get().n,0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE last_error LIKE '%private payload%'").get().n,0);
    assert.equal(claimEmbeddingJob(store),null);
  }finally{store.close();}
});

test('search deduplicates passages per post, returns full wording and respects current structured filters',async()=>{
  const store=setup();
  try{
    add(store,'1','Café will NOT close.');add(store,'2','A different subject.',{author_id:'102'});
    add(store,'3','Quoted report. This report was false.',{referenced_tweets:[{type:'quoted',id:'99'}]});
    await processEmbeddingJobs(store,syntheticRuntime(text=>{
      const r=result(text,text.startsWith('A different')?vector(1):vector());
      if(text.startsWith('Café'))r.passages.push({...r.passages[0],index:1,kind:'sentence'});
      return r;
    }));
    store.saveFeedback('1',{labels:[{topic:'Synthetic',subtopic:'Office'}],reason:'Synthetic review.'},'test-reviewer');
    const found=semanticSearch(store,query,{filters:{memberId:'synthetic-one',topic:'Synthetic',subtopic:'Office'}});
    assert.equal(found.results.length,1);assert.equal(found.results[0].post.text,'Café will NOT close.');
    assert.equal(found.results[0].similarity,1);assert.equal(found.coverage.indexedPosts,1);
    assert.ok(found.results[0].evidence.every(e=>found.results[0].post.text.slice(e.start,e.end)===e.text));
    const all=semanticSearch(store,query);
    assert.equal(new Set(all.results.map(r=>r.post.id)).size,3);
    assert.equal(all.results.find(r=>r.post.id==='3').attribution,'quotation-context-unresolved');
    assert.equal(semanticSearch(store,query,{filters:{accountType:'personal'}}).results[0].post.id,'2');
    store.saveFeedback('1',{labels:[],reason:'Synthetic empty correction.'},'test-reviewer');
    assert.equal(semanticSearch(store,query,{filters:{topic:'Synthetic'}}).coverage.totalPosts,0);
    assert.match(all.searchNote,/not a probability/);
  }finally{store.close();}
});

test('search discloses missing, capped and removed sources and bounds hydrated result text',async()=>{
  const store=setup();
  try{
    for(let i=1;i<=8;i++)add(store,i,'Synthetic subject '+i);
    await processEmbeddingJobs(store,syntheticRuntime(),{limit:6});
    let hydrations=0;const original=store.getPost;store.getPost=id=>{hydrations++;return original(id);};
    const result=semanticSearch(store,query,{limit:2,maxPosts:4,maxPassages:3});
    assert.equal(hydrations,2);assert.equal(result.coverage.totalPosts,8);assert.equal(result.coverage.indexedPosts,6);
    assert.equal(result.coverage.omittedCandidatePosts,2);assert.equal(result.coverage.omittedPassages,1);
    assert.equal(result.coverage.complete,false);
    const bounded=semanticSearch(store,query,{maxSourceCharacters:1});
    assert.equal(bounded.results.length,0);assert.ok(bounded.coverage.omittedResponsePosts>0);
    store.removePost('8');
    assert.equal(embeddingStatus(store).passages,5);
    assert.equal(semanticSearch(store,query).results.some(r=>r.post.id==='8'),false);
    assert.throws(()=>semanticSearch(store,{...query,modelFingerprint:'wrong'}),/Invalid/);
    assert.throws(()=>semanticSearch(store,query,{maxPosts:5001}),/Invalid/);
  }finally{store.close();}
});

test('persisted vectors and jobs survive reopening and migration from version six',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pulse-embeddings-')),path=join(dir,'test.sqlite');let store=setup(path);
  try{
    add(store,'1');
    store.db.exec('DROP TABLE incident_case_history; DROP TABLE incident_case_posts; DROP TABLE incident_cases; DROP TABLE incident_reviews; DROP TRIGGER classifier_post_insert; DROP TRIGGER classifier_post_update; DROP TABLE classifier_jobs; DROP TABLE classifier_profiles; DROP TRIGGER embedding_post_insert; DROP TRIGGER embedding_post_update; DROP TABLE embedding_passages; DROP TABLE embedding_jobs; DROP TABLE embedding_models; UPDATE schema_version SET version=6;');
    store.close();store=openStore(path);
    assert.equal(store.db.prepare('SELECT version FROM schema_version').get().version,10);
    await processEmbeddingJobs(store,syntheticRuntime());
    store.close();store=openStore(path);
    assert.equal(semanticSearch(store,query).results[0].post.id,'1');
    assert.equal(embeddingStatus(store).pending,0);
    assert.equal(embeddingStatus(store).completed,1);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('a missing local model fails closed without downloading a model or contacting a paid provider',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pulse-no-model-'));
  try{await assert.rejects(createEmbeddingClient({modelRoot:dir,timeoutMs:1000}),error=>error.code==='SEMANTIC_UNAVAILABLE');}
  finally{rmSync(dir,{recursive:true,force:true});}
});

test('the private semantic API validates before inference and returns source evidence and real coverage',async()=>{
  const store=setup();add(store,'1');await processEmbeddingJobs(store,syntheticRuntime());
  let requests=0;
  const runtime={status:()=>({ready:true,busy:false,queued:0}),embedQuery:async()=>{requests++;return query;}};
  const semantic={name:'minilm',state:'ready',runtime};
  const server=createServer(store,{semantic});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const root=`http://127.0.0.1:${server.address().port}`;
  const search=body=>fetch(`${root}/api/semantic/search`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  try{
    const status=await(await fetch(`${root}/api/semantic`)).json();assert.equal(status.indexedPosts,1);assert.equal(status.runtime.ready,true);
    for(const body of [{query:''},{query:'x'.repeat(2001)},{query:'flood',limit:51},{query:'flood',filters:{since:'invalid'}},
      {query:'flood',extra:'not-supported'},{query:'flood',filters:[]}])assert.equal((await search(body)).status,400);
    assert.equal(requests,0);
    const response=await search({query:'road flood'});assert.equal(response.status,200);
    const found=await response.json();assert.equal(found.results[0].post.text,'Synthetic flood notice.');
    assert.equal(found.coverage.indexedPosts,1);assert.equal(found.coverage.complete,true);assert.equal(requests,1);
    assert.equal(found.coverage.duplicateSentenceDetails,0);
    const foreign=await fetch(`${root}/api/semantic/search`,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://outside.invalid'},body:JSON.stringify({query:'flood'})});
    assert.equal(foreign.status,403);assert.equal(requests,1);
    semantic.runtime=null;
    assert.equal((await search({query:'flood'})).status,503);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM budget_requests').get().n,0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM feedback').get().n,0);
  }finally{await new Promise(resolve=>server.close(resolve));store.close();}
});
