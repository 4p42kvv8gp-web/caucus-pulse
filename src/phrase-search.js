import {atomic} from './sqlite.js';
import {searchSelection} from './explorer.js';

export const PHRASE_LIMITS=Object.freeze({posts:500,postCharacters:60000,sourceCharacters:300000,occurrences:1000,responseCharacters:1000000});

export function phraseData(store,phrase,filters={}) {
  if(typeof phrase!=='string'||!phrase.trim()||phrase.length>2000||phrase.includes('\0'))throw new Error('Enter an exact phrase, up to 2,000 characters.');
  const selection=searchSelection(filters);
  return atomic(store.db,()=>{
    const matching=`${selection.from} AND s.type<>'repost' AND EXISTS(SELECT 1 FROM posts p WHERE p.id=s.post_id AND instr(p.text,?)>0)`;
    const values=[...selection.values,phrase];
    const totals=store.db.prepare(`SELECT COUNT(*) AS posts,COUNT(DISTINCT s.member_id) AS members,MIN(s.created_at) AS first ${matching}`).get(...values);
    const rows=store.db.prepare(`SELECT s.post_id,s.member_id,s.member_name,s.created_at,s.type,(SELECT length(p.text) FROM posts p WHERE p.id=s.post_id) AS characters ${matching} ORDER BY s.created_at,s.post_id LIMIT ?`).all(...values,PHRASE_LIMITS.posts);
    const sources=[],occurrences=[];let characters=0,responseCharacters=0,omittedOversizedPosts=0,omittedOccurrences=0;
    for(const row of rows){
      if(row.characters>PHRASE_LIMITS.postCharacters||characters+row.characters>PHRASE_LIMITS.sourceCharacters){omittedOversizedPosts++;continue;}
      const data=store.db.prepare(`SELECT text,content_hash,json_extract(normalized_json,'$.textCoverage') AS text_coverage,json_extract(normalized_json,'$.contextCoverage') AS context_coverage FROM posts WHERE id=?`).get(row.post_id);
      if(data.text.length>PHRASE_LIMITS.postCharacters||characters+data.text.length>PHRASE_LIMITS.sourceCharacters){omittedOversizedPosts++;continue;}
      characters+=data.text.length;
      const source={id:row.post_id,memberId:row.member_id,memberName:row.member_name,createdAt:row.created_at,type:row.type,text:data.text,contentHash:data.content_hash,textCoverage:data.text_coverage,contextCoverage:data.context_coverage,sourceUrl:`https://x.com/i/web/status/${row.post_id}`};
      const sourceSize=JSON.stringify(source).length;let included=false,from=0;
      while(from<=data.text.length-phrase.length){
        const start=data.text.indexOf(phrase,from);if(start<0)break;from=start+1;
        const occurrence={postId:row.post_id,span:{start,end:start+phrase.length,text:phrase}};
        const size=JSON.stringify(occurrence).length+(included?0:sourceSize);
        if(occurrences.length>=PHRASE_LIMITS.occurrences||responseCharacters+size>PHRASE_LIMITS.responseCharacters){omittedOccurrences++;continue;}
        if(!included){sources.push(source);included=true;}
        occurrences.push(occurrence);responseCharacters+=size;
      }
    }
    return {version:'bounded-exact-phrase-v2',phrase,matchingPosts:totals.posts,distinctMembers:totals.members,firstObservedInSelection:totals.first,
      occurrences,sources,coverage:{examinedMatchingPosts:rows.length,returnedPosts:sources.length,unexaminedMatchingPosts:Math.max(0,totals.posts-rows.length),omittedOversizedPosts,omittedOccurrences,sourceCharacters:characters,responseCharacters,
        partial:sources.length<totals.posts||omittedOccurrences>0,limits:PHRASE_LIMITS},
      note:'Exact, case-sensitive matches in the selected archive. Counts and earliest date cover all matching stored posts; displayed sources and occurrences are bounded separately. Original wording and overlapping occurrences are preserved. Reposts are excluded. Quotation authorship, agreement and coordination are not established.'};
  });
}
