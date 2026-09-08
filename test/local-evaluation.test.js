import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/db.js';
import {normalizePost} from '../src/normalize.js';
import {createEvaluationSet} from '../src/evaluation.js';
import {evaluateLocalClassifier} from '../src/local-evaluation.js';
import {classifierFingerprint} from '../src/classifier-contract.js';

function setup(){
  const store=openStore();store.upsertAccount({authorId:'1',memberId:'synthetic',memberName:'Synthetic Test Member',handle:'Synthetic'});
  for(const [id,text] of [['1','Medicaid coverage has changed.'],['2','A separate Medicaid announcement.']]){
    store.ingest(normalizePost({id,author_id:'1',text,created_at:'2026-09-08T00:00:00Z'}));store.analyzePending();
    store.saveFeedback(id,{decision:'classified',labels:[{topic:'Health care',subtopic:'Medicaid'}],reason:'Synthetic judgment only.'});
  }
  return {store,set:createEvaluationSet(store,{title:'Synthetic held-out comparison',postIds:['1']})};
}
const output=request=>({result:{postId:request.input.postId,sourceHash:request.input.sourceHash,
  labels:[{topic:'Health care',subtopic:'Medicaid',explanation:'Synthetic source evidence.',evidence:[{start:0,end:request.input.text.length,text:request.input.text}]}],
  entities:[],events:[],functions:[],summary:'Synthetic output.',limitations:[]}});

test('offline candidate evaluation records exact profile identity and no examples while preserving production judgments',async()=>{
  const {store,set}=setup();let closed=false,calls=0;try{
    const before=store.getPost('1');const runs=store.db.prepare('SELECT COUNT(*) AS n FROM analysis_runs').get().n;
    const report=await evaluateLocalClassifier(store,set.id,{createClient:async()=>({fingerprint:classifierFingerprint,
      classify:async request=>{calls++;assert.deepEqual(request.input.reviewedExamples,[]);assert.equal(Object.hasOwn(request.input,'expected'),false);return output(request);},close:async()=>{closed=true;}})});
    assert.equal(calls,1);assert.equal(closed,true);assert.equal(report.counts.exactMatches,1);assert.ok(report.model.endsWith(classifierFingerprint));assert.deepEqual(report.cases[0].examples,[]);
    assert.deepEqual(store.getPost('1'),before);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM analysis_runs').get().n,runs);
  }finally{store.close();}
});

test('stale evaluation is refused before model loading and a mismatched model closes without a run',async()=>{
  const {store,set}=setup();let loaded=0,closed=0;try{
    await assert.rejects(evaluateLocalClassifier(store,set.id,{createClient:async()=>{loaded++;return {fingerprint:'wrong',close:async()=>closed++};}}),/fingerprint/);
    assert.equal(closed,1);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM evaluation_runs').get().n,0);
    store.saveFeedback('1',{decision:'needs-context',labels:[],reason:'Synthetic revised uncertainty.'});
    await assert.rejects(evaluateLocalClassifier(store,set.id,{createClient:async()=>{loaded++;throw new Error('Should not load');}}),/changed/);
    assert.equal(loaded,1);
  }finally{store.close();}
});

test('offline inference failure is recorded independently and always closes the candidate runtime',async()=>{
  const {store,set}=setup();let closed=false;try{
    const report=await evaluateLocalClassifier(store,set.id,{createClient:async()=>({fingerprint:classifierFingerprint,classify:async()=>{throw new Error('Synthetic private diagnostic');},close:async()=>{closed=true;}})});
    assert.equal(report.counts.failed,1);assert.equal(report.counts.exactMatches,0);assert.equal(report.status,'finished');assert.equal(closed,true);
    assert.equal(JSON.stringify(report).includes('private diagnostic'),false);assert.equal(store.getPost('1').feedback.length,1);
  }finally{store.close();}
});
