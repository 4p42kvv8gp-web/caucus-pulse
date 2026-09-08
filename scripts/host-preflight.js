import {readFileSync,lstatSync,statfsSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {totalmem,availableParallelism} from 'node:os';
import {accessFromEnvironment} from '../src/access.js';
import {inspectDatabase} from '../src/archive-operations.js';
import {readRemovalJournal,removalJournalPath} from '../src/removal-journal.js';
import {embeddingModel} from '../src/embedding-models.js';

const root=fileURLToPath(new URL('../',import.meta.url)),checks=[];
const target=process.argv[2]??'local';
if(!['local','hosted'].includes(target)||process.argv.length>3){console.error('Use host-preflight.js local or hosted.');process.exit(1);}
function check(id,action){try{const detail=action();checks.push({id,ok:true,...detail});}catch(error){checks.push({id,ok:false,error:error.message});}}
const need=(condition,message)=>{if(!condition)throw new Error(message);};
const data=resolve(root,'data'),database=resolve(process.env.CAUCUS_DB_PATH??resolve(data,'pulse.sqlite'));
let databaseBytes=0;
check('node-runtime',()=>{const [major,minor]=process.versions.node.split('.').map(Number);need(major===24&&minor>=19,'Use Node 24.19.x or a later supported Node 24 minor.');return {version:process.versions.node};});
check('target-platform',()=>{if(target==='hosted')need(process.platform==='linux'&&process.arch==='x64','The prepared hosted runtime targets Linux x86_64. This check does not simulate another operating system.');return {platform:process.platform,architecture:process.arch};});
check('private-access-configuration',()=>{const access=accessFromEnvironment();if(target==='hosted')need(access?.mode==='cloudflare-access'&&process.env.NODE_ENV==='production','Hosted mode requires production settings and the complete owner access configuration.');return {mode:access?.mode??'local',networkVerificationPerformed:false};});
check('private-archive',()=>{
  const directory=lstatSync(dirname(database)),file=lstatSync(database);
  need(directory.isDirectory()&&!directory.isSymbolicLink()&&!(directory.mode&0o077),'The database directory must be a private real directory.');
  need(file.isFile()&&!file.isSymbolicLink()&&file.nlink===1&&!(file.mode&0o077),'The database must be a private regular file with one link.');
  if(target==='hosted')need(database===resolve(data,'pulse.sqlite'),'The prepared service uses data/pulse.sqlite so model, diagnostic, backup and removal paths share one managed root.');
  databaseBytes=file.size;const info=inspectDatabase(database);need(info.schema===11,'Apply and verify the current archive migration before launch.');
  need(!existsSync(resolve(dirname(database),'maintenance.lock')),'Inspect the existing maintenance operation before starting the service.');
  const journal=readRemovalJournal(removalJournalPath(database));return {schema:info.schema,integrity:info.integrity,removalJournalEntries:journal.entries.length};
});
check('disk-space',()=>{const disk=statfsSync(data),availableBytes=disk.bavail*disk.bsize;const requiredBytes=2*1024**3+2*databaseBytes;need(availableBytes>=requiredBytes,'Keep at least 2 GiB plus twice the archive size free for recovery and growth.');return {availableBytes,requiredBytes};});
check('memory-and-cpu',()=>{if(target==='hosted')need(totalmem()>=7*1024**3&&availableParallelism()>=2,'The prepared model service targets an 8 GiB host with at least two available CPU threads. Measure a smaller host before adopting it.');return {memoryBytes:totalmem(),cpuThreads:availableParallelism()};});
check('model-files-present',()=>{
  const settings=JSON.parse(readFileSync(resolve(root,'config/settings.json'))),classifier=JSON.parse(readFileSync(resolve(root,'config/local-classifier.json')));
  const embedding=embeddingModel(settings.intelligence.localEmbeddings.model),items=[...embedding.files.map(([name,size])=>[resolve(data,'models',embedding.artifactKey,name),size]),...classifier.files.map(([name,size])=>[resolve(data,'models',classifier.name+'-'+classifier.revision,name),size])];
  if(classifier.entityModel?.enabled){
    const entities=JSON.parse(readFileSync(resolve(root,'config/entity-model.json')));
    need(classifier.entityModel.profile===entities.name,'The selected entity profile does not match the pinned model.');
    items.push(...entities.files.map(([name,size])=>[resolve(data,'models',entities.name+'-'+entities.revision,name),size]));
  }
  for(const [path,size] of items){const stat=lstatSync(path);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size===size,'A selected model file is absent, unsafe or has an unexpected size.');}
  need(existsSync(resolve(data,'nli-runtime/bin/python')),'Install the pinned local classifier runtime.');
  return {files:items.length,digestAndExecutionCheck:'Run host-smoke.js with the server stopped.'};
});
console.log(JSON.stringify({kind:'read-only-host-preflight',generatedAt:new Date().toISOString(),target,checks,checksPassed:checks.every(c=>c.ok),launched:false,
  remaining:['Actual owner login and signed-out denial','Model smoke test on this host','Verified off-host backup and recovery drill','Provider credit/coverage/removal checks before collection'],
  note:'No credentials were read, no provider request was made, and no service or collection schedule was started. Passing this preflight alone does not approve live collection.'},null,2));
if(checks.some(c=>!c.ok))process.exitCode=1;
