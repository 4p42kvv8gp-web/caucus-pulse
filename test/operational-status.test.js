import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {openStore} from '../src/db.js';
import {normalizePost} from '../src/normalize.js';
import {createServer} from '../src/server.js';
import {describeOperationalStatus} from '../src/operational-status.js';

function fixture(){return {generatedAt:'2026-09-08T00:00:00Z',readiness:{budget:{balanceFresh:true,remainingMicro:1000000,unresolvedRequests:0,fault:null},roster:{snapshot:{fresh:true},activeAccountBindings:2},inventory:{fresh:true}},
  classification:{runtime:{ready:true},state:'ready',completed:2,archivePosts:2,pending:0,running:0,failed:0,skipped:0},semantic:{runtime:{ready:true},state:'ready',indexedPosts:2,archivePosts:2,pending:0,running:0,failed:0,skipped:0},
  learning:{reviewedPosts:1,heldOutPosts:0,unfinishedEvaluationRuns:0},connection:{configured:true},awaitingRoster:0,collectionEnabled:true};}
const component=(report,id)=>report.components.find(c=>c.id===id);

test('healthy local processing never implies automatic collection, accurate interpretation or full caucus coverage',()=>{
  const value=describeOperationalStatus(fixture());assert.equal(value.automaticCollection,false);assert.equal(value.paidActionTaken,false);assert.equal(value.needsAttention,0);
  assert.equal(component(value,'collection').state,'paused');assert.equal(component(value,'topic-analysis').state,'ready');assert.match(component(value,'account-evidence').detail,/do not establish complete caucus coverage/);assert.equal(component(value,'teaching').state,'review-needed');
});

test('operational faults and uncertain charges take precedence over an apparently fresh balance',()=>{
  const input=fixture();input.readiness.budget.fault='restore-reconciliation-required';input.readiness.budget.unresolvedRequests=1;
  let value=describeOperationalStatus(input);assert.match(component(value,'spending').detail,/restore-reconciliation-required/);assert.equal(component(value,'spending').state,'blocked');
  input.readiness.budget.fault=null;value=describeOperationalStatus(input);assert.match(component(value,'spending').title,/reconciliation/);
  input.readiness.budget.unresolvedRequests=0;input.readiness.budget.balanceFresh=false;value=describeOperationalStatus(input);assert.match(component(value,'spending').title,/verification/);
  input.readiness.budget.balanceFresh=true;input.readiness.budget.remainingMicro=0;assert.match(component(describeOperationalStatus(input),'spending').title,/exhausted/);
});

test('model startup, missing runtime, incomplete indexing and failed jobs remain distinct',()=>{
  const input=fixture();input.classification.state='starting';input.classification.runtime.ready=false;input.semantic.indexedPosts=1;input.semantic.pending=1;
  let value=describeOperationalStatus(input);assert.equal(component(value,'topic-analysis').state,'starting');assert.equal(component(value,'semantic-index').state,'processing');
  input.classification.state='model-unavailable';input.semantic.failed=1;value=describeOperationalStatus(input);assert.equal(component(value,'topic-analysis').state,'attention');assert.equal(component(value,'semantic-index').state,'attention');
  input.classification.state='disabled';assert.equal(component(describeOperationalStatus(input),'topic-analysis').state,'disabled');
  input.classification.state='worker-needs-attention';input.classification.runtime.ready=true;
  assert.equal(component(describeOperationalStatus(input),'topic-analysis').state,'attention');
  assert.match(component(describeOperationalStatus(input),'topic-analysis').title,/processing needs review/);
});

test('processing status is archive-wide, source-free and read-only through the local API',async()=>{
  const store=openStore();store.upsertAccount({authorId:'1',memberId:'synthetic',memberName:'Synthetic Private Name',handle:'Synthetic'});
  store.ingest(normalizePost({id:'7001',author_id:'1',text:'Synthetic private source marker.',created_at:'2026-09-08T00:00:00Z'}));
  let credentialReads=0;const server=createServer(store,{credentials:{status:()=>{credentialReads++;return {configured:false};}}});server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const before=store.db.prepare('SELECT COUNT(*) AS n FROM budget_requests').get().n;
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/operations?query=unmatched`);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');const value=await response.json();
    assert.equal(value.scope,'Stored archive and local runtime only');assert.equal(value.automaticCollection,false);assert.equal(credentialReads,1);
    const serialized=JSON.stringify(value);for(const privateValue of ['7001','Synthetic Private Name','Synthetic private source marker.'])assert.equal(serialized.includes(privateValue),false);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM budget_requests').get().n,before);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM feedback').get().n,0);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();}
});
