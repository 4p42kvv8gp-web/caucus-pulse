import { createHash } from 'node:crypto';

export const SUBJECT_GROUP_VERSION='passage-complete-link-candidates-v1';
export function subjectGroupOptions({threshold=0.68,minMembers=2,minPosts=2,limit=20}={}){
  if(!Number.isFinite(threshold)||threshold<0.5||threshold>0.95||!Number.isInteger(minMembers)||minMembers<2||minMembers>20||
    !Number.isInteger(minPosts)||minPosts<2||minPosts>30||!Number.isInteger(limit)||limit<1||limit>50)throw new Error('Invalid emerging-subject options.');
  return {threshold,minMembers,minPosts,limit};
}
export function groupSubjectPassages(snapshot,options={}) {
  const {threshold,minMembers,minPosts,limit}=subjectGroupOptions(options);
  const nodes=snapshot.passages,posts=new Map(snapshot.posts.map(p=>[p.id,p]));
  if(nodes.length>1000||posts.size>250||snapshot.dimensions!==384)throw new Error('Invalid emerging-subject snapshot size.');
  const n=nodes.length,scores=new Float32Array(n*n).fill(NaN),vectors=new Float32Array(snapshot.vectors);
  if(vectors.length!==n*384)throw new Error('Invalid emerging-subject vectors.');
  for(let i=0;i<n;i++){
    let norm=0;
    for(let d=0;d<384;d++){const value=vectors[i*384+d];if(!Number.isFinite(value))throw new Error('Invalid emerging-subject vector.');norm+=value*value;}
    if(Math.abs(Math.sqrt(norm)-1)>0.002)throw new Error('Invalid emerging-subject vector normalization.');
    if(!posts.has(nodes[i].postId))throw new Error('Invalid emerging-subject source.');
  }
  let comparisons=0;
  for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){
    if(nodes[i].postId===nodes[j].postId)continue;
    let dot=0;
    for(let d=0;d<384;d++)dot+=vectors[i*384+d]*vectors[j*384+d];
    scores[i*n+j]=scores[j*n+i]=Math.max(-1,Math.min(1,dot));comparisons++;
  }
  const candidates=[];
  for(let anchor=0;anchor<n;anchor++){
    const nearest=new Map();
    for(let j=0;j<n;j++){
      const score=scores[anchor*n+j];
      if(!(score>=threshold))continue;
      const previous=nearest.get(nodes[j].postId);
      if(!previous||score>previous.score||(score===previous.score&&nodes[j].kind==='sentence'))nearest.set(nodes[j].postId,{index:j,score});
    }
    const ordered=[...nearest.values()].sort((a,b)=>b.score-a.score||a.index-b.index);
    const members=[anchor];
    for(const candidate of ordered){
      // A similarity chain is insufficient: every admitted representative must match every other one.
      if(members.every(other=>scores[candidate.index*n+other]>=threshold))members.push(candidate.index);
    }
    const memberIds=new Set(members.map(i=>posts.get(nodes[i].postId).memberId));
    if(members.length<minPosts||memberIds.size<minMembers)continue;
    let representative=anchor,best=-Infinity,minimum=1,total=0,pairs=0;
    for(const i of members){
      let sum=0;
      for(const j of members)if(i!==j){const value=scores[i*n+j];sum+=value;if(i<j){minimum=Math.min(minimum,value);total+=value;pairs++;}}
      if(sum>best||(sum===best&&nodes[i].kind==='sentence'&&nodes[representative].kind!=='sentence')){best=sum;representative=i;}
    }
    const unique=members.map(i=>nodes[i].postId).sort();
    candidates.push({members,representative,minimum,mean:total/pairs,key:unique.join(','),memberIds:[...memberIds].sort()});
  }
  // Keep distinct subjects within the same posts. Suppress only overlapping groups with similar representatives.
  candidates.sort((a,b)=>b.members.length-a.members.length||b.minimum-a.minimum||a.representative-b.representative);
  const groups=[];
  for(const candidate of candidates){
    const ids=new Set(candidate.members.map(i=>nodes[i].postId));
    const duplicate=groups.some(group=>{
      const shared=group.members.filter(i=>ids.has(nodes[i].postId)).length;
      const overlap=shared/Math.min(group.members.length,candidate.members.length);
      if(overlap<0.8)return false;
      const a=candidate.representative,b=group.representative;
      if(a===b)return true;
      if(nodes[a].postId===nodes[b].postId){
        let dot=0;for(let d=0;d<384;d++)dot+=vectors[a*384+d]*vectors[b*384+d];return dot>=threshold;
      }
      return scores[a*n+b]>=threshold;
    });
    if(!duplicate)groups.push(candidate);
  }
  const until=Date.parse(snapshot.window.until),recentStart=until-1800000,previousStart=recentStart-1800000;
  const previousComplete=Date.parse(snapshot.window.since)<=previousStart&&snapshot.coverage?.complete!==false;
  const result=groups.map(group=>{
    const representative=nodes[group.representative],source=posts.get(representative.postId);
    const included=group.members.map(i=>posts.get(nodes[i].postId));
    const recent=included.filter(p=>Date.parse(p.createdAt)>=recentStart),previous=included.filter(p=>Date.parse(p.createdAt)>=previousStart&&Date.parse(p.createdAt)<recentStart);
    const dates=included.map(p=>p.createdAt).sort();
    const references=group.members.map(i=>({postId:nodes[i].postId,sourceHash:posts.get(nodes[i].postId).sourceHash,
      start:nodes[i].start,end:nodes[i].end,kind:nodes[i].kind})).sort((a,b)=>a.postId.localeCompare(b.postId));
    const id=createHash('sha256').update(JSON.stringify({version:SUBJECT_GROUP_VERSION,model:snapshot.modelFingerprint,references})).digest('hex');
    const title=source.text.slice(representative.start,representative.end);
    const topics=new Map();
    for(const post of included)for(const label of post.labels){
      const key=JSON.stringify([label.topic,label.subtopic??null]);
      if(!topics.has(key))topics.set(key,{topic:label.topic,subtopic:label.subtopic??null,postIds:new Set()});
      topics.get(key).postIds.add(post.id);
    }
    return {id,status:'candidate',title:{text:title,method:'representative-source-passage',postId:source.id,start:representative.start,end:representative.end},
      posts:included.length,members:group.memberIds.length,memberIds:group.memberIds,evidence:references,
      firstObservedInSelection:dates[0],lastObservedInSelection:dates.at(-1),
      recent:{since:new Date(Math.max(recentStart,Date.parse(snapshot.window.since))).toISOString(),until:snapshot.window.until,
        posts:recent.length,members:new Set(recent.map(p=>p.memberId)).size,completeWindow:Date.parse(snapshot.window.since)<=recentStart&&snapshot.coverage?.complete!==false},
      previous:{since:new Date(previousStart).toISOString(),until:new Date(recentStart).toISOString(),
        posts:previousComplete?previous.length:null,
        members:previousComplete?new Set(previous.map(p=>p.memberId)).size:null,
        observedPosts:previous.length,
        completeWindow:previousComplete},
      sourceTopics:[...topics.values()].map(({postIds,...label})=>({...label,posts:postIds.size})),
      similarity:{minimum:group.minimum,mean:group.mean,threshold,meaning:'passage relatedness; not agreement or probability'},
      interpretation:{eventIdentity:'not-established',agreement:'not-assessed',coordination:'not-inferred',novelty:'not-established'}};
  }).sort((a,b)=>b.lastObservedInSelection.localeCompare(a.lastObservedInSelection)||a.id.localeCompare(b.id));
  return {version:SUBJECT_GROUP_VERSION,groups:result.slice(0,limit),candidateGroups:result.length,
    omittedGroups:Math.max(0,result.length-limit),comparisons,options:{threshold,minMembers,minPosts,limit},
    method:'Greedy overlapping complete-link passage candidates with one representative passage per post. Thresholds are provisional and require real-post calibration.'};
}
