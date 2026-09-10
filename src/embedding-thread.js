import { parentPort,workerData } from 'node:worker_threads';
import { createEmbeddingRuntime } from './local-embeddings.js';

// This worker has no inherited credential environment and never enables remote model loading.
let runtime;
try {
  runtime=await createEmbeddingRuntime(workerData);
  parentPort.postMessage({ready:true});
} catch { parentPort.postMessage({ready:false}); }
let busy=false;
parentPort.on('message',async message=>{
  if (!runtime || busy || !['post','query'].includes(message.kind)) return parentPort.postMessage({id:message.id,error:'unavailable'});
  busy=true;
  try {
    const result=await (message.kind==='post'?runtime.embedPost(message.text):runtime.embedQuery(message.text));
    parentPort.postMessage({id:message.id,result});
  } catch(error) {
    const limit=/^(Source exceeds the embedding|Semantic query is too long|A semantic query must contain)/.test(error.message);
    parentPort.postMessage({id:message.id,error:limit?'input-limit':'failed'});
  } finally { busy=false; }
});
