import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {openStore} from '../src/db.js';
import {normalizePost} from '../src/normalize.js';
import {classifierFingerprint} from '../src/classifier-contract.js';
import {processClassificationJobs,registerClassifier,claimClassification,deferClassification} from '../src/classifier-jobs.js';
import {embeddingModel} from '../src/embedding-models.js';
import {processEmbeddingJobs,registerEmbeddingModel,claimEmbeddingJob,deferEmbeddingJob} from '../src/embedding-store.js';
import {createLocalClassifierClient} from '../src/classifier-client.js';
import {createEmbeddingClient} from '../src/embedding-client.js';

function setup(){const store=openStore();store.upsertAccount({authorId:'1',memberId:'synthetic',memberName:'Synthetic Member',handle:'Synthetic'});for(const id of ['1','2'])add(store,id);return store;}
function add(store,id,text='Synthetic Medicaid source.'){store.ingest(normalizePost({id,author_id:'1',text,created_at:'2026-09-08T00:00:00Z'}));store.analyzePending();}
const cancel=code=>Object.assign(new Error('Synthetic shutdown'),{code});
const result=request=>({result:{postId:request.input.postId,sourceHash:request.input.sourceHash,labels:[],entities:[],events:[],functions:[],summary:'Synthetic output.',limitations:[]},metrics:{}});
function jobs(store,table){return store.db.prepare(`SELECT post_id,status,attempts,lease_owner FROM ${table} ORDER BY post_id`).all().map(row=>({...row}));}

test('planned classifier shutdown defers only active work and resumes without consuming a failed attempt',async()=>{
  const store=setup();let stopping=false,calls=0;try{
    const before=store.getPost('2').analysis;
    const first=await processClassificationJobs(store,{fingerprint:classifierFingerprint,classify:async()=>{calls++;stopping=true;throw cancel('CLASSIFIER_CANCELLED');}},{now:()=>1000,stopping:()=>stopping});
    assert.equal(first.deferred,1);assert.equal(first.failed,0);assert.equal(calls,1);assert.ok(jobs(store,'classifier_jobs').every(j=>j.status==='pending'&&j.attempts===0&&j.lease_owner===null));assert.deepEqual(store.getPost('2').analysis,before);
    const next=await processClassificationJobs(store,{fingerprint:classifierFingerprint,classify:async request=>result(request)},{now:()=>1100});assert.equal(next.completed,2);
  }finally{store.close();}
});

test('cancellation without a planned stop is a visible failure, and changed analysis is not requeued over a newer decision',async()=>{
  const store=setup();try{
    const first=await processClassificationJobs(store,{fingerprint:classifierFingerprint,classify:async()=>{throw cancel('CLASSIFIER_CANCELLED');}},{limit:1,now:()=>1000});assert.equal(first.failed,1);assert.equal(first.deferred,0);
    let stopping=false;
    const second=await processClassificationJobs(store,{fingerprint:classifierFingerprint,classify:async request=>{
      const changed={...store.getPost(request.input.postId).analysis,explanation:'Synthetic explicitly restored analysis.'};store.db.prepare('UPDATE analyses SET analysis_json=? WHERE post_id=?').run(JSON.stringify(changed),request.input.postId);stopping=true;throw cancel('CLASSIFIER_CANCELLED');
    }},{now:()=>1100,stopping:()=>stopping});
    assert.equal(second.stale,1);assert.equal(second.deferred,0);assert.ok(jobs(store,'classifier_jobs').every(j=>j.status==='failed'));
  }finally{store.close();}
});

test('source edits during classifier shutdown retain the new pending source and do not resurrect removed sources',async()=>{
  for(const remove of [false,true]){const store=setup();let stopping=false;try{
    const result=await processClassificationJobs(store,{fingerprint:classifierFingerprint,classify:async request=>{
      if(remove)store.removePost(request.input.postId);else add(store,request.input.postId,'Edited synthetic source.');stopping=true;throw cancel('CLASSIFIER_CANCELLED');
    }},{now:()=>1000,stopping:()=>stopping});assert.equal(result.stale,1);assert.equal(result.deferred,0);
    if(remove)assert.equal(store.getPost('2'),null);else assert.equal(store.getPost('2').text,'Edited synthetic source.');
    assert.ok(jobs(store,'classifier_jobs').every(j=>j.status==='pending'&&j.attempts===0));
  }finally{store.close();}}
});

test('embedding shutdown leaves a pending source and does not claim the rest of the queue',async()=>{
  const store=setup();let stopping=false,calls=0;try{
    const count=await processEmbeddingJobs(store,{model:embeddingModel(),embedPost:async()=>{calls++;stopping=true;throw cancel('SEMANTIC_CANCELLED');}},{now:()=>1000,stopping:()=>stopping});
    assert.equal(count.deferred,1);assert.equal(count.failed,0);assert.equal(calls,1);assert.ok(jobs(store,'embedding_jobs').every(j=>j.status==='pending'&&j.attempts===0&&j.lease_owner===null));
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM embedding_passages').get().n,0);
  }finally{store.close();}
});

test('expired or replaced model claims cannot be deferred by an old worker',()=>{
  const store=setup();try{
    registerClassifier(store,1000);const c=claimClassification(store,{now:1000,leaseMs:1000});assert.equal(deferClassification(store,c,2000),0);
    const newer=claimClassification(store,{now:2001,leaseMs:1000});assert.equal(deferClassification(store,c,2002),0);assert.equal(jobs(store,'classifier_jobs').find(j=>j.post_id===newer.postId).lease_owner,newer.owner);
    const model=registerEmbeddingModel(store,embeddingModel(),1000);const e=claimEmbeddingJob(store,model,{now:1000,leaseMs:1000});assert.equal(deferEmbeddingJob(store,e,2000),0);
    const next=claimEmbeddingJob(store,model,{now:2001,leaseMs:1000});assert.equal(deferEmbeddingJob(store,e,2002),0);assert.equal(jobs(store,'embedding_jobs').find(j=>j.post_id===next.postId).lease_owner,next.owner);
  }finally{store.close();}
});

test('already aborted model lifetimes fail before starting a runtime',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(createLocalClassifierClient({python:'/missing/synthetic-executable',signal:controller.signal}),{code:'CLASSIFIER_CANCELLED'});
  await assert.rejects(createEmbeddingClient({modelRoot:'/missing/synthetic-model',signal:controller.signal}),{code:'SEMANTIC_CANCELLED'});
});

test('a classifier warming up is cancelled and its real child process exits before rejection',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'pulse-shutdown-')),pidPath=join(directory,'pid'),executable=join(directory,'synthetic-worker');
  writeFileSync(executable,'#!'+process.execPath+'\nimport {writeFileSync} from "node:fs";writeFileSync('+JSON.stringify(pidPath)+',String(process.pid));setInterval(()=>{},1000);\n',{mode:0o700});
  const controller=new AbortController();const pending=createLocalClassifierClient({python:executable,signal:controller.signal});
  const observed=assert.rejects(pending,{code:'CLASSIFIER_CANCELLED'});
  try{for(let i=0;i<100&&!existsSync(pidPath);i++)await delay(10);assert.ok(existsSync(pidPath));const pid=Number(readFileSync(pidPath,'utf8'));controller.abort();await observed;assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});}
  finally{controller.abort();await observed;rmSync(directory,{recursive:true,force:true});}
});

test('an active classifier and its queued request are both cancelled and joined',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'pulse-active-stop-')),executable=join(directory,'synthetic-worker');
  writeFileSync(executable,'#!'+process.execPath+'\nprocess.stdout.write(JSON.stringify({ready:true})+"\\n");process.stdin.resume();setInterval(()=>{},1000);\n',{mode:0o700});
  const controller=new AbortController();let client;
  try{client=await createLocalClassifierClient({python:executable,signal:controller.signal});const request={input:{postId:'1',sourceHash:'synthetic',text:'Synthetic source.',postType:'original'}};
    const a=assert.rejects(client.classify(request),{code:'CLASSIFIER_CANCELLED'}),b=assert.rejects(client.classify(request),{code:'CLASSIFIER_CANCELLED'});controller.abort();await Promise.all([a,b]);await client.close();assert.equal(client.status().ready,false);assert.equal(client.status().queued,0);
  }finally{controller.abort();await client?.close();rmSync(directory,{recursive:true,force:true});}
});

test('embedding initialization can be aborted without loading a model or leaving its thread alive',async()=>{
  const controller=new AbortController();const pending=createEmbeddingClient({modelRoot:'/missing/synthetic-model',signal:controller.signal});const observed=assert.rejects(pending,{code:'SEMANTIC_CANCELLED'});controller.abort();await observed;
});
