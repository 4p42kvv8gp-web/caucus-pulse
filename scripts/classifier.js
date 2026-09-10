import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/db.js';
import { createLocalClassifierClient } from '../src/classifier-client.js';
import { classificationStatus, processClassificationJobs, queueClassification } from '../src/classifier-jobs.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const [command='status',value]=process.argv.slice(2);
if(!['status','run','queue'].includes(command))throw new Error('Choose classifier status, run [1–25], or queue POST_ID.');
process.umask(0o077);
const store=openStore(process.env.CAUCUS_DB_PATH??resolve(root,'data/pulse.sqlite'));
let runtime;
try{
  if(command==='run'){
    const limit=Number(value??5);if(!Number.isInteger(limit)||limit<1||limit>25)throw new Error('Invalid local classification pass limit.');
    runtime=await createLocalClassifierClient();
    console.log(JSON.stringify({pass:await processClassificationJobs(store,runtime,{limit}),status:classificationStatus(store)}));
  }else if(command==='queue'){
    if(!/^\d{1,25}$/.test(value??''))throw new Error('Invalid post ID.');
    const post=store.getPost(value);if(!post)throw new Error('Post not found.');
    console.log(JSON.stringify(queueClassification(store,value,post.contentHash)));
  }else console.log(JSON.stringify(classificationStatus(store),null,2));
}catch(error){
  console.error(JSON.stringify({status:'not-completed',code:/^CLASSIFIER_[A-Z_]+$/.test(error.code??'')?error.code:'LOCAL_CLASSIFIER_ERROR',note:'Source posts and prior analysis are retained.'}));process.exitCode=1;
}finally{await runtime?.close();store.close();}
