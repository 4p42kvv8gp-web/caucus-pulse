import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/db.js';
import {normalizePost} from '../src/normalize.js';
import {prepareAnalysis,commitSemanticAnalysis} from '../src/intelligence.js';
import {incidentDesk,postIncidents,saveIncidentReview,createIncidentCase,updateIncidentCase,incidentCase} from '../src/incidents.js';
import {createServer} from '../src/server.js';

const now=Date.parse('2026-09-08T09:00:00Z');
const wording='Flooding closed River Road in my district. Residents can use the shelter at North School.';
function setup(){const s=openStore();s.upsertAccount({authorId:'1',memberId:'synthetic-member',memberName:'Synthetic Member',handle:'Synthetic',accountType:'official'});return s;}
function event(source=wording){const sentence=source.slice(0,source.indexOf('.')+1);return {description:'Synthetic source reports flooding on River Road.',development:'reported-incident',location:{name:'River Road',evidence:[{start:source.indexOf('River Road'),end:source.indexOf('River Road')+10,text:'River Road'}]},districtRelation:'explicitly-stated',districtEvidence:[{start:0,end:sentence.length,text:sentence}],evidence:[{start:0,end:sentence.length,text:sentence}]};}
function add(s,id='10',source=wording){
  s.ingest(normalizePost({id,author_id:'1',created_at:'2026-09-08T08:00:00Z',text:source}));s.analyzePending();
  const request=prepareAnalysis(s,id);
  commitSemanticAnalysis({store:s,request,providerName:'Synthetic fixture',model:'synthetic',result:{postId:id,sourceHash:request.input.sourceHash,labels:[{topic:'Disaster response',subtopic:'Flooding',explanation:'Synthetic.',evidence:event(source).evidence}],entities:[],events:[event(source)],functions:[],summary:'Synthetic test report.',limitations:[]},now});
  return s.getPost(id);
}
function link(s,id='10'){const r=postIncidents(s,id);return {postId:id,sourceHash:r.post.contentHash,predictionHash:r.post.analysisHash,eventKey:r.candidates[0].key};}
function review(s,id='10',decision='no-event',events=[]){const p=s.getPost(id);return {sourceHash:p.contentHash,predictionHash:p.analysisHash,revision:postIncidents(s,id).revision,decision,events,reason:'Synthetic source review for an isolated test.'};}

test('the incident desk exposes candidate evidence, source dates and a separate human review decision',()=>{
  const s=setup();try{
    add(s);let data=incidentDesk(s,{}, {now});assert.equal(data.candidates.length,1);assert.equal(data.sources[0].text,wording);assert.equal(data.candidates[0].basis,'model-suggestion');
    assert.equal(data.candidates[0].story.status,'provisional');assert.equal(data.candidates[0].story.memberCount,1);assert.equal(data.candidates[0].story.subtopic,'River Road · Flooding');
    assert.equal(data.candidates[0].story.corroboration,'not-established');assert.equal(data.cases.length,0);
    assert.equal(data.sources[0].analysis,undefined,'The desk uses a bounded source projection rather than copying entire analysis histories');
    saveIncidentReview(s,'10',review(s));data=incidentDesk(s,{}, {now});assert.equal(data.candidates.length,0);assert.equal(data.decisions.noEvent,1);
    assert.equal(s.getPost('10').labels[0].topic,'Disaster response','An incident correction does not change topic labels');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM feedback').get().n,0,'An incident review does not pretend to be a topic review');
    saveIncidentReview(s,'10',review(s,'10','needs-context'));data=incidentDesk(s,{}, {now});assert.equal(data.candidates[0].needsContext,true);
  }finally{s.close();}
});

test('source and prediction guards refuse stale incident reviews while exact human location evidence persists',()=>{
  const s=setup();try{
    add(s);const stale=review(s);add(s,'10',wording+' An update.');
    assert.throws(()=>saveIncidentReview(s,'10',stale),e=>e.code==='INCIDENT_CHANGED');
    const invalid=review(s,'10','events-supported',[event(wording+' An update.')]);invalid.events[0].location.name='Invented Place';
    assert.throws(()=>saveIncidentReview(s,'10',invalid),/location must be named/);
    const valid=review(s,'10','events-supported',[event(wording+' An update.')]);saveIncidentReview(s,'10',valid);
    assert.equal(postIncidents(s,'10').candidates[0].basis,'human-source-review');
    const saved=postIncidents(s,'10').candidates[0].key;add(s,'10',wording+' An update.');
    assert.equal(postIncidents(s,'10').candidates[0].key,saved,'A new model run does not override a current-source human interpretation');
  }finally{s.close();}
});

test('tracking multiple source posts deduplicates members and requires explicit case state changes',()=>{
  const s=setup();try{
    add(s);add(s,'11');const c=createIncidentCase(s,{title:'Synthetic River Road report',sources:[link(s),link(s,'11')]},{now});
    assert.equal(c.status,'watching');assert.equal(c.posts,2);assert.equal(c.members,1);assert.equal(c.firstObservedInCase,'2026-09-08T08:00:00.000Z');
    assert.equal(incidentDesk(s,{}, {now:now+10*86_400_000}).cases[0].status,'watching','Silence does not resolve a case');
    const updated=updateIncidentCase(s,c.id,{revision:1,status:'resolved',reason:'Synthetic reviewed resolution.'},{now:now+1});assert.equal(updated.status,'resolved');
    assert.throws(()=>updateIncidentCase(s,c.id,{revision:1,status:'watching',reason:'Stale test edit.'}),e=>e.code==='INCIDENT_CHANGED');
    assert.equal(updated.history.length,2);
  }finally{s.close();}
});

test('source edits, changed event interpretation and removal invalidate case links without replay',()=>{
  const s=setup();try{
    add(s);add(s,'11');const c=createIncidentCase(s,{title:'Synthetic incident',sources:[link(s),link(s,'11')]});
    add(s,'10',wording+' Edited.');let current=incidentCase(s,c.id);assert.equal(current.posts,1);assert.equal(current.stale.length,1);
    saveIncidentReview(s,'11',review(s,'11'));current=incidentCase(s,c.id);assert.equal(current.posts,0);assert.equal(current.stale.length,2);
    s.removePost('11');assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM incident_reviews WHERE post_id='11'").get().n,0);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM incident_case_posts WHERE post_id='11'").get().n,0);
    assert.equal(s.ingest(normalizePost({id:'11',author_id:'1',created_at:'2026-09-08T08:00:00Z',text:wording})).removed,true);
  }finally{s.close();}
});

test('case creation and updates roll back entirely when a link or persistence operation fails',()=>{
  const s=setup();try{
    add(s);const invalid={...link(s),eventKey:'f'.repeat(64)};
    assert.throws(()=>createIncidentCase(s,{title:'Synthetic',sources:[invalid]}),e=>e.code==='INCIDENT_CHANGED');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM incident_cases').get().n,0);
    s.db.exec("CREATE TRIGGER synthetic_incident_failure BEFORE INSERT ON incident_case_history BEGIN SELECT RAISE(ABORT,'Synthetic failure'); END");
    assert.throws(()=>createIncidentCase(s,{title:'Synthetic',sources:[link(s)]}),/Synthetic failure/);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM incident_cases').get().n,0);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM incident_case_posts').get().n,0);
  }finally{s.close();}
});

test('the incoming desk respects source filters and resource bounds',()=>{
  const s=setup();try{
    for(let i=0;i<80;i++)add(s,String(100+i),wording+' '+('Synthetic source detail. '.repeat(250)));
    const data=incidentDesk(s,{}, {now});assert.equal(data.coverage.availablePosts,80);assert.ok(data.coverage.omittedOversizedPosts>0);assert.ok(data.coverage.sourceCharacters<=300000);assert.ok(data.coverage.candidateCharacters<=500000);
    assert.equal(incidentDesk(s,{query:'absent-wording'}, {now}).candidates.length,0);
    assert.throws(()=>incidentDesk(s,{since:'2026-01-01T00:00:00Z'},{now}),/at most 31 days/);
  }finally{s.close();}
});

test('incident HTTP routes enforce source versions, source-only reviews and case revisions',async()=>{
  const s=setup();add(s);const server=createServer(s);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  async function call(path,method='GET',body){const response=await fetch(base+path,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};}
  try{
    assert.equal((await call('/api/incidents?since=2026-09-08T00:00:00Z&until=2026-09-09T00:00:00Z')).data.candidates.length,1);
    const created=await call('/api/incidents/cases','POST',{title:'Synthetic API case',sources:[link(s)]});assert.equal(created.status,201);
    assert.equal((await call(`/api/incidents/cases/${created.data.id}`,'PATCH',{revision:0,status:'resolved',reason:'Synthetic stale update.'})).status,409);
    assert.equal((await call('/api/posts/10/incidents','POST',review(s))).status,200);
    assert.equal((await call(`/api/incidents/cases/${created.data.id}`)).data.stale.length,1);
    assert.equal((await call('/api/posts/999/incidents')).status,404);
  }finally{await new Promise(resolve=>server.close(resolve));s.close();}
});


test('two incident reviewers cannot silently supersede the same displayed review state',()=>{
  const s=setup();try{
    add(s);const first=review(s),second=review(s,'10','needs-context');
    saveIncidentReview(s,'10',first);
    assert.throws(()=>saveIncidentReview(s,'10',second),e=>e.code==='INCIDENT_CHANGED');
    assert.equal(postIncidents(s,'10').decision,'no-event');
    assert.equal(postIncidents(s,'10').reviewCount,1);
  }finally{s.close();}
});
