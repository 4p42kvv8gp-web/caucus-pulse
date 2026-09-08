import {atomic} from './sqlite.js';

export function prepareVoiceSession(store,{postIds=null,limit=6,now=Date.now()}={}){
  if(!Number.isInteger(limit)||limit<1||limit>8)throw new Error('Invalid voice session size: choose 1–8 sources.');
  if(postIds!==null&&(!Array.isArray(postIds)||!postIds.length||postIds.length>limit||new Set(postIds).size!==postIds.length||postIds.some(id=>typeof id!=='string'||!/^\d{1,30}$/.test(id))))
    throw new Error('Invalid voice session source IDs.');
  return atomic(store.db,()=>{
    const ids=postIds??store.db.prepare(`SELECT p.id FROM posts p ORDER BY
      EXISTS(SELECT 1 FROM feedback f WHERE f.post_id=p.id AND f.source_hash=p.content_hash),p.created_at DESC,p.id DESC LIMIT ?`).all(limit).map(row=>row.id);
    const cards=ids.map(id=>{
      const post=store.getPost(id);if(!post)throw new Error('Invalid voice session source: a post is missing.');
      const accepted=post.feedback.find(review=>review.appliesToCurrentText);
      return {postId:post.id,sourceHash:post.contentHash,predictionHash:post.analysisHash,reviewId:post.reviewId,
        role:accepted?'revisit-existing-judgment':'new-discussion',
        source:{memberName:post.memberName,handle:post.handle,createdAt:post.createdAt,type:post.type,text:post.text,sourceUrl:post.sourceUrl,textCoverage:post.textCoverage,contextCoverage:post.contextCoverage,
          identityNote:post.identityNote,accountType:post.accountType,district:post.district??null},
        prediction:{method:post.analysis.method,model:post.analysis.model??null,version:post.analysis.version,labels:post.analysis.labels,explanation:post.analysis.explanation,
          entities:post.analysis.entities??[],events:post.analysis.events??[],functions:post.analysis.functions??[],limitations:post.analysis.limitations},
        currentJudgment:accepted?{feedbackId:accepted.id,decision:accepted.decision,labels:accepted.labels,reason:accepted.reason,ruleProposal:accepted.ruleProposal??null}:null,
        discussionPrompts:[
          'Which subject labels does the available wording support, and which should be removed?',
          'Does a named facility or event deserve its own subtopic? What exact wording identifies it?',
          'Is this a current physical incident, an update, a historical reference, or something else?',
          'What remains unknown without the linked story, media, or earlier post?'
        ],
        saveInstruction:'Ask one relevant question at a time. Record only the user’s actual judgment. Reload the source before saving; a changed source, prediction or previous review requires a fresh discussion. Broader lessons remain proposals.'};
    });
    return {kind:'private-voice-discussion-preparation',generatedAt:new Date(now).toISOString(),cards,
      changesMade:{reviews:0,evaluationReservations:0,modelRuns:0,paidRequests:0},
      note:'This is a discussion aid, not a completed session or a held-out test. The predictions are visible and the sources may already have informed development. Start voice chat in Codex; the dashboard does not record audio or run speech recognition.'};
  });
}
