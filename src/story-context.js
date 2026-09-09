import {createHash} from 'node:crypto';
import {readPrivateJson} from './private-files.js';

export const STORY_CONTEXT_VERSION='grounded-story-context-v1';
const LIMITS={stories:25,textCharacters:60000,matches:4,termOccurrences:32,contextRadius:400};
const fail=()=>{throw new Error('Invalid story context library.');};
function text(value,max=160){if(typeof value!=='string'||!value.trim()||value.length>max||value.includes('\0'))fail();return value;}
function list(value,min,max,check){if(!Array.isArray(value)||value.length<min||value.length>max)fail();value.forEach(check);return value;}
function https(value){text(value,2000);let url;try{url=new URL(value);}catch{fail();}if(url.protocol!=='https:'||url.username||url.password||url.port)fail();}

export function validateStoryLibrary(library){
  if(!library||library.schemaVersion!==1)fail();
  list(library.stories,0,LIMITS.stories,story=>{
    text(story.id,80);text(story.topic,100);text(story.subtopic);text(story.summary,600);
    if(story.curator!=='assistant')fail();
    list(story.aliases,1,12,alias=>{text(alias.text,100);if(typeof alias.specific!=='boolean')fail();});
    list(story.contextGroups,2,6,group=>{text(group.name,60);list(group.terms,1,10,term=>text(term,100));});
    if(new Set(story.contextGroups.map(g=>g.name)).size!==story.contextGroups.length)fail();
    if(!Number.isFinite(Date.parse(story.matchFrom))||!Number.isFinite(Date.parse(story.matchUntil))||Date.parse(story.matchUntil)<Date.parse(story.matchFrom))fail();
    list(story.explicitTimeReferences??[],0,5,term=>text(term,80));
    list(story.sources,1,5,source=>{https(source.url);text(source.title,300);text(source.supports,600);if(source.publishedOn!==null&&!/^\d{4}-\d{2}-\d{2}$/.test(source.publishedOn??''))fail();});
  });
  if(new Set(library.stories.map(s=>s.id)).size!==library.stories.length)fail();
  return library;
}

function occurrences(source,phrase){
  const pattern=phrase.trim().split(/\s+/u).map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('\\s+');
  const regex=new RegExp(`(?<![\\p{L}\\p{N}_])${pattern}(?![\\p{L}\\p{N}_])`,'giu');
  const spans=[];let match;
  while((match=regex.exec(source))&&spans.length<LIMITS.termOccurrences)spans.push({start:match.index,end:match.index+match[0].length,text:match[0]});
  return spans;
}
function paragraphRanges(source){
  const result=[];let start=0;
  for(const match of source.matchAll(/\n\s*\n/gu)){result.push({start,end:match.index});start=match.index+match[0].length;}
  result.push({start,end:source.length});return result;
}

/** Associating a source with background context does not verify its claims or stance. */
export function recognizeStories(post,rawLibrary){
  const library=validateStoryLibrary(rawLibrary);
  if(typeof post?.text!=='string'||post.text.length>LIMITS.textCharacters||!Number.isFinite(Date.parse(post.createdAt)))throw new Error('Invalid story source bounds.');
  const libraryHash=createHash('sha256').update(JSON.stringify(library)).digest('hex');
  const hash=createHash('sha256').update(JSON.stringify({version:STORY_CONTEXT_VERSION,libraryHash,sourceHash:post.contentHash??null,text:post.text,createdAt:post.createdAt})).digest('hex');
  const paragraphs=paragraphRanges(post.text),candidates=[];
  for(const story of library.stories){
    const inWindow=Date.parse(post.createdAt)>=Date.parse(story.matchFrom)&&Date.parse(post.createdAt)<=Date.parse(story.matchUntil);
    const timeEvidence=(story.explicitTimeReferences??[]).flatMap(term=>occurrences(post.text,term));
    if(!inWindow&&!timeEvidence.length)continue;
    const contexts=story.contextGroups.map(group=>({name:group.name,spans:group.terms.flatMap(term=>occurrences(post.text,term))}));
    const matches=[];
    for(const alias of story.aliases){
      for(const anchor of occurrences(post.text,alias.text)){
        const paragraph=paragraphs.find(p=>anchor.start>=p.start&&anchor.end<=p.end);if(!paragraph)continue;
        const near=span=>span.start>=Math.max(paragraph.start,anchor.start-LIMITS.contextRadius)&&span.end<=Math.min(paragraph.end,anchor.end+LIMITS.contextRadius);
        // A date elsewhere in a long post cannot attach an unrelated current incident to an old story.
        const dateSpan=inWindow?null:timeEvidence.find(near);if(!inWindow&&!dateSpan)continue;
        const groups=contexts.map(group=>({name:group.name,span:group.spans.find(s=>near(s)&&!(s.start<anchor.end&&s.end>anchor.start))})).filter(g=>g.span);
        // The same word cannot count as independent corroboration in two groups.
        const distinct=new Map(groups.map(g=>[`${g.span.start}:${g.span.end}`,g]));
        const support=[...distinct.values()];if(support.length<(alias.specific?1:2))continue;
        matches.push({anchor,specific:alias.specific,support,dateSpan});
      }
    }
    matches.sort((a,b)=>Number(b.specific)-Number(a.specific)||b.support.length-a.support.length||(b.anchor.end-b.anchor.start)-(a.anchor.end-a.anchor.start)||a.anchor.start-b.anchor.start);
    const best=matches[0];if(!best)continue;
    const evidence=[{...best.anchor,role:'name-or-event'},...best.support.map(g=>({...g.span,role:g.name})),...(best.dateSpan?[{...best.dateSpan,role:'explicit-event-date'}]:[])];
    candidates.push({storyId:story.id,topic:story.topic,subtopic:story.subtopic,summary:story.summary,curator:'assistant',status:'suggestion',
      matchBasis:best.specific?'specific-name-and-context':'partial-name-and-multiple-contexts',
      explanation:`${JSON.stringify(best.anchor.text)} appears with ${best.support.map(g=>g.name).join(' and ')} in the same nearby passage.`,
      evidence,sources:story.sources,temporalBasis:inWindow?'within-curated-match-window':'explicit-historical-reference',
      knowledgeTiming:'Retrospective background research; availability at the original post time is not established.',
      nationalAttention:'not-measured',currentIncident:'not-established',stance:'not-inferred'});
  }
  return {status:library.stories.length?'available':'not-configured',version:STORY_CONTEXT_VERSION,hash,libraryHash,examinedStories:library.stories.length,
    matches:candidates.slice(0,LIMITS.matches),omittedMatches:Math.max(0,candidates.length-LIMITS.matches),limits:LIMITS,
    note:'Researched story suggestions. These do not change saved topic labels or human judgments, verify the post’s claims, establish national prominence, or discover stories outside this library.'};
}

export function createStoryContextProvider(path){
  return post=>{
    try{return recognizeStories(post,readPrivateJson(path,{missing:{schemaVersion:1,stories:[]},maxBytes:250000}));}
    catch{return {status:'unavailable',hash:null,matches:[],note:'Story context could not be checked. The original source and saved classification remain available.'};}
  };
}
