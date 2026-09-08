import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/db.js';
import { normalizePost } from '../src/normalize.js';
import { prepareAnalysis } from '../src/intelligence.js';
import { reviewedExampleSelection } from '../src/reviewed-examples.js';
import { reserveHoldouts } from '../src/learning-context.js';
import { embeddingModel } from '../src/embedding-models.js';
import { registerEmbeddingModel } from '../src/embedding-store.js';

function setup(){const store=openStore();store.upsertAccount({authorId:'1',memberId:'synthetic',memberName:'Synthetic',handle:'Synthetic'});registerEmbeddingModel(store,embeddingModel('bge'));return store;}
function add(store,id,text){store.ingest(normalizePost({id,author_id:'1',text,created_at:'2026-09-08T00:00:00Z'}));store.analyzePending();return store.getPost(id);}
function review(store,id,decision='classified'){return store.saveFeedback(id,{labels:decision==='classified'?[{topic:'Economy & cost of living',subtopic:'Federal Reserve and monetary policy'}]:[],decision,reason:'Synthetic teaching explanation.'},'synthetic-reviewer');}
function vector(store,id,axis=0,count=1){const post=store.getPost(id),bytes=Buffer.alloc(1536);bytes.writeFloatLE(1,axis*4);for(let i=0;i<count;i++)store.db.prepare('INSERT INTO embedding_passages VALUES (?,?,?,?,?,?,?,?,?)').run(id,embeddingModel('bge').fingerprint,post.contentHash,i,0,post.text.length,10,'context-window',bytes);}

test('accepted examples can be retrieved semantically without shared literal topic words',()=>{
  const store=setup();
  try{
    const post=add(store,'1','Our reserve bank must set rates without political interference.');vector(store,'1');
    add(store,'2','Monetary decisions should remain independent of elected officials.');review(store,'2');vector(store,'2');
    add(store,'3','The garden festival opens this weekend.');review(store,'3');vector(store,'3',1);
    const selected=reviewedExampleSelection(store,post);
    assert.deepEqual(selected.examples.map(e=>e.postId),['2']);
    assert.equal(selected.examples[0].retrieval.lexical,false);
    assert.equal(selected.examples[0].retrieval.method,'semantic-passages-with-topic-fallback');
    const request=prepareAnalysis(store,'1');
    assert.equal(request.input.exampleRetrieval.selectedExamples,1);
    assert.equal(request.input.reviewedExamples[0].decision,'classified');
  }finally{store.close();}
});

test('semantic similarity never overrides held-out, duplicate, superseded or uncertain-example exclusions',()=>{
  const store=setup();
  try{
    const post=add(store,'1','Monetary decisions should remain independent.');vector(store,'1');
    add(store,'2','Rates should reflect evidence alone.');review(store,'2');vector(store,'2');reserveHoldouts(store,['2']);
    add(store,'3','Monetary decisions should remain independent.');review(store,'3');vector(store,'3');
    add(store,'4','Protect the central bank from pressure.');review(store,'4','needs-context');vector(store,'4');
    add(store,'5','Keep decisions independent from elected officials.');review(store,'5');vector(store,'5');
    assert.deepEqual(reviewedExampleSelection(store,post).examples.map(e=>e.postId),['5']);
    review(store,'5','needs-context');
    assert.equal(reviewedExampleSelection(store,post).examples.length,0);
    add(store,'5','An edited and unreviewed version.');vector(store,'5');
    assert.equal(reviewedExampleSelection(store,post).examples.length,0);
    assert.equal(reviewedExampleSelection(store,post,{holdoutIds:['1','5']}).examples.length,0);
  }finally{store.close();}
});

test('explicit empty answers teach abstention and source text is kept whole under context limits',()=>{
  const store=setup();
  try{
    const post=add(store,'1','The central bank should set monetary policy independently.');vector(store,'1');
    add(store,'2','An unclear reaction with an unavailable link.');review(store,'2','no-supported-topic');vector(store,'2');
    const selected=reviewedExampleSelection(store,post);
    assert.equal(selected.examples[0].decision,'no-supported-topic');assert.deepEqual(selected.examples[0].labels,[]);
    add(store,'3','A'.repeat(8001));review(store,'3');vector(store,'3');
    add(store,'4','B'.repeat(6000));review(store,'4');vector(store,'4');
    add(store,'5','C'.repeat(6000));review(store,'5');vector(store,'5');
    const bounded=reviewedExampleSelection(store,post);
    assert.equal(bounded.coverage.oversizedSources,1);
    assert.equal(bounded.coverage.omittedForContextBudget,1);
    assert.equal(bounded.examples.some(e=>e.postId==='3'),false);
    assert.ok(bounded.examples.every(e=>e.text===store.getPost(e.postId).text));
    assert.ok(bounded.coverage.selectedSourceCharacters<=10000);
    assert.equal(reviewedExampleSelection(store,post,{limit:0}).examples.length,0);
  }finally{store.close();}
});

test('candidate scanning and passage comparison disclose their finite coverage without hydrating the archive',()=>{
  const store=setup();
  try{
    const post=add(store,'1','Central bank decisions need independence.');vector(store,'1',0,20);
    for(let i=2;i<205;i++){add(store,String(i),`Synthetic monetary example number ${i}.`);review(store,String(i));vector(store,String(i),0,10);}
    const original=store.getPost;store.getPost=()=>{throw new Error('Candidate retrieval must not hydrate the archive.');};
    const result=reviewedExampleSelection(store,post);
    store.getPost=original;
    assert.equal(result.coverage.eligibleReviewedPosts,203);assert.equal(result.coverage.examinedReviewedPosts,200);
    assert.equal(result.coverage.omittedOlderCandidates,3);assert.equal(result.coverage.omittedTargetPassages,4);
    assert.equal(result.coverage.omittedCandidatePassages,400);assert.equal(result.examples.length,5);
  }finally{store.close();}
});
