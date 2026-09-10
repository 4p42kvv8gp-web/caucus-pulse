import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openStore} from '../src/db.js';
import {createBudget} from '../src/budget.js';
import {runConnectionTrial} from '../src/connection-trial.js';

const now=Date.parse('2026-09-08T06:00:00Z'),expiresAt='2026-09-08T07:00:00Z';
const policy={dailyCeilingUsd:25,pilotCeilingUsd:350,reserveUsd:50,balanceMaxAgeSeconds:300,resourcePricesUsd:{post:0.005,user:0.01}};
const settings={listId:'1841177179872243858',collectionEnabled:false,budget:policy};
const trial={reason:'credit-endpoint-unavailable',expiresAt};
const unavailable=()=>Promise.reject(Object.assign(new Error('Synthetic endpoint not found'),{code:'http-404'}));

test('connection trial remains distinct from verified balance and caps the entire persistent ledger',()=>{
  const dir=mkdtempSync(join(tmpdir(),'pulse-connection-trial-'));let store=openStore(join(dir,'test.sqlite'));
  try{
    let budget=createBudget(store.db,policy,{clock:()=>now,connectionTrial:trial});
    assert.equal(budget.state().balanceFresh,false);assert.equal(budget.state().connectionTrial.prepaidReserveVerified,false);
    const users=budget.reserveRequest({kind:'user',maxResources:300,purpose:'roster'});budget.uncertain(users.id);
    const posts=budget.reserveRequest({kind:'post',maxResources:5,purpose:'new-posts'});budget.uncertain(posts.id);
    assert.equal(budget.state().totalMicro,3_025_000);
    assert.throws(()=>budget.reserveRequest({kind:'post',maxResources:1,purpose:'new-posts'}),e=>e.code==='budget-ceiling');
    assert.match(store.db.prepare('SELECT purpose FROM budget_requests WHERE id=?').get(users.id).purpose,/^connection-trial:/);
    store.close();store=openStore(join(dir,'test.sqlite'));
    budget=createBudget(store.db,policy,{clock:()=>now+1000,connectionTrial:{...trial,expiresAt:'2026-09-08T08:00:00Z'}});
    assert.equal(budget.state().remainingMicro,0);
    assert.throws(()=>createBudget(store.db,policy,{clock:()=>now}).reserveRequest({kind:'post',maxResources:1,purpose:'new-posts'}),e=>e.code==='balance-verification-required');
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('trial expiry, known low credit and billing faults still prevent new requests',()=>{
  const store=openStore();
  try{
    assert.throws(()=>createBudget(store.db,policy,{clock:()=>now,connectionTrial:{...trial,expiresAt:'2026-09-09T00:00:00Z'}}),/Invalid/);
    const expired=createBudget(store.db,policy,{clock:()=>Date.parse(expiresAt),connectionTrial:trial});
    assert.throws(()=>expired.reserveRequest({kind:'post',maxResources:1,purpose:'new-posts'}),e=>e.code==='balance-verification-required');
    const budget=createBudget(store.db,policy,{clock:()=>now,connectionTrial:trial});
    budget.recordBalance({prepaidUsd:49,readStartedAt:new Date(now).toISOString()});
    assert.throws(()=>budget.reserveRequest({kind:'post',maxResources:1,purpose:'new-posts'}),e=>e.code==='budget-ceiling');
    store.db.prepare('INSERT INTO operation_faults(id,code,created_at) VALUES (?,?,?)').run('synthetic','response-exceeded-reservation',new Date(now).toISOString());
    assert.throws(()=>budget.reserveRequest({kind:'post',maxResources:1,purpose:'new-posts'}),e=>e.code==='billing-review-required');
  }finally{store.close();}
});

test('preview is free and a missing credit endpoint requires successful usage authentication before paid reads',async()=>{
  const store=openStore();let calls=0;
  const client={creditBalance:unavailable,usageAccess:async()=>{throw new Error('Synthetic access failed');},listMembers:async()=>{calls++;return {data:[]};}};
  try{
    const args={store,settings,mode:'inventory',expiresAt,clock:()=>now,client};
    assert.equal((await runConnectionTrial(args)).status,'preview');assert.equal(calls,0);
    assert.equal((await runConnectionTrial({...args,execute:true})).reason,'usage-access-not-verified');assert.equal(calls,0);
    assert.equal(createBudget(store.db,policy,{clock:()=>now}).state().requestCount,0);
    client.creditBalance=async()=>{throw Object.assign(new Error('Synthetic rejected'),{code:'http-401'});};
    client.usageAccess=async()=>({available:true});
    assert.equal((await runConnectionTrial({...args,execute:true})).reason,'balance-check-rejected');assert.equal(calls,0);
  }finally{store.close();}
});

test('bounded authenticated inventory is recorded as a trial without inventing member bindings or balance',async()=>{
  const store=openStore();let calls=0;
  const client={creditBalance:unavailable,usageAccess:async()=>({available:true}),listMembers:async()=>{calls++;return {data:[{id:'1',username:'Synthetic',name:'Synthetic Account',protected:false}],meta:{result_count:1}};}};
  try{
    const result=await runConnectionTrial({store,settings,mode:'inventory',expiresAt,clock:()=>now,client,execute:true});
    assert.equal(calls,1);assert.equal(result.missingBalance,true);assert.equal(result.budget.balanceFresh,false);
    assert.equal(result.budget.totalMicro,10000);assert.equal(result.readiness.roster.activeAccountBindings,0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM posts').get().n,0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM balance_observations').get().n,0);
  }finally{store.close();}
});

test('a failed paid trial keeps its maximum reservation and can never enable ordinary polling',async()=>{
  const store=openStore();
  const client={creditBalance:unavailable,usageAccess:async()=>({available:true}),listPosts:async()=>{throw new Error('Synthetic transport uncertainty');}};
  try{
    await runConnectionTrial({store,settings,mode:'posts',expiresAt,clock:()=>now,client,execute:true});
    const state=createBudget(store.db,policy,{clock:()=>now}).state();
    assert.equal(state.totalMicro,25000);assert.equal(state.unresolvedRequests,1);assert.equal(state.remainingMicro,0);
    assert.equal(settings.collectionEnabled,false);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM posts').get().n,0);
  }finally{store.close();}
});
