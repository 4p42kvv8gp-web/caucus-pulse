import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {totalmem,availableParallelism,release} from 'node:os';
import {createEmbeddingClient} from '../src/embedding-client.js';
import {createLocalClassifierClient} from '../src/classifier-client.js';
import {writePrivateJson} from '../src/private-files.js';

process.umask(0o077);
if(process.argv.length!==2){console.error('Use host-smoke.js without arguments, with the model server stopped.');process.exit(1);}
const root=fileURLToPath(new URL('../',import.meta.url));
const settings=JSON.parse(readFileSync(resolve(root,'config/settings.json')));
const report={kind:'synthetic-host-execution-check',generatedAt:new Date().toISOString(),platform:process.platform,architecture:process.arch,
  kernel:release(),node:process.versions.node,memoryBytes:totalmem(),cpuThreads:availableParallelism(),checks:[],networkRequests:0,realArchiveOpened:false,humanAccuracyMeasured:false};
let embedding,classifier;
try{
  const started=performance.now();
  embedding=await createEmbeddingClient({name:settings.intelligence.localEmbeddings.model,modelRoot:resolve(root,'data/models')});
  const text='Synthetic exercise: residents affected by flooding can seek help from the emergency shelter.';
  const post=await embedding.embedPost(text),query=await embedding.embedQuery('flood shelter assistance');
  if(post.coveredCharacters!==text.length||!post.passages.length||query.vector.length!==384||!Array.from(query.vector).every(Number.isFinite))throw Object.assign(new Error('Embedding smoke check failed.'),{code:'EMBEDDING_SMOKE_FAILED'});
  report.checks.push({id:'local-embeddings',ok:true,modelFingerprint:post.modelFingerprint,sourceCharacters:text.length,coveredCharacters:post.coveredCharacters,passages:post.passages.length,elapsedMs:Math.round(performance.now()-started)});
  classifier=await createLocalClassifierClient();
  for(const [id,source,noLabels] of [['physical-emergency','Synthetic exercise: Cal Fire says a wildfire near Pine Creek has forced residents to evacuate. Follow official alerts.',false],['missing-context','This is unacceptable. https://example.invalid/story',true]]){
    const output=await classifier.classify({input:{postId:id,sourceHash:createHash('sha256').update(source).digest('hex'),text:source,createdAt:'2026-09-01T00:00:00Z',postType:'original',references:[],contextCoverage:'Synthetic source; no linked content or media.',memberDistrict:null,reviewedExamples:[]}});
    if(noLabels&&(output.result.labels.length||output.result.events.length))throw Object.assign(new Error('Missing-context guard failed.'),{code:'CONTEXT_SMOKE_FAILED'});
    const entityProfile=JSON.parse(readFileSync(resolve(root,'config/local-classifier.json'))).entityModel;
    if(entityProfile?.enabled&&output.metrics.entityExtraction?.coveredCharacters!==source.length)throw Object.assign(new Error('Entity source coverage check failed.'),{code:'ENTITY_COVERAGE_FAILED'});
    if(entityProfile?.enabled&&id==='physical-emergency'&&!['Cal Fire','Pine Creek'].every(name=>output.result.entities.some(entity=>entity.name===name)))throw Object.assign(new Error('Entity fixture check failed.'),{code:'ENTITY_SMOKE_FAILED'});
    report.checks.push({id,ok:true,sourceValidated:true,labels:output.result.labels.map(l=>l.topic),entityMentions:output.result.entities.map(e=>e.name),eventCandidates:output.result.events.length,metrics:output.metrics});
  }
  report.classifierFingerprint=classifier.fingerprint;
}catch(error){report.checks.push({id:'runtime-execution',ok:false,code:/^[A-Z_]{3,60}$/.test(error.code??'')?error.code:'HOST_SMOKE_FAILED'});}
finally{await classifier?.close();await embedding?.close();}
report.checksPassed=report.checks.length===3&&report.checks.every(c=>c.ok);
const path=resolve(root,`data/reports/host-smoke-${process.platform}-${process.arch}-${Date.now()}.json`);
writePrivateJson(path,report);console.log(JSON.stringify({...report,report:path},null,2));
if(!report.checksPassed)process.exitCode=1;
