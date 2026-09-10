import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {recognizeStories,validateStoryLibrary,createStoryContextProvider} from '../src/story-context.js';
import {writePrivateJson} from '../src/private-files.js';
import {storyContextHtml} from '../site/story-context.js';
import {openStore} from '../src/db.js';
import {normalizePost} from '../src/normalize.js';
import {createServer} from '../src/server.js';

const source={url:'https://reports.example.org/story',title:'Synthetic background report',publishedOn:'2026-02-01',supports:'Fictional training fixture only.'};
const story={id:'synthetic-ari',topic:'Immigration',subtopic:'Ari Taylor',summary:'Fictional context for a test.',curator:'assistant',
  aliases:[{text:'Ari Taylor',specific:true},{text:'Ari',specific:false}],
  contextGroups:[{name:'family',terms:['Jonah','dad']},{name:'facility',terms:['Lakeview','detention']},{name:'place',terms:['Arbor City']}],
  matchFrom:'2026-01-01',matchUntil:'2026-03-01',explicitTimeReferences:['February 2026'],sources:[source]};
const library={schemaVersion:1,stories:[story]};
const post=text=>({text,createdAt:'2026-02-02T10:00:00Z',contentHash:'a'.repeat(64)});

test('a partial name needs nearby independent context and preserves exact Unicode offsets',()=>{
  const p=post('📍 Ari and dad left Lakeview detention.');const result=recognizeStories(p,library);
  assert.equal(result.matches.length,1);assert.equal(result.matches[0].subtopic,'Ari Taylor');
  for(const s of result.matches[0].evidence)assert.equal(p.text.slice(s.start,s.end),s.text);
  assert.equal(result.matches[0].nationalAttention,'not-measured');
  for(const text of ['Ari visited today.','Ari left detention.','Ariadne and dad left Lakeview.','Someone left Lakeview detention.','Ari spoke.\n\nJonah left Lakeview detention.','Ari spoke. '+'. '.repeat(250)+'Jonah left Lakeview.'])assert.equal(recognizeStories(post(text),library).matches.length,0,text);
});
test('full names still require context; old stories need a nearby explicit historical date',()=>{
  assert.equal(recognizeStories(post('Ari Taylor left detention.'),library).matches.length,1);
  assert.equal(recognizeStories(post('Ari Taylor attended school.'),library).matches.length,0);
  const old={...post('Ari Taylor left detention.'),createdAt:'2026-09-09T00:00:00Z'};
  assert.equal(recognizeStories(old,library).matches.length,0);
  assert.equal(recognizeStories({...old,text:'In February 2026, Ari Taylor left detention.'},library).matches[0].temporalBasis,'explicit-historical-reference');
  assert.equal(recognizeStories({...old,text:'In February 2026 we met.\n\nAri Taylor left detention.'},library).matches.length,0);
});
test('library changes invalidate context hashes and malformed sources fail closed',()=>{
  const p=post('Ari Taylor left detention.');const before=recognizeStories(p,library);
  const revised=structuredClone(library);revised.stories[0].summary='Different researched background.';
  assert.notEqual(recognizeStories(p,revised).hash,before.hash);
  for(const url of ['javascript:alert(1)','https://user:password@reports.example.org/story','http://reports.example.org/story']){
    const invalid=structuredClone(library);invalid.stories[0].sources[0].url=url;assert.throws(()=>validateStoryLibrary(invalid));
  }
  assert.throws(()=>recognizeStories(post('x'.repeat(60001)),library));
  const dir=mkdtempSync(join(tmpdir(),'pulse-story-'));try{
    const provider=createStoryContextProvider(join(dir,'library.json'));assert.equal(provider(p).status,'not-configured');
    writePrivateJson(join(dir,'library.json'),{schemaVersion:7});assert.equal(provider(p).status,'unavailable');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('two named stories remain separate suggestions rather than a merged event',()=>{
  const other={...story,id:'synthetic-bea',subtopic:'Bea North',aliases:[{text:'Bea North',specific:true}]};
  const result=recognizeStories(post('Ari Taylor left detention.\n\nBea North left detention.'),{schemaVersion:1,stories:[story,other]});
  assert.deepEqual(result.matches.map(s=>s.subtopic),['Ari Taylor','Bea North']);
});
test('rendered context escapes third-party text and rejects executable links',()=>{
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const html=storyContextHtml({stories:{matches:[]},outside:{status:'leads-found',articles:[{url:'javascript:alert(1)',title:'<script>bad()</script>'}],canLookup:true,note:'Synthetic'}},{esc,date:String,sourceEvidence:()=>''});
  assert.doesNotMatch(html,/<script>|href="javascript/);assert.match(html,/&lt;script&gt;/);assert.match(html,/Content awaiting review/);
});
test('HTTP research suggestions preserve accepted labels and review records retain the displayed context',async()=>{
  const store=openStore();store.upsertAccount({authorId:'101',memberId:'synthetic',memberName:'Synthetic',handle:'synthetic'});
  store.ingest(normalizePost({id:'1010',author_id:'101',created_at:'2026-02-02T10:00:00Z',text:'Ari and dad left Lakeview detention.'}));store.analyzePending();
  store.saveFeedback('1010',{labels:[{topic:'Synthetic accepted topic',subtopic:null}],reason:'Authentic only within this synthetic test.'});
  let current=structuredClone(library);
  const server=createServer(store,{storyContext:p=>recognizeStories(p,current)});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  const get=async()=>await(await fetch(base+'/api/posts/1010')).json();
  const save=async body=>fetch(base+'/api/posts/1010/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  try{
    const shown=await get();assert.equal(shown.context.stories.matches.length,1);assert.equal(shown.labels[0].topic,'Synthetic accepted topic');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM feedback').get().n,1);
    const body={sourceHash:shown.contentHash,predictionHash:shown.analysisHash,reviewId:shown.reviewId,contextHash:shown.context.hash,labels:[{topic:'Immigration',subtopic:'Ari Taylor'}],reason:'Synthetic exercise based on the displayed background.'};
    current.stories[0].summary='Revised context.';assert.equal((await save(body)).status,409);
    body.contextHash=(await get()).context.hash;assert.equal((await save(body)).status,200);
    const saved=store.getPost('1010').feedback[0];assert.equal(saved.contextAtReview.stories.matches[0].sources[0].url,source.url);
    const hostile=await fetch(base+'/api/posts/1010/outside-context',{method:'POST',headers:{Origin:'https://unrelated.example','Content-Type':'application/json'},body:JSON.stringify({sourceHash:shown.contentHash})});assert.equal(hostile.status,403);
  }finally{await new Promise(r=>server.close(r));store.close();}
});
