import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {openStore} from '../src/db.js';
import {normalizePost} from '../src/normalize.js';
import {writePrivateJson} from '../src/private-files.js';

process.umask(0o077);
if(process.argv.length!==2){console.error('Use host-shutdown-smoke.js without arguments, with the preview stopped.');process.exit(1);}
const root=fileURLToPath(new URL('../',import.meta.url)),directory=mkdtempSync(join(tmpdir(),'pulse-host-shutdown-'));
const SOURCE_COUNT=6;
const report={kind:'synthetic-service-shutdown-check',generatedAt:new Date().toISOString(),platform:process.platform,architecture:process.arch,
  checks:[],providerRequests:0,realArchiveOpened:false,humanAccuracyMeasured:false};
let child=null,childFinished=null;
async function exercise(mode,existingDatabase=null){
  const database=existingDatabase??join(directory,mode+'.sqlite');let store;
  if(!existingDatabase){store=openStore(database);
  store.upsertAccount({authorId:'700',memberId:'synthetic-smoke',memberName:'Synthetic Test Member',handle:'SyntheticOnly'});
  for(let i=0;i<SOURCE_COUNT;i++)store.ingest(normalizePost({id:String(7001+i),author_id:'700',created_at:'2026-09-01T00:00:00Z',
    text:'Synthetic exercise only: residents can contact the office for help after a flood. '+('Routine constituent appointments remain available. '.repeat(2))}));
  store.close();}
  const processHandle=spawn(process.execPath,[resolve(root,'src/server.js')],{cwd:root,
    env:{PATH:dirname(process.execPath),PORT:'0',CAUCUS_DB_PATH:database,NODE_ENV:'test'},stdio:['ignore','pipe','ignore']});child=processHandle;
  let address=null,buffer='',exit=null;
  const finished=new Promise(resolve=>processHandle.once('close',(code,signal)=>{exit={code,signal};resolve(exit);}));
  childFinished=finished;
  processHandle.on('error',()=>{});
  processHandle.stdout.setEncoding('utf8');processHandle.stdout.on('data',data=>{buffer=(buffer+data).slice(-1000);address=buffer.match(/http:\/\/127\.0\.0\.1:(\d+)/)?.[0]??address;});
  const start=performance.now();let status=null;
  while(performance.now()-start<(mode==='resume'?180000:65000)){
    if(exit)throw new Error('Synthetic service exited before its shutdown check.');
    if(address){
      const response=await fetch(address+'/api/classification',{signal:AbortSignal.timeout(3000)});status=await response.json();
      if(mode==='startup'||(mode==='inference'&&status.runtime?.busy)||(mode==='resume'&&status.completed===SOURCE_COUNT&&!status.runtime?.busy))break;
      if(status.state==='model-unavailable')throw new Error('Model was unavailable; close the other classifier before this check.');
      if(status.failed||status.skipped)throw new Error('Synthetic analysis failed before recovery could complete.');
    }
    await delay(100);
  }
  if(!address||(mode==='inference'&&!status?.runtime?.busy))throw new Error('The intended shutdown state was not observed.');
  if(mode==='resume'&&status?.completed!==SOURCE_COUNT)throw new Error('The deferred sources did not finish after restart.');
  const stoppingAt=performance.now();processHandle.kill('SIGTERM');
  let timer;const stopped=await Promise.race([finished,new Promise(resolve=>{timer=setTimeout(()=>resolve({timeout:true}),10000);})]);clearTimeout(timer);
  if(stopped.timeout){processHandle.kill('SIGKILL');await finished;throw new Error('The synthetic service exceeded the shutdown deadline.');}
  child=null;
  if(stopped.code!==0||stopped.signal)throw new Error('The synthetic service did not exit cleanly.');
  store=openStore(database);try{
    const rows=store.db.prepare('SELECT status,attempts FROM classifier_jobs').all();
    const total=store.db.prepare('SELECT COUNT(*) AS n FROM posts').get().n;
    const requests=store.db.prepare('SELECT COUNT(*) AS n FROM budget_requests').get().n;
    const embeddingJobs=store.db.prepare('SELECT status,attempts FROM embedding_jobs').all();
    const integrity=store.db.prepare('PRAGMA quick_check').get().quick_check;
    if(total!==SOURCE_COUNT||requests!==0||integrity!=='ok'||[...rows,...embeddingJobs].some(row=>['running','failed','skipped'].includes(row.status)))throw new Error('Shutdown did not preserve the expected synthetic archive/job state.');
    if(mode==='inference'&&(!rows.length||rows.some(row=>row.status==='pending'&&row.attempts!==0)))throw new Error('An interrupted run consumed a failed attempt.');
    if(mode==='resume'&&(rows.length!==SOURCE_COUNT||rows.some(row=>row.status!=='completed'||row.attempts!==1)))throw new Error('Deferred work did not resume exactly once.');
    report.checks.push({mode,ok:true,observedState:status.state,observedBusy:status.runtime?.busy??false,operationMs:Math.round(performance.now()-start),shutdownMs:Math.round(performance.now()-stoppingAt),
      sourcePosts:total,providerRequests:requests,jobs:rows.map(row=>({...row})),embeddingJobs:embeddingJobs.map(row=>({...row})),integrity});
  }finally{store.close();}
  return database;
}
try{await exercise('startup');const paused=await exercise('inference');await exercise('resume',paused);}
catch{report.checks.push({mode:'execution',ok:false,code:'HOST_SHUTDOWN_CHECK_FAILED'});}
finally{if(child){child.kill('SIGKILL');await childFinished;}rmSync(directory,{recursive:true,force:true});}
report.checksPassed=report.checks.length===3&&report.checks.every(check=>check.ok);
const path=resolve(root,`data/reports/host-shutdown-${process.platform}-${process.arch}-${Date.now()}.json`);writePrivateJson(path,report);
console.log(JSON.stringify({...report,report:path},null,2));if(!report.checksPassed)process.exitCode=1;
