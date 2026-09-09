import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {outsideContextPlan,searchOutsideNews,publicArticleUrl,createOutsideContextService} from '../src/outside-context.js';
import {openStore} from '../src/db.js';
import {normalizePost} from '../src/normalize.js';
import {acquirePrivateLock} from '../src/private-files.js';

const now=Date.parse('2026-09-09T03:00:00Z');
const source='Flooding closed River Road in my district.';
const span=text=>({text,start:source.indexOf(text),end:source.indexOf(text)+text.length});
const context=()=>({matches:[{evidence:[span('River Road'),span('Flooding')]}]});
const post={id:'1010',text:source,contentHash:'a'.repeat(64),createdAt:'2026-09-08T10:00:00Z'};
const article={url:'https://reports.example.org/flood',title:'Synthetic River Road flooding report',seendate:'20260908T120000Z'};
const response=articles=>new Response(JSON.stringify({articles}),{headers:{'Content-Type':'application/json'}});
function setup(){const store=openStore();store.upsertAccount({authorId:'101',memberId:'synthetic',memberName:'Synthetic',handle:'synthetic'});store.ingest(normalizePost({id:post.id,author_id:'101',created_at:post.createdAt,text:source}));store.analyzePending();return store;}

test('lookup plans send only exact public phrases, bound dates, and abstain on vague captions',()=>{
  const p=outsideContextPlan({...post,feedback:[{reason:'PRIVATE TEST FEEDBACK'}]},context(),{now});
  assert.equal(p.query,'"River Road" "Flooding"');assert.ok(Date.parse(p.until)<=now);assert.equal(p.automaticEligible,true);
  assert.equal(outsideContextPlan({...post,createdAt:'2026-02-01T00:00:00Z'},context(),{now}).automaticEligible,false);
  assert.equal(outsideContextPlan({...post,text:'No one gets a pass.'},context(),{now}),null);
  assert.equal(outsideContextPlan(post,{matches:[{evidence:[span('River Road'),{text:'private data',start:0,end:12}]}]},{now}),null);
});
test('a named incident can create an outside search without a known story',()=>{
  const p=outsideContextPlan({...post,analysis:{events:[{location:{evidence:[span('River Road')]},evidence:[span(source)]}]}},{matches:[]},{now});
  assert.equal(p.query,'"River Road" "Flooding"');
});
test('news metadata remains unreviewed and out-of-window or unsafe results are rejected',async()=>{
  const plan=outsideContextPlan(post,context(),{now});let requested;
  const result=await searchOutsideNews(plan,{now,fetcher:async(url,options)=>{requested=url;assert.equal(options.redirect,'error');return response([article,article,{...article,url:'javascript:alert(1)'},{...article,url:'https://127.0.0.1/private'},{...article,url:'https://reports.example.org/old',seendate:'20260101T000000Z'}]);}});
  assert.equal(requested.origin,'https://api.gdeltproject.org');assert.equal(requested.searchParams.get('maxrecords'),'8');
  assert.equal(result.articles.length,1);assert.equal(result.articles[0].publishedAt,null);assert.equal(result.articles[0].verification,'unreviewed-lead');assert.equal(result.rejectedResults,3);
  for(const url of ['file:///private','https://localhost/a','http://10.0.0.1/a','https://x.com/user/status/1','https://a:b@reports.example.org'])assert.equal(publicArticleUrl(url),null);
});
test('invalid and oversized provider payloads do not become empty successful searches',async()=>{
  const plan=outsideContextPlan(post,context(),{now});
  for(const r of [new Response('Unsupported date range'),new Response('{}'),new Response('x'.repeat(250001))])await assert.rejects(()=>searchOutsideNews(plan,{fetcher:async()=>r}),e=>['INVALID_RESPONSE','RESPONSE_TOO_LARGE'].includes(e.code));
  const result=await searchOutsideNews(plan,{fetcher:async()=>response([])});assert.equal(result.status,'no-matching-leads');assert.match(result.note,/do not establish/);
});
test('rate limits persist across restarts and concurrent requests cannot multiply provider calls',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pulse-outside-')),store=setup();let calls=0,release;
  const fetcher=async()=>{calls++;await new Promise(r=>release=r);return new Response('Wait',{status:429});};
  let clock=now;
  try{
    const service=createOutsideContextService({store,directory:dir,storyContext:context,fetcher,clock:()=>clock});
    const p=store.getPost(post.id),first=service.lookup(p.id,p.contentHash);
    assert.equal((await service.lookup(p.id,p.contentHash)).status,'busy');release();
    assert.equal((await first).status,'rate-limited');assert.equal(calls,1);
    const restarted=createOutsideContextService({store,directory:dir,storyContext:context,fetcher,clock:()=>clock});
    assert.equal((await restarted.lookup(p.id,p.contentHash)).status,'rate-limited');assert.equal(calls,1);
    clock+=31*60000;const retried=restarted.lookup(p.id,p.contentHash);release();await retried;assert.equal(calls,2);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('source changes discard in-flight results and accepted labels are never overwritten',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pulse-outside-')),store=setup();let release;
  try{
    store.saveFeedback(post.id,{labels:[{topic:'Synthetic human label',subtopic:null}],reason:'Synthetic decision.'});
    const service=createOutsideContextService({store,directory:dir,storyContext:context,clock:()=>now,fetcher:async()=>{await new Promise(r=>release=r);return response([article]);}});
    const p=store.getPost(post.id),pending=service.lookup(p.id,p.contentHash);
    store.removePost(p.id);release();await assert.rejects(()=>pending,e=>e.code==='CONTEXT_CHANGED');
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('automatic context lookup works from one recent source and retains human decisions',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pulse-outside-')),store=setup();let calls=0;
  try{
    store.saveFeedback(post.id,{labels:[{topic:'Synthetic human label',subtopic:null}],reason:'Synthetic decision.'});
    const service=createOutsideContextService({store,directory:dir,storyContext:context,clock:()=>now,fetcher:async()=>{calls++;return response([article]);}});
    await service.tick();await service.tick();const p=store.getPost(post.id);
    assert.equal(calls,1);assert.equal(service.status(p).articles.length,1);assert.equal(p.labels[0].topic,'Synthetic human label');assert.equal(p.feedback.length,1);
    await assert.rejects(()=>service.lookup(p.id,'f'.repeat(64)),e=>e.code==='CONTEXT_CHANGED');
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('active archive maintenance prevents a late lookup from recreating a source cache',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pulse-outside-')),store=setup();let releaseResponse,releaseMaintenance;
  try{
    const service=createOutsideContextService({store,directory:dir,storyContext:context,clock:()=>now,fetcher:async()=>{await new Promise(r=>releaseResponse=r);return response([article]);}});
    const p=store.getPost(post.id),pending=service.lookup(p.id,p.contentHash);
    releaseMaintenance=acquirePrivateLock(dir);releaseResponse();
    await assert.rejects(()=>pending,/maintenance lock/);
    assert.equal(service.status(p).articles.length,0);
  }finally{releaseMaintenance?.();store.close();rmSync(dir,{recursive:true,force:true});}
});
