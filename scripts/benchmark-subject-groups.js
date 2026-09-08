import { mkdir,writeFile } from 'node:fs/promises';
import { openStore } from '../src/db.js';
import { normalizePost } from '../src/normalize.js';
import { createEmbeddingClient } from '../src/embedding-client.js';
import { processEmbeddingJobs } from '../src/embedding-store.js';
import { prepareSubjectSnapshot } from '../src/subject-groups.js';
import { groupSubjectPassages } from '../src/subject-groups-core.js';

const examples=[
  ['flood','Floodwaters have closed the bridge in River County. Emergency shelter is available at the high school.'],
  ['flood','The River County bridge is shut because of rising water. Families can shelter at the local high school.'],
  ['flood','River County residents: avoid the flooded bridge and use the high school shelter if you need a safe place.'],
  ['wildfire','Wildfire evacuation orders are in effect for Pine Valley. Fire crews ask residents to leave now.'],
  ['wildfire','Pine Valley residents should evacuate immediately as firefighters work to contain the wildfire.'],
  ['wildfire','Leave Pine Valley now. The spreading wildfire has prompted a mandatory evacuation order.'],
  ['detention','Families at the Willow immigration detention center need access to lawyers and medical care.'],
  ['detention','Immigration detainees at the Willow facility must be able to consult attorneys and receive health care.'],
  ['detention','The Willow detention center is holding immigrant families without adequate legal or medical services.'],
  ['fed','The Federal Reserve must remain independent of political pressure when setting interest rates.'],
  ['fed','Central bankers should make monetary policy decisions without interference from elected officials.'],
  ['fed','The Federal Reserve should not remain independent of political pressure when setting interest rates.'],
  ['shooting','Police report a shooting at the Oak shopping center. Avoid the mall while emergency responders work.'],
  ['shooting','Reports of a gunman at Oak mall prompted a police response. Stay away from the shopping center.'],
  ['shooting','Officials said there was a shooting at Oak mall. Police now confirm that report was false.'],
  ['sports','Congratulations to the local basketball team on winning the regional championship.'],
  ['office','Our office will offer regular walk-in constituent assistance this Thursday afternoon.']
];
const name=process.argv[2]??'minilm',now=Date.now(),store=openStore();let runtime;
try{
  for(let i=0;i<4;i++)store.upsertAccount({authorId:String(i+1),memberId:`synthetic-${i+1}`,memberName:`Synthetic Member ${i+1}`,handle:`Synthetic${i+1}`});
  const tags=new Map();
  for(const [i,[subject,text]] of examples.entries()){
    const id=String(1000+i);tags.set(id,subject);
    store.ingest(normalizePost({id,author_id:String(i%4+1),created_at:new Date(now-(i+1)*60000).toISOString(),text},{kind:'synthetic-benchmark'}));
  }
  runtime=await createEmbeddingClient({name});await processEmbeddingJobs(store,runtime);
  const snapshot=prepareSubjectSnapshot(store,{}, {now,name});
  const reports=[];
  for(const threshold of [0.55,0.62,0.68,0.75]){
    const started=performance.now(),result=groupSubjectPassages(snapshot,{threshold});
    reports.push({threshold,milliseconds:performance.now()-started,comparisons:result.comparisons,groups:result.groups.map(g=>({posts:g.posts,members:g.members,
      syntheticSubjects:[...new Set(g.evidence.map(e=>tags.get(e.postId)))],postIds:g.evidence.map(e=>e.postId),minimumCosine:g.similarity.minimum}))});
  }
  await mkdir('data/reports',{recursive:true,mode:0o700});
  const path=`data/reports/subject-group-benchmark-${now}.json`;
  const report={createdAt:new Date(now).toISOString(),model:runtime.model,fixture:'synthetic-subject-groups-v1',coverage:snapshot.coverage,reports,
    limitations:['Synthetic engineering exploration; not held-out human labels or proof of clustering accuracy.',
      'Opposite positions and corrected incident reports can share a subject. Groups do not establish agreement or factual truth.',
      'Thresholds are provisional; this small fixture does not validate a universal threshold.']};
  await writeFile(path,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({path,model:name,coverage:snapshot.coverage,reports:reports.map(r=>({...r,groups:r.groups.map(g=>({posts:g.posts,subjects:g.syntheticSubjects,minimumCosine:g.minimumCosine}))}))},null,2));
}finally{await runtime?.close();store.close();}
