import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/db.js';
import {createBudget} from '../src/budget.js';
import {checkXAccess} from '../src/x-access-check.js';
const clock=()=>Date.parse('2026-09-08T17:00:00Z');
const policy={dailyCeilingUsd:25,pilotCeilingUsd:350,reserveUsd:50,resourcePricesUsd:{post:0.005,user:0.01}};

test('usage success with credit 404 never creates a balance or a paid reservation',async()=>{
  const store=openStore();try{
    const budget=createBudget(store.db,policy,{clock});
    const result=await checkXAccess({budget,clock,client:{creditBalance:async()=>{throw Object.assign(new Error('secret provider detail'),{code:'http-404'});},usageAccess:async()=>({available:true})}});
    assert.equal(result.credit.state,'unavailable');assert.equal(result.credit.code,'http-404');assert.equal(result.usage.state,'available');
    assert.equal(budget.state().balanceVerifiedAt,null);assert.equal(budget.state().requestCount,0);
    assert.equal(JSON.stringify(result).includes('secret provider detail'),false);
  }finally{store.close();}
});
test('only valid prepaid dollar observations enter the budget ledger',async()=>{
  const store=openStore();try{
    const budget=createBudget(store.db,policy,{clock});
    const result=await checkXAccess({budget,clock,client:{creditBalance:async()=>({prepaidUsd:396.975}),usageAccess:async()=>({available:true})}});
    assert.equal(result.credit.state,'verified');assert.equal(budget.state().verifiedPrepaidUsd,396.975);assert.equal(budget.state().requestCount,0);
    const invalid=await checkXAccess({budget,clock,client:{creditBalance:async()=>({prepaidUsd:'400'}),usageAccess:async()=>{throw new Error('private data');}}});
    assert.equal(invalid.credit.state,'unavailable');assert.equal(invalid.usage.code,'check-failed');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM balance_observations').get().n,1);
  }finally{store.close();}
});
