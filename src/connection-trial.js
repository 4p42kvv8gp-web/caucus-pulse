import { createBudget } from './budget.js';
import { passPlan, workerReadiness } from './worker.js';
import { syncListInventory } from './list-inventory.js';
import { registerListSource, collectOnce } from './collect.js';
import { promoteCaptured } from './roster.js';

export async function runConnectionTrial({store,settings,mode,fieldDialect='tweet',client,expiresAt,execute=false,clock=()=>Date.now()}){
  const plan=passPlan(settings,{mode,trial:true,fieldDialect,pageSize:mode==='inventory'?100:5,maxPages:mode==='inventory'?3:1});
  const trial={expiresAt,reason:'credit-endpoint-unavailable'};
  const budget=createBudget(store.db,settings.budget,{clock,connectionTrial:trial});
  const note='Explicit connection trial only: at most $3.025 across the entire existing request ledger. A missing balance stays unverified. No scheduler or top-up starts.';
  plan.note='Checks credits first. Only the documented credits endpoint returning 404 permits the explicit lifetime-capped trial after a successful usage-access check; this does not verify remaining prepaid credit.';
  if(!execute)return {status:'preview',plan,budget:budget.state(),note};
  if(!budget.state().connectionTrial.active||budget.state().remainingMicro<Math.round(plan.maximumReadCostUsd*1_000_000))return {status:'paused',reason:'connection-trial-ceiling-or-expiry',plan,note};
  if(!client||typeof client.creditBalance!=='function'||typeof client.usageAccess!=='function')throw new Error('Private access adapter is unavailable.');
  const readStartedAt=new Date(clock()).toISOString();
  let missingBalance=false;
  try{budget.recordBalance({...await client.creditBalance(),readStartedAt});}
  catch(error){
    if(error.code!=='http-404')return {status:'paused',reason:'balance-check-rejected',code:/^http-\d{3}$/.test(error.code??'')?error.code:'unavailable',plan,note};
    missingBalance=true;
  }
  try{const access=await client.usageAccess();if(access?.available!==true)throw new Error('Unavailable');}
  catch{return {status:'paused',reason:'usage-access-not-verified',plan,note};}
  const result=mode==='inventory'
    ?await syncListInventory({db:store.db,listId:settings.listId,fetchPage:client.listMembers,budget,pageSize:100,maxPages:3,clock})
    :await collectOnce({db:store.db,sourceId:registerListSource(store.db,settings.listId),fetchPage:client.listPosts,budget,pageSize:5,maxPages:1,clock});
  const processing=promoteCaptured(store,{now:clock()});store.analyzePending();
  return {...result,plan,missingBalance,processing,budget:budget.state(),readiness:workerReadiness(store,settings,{clock}),note};
}
