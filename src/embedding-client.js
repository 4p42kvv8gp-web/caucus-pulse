import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { embeddingModel } from './embedding-models.js';

function failure(message='Local semantic search is unavailable.',code='SEMANTIC_UNAVAILABLE') { return Object.assign(new Error(message),{code}); }
export async function createEmbeddingClient({name='minilm',modelRoot=resolve('data/models'),timeoutMs=60000}={}) {
  const model=embeddingModel(name);
  if (!Number.isInteger(timeoutMs) || timeoutMs<1000 || timeoutMs>120000) throw new Error('Invalid embedding timeout.');
  const worker=new Worker(new URL('./embedding-thread.js',import.meta.url),{
    workerData:{name,modelRoot},env:{},execArgv:[],resourceLimits:{maxOldGenerationSizeMb:384},stdout:true,stderr:true
  });
  // Runtime diagnostics must not expose source text, paths or a provider payload to the UI/log.
  worker.stdout.resume();worker.stderr.resume();
  let closed=false,sequence=0,active=null;
  const queue=[];
  let readyResolve,readyReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  let startup=setTimeout(()=>stop(failure('Local semantic runtime did not start in time.')),timeoutMs);
  async function stop(error=failure()) {
    if (closed) return;
    closed=true; clearTimeout(startup); readyReject(error);
    if (active) {clearTimeout(active.timer);active.reject(error);active=null;}
    for(const pending of queue.splice(0)) pending.reject(error);
    await worker.terminate();
  }
  function next() {
    if(closed || active || !queue.length) return;
    active=queue.shift();
    active.timer=setTimeout(()=>stop(failure('Local semantic operation exceeded its time limit.')),timeoutMs);
    worker.postMessage({id:active.id,kind:active.kind,text:active.text});
  }
  worker.on('message',message=>{
    if(Object.hasOwn(message,'ready')) {
      clearTimeout(startup);
      if(message.ready) readyResolve();else stop(failure('Local embedding model is missing or could not be verified.'));
      return;
    }
    if(!active || message.id!==active.id) return;
    const current=active;active=null;clearTimeout(current.timer);
    if(message.error) current.reject(message.error==='input-limit'?failure(
      current.kind==='query'?'Invalid semantic query: it exceeds the model length limit.':'Source exceeds the embedding passage limit.',
      'SEMANTIC_INPUT_LIMIT'):failure());
    else current.resolve(message.result);
    next();
  });
  worker.on('error',()=>stop(failure()));
  worker.on('exit',()=>{if(!closed)stop(failure());});
  await ready;
  function request(kind,text) {
    if(closed)return Promise.reject(failure());
    if(typeof text!=='string' || !text.trim() || text.length>(kind==='query'?2000:model.maxCharacters))
      return Promise.reject(failure('Invalid semantic input length.','SEMANTIC_INPUT_LIMIT'));
    if(queue.length>=8)return Promise.reject(failure('Semantic search is busy; try again shortly.','SEMANTIC_BUSY'));
    return new Promise((resolve,reject)=>{queue.push({id:++sequence,kind,text,resolve,reject});next();});
  }
  return {model,embedPost:text=>request('post',text),embedQuery:text=>request('query',text),
    status:()=>({ready:!closed,busy:Boolean(active),queued:queue.length}),close:()=>stop(failure('Local semantic runtime closed.'))};
}
