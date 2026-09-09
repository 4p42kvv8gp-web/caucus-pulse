import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {readdirSync,unlinkSync} from 'node:fs';
import {privateDirectory,regularFile,readPrivateJson,writePrivateJson,acquirePrivateLock} from './private-files.js';

const DAY=86400000, REFRESH=30*60000, MAX_BYTES=250000;
export const OUTSIDE_CONTEXT_VERSION='public-news-leads-v1';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exact=(post,s)=>s&&Number.isInteger(s.start)&&Number.isInteger(s.end)&&s.start>=0&&s.end>s.start&&s.end<=post.text.length&&post.text.slice(s.start,s.end)===s.text;
const phrase=value=>typeof value==='string'&&value.length<=100&&/^[\p{L}\p{N}][\p{L}\p{N} /’'.,-]*$/u.test(value)&&value.replace(/[^\p{L}\p{N}]/gu,'').length>=4?value.trim():null;
const dateCode=ms=>new Date(ms).toISOString().slice(0,19).replace(/[-:T]/g,'');
const error=code=>Object.assign(new Error('Outside context lookup is unavailable.'),{code});

/** Only exact public source spans become search terms. Private judgments never enter a query. */
export function outsideContextPlan(post,stories={matches:[]},{now=Date.now()}={}){
  if(!post||typeof post.text!=='string'||post.text.length>60000||!Number.isFinite(Date.parse(post.createdAt)))return null;
  const at=Date.parse(post.createdAt);if(at>now)return null;
  let evidence=[];
  const match=stories.matches?.[0];
  if(match)evidence=(match.evidence??[]).filter(s=>exact(post,s)&&phrase(s.text)).slice(0,3);
  if(evidence.length<2){
    evidence=[];
    const event=(post.analysis?.events??[]).find(e=>e.location?.evidence?.some(s=>exact(post,s)));
    if(event){
      const location=event.location.evidence.find(s=>exact(post,s)&&phrase(s.text));
      const passage=event.evidence?.find(s=>exact(post,s));
      const type=passage?.text.match(/\b(?:shooting|shooter|flooding|flood|wildfire|fire|tornado|earthquake|explosion|evacuation)\b/i);
      if(location&&type)evidence=[location,{start:passage.start+type.index,end:passage.start+type.index+type[0].length,text:type[0]}];
    }
  }
  if(evidence.length<2){
    evidence=(post.analysis?.entities??[]).filter(e=>['person','location','facility','bill','agency','organization'].includes(e.kind))
      .flatMap(e=>(e.evidence??[]).filter(s=>exact(post,s)&&phrase(s.text)).slice(0,1)).slice(0,3);
  }
  evidence=evidence.filter((s,i,a)=>a.findIndex(x=>x.text.toLocaleLowerCase('en')===s.text.toLocaleLowerCase('en'))===i);
  if(evidence.length<2)return null;
  // Narrow to the source date, including one following day for retrospective context.
  const start=at-3*DAY,end=Math.min(at+DAY,now);
  const query=evidence.map(s=>`"${s.text}"`).join(' ');
  return {query,evidence,from:new Date(start).toISOString(),until:new Date(end).toISOString(),
    retrospective:end>at,automaticEligible:now-at<=7*DAY,
    key:digest({version:OUTSIDE_CONTEXT_VERSION,sourceHash:post.contentHash,query,start,end:at+DAY})};
}

export function publicArticleUrl(value){
  try{
    const u=new URL(value);
    if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.port||u.href.length>2000||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(u.hostname)||
      /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion|x\.com|twitter\.com)$/i.test(u.hostname))return null;
    u.hash='';return u.href;
  }catch{return null;}
}

/** GDELT metadata is a discovery lead; neither its timestamp nor headline verifies the event. */
export async function searchOutsideNews(plan,{fetcher=fetch,signal,now=Date.now()}={}){
  const url=new URL('https://api.gdeltproject.org/api/v2/doc/doc');
  for(const [k,v] of Object.entries({query:plan.query,mode:'artlist',format:'json',maxrecords:8,sort:'datedesc',startdatetime:dateCode(Date.parse(plan.from)),enddatetime:dateCode(Date.parse(plan.until))}))url.searchParams.set(k,String(v));
  const response=await fetcher(url,{redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000),headers:{Accept:'application/json'}});
  if(response.status===429){await response.body?.cancel();throw error('RATE_LIMITED');}
  if(!response.ok){await response.body?.cancel();throw error('PROVIDER_UNAVAILABLE');}
  let size=0;const chunks=[];
  if(!response.body)throw error('INVALID_RESPONSE');
  for await(const part of response.body){size+=part.byteLength;if(size>MAX_BYTES)throw error('RESPONSE_TOO_LARGE');chunks.push(part);}
  let payload;try{payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw error('INVALID_RESPONSE');}
  if(!payload||!Array.isArray(payload.articles)||payload.articles.length>250)throw error('INVALID_RESPONSE');
  const articles=[],seen=new Set();let rejected=0;
  for(const item of payload.articles){
    const link=publicArticleUrl(item?.url);
    const m=typeof item?.seendate==='string'&&item.seendate.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
    const indexedAt=m?`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`:null;
    const stamp=Date.parse(indexedAt);
    if(!link||typeof item.title!=='string'||!item.title.trim()||item.title.length>500||!Number.isFinite(stamp)||stamp<Date.parse(plan.from)||stamp>Date.parse(plan.until)){rejected++;continue;}
    if(seen.has(link))continue;seen.add(link);
    if(articles.length>=8)continue;
    articles.push({url:link,title:item.title,domain:new URL(link).hostname,indexedAt,publishedAt:null,
      sourceType:/\.gov$/.test(new URL(link).hostname)?'government-domain':'news-index-result',verification:'unreviewed-lead'});
  }
  return {status:articles.length?'leads-found':'no-matching-leads',articles,rejectedResults:rejected,checkedAt:new Date(now).toISOString(),
    note:'News index leads only. Article contents and claims have not been verified. Indexed time is not publication time; results may include follow-up reporting. Missing results do not establish that a story is absent.'};
}

export function createOutsideContextService({store,directory,storyContext=()=>({matches:[]}),fetcher=fetch,clock=Date.now,signal}={}){
  const reports=privateDirectory(resolve(directory,'reports')),operations=privateDirectory(resolve(directory,'operations'));
  const providerPath=resolve(operations,'outside-context-provider.json');let busy=false;
  const path=id=>{if(!/^\d{1,30}$/.test(id))throw error('INVALID_POST');return resolve(reports,`outside-context-${id}.json`);};
  const planFor=post=>outsideContextPlan(post,storyContext(post),{now:clock()});
  function read(post){const value=readPrivateJson(path(post.id),{maxBytes:100000});return value?.sourceHash===post.contentHash?value:null;}
  function status(post){
    const plan=planFor(post),saved=read(post),record=plan&&saved?.planKey===plan.key?saved:null;
    const provider=readPrivateJson(providerPath,{maxBytes:20000});
    const waiting=plan&&!record&&Number.isFinite(provider?.nextAt)&&provider.nextAt>clock();
    const result=record??{status:waiting?'waiting':plan?'not-checked':'needs-search-terms',articles:[],checkedAt:null,
      ...(waiting?{retryAt:new Date(provider.nextAt).toISOString()}:{}),
      note:waiting?'The news index is waiting before another request. Outside corroboration is still pending.':plan?'Outside reporting has not been checked yet.':'The source needs more specific names, places, or linked context before an outside search can be targeted.'};
    return {...result,query:plan?.query??null,searchEvidence:plan?.evidence??[],window:plan?{from:plan.from,until:record?.window?.until??plan.until,retrospective:plan.retrospective}:null,
      canLookup:!!plan,automaticEligible:plan?.automaticEligible??false,
      hash:digest({version:OUTSIDE_CONTEXT_VERSION,planKey:plan?.key??null,record:record??null}),
      provider:'GDELT DOC',providerDocumentation:'https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/'};
  }
  function evictCache(){
    const files=readdirSync(reports).filter(n=>/^outside-context-\d{1,30}\.json$/.test(n));
    if(files.length<1000)return;
    const oldest=files.map(name=>({name,stat:regularFile(resolve(reports,name),{maxBytes:100000})})).sort((a,b)=>a.stat.mtimeMs-b.stat.mtimeMs);
    for(const item of oldest.slice(0,files.length-999))unlinkSync(resolve(reports,item.name));
  }
  async function lookup(postId,expectedHash){
    const post=store.getPost(postId);if(!post)throw error('CONTEXT_NOT_FOUND');
    if(expectedHash!==post.contentHash)throw error('CONTEXT_CHANGED');
    const plan=planFor(post);if(!plan)return status(post);
    const prior=read(post),now=clock();
    if(prior?.planKey===plan.key&&Date.parse(prior.retryAt)>now)return status(post);
    if(busy)return {...status(post),status:'busy'};
    busy=true;let release;
    try{
      try{release=acquirePrivateLock(operations,'outside-context.lock');}catch{return {...status(post),status:'busy'};}
      const provider=readPrivateJson(providerPath,{missing:{nextAt:0,requests:[]},maxBytes:20000});
      if(!Number.isFinite(provider.nextAt)||!Array.isArray(provider.requests)||provider.requests.length>60||provider.requests.some(n=>!Number.isFinite(n)))throw error('PROVIDER_STATE_UNAVAILABLE');
      if(provider.nextAt>now)return {...status(post),status:'waiting',retryAt:new Date(provider.nextAt).toISOString()};
      const recent=provider.requests.filter(t=>t>now-3600000);
      if(recent.length>=60)return {...status(post),status:'waiting',retryAt:new Date(recent[0]+3600000).toISOString()};
      const state={nextAt:now+10000,requests:[...recent,now]};writePrivateJson(providerPath,state);
      let result;
      try{result=await searchOutsideNews(plan,{fetcher,signal,now});}
      catch(e){result={status:e.code==='RATE_LIMITED'?'rate-limited':'unavailable',articles:[],checkedAt:new Date(now).toISOString(),note:e.code==='RATE_LIMITED'?'The news index is rate limited. This source remains provisional; the lookup will wait before trying again.':'Outside reporting could not be checked. Provider coverage or availability may be limited; the source remains provisional.'};state.nextAt=now+REFRESH;writePrivateJson(providerPath,state);}
      const record={...result,postId,sourceHash:post.contentHash,planKey:plan.key,window:{from:plan.from,until:plan.until},retryAt:new Date(now+REFRESH).toISOString()};
      // Managed deletion uses the same maintenance fence, so a late request cannot recreate its cache.
      const releaseMaintenance=acquirePrivateLock(directory);
      try{
        if(signal?.aborted||store.getPost(postId)?.contentHash!==post.contentHash)throw error('CONTEXT_CHANGED');
        evictCache();writePrivateJson(path(postId),record);
      }finally{releaseMaintenance();}
      return status(post);
    }finally{release?.();busy=false;}
  }
  async function tick(){
    if(busy||signal?.aborted)return;
    const rows=store.db.prepare('SELECT id,length(text) AS characters FROM posts WHERE created_at>=? ORDER BY created_at DESC,id DESC LIMIT 200').all(new Date(clock()-7*DAY).toISOString());
    let characters=0;
    for(const row of rows){
      if(row.characters>60000)continue;if(characters+row.characters>300000)break;characters+=row.characters;
      const post=store.getPost(row.id);if(!post)continue;
      const plan=planFor(post);if(!plan)continue;
      const saved=read(post);if(saved?.planKey===plan.key&&Date.parse(saved.retryAt)>clock())continue;
      await lookup(post.id,post.contentHash);return;
    }
  }
  return {status,lookup,tick};
}
