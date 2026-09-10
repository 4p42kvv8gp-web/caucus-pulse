import test from 'node:test';
import assert from 'node:assert/strict';
import {drainLocalQueue} from '../src/local-processing.js';
import {openStore} from '../src/db.js';
import {normalizePost} from '../src/normalize.js';
import {processClassificationJobs} from '../src/classifier-jobs.js';
import {classifierFingerprint} from '../src/classifier-contract.js';
import {processEmbeddingJobs} from '../src/embedding-store.js';
import {embeddingModel} from '../src/embedding-models.js';

const pass=completed=>({completed,failed:0,skipped:0,stale:0,deferred:0});
test('local processing follows completed batches promptly and stops when no work can be claimed',async()=>{
  let calls=0,yielded=false;setImmediate(()=>{yielded=true;});
  const result=await drainLocalQueue({ready:()=>true,runPass:async()=>{calls++;if(calls>1)assert.equal(yielded,true);return pass(calls<4?5:0);}});
  assert.equal(calls,4);assert.equal(result.counts.completed,15);assert.equal(result.reason,'no-claimable-work');
});

test('local passes stop on shutdown, unavailable runtime and an explicit bound',async()=>{
  let stop=false;const interrupted=await drainLocalQueue({ready:()=>true,stopping:()=>stop,runPass:async()=>{stop=true;return {...pass(0),deferred:1};}});assert.equal(interrupted.passes,1);assert.equal(interrupted.reason,'stopping');
  let ready=true;const failed=await drainLocalQueue({ready:()=>ready,runPass:async()=>{ready=false;return {...pass(0),failed:1};}});assert.equal(failed.reason,'runtime-unavailable');assert.equal(failed.passes,1);
  const bounded=await drainLocalQueue({ready:()=>true,maxPasses:3,runPass:async()=>pass(5)});assert.equal(bounded.passes,3);assert.equal(bounded.counts.completed,15);assert.equal(bounded.reason,'pass-limit');
  const absent=await drainLocalQueue({ready:()=>false,runPass:async()=>{throw new Error('Should not run');}});assert.equal(absent.passes,0);
});

test('invalid pass results cannot create a busy loop or a false completed count',async()=>{
  await assert.rejects(drainLocalQueue({ready:()=>true,runPass:async()=>({...pass(1),failed:NaN})}),/Invalid local pass/);
  await assert.rejects(drainLocalQueue({ready:()=>true,maxPasses:101,runPass:async()=>pass(1)}),/configuration/);
});

test('a stopped runtime cannot mark unattempted sources as model failures',async()=>{
  for(const kind of ['classifier','embedding']){const store=openStore();try{
    store.upsertAccount({authorId:'1',memberId:'synthetic',memberName:'Synthetic Member',handle:'Synthetic'});
    for(const id of ['1','2','3'])store.ingest(normalizePost({id,author_id:'1',text:'Synthetic source.',created_at:'2026-09-08T00:00:00Z'}));store.analyzePending();
    let ready=true,calls=0;const fail=async()=>{calls++;ready=false;throw Object.assign(new Error('Synthetic worker failure'),{code:'CLASSIFIER_UNAVAILABLE'});};
    const result=kind==='classifier'?await processClassificationJobs(store,{fingerprint:classifierFingerprint,status:()=>({ready}),classify:fail}):await processEmbeddingJobs(store,{model:embeddingModel(),status:()=>({ready}),embedPost:fail});
    assert.equal(calls,1);assert.equal(result.failed,1);const table=kind==='classifier'?'classifier_jobs':'embedding_jobs';
    const pending=store.db.prepare(`SELECT status,attempts FROM ${table} WHERE status='pending'`).all();assert.equal(pending.length,2);assert.ok(pending.every(row=>row.attempts===0));
  }finally{store.close();}}
});
