import { atomic } from './sqlite.js';
import { embeddingModel } from './embedding-models.js';
import { searchSelection } from './explorer.js';

export const SEMANTIC_SEARCH_VERSION='local-passages-v1';
export const SEMANTIC_SEARCH_NOTE='Related-subject retrieval from locally indexed source passages. Similarity is not a probability, agreement, verified fact, or evidence of coordination. Read each full post, including negation and quotations.';
export function semanticSearch(store,queryEmbedding,{name='minilm',filters={},limit=20,maxPosts=5000,maxPassages=20000,maxSourceCharacters=300000}={}) {
  const model=embeddingModel(name),db=store.db;
  if (queryEmbedding?.modelFingerprint!==model.fingerprint || !Array.isArray(queryEmbedding.vector) ||
      queryEmbedding.vector.length!==model.dimensions || queryEmbedding.vector.some(v=>!Number.isFinite(v))) throw new Error('Invalid semantic query embedding.');
  const norm=Math.sqrt(queryEmbedding.vector.reduce((n,v)=>n+v*v,0));
  if (Math.abs(norm-1)>0.001) throw new Error('Invalid semantic query embedding normalization.');
  for (const [n,maximum] of [[limit,50],[maxPosts,5000],[maxPassages,20000],[maxSourceCharacters,300000]])
    if (!Number.isInteger(n) || n<1 || n>maximum) throw new Error('Invalid semantic search limit.');
  const selection=searchSelection(filters);
  return atomic(db,()=>{
    const selected=`WITH selected AS (SELECT s.post_id,s.created_at ${selection.from})`;
    const totalPosts=db.prepare(`SELECT COUNT(*) AS n ${selection.from}`).get(...selection.values).n;
    const indexStats=db.prepare(`${selected} SELECT COUNT(*) AS n,COALESCE(SUM(j.detail_omitted),0) AS detailOmitted,
      COALESCE(SUM(j.detail_duplicates),0) AS detailDuplicates FROM selected s JOIN embedding_jobs j ON j.post_id=s.post_id
      JOIN posts p ON p.id=s.post_id AND p.content_hash=j.source_hash WHERE j.model_id=? AND j.status='completed'`).get(...selection.values,model.fingerprint);
    const indexedPosts=indexStats.n;
    const cte=`${selected}, candidates AS (SELECT s.post_id,s.created_at FROM selected s JOIN embedding_jobs j ON j.post_id=s.post_id
      JOIN posts p ON p.id=s.post_id AND p.content_hash=j.source_hash WHERE j.model_id=? AND j.status='completed'
      ORDER BY s.created_at DESC,s.post_id DESC LIMIT ?)`;
    const values=[...selection.values,model.fingerprint,maxPosts];
    const totalPassages=db.prepare(`${cte} SELECT COUNT(*) AS n FROM candidates c JOIN embedding_passages e ON e.post_id=c.post_id
      JOIN posts p ON p.id=e.post_id AND p.content_hash=e.source_hash WHERE e.model_id=?`).get(...values,model.fingerprint).n;
    const byPost=new Map(); let examinedPassages=0,invalidPassages=0;
    const rows=db.prepare(`${cte} SELECT e.post_id,e.source_hash,e.passage_index,e.start_offset,e.end_offset,e.kind,e.vector,c.created_at
      FROM candidates c JOIN embedding_passages e ON e.post_id=c.post_id JOIN posts p ON p.id=e.post_id AND p.content_hash=e.source_hash
      WHERE e.model_id=? ORDER BY c.created_at DESC,c.post_id DESC,e.passage_index LIMIT ?`).iterate(...values,model.fingerprint,maxPassages);
    for (const row of rows) {
      examinedPassages++;
      const buffer=Buffer.from(row.vector.buffer,row.vector.byteOffset,row.vector.byteLength);
      if (buffer.length!==model.dimensions*4) { invalidPassages++; continue; }
      let dot=0,length=0;
      for(let i=0;i<model.dimensions;i++) { const value=buffer.readFloatLE(i*4); dot+=value*queryEmbedding.vector[i]; length+=value*value; }
      if (!Number.isFinite(dot) || Math.abs(Math.sqrt(length)-1)>0.002) { invalidPassages++; continue; }
      const similarity=Math.max(-1,Math.min(1,dot/(norm*Math.sqrt(length))));
      const match={start:row.start_offset,end:row.end_offset,kind:row.kind,similarity};
      let post=byPost.get(row.post_id);
      if (!post) { post={postId:row.post_id,sourceHash:row.source_hash,createdAt:row.created_at,similarity,matches:[]}; byPost.set(row.post_id,post); }
      post.similarity=Math.max(post.similarity,similarity);
      post.matches.push(match); post.matches.sort((a,b)=>b.similarity-a.similarity || a.start-b.start || a.end-b.end);
      post.matches=post.matches.slice(0,3);
    }
    const ranked=[...byPost.values()].sort((a,b)=>b.similarity-a.similarity || b.createdAt.localeCompare(a.createdAt) || b.postId.localeCompare(a.postId));
    const results=[];let admittedCharacters=0,omittedResponsePosts=0;
    for(const row of ranked.slice(0,limit)) {
      const sourceLength=db.prepare('SELECT length(text) AS n FROM posts WHERE id=?').get(row.postId).n;
      if (sourceLength>maxSourceCharacters-admittedCharacters) { omittedResponsePosts++; continue; }
      const post=store.getPost(row.postId);
      if (post.text.length>maxSourceCharacters-admittedCharacters) { omittedResponsePosts++; continue; }
      admittedCharacters+=post.text.length;
      results.push({post,similarity:row.similarity,evidence:row.matches.map(m=>({...m,text:post.text.slice(m.start,m.end)})),
        attribution:post.type==='repost'?'amplification':post.type==='quote'?'quotation-context-unresolved':'source-caption'});
    }
    return {version:SEMANTIC_SEARCH_VERSION,model:{name,repository:model.repository,revision:model.revision,fingerprint:model.fingerprint},
      filters:selection.filters,results,searchNote:SEMANTIC_SEARCH_NOTE,
      coverage:{totalPosts,indexedPosts,unindexedPosts:totalPosts-indexedPosts,candidatePosts:Math.min(indexedPosts,maxPosts),
        omittedSentenceDetails:indexStats.detailOmitted,duplicateSentenceDetails:indexStats.detailDuplicates,
        examinedPosts:byPost.size,examinedPassages,totalCandidatePassages:totalPassages,invalidPassages,
        omittedCandidatePosts:Math.max(0,indexedPosts-maxPosts),omittedPassages:Math.max(0,totalPassages-maxPassages),
        returnedPosts:results.length,omittedResponsePosts,admittedSourceCharacters:admittedCharacters,
        complete:indexedPosts===totalPosts && indexedPosts<=maxPosts && totalPassages<=maxPassages && invalidPassages===0 && omittedResponsePosts===0,
        candidateOrder:'newest indexed posts within the selected filters',resultOrder:'highest passage similarity per post',
        limits:{posts:maxPosts,passages:maxPassages,results:limit,sourceCharacters:maxSourceCharacters}}};
  });
}
