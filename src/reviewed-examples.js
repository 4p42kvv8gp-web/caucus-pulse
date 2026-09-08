import { exampleExclusions } from './learning-context.js';
import { embeddingModel } from './embedding-models.js';

export const EXAMPLE_RETRIEVAL_VERSION='bounded-reviewed-passages-v1';
const MAX_CANDIDATES=200,MAX_EXAMPLE_CHARACTERS=8000,MAX_TOTAL_CHARACTERS=10000;

function representativeVectors(store,postId,sourceHash,modelId,limit){
  const rows=store.db.prepare(`SELECT vector FROM embedding_passages WHERE post_id=? AND model_id=? AND source_hash=? ORDER BY passage_index`).all(postId,modelId,sourceHash);
  const selected=rows.length<=limit?rows:Array.from({length:limit},(_,i)=>rows[Math.round(i*(rows.length-1)/(limit-1))]);
  return {vectors:selected.map(row=>{const bytes=Buffer.from(row.vector);return Array.from({length:384},(_,i)=>bytes.readFloatLE(i*4));}),omitted:Math.max(0,rows.length-selected.length)};
}
function cosine(a,b){let value=0;for(let i=0;i<384;i++)value+=a[i]*b[i];return value;}

export function reviewedExampleSelection(store,post,{limit=5,holdoutIds=[],embeddingName='bge'}={}){
  if(!Number.isInteger(limit)||limit<0||limit>10)throw new Error('Invalid example limit.');
  const excluded=exampleExclusions(store,post,holdoutIds),model=embeddingModel(embeddingName);
  const topics=new Set(post.analysis?.labels.map(l=>l.topic)??[]),target=post.text.toLowerCase();
  const targetVectors=representativeVectors(store,post.id,post.contentHash,model.fingerprint,16);
  const eligibleSQL=`FROM feedback f JOIN posts p ON p.id=f.post_id AND p.content_hash=f.source_hash
    WHERE NOT EXISTS(SELECT 1 FROM feedback newer WHERE newer.post_id=f.post_id AND newer.source_hash=f.source_hash AND newer.sequence>f.sequence)
      AND COALESCE(json_extract(f.feedback_json,'$.decision'),'classified') IN ('classified','no-supported-topic')`;
  const total=store.db.prepare(`SELECT COUNT(*) AS n ${eligibleSQL}`).get().n;
  const rows=store.db.prepare(`SELECT p.id,p.content_hash,p.created_at,
    CASE WHEN length(p.text)<=? THEN p.text ELSE NULL END AS text,
    json_extract(p.normalized_json,'$.references') AS references_json,
    json_extract(p.normalized_json,'$.contextCoverage') AS context_coverage,f.id AS feedback_id,f.feedback_json ${eligibleSQL}
    ORDER BY f.sequence DESC LIMIT ?`).all(MAX_EXAMPLE_CHARACTERS,MAX_CANDIDATES);
  const coverage={version:EXAMPLE_RETRIEVAL_VERSION,model:embeddingName,eligibleReviewedPosts:total,examinedReviewedPosts:rows.length,
    omittedOlderCandidates:Math.max(0,total-rows.length),excludedSources:0,oversizedSources:0,
    targetPassages:targetVectors.vectors.length,omittedTargetPassages:targetVectors.omitted,omittedCandidatePassages:0,semanticCandidates:0,
    omittedForContextBudget:0,selectedExamples:0,selectedSourceCharacters:0};
  const candidates=[];
  for(const row of rows){
    if(row.text===null||row.text.length>MAX_EXAMPLE_CHARACTERS){coverage.oversizedSources++;continue;}
    const candidate={id:row.id,text:row.text,references:JSON.parse(row.references_json??'[]')};
    if(excluded(candidate)){coverage.excludedSources++;continue;}
    const feedback=JSON.parse(row.feedback_json),decision=feedback.decision??'classified';
    const subjects=decision==='no-supported-topic'?feedback.predictionAtReview?.labels??[]:feedback.labels;
    const lexical=subjects.some(l=>topics.has(l.topic)||target.includes(l.topic.toLowerCase())||(l.subtopic&&target.includes(l.subtopic.toLowerCase())));
    let similarity=null;
    if(targetVectors.vectors.length){
      const vectors=representativeVectors(store,row.id,row.content_hash,model.fingerprint,8);
      coverage.omittedCandidatePassages+=vectors.omitted;
      if(vectors.vectors.length){coverage.semanticCandidates++;similarity=-1;for(const a of targetVectors.vectors)for(const b of vectors.vectors)similarity=Math.max(similarity,cosine(a,b));}
    }
    // A provisional retrieval threshold, not an accuracy or agreement score.
    if(!lexical&&(similarity===null||similarity<0.65))continue;
    candidates.push({postId:row.id,sourceHash:row.content_hash,text:row.text,createdAt:row.created_at,
      labels:decision==='no-supported-topic'?[]:feedback.labels,decision,correctionReason:feedback.reason,feedbackId:row.feedback_id,
      contextCoverage:row.context_coverage,retrieval:{method:similarity!==null?'semantic-passages-with-topic-fallback':'topic-fallback',similarity,lexical},sequenceOrder:candidates.length});
  }
  candidates.sort((a,b)=>(b.retrieval.similarity??(b.retrieval.lexical?0.65:-1))-(a.retrieval.similarity??(a.retrieval.lexical?0.65:-1))||a.sequenceOrder-b.sequenceOrder);
  const examples=[];
  for(const candidate of candidates){
    if(examples.length>=limit)break;
    if(coverage.selectedSourceCharacters+candidate.text.length>MAX_TOTAL_CHARACTERS){coverage.omittedForContextBudget++;continue;}
    const {sequenceOrder,...example}=candidate;examples.push(example);coverage.selectedSourceCharacters+=candidate.text.length;
  }
  coverage.selectedExamples=examples.length;
  return {examples,coverage};
}
