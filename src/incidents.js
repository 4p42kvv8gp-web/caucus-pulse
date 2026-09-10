import {createHash,randomUUID} from 'node:crypto';
import {atomic} from './sqlite.js';
import {searchSelection} from './explorer.js';
import {validateSemanticResult} from './intelligence.js';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(message,code='INCIDENT_CHANGED')=>Object.assign(new Error(message),{code});
const cleanEvent=e=>Object.fromEntries(['description','development','location','districtRelation','districtEvidence','evidence'].map(k=>[k,e[k]]));
const text=(value,max,name)=>{if(typeof value!=='string'||!value.trim()||value.length>max||value.includes('\0'))throw new Error(`Invalid ${name}.`);return value.trim();};
const validHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function provisionalStory(post,event,key){
  const passage=(event.evidence??[]).map(s=>s.text).join(' ');
  const incident=passage.match(/\b(flooding|flood|wildfire|shooting|shooter|fire|tornado|earthquake|explosion)\b/i)?.[0];
  const title=[event.location?.name,incident].filter(Boolean).join(' · ')||event.description;
  return {id:`report:${key}`,topic:event.districtRelation==='explicitly-stated'?'District incidents':'Incidents',subtopic:title.slice(0,160),status:'provisional',
    firstReportAt:post.createdAt,sourceCount:1,memberCount:1,corroboration:'not-established',
    note:'Surfaced from one source report. Related reports have not yet been merged or independently corroborated.'};
}
const sourcePost=post=>({...Object.fromEntries(['id','memberId','memberName','handle','type','createdAt','sourceUrl','contentHash','analysisHash','text','textCoverage','accountType','district','contextCoverage'].map(k=>[k,post[k]])),
  labels:post.labels.map(l=>({topic:l.topic,subtopic:l.subtopic})),functions:(post.analysis.functions??[]).map(f=>f.function)});

export function migrateIncidents(db){
  if(db.prepare('SELECT version FROM schema_version').get().version>=9)return;
  atomic(db,()=>db.exec(`
    CREATE TABLE incident_reviews (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,source_hash TEXT NOT NULL,
      prediction_hash TEXT NOT NULL,created_at TEXT NOT NULL,decision TEXT NOT NULL,
      events_json TEXT NOT NULL,reason TEXT NOT NULL
    );
    CREATE INDEX incident_reviews_source ON incident_reviews(post_id,source_hash,sequence DESC);
    CREATE TABLE incident_cases (
      id TEXT PRIMARY KEY,title TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('watching','resolved','dismissed')),
      revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE incident_case_posts (
      case_id TEXT NOT NULL REFERENCES incident_cases(id) ON DELETE CASCADE,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,source_hash TEXT NOT NULL,event_key TEXT NOT NULL,added_at TEXT NOT NULL,
      PRIMARY KEY(case_id,post_id,source_hash,event_key)
    );
    CREATE INDEX incident_links_post ON incident_case_posts(post_id);
    CREATE TABLE incident_case_history (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,case_id TEXT NOT NULL REFERENCES incident_cases(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,action TEXT NOT NULL,revision INTEGER NOT NULL,details_json TEXT NOT NULL
    );
    UPDATE schema_version SET version=9;
  `));
}

export function postIncidents(store,postId){
  return atomic(store.db,()=>{
  const post=store.getPost(postId);
  if(!post)throw fail('The source post is no longer available.','INCIDENT_NOT_FOUND');
  const rows=store.db.prepare('SELECT * FROM incident_reviews WHERE post_id=? ORDER BY sequence DESC LIMIT 50').all(postId);
  const current=store.db.prepare('SELECT * FROM incident_reviews WHERE post_id=? AND source_hash=? ORDER BY sequence DESC LIMIT 1').get(postId,post.contentHash);
  const fromReview=current&&current.decision!=='needs-context';
  const events=fromReview?JSON.parse(current.events_json):post.analysis.events??[];
  const candidates=events.slice(0,10).map((event,index)=>{
    const key=hash({postId:post.id,sourceHash:post.contentHash,event:cleanEvent(event)});
    return {key,index,event:cleanEvent(event),story:provisionalStory(post,event,key),
    basis:fromReview?'human-source-review':'model-suggestion',reviewId:fromReview?current.id:null,
    needsContext:current?.decision==='needs-context'
  };});
  return {post,candidates,decision:current?.decision??'unreviewed',revision:current?.sequence??0,reviewCount:store.db.prepare('SELECT COUNT(*) AS n FROM incident_reviews WHERE post_id=?').get(postId).n,
    history:rows.map(r=>({id:r.id,sourceHash:r.source_hash,predictionHash:r.prediction_hash,createdAt:r.created_at,decision:r.decision,events:JSON.parse(r.events_json),reason:r.reason,appliesToCurrentText:r.source_hash===post.contentHash})),
    note:'Review concerns what this source reports. It does not independently verify an incident occurred or establish its current real-world status.'};
  });
}

function guardedPost(store,postId,sourceHash,predictionHash){
  if(!validHash(sourceHash)||!validHash(predictionHash))throw new Error('Invalid source or prediction version.');
  const result=postIncidents(store,postId);
  if(result.post.contentHash!==sourceHash||result.post.analysisHash!==predictionHash)throw fail('The source or its analysis changed. Reload it before saving.');
  return result;
}

export function saveIncidentReview(store,postId,input,{now=Date.now()}={}){
  if(!input||Array.isArray(input)||Object.keys(input).some(k=>!['sourceHash','predictionHash','revision','decision','events','reason'].includes(k))||!Number.isSafeInteger(input.revision)||input.revision<0||!['events-supported','no-event','needs-context'].includes(input.decision)||!Array.isArray(input.events)||input.events.length>6)throw new Error('Invalid incident review.');
  const reason=text(input.reason,2000,'incident review reason');
  if(input.decision!=='events-supported'&&input.events.length)throw new Error('Invalid event list for this review decision.');
  if(input.decision==='events-supported'&&!input.events.length)throw new Error('Invalid empty supported-event review.');
  return atomic(store.db,()=>{
    const {post,revision}=guardedPost(store,postId,input.sourceHash,input.predictionHash);
    if(input.revision!==revision)throw fail('This source already has a newer incident review. Reload it before saving.');
    const checked=validateSemanticResult({id:post.id,contentHash:post.contentHash,text:post.text,type:post.type,contextCoverage:post.contextCoverage},{
      postId:post.id,sourceHash:post.contentHash,labels:[],entities:[],events:input.events,functions:[],summary:'Human review of the source report.',limitations:[]
    }).events.map(cleanEvent);
    if(new Set(checked.map(hash)).size!==checked.length)throw new Error('Invalid duplicate incident descriptions.');
    const id=randomUUID();
    store.db.prepare('INSERT INTO incident_reviews(id,post_id,source_hash,prediction_hash,created_at,decision,events_json,reason) VALUES (?,?,?,?,?,?,?,?)')
      .run(id,post.id,post.contentHash,post.analysisHash,new Date(now).toISOString(),input.decision,JSON.stringify(checked),reason);
    return {saved:true,reviewId:id,...postIncidents(store,postId)};
  });
}

function boundedCandidatePost(store,id,budget){
  const length=store.db.prepare('SELECT length(text) AS n FROM posts WHERE id=?').get(id)?.n??0;
  if(length>60000||budget.characters+length>300000){budget.omittedPosts++;return null;}
  const result=postIncidents(store,id);
  if(result.post.text.length>60000||budget.characters+result.post.text.length>300000){budget.omittedPosts++;return null;}
  budget.characters+=result.post.text.length;
  return result;
}

export function incidentDesk(store,input={}, {now=Date.now()}={}){
  const end=input.until?new Date(input.until).toISOString():new Date(now).toISOString();
  const selection=searchSelection({...input,since:input.since||new Date(Date.parse(end)-86_400_000).toISOString(),until:end});
  if(Date.parse(end)-Date.parse(selection.filters.since)>31*86_400_000)throw new Error('Invalid incident window; choose at most 31 days.');
  return atomic(store.db,()=>{
    const available=store.db.prepare(`SELECT COUNT(*) AS n ${selection.from}`).get(...selection.values).n;
    const rows=store.db.prepare(`SELECT s.post_id ${selection.from} AND (
      EXISTS(SELECT 1 FROM analyses n WHERE n.post_id=s.post_id AND json_array_length(n.analysis_json,'$.events')>0)
      OR EXISTS(SELECT 1 FROM incident_reviews r JOIN posts p ON p.id=r.post_id WHERE r.post_id=s.post_id AND r.source_hash=p.content_hash))
      ORDER BY s.created_at DESC,s.post_id DESC LIMIT 251`).all(...selection.values);
    const budget={characters:0,omittedPosts:0};const candidates=[],sources=[],decisions={noEvent:0,needsContext:0};
    let omittedCandidates=0,candidateCharacters=0;
    for(const row of rows.slice(0,250)){
      const result=boundedCandidatePost(store,row.post_id,budget);if(!result)continue;
      if(result.decision==='no-event')decisions.noEvent++;
      if(result.decision==='needs-context')decisions.needsContext++;
      if(!result.candidates.length)continue;
      if(candidates.length>=100){omittedCandidates+=result.candidates.length;continue;}
      let included=false;
      for(const candidate of result.candidates){
        const size=JSON.stringify(candidate).length;
        if(candidates.length>=100||candidateCharacters+size>500000){omittedCandidates++;continue;}
        candidateCharacters+=size;included=true;
        candidates.push({...candidate,postId:result.post.id,sourceHash:result.post.contentHash,predictionHash:result.post.analysisHash});
      }
      if(included)sources.push(sourcePost(result.post));
    }
    const cases=store.db.prepare(`SELECT c.*,(SELECT COUNT(*) FROM incident_case_posts p WHERE p.case_id=c.id) AS linked_sources FROM incident_cases c ORDER BY updated_at DESC,id LIMIT 101`).all();
    return {generatedAt:new Date(now).toISOString(),filters:selection.filters,candidates,sources,decisions,
      cases:cases.slice(0,100).map(c=>({id:c.id,title:c.title,status:c.status,revision:c.revision,createdAt:c.created_at,updatedAt:c.updated_at,linkedSources:c.linked_sources})),
      coverage:{availablePosts:available,examinedCandidatePosts:Math.min(rows.length,250),candidatePostLimitReached:rows.length>250,omittedOversizedPosts:budget.omittedPosts,omittedCandidates,sourceCharacters:budget.characters,candidateCharacters,omittedCases:Math.max(0,store.db.prepare('SELECT COUNT(*) AS n FROM incident_cases').get().n-100)},
      note:'Incoming reports are source-based suggestions. Saved cases are user-organized collections, not automatic confirmation of shared event identity. Silence never resolves a case.'};
  });
}

function validateLinks(store,links){
  if(!Array.isArray(links)||!links.length||links.length>20)throw new Error('Invalid incident source selection.');
  const seen=new Set();
  return links.map(link=>{
    if(!link||Object.keys(link).some(k=>!['postId','sourceHash','predictionHash','eventKey'].includes(k))||!/^\d+$/.test(link.postId??'')||!validHash(link.eventKey))throw new Error('Invalid incident source link.');
    const current=guardedPost(store,link.postId,link.sourceHash,link.predictionHash);
    if(!current.candidates.some(candidate=>candidate.key===link.eventKey))throw fail('The incident interpretation changed. Reload the source before linking it.');
    const key=JSON.stringify([link.postId,link.sourceHash,link.eventKey]);if(seen.has(key))throw new Error('Invalid duplicate source selection.');seen.add(key);
    return link;
  });
}
function addLinks(store,id,links,at){
  for(const link of links)store.db.prepare('INSERT OR IGNORE INTO incident_case_posts(case_id,post_id,source_hash,event_key,added_at) VALUES (?,?,?,?,?)').run(id,link.postId,link.sourceHash,link.eventKey,at);
  if(store.db.prepare('SELECT COUNT(*) AS n FROM incident_case_posts WHERE case_id=?').get(id).n>100)throw new Error('Invalid case size; use at most 100 source links.');
}
function history(store,id,at,action,revision,details){store.db.prepare('INSERT INTO incident_case_history(case_id,created_at,action,revision,details_json) VALUES (?,?,?,?,?)').run(id,at,action,revision,JSON.stringify(details));}

export function createIncidentCase(store,input,{now=Date.now()}={}){
  if(!input||Object.keys(input).some(k=>!['title','sources'].includes(k)))throw new Error('Invalid new incident case.');
  const title=text(input.title,160,'incident title');
  return atomic(store.db,()=>{
    const links=validateLinks(store,input.sources),id=randomUUID(),at=new Date(now).toISOString();
    store.db.prepare("INSERT INTO incident_cases VALUES (?,?,'watching',1,?,?)").run(id,title,at,at);
    addLinks(store,id,links,at);history(store,id,at,'created',1,{title,sourceCount:links.length});
    return incidentCase(store,id);
  });
}

export function updateIncidentCase(store,id,input,{now=Date.now()}={}){
  if(!input||!Number.isSafeInteger(input.revision)||Object.keys(input).some(k=>!['revision','title','status','addSources','removeSources','reason'].includes(k)))throw new Error('Invalid incident case update.');
  const reason=text(input.reason,1000,'case update reason');
  return atomic(store.db,()=>{
    const current=store.db.prepare('SELECT * FROM incident_cases WHERE id=?').get(id);if(!current)throw fail('Case not found.','INCIDENT_NOT_FOUND');
    if(input.revision!==current.revision)throw fail('This case changed. Reload it before saving.');
    const title=input.title===undefined?current.title:text(input.title,160,'incident title');
    const status=input.status??current.status;if(!['watching','resolved','dismissed'].includes(status))throw new Error('Invalid incident status.');
    const at=new Date(now).toISOString(),revision=current.revision+1;
    if(input.addSources)addLinks(store,id,validateLinks(store,input.addSources),at);
    if(input.removeSources){
      if(!Array.isArray(input.removeSources)||input.removeSources.length>100||input.removeSources.some(k=>!validHash(k)))throw new Error('Invalid incident links to remove.');
      for(const key of input.removeSources)store.db.prepare('DELETE FROM incident_case_posts WHERE case_id=? AND event_key=?').run(id,key);
    }
    store.db.prepare('UPDATE incident_cases SET title=?,status=?,revision=?,updated_at=? WHERE id=?').run(title,status,revision,at,id);
    history(store,id,at,'updated',revision,{title,status,reason,added:input.addSources?.length??0,removed:input.removeSources?.length??0});
    return incidentCase(store,id);
  });
}

export function incidentCase(store,id){
  return atomic(store.db,()=>{
  const row=store.db.prepare('SELECT * FROM incident_cases WHERE id=?').get(id);if(!row)throw fail('Case not found.','INCIDENT_NOT_FOUND');
  const links=store.db.prepare('SELECT * FROM incident_case_posts WHERE case_id=? ORDER BY added_at,post_id LIMIT 100').all(id);
  const sources=[],stale=[],budget={characters:0,omittedPosts:0};
  for(const link of links){
    const current=boundedCandidatePost(store,link.post_id,budget);if(!current)continue;
    const candidate=current.candidates.find(c=>c.key===link.event_key);
    if(current.post.contentHash!==link.source_hash||!candidate){stale.push({postId:link.post_id,eventKey:link.event_key,reason:'The source or its event interpretation changed.'});continue;}
    sources.push({post:sourcePost(current.post),candidate,addedAt:link.added_at});
  }
  sources.sort((a,b)=>a.post.createdAt.localeCompare(b.post.createdAt)||a.post.id.localeCompare(b.post.id));
  return {id:row.id,title:row.title,status:row.status,revision:row.revision,createdAt:row.created_at,updatedAt:row.updated_at,sources,stale,
    members:new Set(sources.map(s=>s.post.memberId)).size,posts:new Set(sources.map(s=>s.post.id)).size,
    firstObservedInCase:sources[0]?.post.createdAt??null,lastObservedInCase:sources.at(-1)?.post.createdAt??null,
    omittedOversizedSources:budget.omittedPosts,
    history:store.db.prepare('SELECT created_at,action,revision,details_json FROM incident_case_history WHERE case_id=? ORDER BY sequence DESC LIMIT 50').all(id).map(r=>({createdAt:r.created_at,action:r.action,revision:r.revision,...JSON.parse(r.details_json)})),
    note:'Status is a user-maintained case state. Source chronology and member counts do not establish verified occurrence, first use on X, agreement or coordination.'};
  });
}
