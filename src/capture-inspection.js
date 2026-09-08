import {atomic} from './sqlite.js';

export function inspectUnverifiedCaptures(store,{limit=25,maxPostCharacters=60000,maxSourceCharacters=300000}={}){
  for(const [value,max] of [[limit,50],[maxPostCharacters,60000],[maxSourceCharacters,300000]])
    if(!Number.isInteger(value)||value<1||value>max)throw new Error('Invalid capture inspection limit.');
  return atomic(store.db,()=>{
    const where="FROM captured_posts c WHERE c.status<>'promoted' AND NOT EXISTS(SELECT 1 FROM tombstones t WHERE t.post_id=c.id)";
    const total=store.db.prepare(`SELECT COUNT(*) AS n ${where}`).get().n;
    // Measure before loading a whole source. Do not return the provider payload or infer a member identity.
    const rows=store.db.prepare(`SELECT c.id,c.created_at,c.captured_at,c.status,
      length(json_extract(c.normalized_json,'$.text')) AS characters ${where}
      ORDER BY c.created_at DESC,c.id DESC LIMIT ?`).all(limit);
    const captures=[];let sourceCharacters=0,omittedOversized=0;
    for(const row of rows){
      if(row.characters>maxPostCharacters||row.characters>maxSourceCharacters-sourceCharacters){omittedOversized++;continue;}
      const value=store.db.prepare(`SELECT json_extract(normalized_json,'$.text') AS text,
        json_extract(normalized_json,'$.contentHash') AS sourceHash,json_extract(normalized_json,'$.type') AS type,
        json_extract(normalized_json,'$.textCoverage') AS textCoverage,json_extract(normalized_json,'$.contextCoverage') AS contextCoverage
        FROM captured_posts WHERE id=?`).get(row.id);
      if(typeof value.text!=='string'||value.text.length>maxPostCharacters||value.text.length>maxSourceCharacters-sourceCharacters){omittedOversized++;continue;}
      sourceCharacters+=value.text.length;
      captures.push({id:row.id,createdAt:row.created_at,capturedAt:row.captured_at,status:row.status,...value,
        sourceUrl:`https://x.com/i/web/status/${row.id}`,identityStatus:'not-established',includedInMemberCounts:false});
    }
    return {captures,coverage:{total,examined:rows.length,returned:captures.length,unexamined:Math.max(0,total-rows.length),
      omittedOversized,sourceCharacters,partial:captures.length<total,order:'newest captured source date first',
      limits:{posts:limit,postCharacters:maxPostCharacters,sourceCharacters:maxSourceCharacters}},
      note:'Saved captures awaiting account or membership evidence. Their wording is available for inspection; no caucus identity, topic classification or member count is assigned here. This archive-wide view makes no X requests.'};
  });
}
