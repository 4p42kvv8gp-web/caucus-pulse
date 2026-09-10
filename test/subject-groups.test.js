import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/db.js';
import { normalizePost } from '../src/normalize.js';
import { embeddingModel } from '../src/embedding-models.js';
import { processEmbeddingJobs } from '../src/embedding-store.js';
import { groupSubjectPassages } from '../src/subject-groups-core.js';
import { prepareSubjectSnapshot,subjectGroups } from '../src/subject-groups.js';
import { createServer } from '../src/server.js';

const now=Date.parse('2026-09-08T00:30:00Z'),model=embeddingModel();
function vector(angle=0){const v=Array(384).fill(0);v[0]=Math.cos(angle);v[1]=Math.sin(angle);return v;}
function setup(){
  const store=openStore();
  for(let i=1;i<=4;i++)store.upsertAccount({authorId:String(i),memberId:`member-${i}`,memberName:`Synthetic Member ${i}`,handle:`Synthetic${i}`,accountType:'official'});
  return store;
}
function add(store,id,text='Synthetic related source passage.',extra={}){
  const p=normalizePost({id:String(id),author_id:String(Number(id)%4+1),created_at:'2026-09-08T00:10:00Z',text,...extra},{kind:'historical-calibration'});
  store.ingest(p);return p;
}
async function index(store,lookup=()=>[vector()]){
  await processEmbeddingJobs(store,{model,embedPost:async text=>({modelFingerprint:model.fingerprint,textLength:text.length,coveredCharacters:text.length,detailOmitted:0,
    passages:lookup(text).map((v,i)=>({index:i,start:0,end:text.length,text,tokenCount:12,kind:i?'sentence':'context-window',vector:v}))})});
}

test('related groups span classified and unclassified sources with exact titles and distinct stored members',async()=>{
  const store=setup();
  try{
    add(store,1,'Medicaid coverage remains available today.');add(store,2,'Health coverage remains available today.');add(store,3,'Sports championships begin next week.');
    store.analyzePending();store.saveFeedback('1',{labels:[{topic:'Health care',subtopic:'Medicaid'}],reason:'Synthetic review.'},'synthetic-reviewer');
    await index(store,text=>[vector(text.startsWith('Sports')?Math.PI/2:0)]);
    const result=await subjectGroups(store,{}, {now});
    assert.equal(result.groups.length,1);
    const group=result.groups[0];assert.equal(group.posts,2);assert.equal(group.members,2);
    assert.equal(group.status,'candidate');assert.equal(group.interpretation.coordination,'not-inferred');
    assert.equal(group.interpretation.eventIdentity,'not-established');
    assert.ok(group.sourceTopics.some(t=>t.topic==='Health care'));
    const source=result.sourcePosts.find(p=>p.id===group.title.postId);
    assert.equal(group.title.text,source.text.slice(group.title.start,group.title.end));
    assert.equal(result.coverage.totalPosts,3);assert.equal(result.coverage.complete,true);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM analysis_runs').get().n,0);
  }finally{store.close();}
});

test('complete-link checks stop a similarity chain from being asserted as one coherent group',async()=>{
  const store=setup();
  try{
    add(store,1,'Left synthetic passage with words.');add(store,2,'Middle synthetic passage with words.');add(store,3,'Right synthetic passage with words.');
    await index(store,text=>[vector(text.startsWith('Left')?-0.5:text.startsWith('Right')?0.5:0)]);
    const result=groupSubjectPassages(prepareSubjectSnapshot(store,{}, {now}),{threshold:0.8});
    assert.ok(result.groups.length>=1);assert.ok(result.groups.every(g=>g.posts===2&&g.similarity.minimum>=0.8));
  }finally{store.close();}
});

test('two subjects may coexist in the same posts; repeated account posts do not manufacture members',async()=>{
  const store=setup();
  try{
    add(store,1);add(store,2);await index(store,()=>[vector(),vector(Math.PI/2)]);
    const both=groupSubjectPassages(prepareSubjectSnapshot(store,{}, {now}));assert.equal(both.groups.length,2);
    store.upsertAccount({authorId:'3',memberId:'member-2',memberName:'Synthetic Member 2',handle:'SyntheticAlt',accountType:'personal'});
    assert.equal(groupSubjectPassages(prepareSubjectSnapshot(store,{}, {now})).groups.length,0);
  }finally{store.close();}
});

test('rolling windows cross midnight and comparison counts never treat unavailable history as zero',async()=>{
  const store=setup();
  try{
    add(store,1,undefined,{created_at:'2026-09-07T23:45:00Z'});add(store,2,undefined,{created_at:'2026-09-08T00:10:00Z'});
    add(store,3,undefined,{created_at:'2026-09-08T00:15:00Z'});add(store,4,undefined,{created_at:'2026-09-08T00:30:00Z'});
    await index(store);
    const full=groupSubjectPassages(prepareSubjectSnapshot(store,{}, {now,windowHours:1}));
    assert.equal(full.groups[0].posts,3);assert.equal(full.groups[0].recent.posts,2);assert.equal(full.groups[0].previous.posts,1);
    assert.equal(full.groups[0].firstObservedInSelection,'2026-09-07T23:45:00.000Z');
    const short=groupSubjectPassages(prepareSubjectSnapshot(store,{}, {now,windowHours:0.5}));
    assert.equal(short.groups[0].previous.completeWindow,false);assert.equal(short.groups[0].previous.posts,null);
    assert.equal(short.groups[0].recent.posts,2);
  }finally{store.close();}
});

test('reposts are excluded, quotes remain unresolved, and bounds omit whole posts with visible counts',async()=>{
  const store=setup();
  try{
    add(store,1);add(store,2,undefined,{referenced_tweets:[{type:'quoted',id:'90'}]});
    add(store,3,undefined,{referenced_tweets:[{type:'retweeted',id:'91'}]});add(store,4,'Unindexed source has enough words.');
    await processEmbeddingJobs(store,{model,embedPost:async text=>({modelFingerprint:model.fingerprint,textLength:text.length,coveredCharacters:text.length,detailOmitted:0,
      passages:[{index:0,start:0,end:text.length,text,tokenCount:12,kind:'context-window',vector:vector()}]})},{limit:3});
    const snapshot=prepareSubjectSnapshot(store,{}, {now,maxPosts:2,maxPassages:1});
    assert.equal(snapshot.coverage.excludedReposts,1);assert.equal(snapshot.coverage.admittedPosts,1);
    assert.ok(snapshot.coverage.omittedResourcePosts>0);assert.equal(snapshot.coverage.complete,false);
    assert.equal(snapshot.posts.some(p=>p.type==='repost'),false);
    const tiny=prepareSubjectSnapshot(store,{}, {now,maxCharacters:1});assert.equal(tiny.posts.length,0);assert.ok(tiny.coverage.omittedResourcePosts>0);
  }finally{store.close();}
});

test('source edits, removal and changed review labels invalidate an in-flight grouping snapshot',async()=>{
  const store=setup();
  try{
    add(store,1);add(store,2);await index(store);
    const compute=async snapshot=>{store.saveFeedback('1',{labels:[],reason:'Synthetic interpretation changed.'},'test');return groupSubjectPassages(snapshot);};
    await assert.rejects(subjectGroups(store,{}, {now},compute),e=>e.code==='DISCOVERY_CHANGED');
    await assert.rejects(subjectGroups(store,{}, {now},async snapshot=>{store.removePost('2');return groupSubjectPassages(snapshot);}),e=>e.code==='DISCOVERY_CHANGED');
    assert.equal((await subjectGroups(store,{}, {now})).groups.length,0);
    add(store,1,'Edited synthetic source retains all words.');
    assert.equal(prepareSubjectSnapshot(store,{}, {now}).posts.length,0);
  }finally{store.close();}
});

test('invalid limits and malformed vectors fail instead of producing candidate statistics',async()=>{
  const store=setup();
  try{
    for(const options of [{threshold:NaN},{threshold:0.1},{minMembers:1},{limit:51},{maxPassages:1001},{windowHours:1000}])assert.throws(()=>prepareSubjectSnapshot(store,{},options),/Invalid/);
    assert.throws(()=>prepareSubjectSnapshot(store,{since:'2025-01-01',until:'2026-01-01'}),/Invalid/);
    add(store,1);add(store,2);await index(store);
    const snapshot=prepareSubjectSnapshot(store,{}, {now});new Float32Array(snapshot.vectors)[0]=NaN;
    assert.throws(()=>groupSubjectPassages(snapshot),/Invalid/);
  }finally{store.close();}
});

test('HTTP candidate groups return bounded evidence and validate filters without spending or saving reviews',async()=>{
  const store=setup();add(store,1);add(store,2);await index(store);
  const server=createServer(store);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const root=`http://127.0.0.1:${server.address().port}`;
  try{
    const params=new URLSearchParams({since:'2026-09-07T00:00:00Z',until:'2026-09-08T00:30:00Z'});
    const response=await fetch(`${root}/api/emerging?${params}`);assert.equal(response.status,200);
    const result=await response.json();assert.equal(result.groups.length,1);assert.equal(result.sourcePosts.length,2);
    for(const query of ['threshold=0.2','minMembers=1','limit=500','since=bad','windowHours=800'])assert.equal((await fetch(`${root}/api/emerging?${query}`)).status,400);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM budget_requests').get().n,0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM feedback').get().n,0);
  }finally{await new Promise(resolve=>server.close(resolve));store.close();}
});
