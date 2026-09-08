import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { atomic } from './sqlite.js';
import { searchSelection } from './explorer.js';
import { embeddingModel } from './embedding-models.js';
import { SUBJECT_GROUP_VERSION,subjectGroupOptions } from './subject-groups-core.js';

export function prepareSubjectSnapshot(store,filters={},options={}){
  const {name='minilm',now=Date.now(),windowHours=24,maxPosts=250,maxPassages=1000,maxCharacters=150000}=options;
  subjectGroupOptions(options);
  if(!Number.isFinite(windowHours)||windowHours<0.5||windowHours>744)throw new Error('Invalid emerging-subject window.');
  for(const [value,max] of [[maxPosts,250],[maxPassages,1000],[maxCharacters,150000]])
    if(!Number.isInteger(value)||value<1||value>max)throw new Error('Invalid emerging-subject limit.');
  const until=filters.until?new Date(filters.until).toISOString():new Date(now).toISOString();
  const since=filters.since?new Date(filters.since).toISOString():new Date(Date.parse(until)-windowHours*3600000).toISOString();
  if(Date.parse(until)-Date.parse(since)>31*86400000)throw new Error('Invalid emerging-subject window: choose at most 31 days.');
  const selection=searchSelection({...filters,since,until}),model=embeddingModel(name),db=store.db;
  return atomic(db,()=>{
    const revision=db.prepare('SELECT revision FROM explorer_revision WHERE id=1').get().revision;
    const totalPosts=db.prepare(`SELECT COUNT(*) AS n ${selection.from}`).get(...selection.values).n;
    const excludedReposts=db.prepare(`SELECT COUNT(*) AS n ${selection.from} AND s.type='repost'`).get(...selection.values).n;
    const eligible=`${selection.from} AND s.type<>'repost' AND EXISTS(SELECT 1 FROM embedding_jobs j JOIN posts p ON p.id=j.post_id
      WHERE j.post_id=s.post_id AND j.source_hash=p.content_hash AND j.model_id=? AND j.status='completed')`;
    const eligibleValues=[...selection.values,model.fingerprint];
    const indexedPosts=db.prepare(`SELECT COUNT(*) AS n ${eligible}`).get(...eligibleValues).n;
    const posts=[],passages=[],vectors=[];let characters=0,omittedResourcePosts=0,omittedSentenceDetails=0,excludedShortPassages=0;
    const rows=db.prepare(`SELECT s.post_id,s.member_id,s.member_name,s.created_at,s.type,s.labels_json ${eligible}
      ORDER BY s.created_at DESC,s.post_id DESC LIMIT ?`).all(...eligibleValues,maxPosts);
    for(const row of rows){
      const count=db.prepare('SELECT COUNT(*) AS n FROM embedding_passages WHERE post_id=? AND model_id=?').get(row.post_id,model.fingerprint).n;
      const source=db.prepare('SELECT content_hash,CASE WHEN length(text)<=? THEN text ELSE NULL END AS text FROM posts WHERE id=?')
        .get(maxCharacters-characters,row.post_id);
      if(!count||count>maxPassages-passages.length||source.text===null||source.text.length>maxCharacters-characters){omittedResourcePosts++;continue;}
      const items=db.prepare(`SELECT start_offset,end_offset,kind,vector FROM embedding_passages WHERE post_id=? AND model_id=? AND source_hash=? ORDER BY passage_index`)
        .all(row.post_id,model.fingerprint,source.content_hash);
      if(items.length!==count)throw new Error('Invalid source-versioned passage index.');
      const post={id:row.post_id,memberId:row.member_id,memberName:row.member_name,createdAt:row.created_at,type:row.type,
        labels:JSON.parse(row.labels_json),sourceHash:source.content_hash,text:source.text,sourceUrl:`https://x.com/i/web/status/${row.post_id}`};
      const included=[];
      for(const item of items){
        const text=post.text.slice(item.start_offset,item.end_offset);
        if((text.match(/[\p{L}\p{N}]+/gu)??[]).length<4){excludedShortPassages++;continue;}
        included.push({postId:post.id,start:item.start_offset,end:item.end_offset,kind:item.kind});
        const buffer=Buffer.from(item.vector.buffer,item.vector.byteOffset,item.vector.byteLength);
        for(let i=0;i<384;i++)vectors.push(buffer.readFloatLE(i*4));
      }
      passages.push(...included);posts.push(post);characters+=post.text.length;
      omittedSentenceDetails+=db.prepare('SELECT detail_omitted AS n FROM embedding_jobs WHERE post_id=? AND model_id=?').get(post.id,model.fingerprint).n;
    }
    const vectorData=Float32Array.from(vectors).buffer;
    const manifest=createHash('sha256').update(JSON.stringify({version:SUBJECT_GROUP_VERSION,model:model.fingerprint,filters:selection.filters,
      posts:posts.map(({id,sourceHash})=>({id,sourceHash})),passages})).update(new Uint8Array(vectorData)).digest('hex');
    return {version:SUBJECT_GROUP_VERSION,manifest,revision,asOf:new Date(now).toISOString(),modelFingerprint:model.fingerprint,dimensions:384,window:{since,until},
      filters:selection.filters,posts,passages,vectors:vectorData,
      coverage:{totalPosts,excludedReposts,indexedPosts,unindexedPosts:totalPosts-excludedReposts-indexedPosts,
        admittedPosts:posts.length,admittedPassages:passages.length,admittedCharacters:characters,
        omittedCandidatePosts:Math.max(0,indexedPosts-maxPosts),omittedResourcePosts,omittedSentenceDetails,excludedShortPassages,
        complete:indexedPosts===totalPosts-excludedReposts&&indexedPosts<=maxPosts&&omittedResourcePosts===0,
        limits:{posts:maxPosts,passages:maxPassages,characters:maxCharacters},selectionOrder:'newest first; resource limits omit whole posts'}};
  });
}

function computeInWorker(snapshot,options){
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./subject-groups-thread.js',import.meta.url),{
      workerData:{snapshot,options},env:{},execArgv:[],resourceLimits:{maxOldGenerationSizeMb:128},stdout:true,stderr:true
    });
    worker.stdout.resume();worker.stderr.resume();let settled=false;
    function finish(error,result){if(settled)return;settled=true;clearTimeout(timer);void worker.terminate();if(error)reject(error);else resolve(result);}
    const timer=setTimeout(()=>finish(Object.assign(new Error('Emerging-subject analysis exceeded its local time limit.'),{code:'DISCOVERY_UNAVAILABLE'})),15000);
    worker.on('message',message=>message.result?finish(null,message.result):finish(Object.assign(new Error('Emerging-subject analysis could not complete.'),{code:'DISCOVERY_UNAVAILABLE'})));
    worker.on('error',()=>finish(Object.assign(new Error('Emerging-subject analysis could not complete.'),{code:'DISCOVERY_UNAVAILABLE'})));
    worker.on('exit',()=>{if(!settled)finish(Object.assign(new Error('Emerging-subject analysis stopped before completion.'),{code:'DISCOVERY_UNAVAILABLE'}));});
  });
}

export async function subjectGroups(store,filters={},options={},compute=computeInWorker){
  const snapshot=prepareSubjectSnapshot(store,filters,options);
  const result=await compute(snapshot,options);
  const revision=store.db.prepare('SELECT revision FROM explorer_revision WHERE id=1').get().revision;
  if(revision!==snapshot.revision)throw Object.assign(new Error('The archive changed during grouping. Refresh the subject candidates.'),{code:'DISCOVERY_CHANGED'});
  const used=new Set(result.groups.flatMap(g=>g.evidence.map(e=>e.postId)));
  return {...result,generatedAt:new Date().toISOString(),sourceSnapshotAt:snapshot.asOf,snapshotId:snapshot.manifest,modelFingerprint:snapshot.modelFingerprint,
    window:snapshot.window,filters:snapshot.filters,coverage:snapshot.coverage,sourcePosts:snapshot.posts.filter(p=>used.has(p.id)),
    note:'Candidate groups describe related source passages in this archive selection. They do not establish a shared incident, agreement, coordination, factual truth, or first use on X. Topics on source posts are not automatically the group title.'};
}
