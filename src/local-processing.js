import {setImmediate as yieldTurn} from 'node:timers/promises';

/** Drain bounded local passes promptly, yielding between them for HTTP and shutdown. */
export async function drainLocalQueue({runPass,ready,stopping=()=>false,maxPasses=100}){
  if(typeof runPass!=='function'||typeof ready!=='function'||typeof stopping!=='function'||!Number.isInteger(maxPasses)||maxPasses<1||maxPasses>100)
    throw new Error('Invalid local processing configuration.');
  const counts={completed:0,failed:0,skipped:0,stale:0,deferred:0};let passes=0;
  while(passes<maxPasses&&ready()&&!stopping()){
    const result=await runPass();passes++;
    if(!result||Object.keys(counts).some(key=>!Number.isSafeInteger(result[key])||result[key]<0))throw new Error('Invalid local pass result.');
    const work=Object.keys(counts).reduce((n,key)=>n+result[key],0);
    for(const key of Object.keys(counts))counts[key]+=result[key];
    if(!work)return {passes,counts,reason:'no-claimable-work'};
    await yieldTurn();
  }
  return {passes,counts,reason:stopping()?'stopping':!ready()?'runtime-unavailable':'pass-limit'};
}
