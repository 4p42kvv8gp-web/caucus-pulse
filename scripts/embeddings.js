import { openStore } from '../src/db.js';
import { createEmbeddingClient } from '../src/embedding-client.js';
import { embeddingStatus,processEmbeddingJobs } from '../src/embedding-store.js';
import { semanticSearch } from '../src/semantic-search.js';
import { readFileSync } from 'node:fs';

const [action='status',...args]=process.argv.slice(2);
const name=JSON.parse(readFileSync(new URL('../config/settings.json',import.meta.url),'utf8')).intelligence?.localEmbeddings?.model??'minilm';
if(!['status','index','search'].includes(action))throw new Error('Choose embeddings status, index, or search.');
const store=openStore(process.env.CAUCUS_DB_PATH??'data/pulse.sqlite');
let runtime;
try{
  if(action==='status')console.log(JSON.stringify(embeddingStatus(store,name),null,2));
  else{
    runtime=await createEmbeddingClient({name});
    if(action==='index'){
      const limit=args[0]===undefined?25:Number(args[0]);
      console.log(JSON.stringify({processed:await processEmbeddingJobs(store,runtime,{limit}),status:embeddingStatus(store,name)},null,2));
    }else{
      const query=await runtime.embedQuery(args.join(' '));
      const found=semanticSearch(store,query,{name});
      // The CLI prints IDs and counts; complete source evidence is available in the private API.
      console.log(JSON.stringify({...found,results:found.results.map(r=>({postId:r.post.id,similarity:r.similarity,
        evidenceSpans:r.evidence.map(({start,end,kind})=>({start,end,kind}))}))},null,2));
    }
  }
}finally{await runtime?.close();store.close();}
