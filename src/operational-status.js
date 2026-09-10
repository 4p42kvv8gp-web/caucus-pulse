import {atomic} from './sqlite.js';
import {workerReadiness} from './worker.js';
import {classificationStatus} from './classifier-jobs.js';
import {embeddingStatus} from './embedding-store.js';
import {learningStatus} from './learning-context.js';

export function describeOperationalStatus({readiness,classification,semantic,learning,connection,awaitingRoster,collectionEnabled,generatedAt}){
  const components=[],budget=readiness.budget,roster=readiness.roster,inventory=readiness.inventory;
  const add=(id,state,title,detail)=>components.push({id,state,title,detail});
  add('collection','paused','Automatic collection is off',collectionEnabled?'Bounded live passes are enabled in configuration; no repeating collection service is installed.':'Collection is paused. Reading this status does not start a pass or spend credits.');
  if(!connection.configured)add('x-connection','attention','Private X connection is missing','Configure the product token privately before checking account access.');
  else add('x-connection','configured','Private X token is present','Presence alone does not verify provider access, billing or available credit.');
  if(budget.fault)add('spending','blocked','An operational check requires review',`Paid reads remain blocked (${budget.fault}). Resolve the recorded issue before continuing.`);
  else if(budget.unresolvedRequests)add('spending','blocked','A paid request needs reconciliation',`${budget.unresolvedRequests} requests remain uncertain or unfinished. Preserve their reservations while checking what the provider charged.`);
  else if(!budget.balanceFresh)add('spending','blocked','Provider credit needs verification','There is no fresh verified dollar balance. The local spending total is not the provider balance.');
  else if(budget.remainingMicro<=0)add('spending','blocked','The spending allowance is exhausted','The daily ceiling, pilot ceiling or protected reserve prevents further paid reads.');
  else add('spending','observed','A recent credit observation is available','Each request still needs its own reservation and must remain within the configured limits.');
  const rosterFresh=Boolean(roster.snapshot?.fresh),inventoryFresh=Boolean(inventory?.fresh);
  add('account-evidence',rosterFresh&&inventoryFresh?'observed':'attention',rosterFresh&&inventoryFresh?'Account evidence is within its observation windows':'Account coverage needs reconciliation',
    `${roster.activeAccountBindings??0} active account bindings. ${!rosterFresh?'The dated House roster needs refreshing. ':''}${!inventoryFresh?'The supplied List needs a fresh completed scan. ':''}${awaitingRoster} captured posts await account verification. These counts do not establish complete caucus coverage.`);
  function model(id,label,data){
    const failures=(data.failed??0)+(data.skipped??0),pending=(data.pending??0)+(data.running??0);
    const indexed=id==='semantic-index'?data.indexedPosts:data.completed;
    if(data.state==='disabled')return add(id,'disabled',`${label} is disabled`,'Saved sources and earlier results remain available.');
    if(data.state==='starting')return add(id,'starting',`${label} is starting`,'The model is loading locally; existing source posts remain available.');
    if(data.state==='worker-needs-attention')return add(id,'attention',`${label} processing needs review`,'A local processing pass did not finish normally. Inspect the worker before treating saved results as current.');
    if(!data.runtime?.ready)return add(id,'attention',`${label} is unavailable`,'Inspect the local model/runtime status. Source posts and previous successful results are retained.');
    if(failures)return add(id,'attention',`${label} has incomplete work`,`${data.failed??0} failed and ${data.skipped??0} skipped source jobs; ${pending} pending or running. Review the recorded limits/failures before retrying.`);
    if(pending||indexed<data.archivePosts)return add(id,'processing',`${label} is catching up`,`${indexed??0} of ${data.archivePosts} archived sources have current results; ${pending} jobs are pending or running.`);
    return add(id,'ready',`${label} is available`,`${indexed??0} archived sources have current results. Availability does not establish interpretation accuracy or complete X coverage.`);
  }
  model('topic-analysis','Topic analysis',classification);model('semantic-index','Semantic search',semantic);
  add('teaching','review-needed','Classification still needs your judgment',`${learning.reviewedPosts} sources have current reviews; ${learning.heldOutPosts} are reserved for testing. The fixed-hypothesis model does not retrain itself. ${learning.unfinishedEvaluationRuns?`${learning.unfinishedEvaluationRuns} comparison runs are unfinished.`:'No automatic model promotion is enabled.'}`);
  return {generatedAt,automaticCollection:false,paidActionTaken:false,scope:'Stored archive and local runtime only',
    needsAttention:components.filter(c=>['attention','blocked'].includes(c.state)).length,components,
    note:'This status performs no provider calls. It does not verify a host login, off-host backup, model accuracy, current events or complete caucus coverage.'};
}

export function operationalStatus(store,settings,{classifier=null,semantic=null,connection={configured:false},now=Date.now()}={}){
  return atomic(store.db,()=>describeOperationalStatus({
    readiness:workerReadiness(store,settings,{clock:()=>now}),
    classification:{...classificationStatus(store),state:classifier?.state??(settings.intelligence?.localClassifier?.enabled?'not-started':'disabled'),runtime:classifier?.runtime?.status()??{ready:false}},
    semantic:{...embeddingStatus(store,settings.intelligence?.localEmbeddings?.model??'minilm'),state:semantic?.state??(settings.intelligence?.localEmbeddings?.enabled?'not-started':'disabled'),runtime:semantic?.runtime?.status()??{ready:false}},
    learning:learningStatus(store),connection,collectionEnabled:settings.collectionEnabled===true,
    awaitingRoster:store.db.prepare("SELECT COUNT(*) AS n FROM captured_posts WHERE status<>'promoted'").get().n,generatedAt:new Date(now).toISOString()
  }));
}
