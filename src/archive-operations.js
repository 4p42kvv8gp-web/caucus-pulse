import {DatabaseSync} from 'node:sqlite';
import {constants,copyFileSync,renameSync,unlinkSync,readdirSync,existsSync,createReadStream,readFileSync,chmodSync,statSync} from 'node:fs';
import {resolve,dirname,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {openStore} from './db.js';
import {atomic} from './sqlite.js';
import {privateDirectory,regularFile,acquirePrivateLock,writePrivateJson,readPrivateJson,syncDirectory} from './private-files.js';
import {readRemovalJournal,recordRemovals,removalJournalPath,applyRemovalJournal,validateRemovalIds} from './removal-journal.js';

const backupName=/^(?:backup-|before-|\.building-)[a-zA-Z0-9._-]+\.sqlite$/;
const tableExists=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);
const count=(db,table)=>tableExists(db,table)?db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n:0;
const inspectError=()=>new Error('Archive integrity or foreign-key verification failed.');
const fault=(db,code,at)=>db.prepare('INSERT INTO operation_faults(id,code,created_at,resolved_at) VALUES (?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET resolved_at=NULL,created_at=excluded.created_at').run(code,code,at);

function snapshotUrl(path){const url=pathToFileURL(path);url.searchParams.set('immutable','1');return url.href;}
export function inspectDatabase(path,{snapshot=false}={}) {
  regularFile(path,{privateOnly:false});const db=new DatabaseSync(snapshot?snapshotUrl(path):path,{readOnly:true});
  try{
    const version=db.prepare('SELECT version FROM schema_version').get()?.version;
    if(!Number.isSafeInteger(version)||version<1||version>11)throw new Error('Backup schema is unsupported.');
    if(db.prepare('PRAGMA quick_check').all().some(row=>Object.values(row)[0]!=='ok')||db.prepare('PRAGMA foreign_key_check').all().length)throw inspectError();
    return {schema:version,integrity:'ok',posts:count(db,'posts'),capturedPosts:count(db,'captured_posts'),topicReviews:count(db,'feedback'),incidentReviews:count(db,'incident_reviews'),cases:count(db,'incident_cases'),tombstones:count(db,'tombstones'),requests:count(db,'budget_requests'),accountedMicro:tableExists(db,'budget_requests')?db.prepare('SELECT COALESCE(SUM(accounted_micro),0) AS n FROM budget_requests').get().n:0};
  }finally{db.close();}
}
async function fileHash(path) {
  const before=regularFile(path);const hash=createHash('sha256');
  for await(const part of createReadStream(path,{flags:constants.O_RDONLY|constants.O_NOFOLLOW}))hash.update(part);
  const after=regularFile(path);if(before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new Error('Archive file changed during verification.');
  return hash.digest('hex');
}
function removeTemporary(path){for(const suffix of ['','-wal','-shm'])try{regularFile(path+suffix);unlinkSync(path+suffix);}catch(e){if(e.code!=='ENOENT')throw e;}}

export async function createDatabaseBackup(databasePath,{now=Date.now()}={}) {
  databasePath=resolve(databasePath);regularFile(databasePath);
  const root=privateDirectory(dirname(databasePath)),directory=privateDirectory(resolve(root,'backups')),release=acquirePrivateLock(root);
  const id=randomUUID(),temporary=resolve(directory,`.building-${id}.sqlite`),output=resolve(directory,`backup-${new Date(now).toISOString().replaceAll(':','-')}-${id}.sqlite`);
  let source;
  try{
    source=new DatabaseSync(databasePath,{readOnly:true});source.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL');
    source.prepare('VACUUM INTO ?').run(temporary);source.close();source=null;chmodSync(temporary,0o600);
    const journal=readRemovalJournal(removalJournalPath(databasePath));
    const copy=openStore(temporary);try{applyRemovalJournal(copy.db,journal);sealSnapshot(copy.db);}finally{copy.close();}
    const metadata={version:1,id,createdAt:new Date(now).toISOString(),database:basename(output),...inspectDatabase(temporary),bytes:statSync(temporary).size,sha256:await fileHash(temporary),removalDigest:journal.digest,kind:'consistent-sqlite-snapshot',containsCredentials:false};
    renameSync(temporary,output);syncDirectory(directory);writePrivateJson(output+'.manifest.json',metadata);
    return {path:output,manifestPath:output+'.manifest.json',...metadata};
  }catch(error){if(source)source.close();removeTemporary(temporary);throw error;}
  finally{release();}
}

export async function verifyDatabaseBackup(path) {
  path=resolve(path);regularFile(path);
  // Backups are closed snapshots. An attached WAL means another process or an incomplete copy needs inspection.
  if(existsSync(path+'-wal')&&statSync(path+'-wal').size)throw new Error('Backup has an attached write-ahead log; close or inspect it before restoration.');
  const manifest=readPrivateJson(path+'.manifest.json'),sha256=await fileHash(path),info=inspectDatabase(path,{snapshot:true});
  if(manifest&&(manifest.version!==1||manifest.sha256!==sha256||manifest.bytes!==statSync(path).size||manifest.database!==basename(path)))throw new Error('Backup does not match its integrity manifest.');
  return {path,sha256,bytes:statSync(path).size,manifestVerified:!!manifest,...info};
}

function mergeSafetyState(target,current) {
  if(count(current,'budget_requests')>100000||count(current,'budget_resources')>2000000)throw new Error('Safety-ledger reconciliation exceeds the configured recovery bound.');
  const columns=['id','kind','purpose','max_resources','unit_micro','reserved_micro','accounted_micro','status','started_at','settled_at','billing_day','settlement_day'];
  const put=target.prepare(`INSERT INTO budget_requests(${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${columns.slice(1).map(c=>`${c}=excluded.${c}`).join(',')}`);
  for(const row of current.prepare('SELECT * FROM budget_requests ORDER BY sequence').iterate()){
    const prior=target.prepare('SELECT * FROM budget_requests WHERE id=?').get(row.id);
    if(prior){
      if(['kind','purpose','max_resources','unit_micro','started_at','billing_day'].some(k=>prior[k]!==row[k]))throw new Error('The backup and current spending ledger disagree about a request identity.');
      row.reserved_micro=Math.max(row.reserved_micro,prior.reserved_micro);row.accounted_micro=Math.max(row.accounted_micro,prior.accounted_micro);
      if(row.status!=='settled'||prior.status!=='settled')row.status='uncertain';
      if((prior.settled_at??'')>(row.settled_at??'')){row.settled_at=prior.settled_at;row.settlement_day=prior.settlement_day;}
    }
    put.run(...columns.map(c=>row[c]));
  }
  for(const row of current.prepare('SELECT * FROM budget_resources').iterate())target.prepare('INSERT OR IGNORE INTO budget_resources(request_id,kind,resource_id,billing_day) VALUES (?,?,?,?)').run(row.request_id,row.kind,row.resource_id,row.billing_day);
  for(const row of current.prepare('SELECT * FROM tombstones').iterate()){
    target.prepare('INSERT OR IGNORE INTO tombstones(post_id,deleted_at) VALUES (?,?)').run(row.post_id,row.deleted_at);
    target.prepare('DELETE FROM posts WHERE id=?').run(row.post_id);target.prepare('DELETE FROM captured_posts WHERE id=?').run(row.post_id);
  }
  for(const row of current.prepare('SELECT * FROM operation_faults WHERE resolved_at IS NULL').iterate())fault(target,row.code,row.created_at);
  target.exec('DELETE FROM balance_observations; DELETE FROM collection_leases; DELETE FROM list_inventory_leases;');
  fault(target,'restore-reconciliation-required',new Date().toISOString());
}

export async function stageDatabaseRestore(backupPath,{currentPath,outputPath}={}) {
  if(!currentPath||!outputPath)throw new Error('A current archive and a new output path are required for a staged restore.');
  backupPath=resolve(backupPath);currentPath=resolve(currentPath);outputPath=resolve(outputPath);
  regularFile(currentPath);privateDirectory(dirname(outputPath));
  if(outputPath===currentPath||outputPath===backupPath||existsSync(outputPath)||existsSync(outputPath+'.manifest.json'))throw new Error('Restore output must be a new file; an existing archive is never overwritten.');
  const root=privateDirectory(dirname(currentPath));
  if(dirname(outputPath)!==resolve(root,'restores')||!/^restore-[a-zA-Z0-9._-]+\.sqlite$/.test(basename(outputPath)))throw new Error('Stage recovery into a restore-*.sqlite file inside the archive’s private restores directory.');
  const release=acquirePrivateLock(root),temporary=resolve(dirname(outputPath),`.restore-build-${randomUUID()}.sqlite`);
  let store,current;
  try{
    const backup=await verifyDatabaseBackup(backupPath);
    current=new DatabaseSync(currentPath,{readOnly:true});current.exec('PRAGMA busy_timeout=5000; BEGIN');
    if(current.prepare('SELECT version FROM schema_version').get().version!==11)throw new Error('Current archive must use the current schema before reconciliation.');
    copyFileSync(backupPath,temporary,constants.COPYFILE_EXCL);chmodSync(temporary,0o600);
    if(await fileHash(temporary)!==backup.sha256)throw new Error('Backup changed while staging the restore.');
    store=openStore(temporary);
    const journal=readRemovalJournal(removalJournalPath(currentPath));
    atomic(store.db,()=>{mergeSafetyState(store.db,current);applyRemovalJournal(store.db,journal);});
    current.exec('COMMIT');current.close();current=null;
    sealSnapshot(store.db);store.close();store=null;
    const info=inspectDatabase(temporary),sha256=await fileHash(temporary);
    const manifest={version:1,kind:'staged-restore-requires-reconciliation',createdAt:new Date().toISOString(),database:basename(outputPath),sourceBackupSha256:backup.sha256,sourceManifestVerified:backup.manifestVerified,removalDigest:journal.digest,sha256,bytes:statSync(temporary).size,...info,collectionBlocked:true,activated:false};
    renameSync(temporary,outputPath);syncDirectory(dirname(outputPath));writePrivateJson(outputPath+'.manifest.json',manifest);
    return {path:outputPath,...manifest};
  }catch(error){if(current)current.close();if(store)store.close();removeTemporary(temporary);throw error;}
  finally{release();}
}

export function compactDatabase(db) {
  if(db.isTransaction)throw new Error('Compaction must run outside a database transaction.');
  db.exec('PRAGMA secure_delete=ON');
  if(tableExists(db,'post_search_fts'))db.exec("INSERT INTO post_search_fts(post_search_fts) VALUES ('rebuild')");
  db.exec('VACUUM');
  if(tableExists(db,'post_search_fts'))db.exec("INSERT INTO post_search_fts(post_search_fts,rank) VALUES ('integrity-check',1)");
  const checkpoint=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  if(checkpoint.busy)throw new Error('A reader still holds the write-ahead log. Close active readers and retry compaction.');
  if(db.prepare('PRAGMA quick_check').all().some(row=>Object.values(row)[0]!=='ok')||db.prepare('PRAGMA foreign_key_check').all().length)throw inspectError();
  return {integrity:'ok',walCheckpoint:'truncated'};
}

function sealSnapshot(db){
  compactDatabase(db);
  // Closed backups use rollback journaling, so a read-only verifier needs no WAL/SHM files.
  if(db.prepare('PRAGMA journal_mode=DELETE').get().journal_mode!=='delete')throw new Error('Could not seal the snapshot as a self-contained database.');
}

function backupContains(path,ids) {
  // A managed snapshot is only removable after its attached writer has closed.
  // Leaving an active WAL behind could otherwise retain removed source text.
  for(const suffix of ['-wal','-shm'])if(existsSync(path+suffix)){
    regularFile(path+suffix);if(statSync(path+suffix).size)throw new Error('Snapshot has an active SQLite sidecar; close it before cleanup.');
  }
  const db=new DatabaseSync(snapshotUrl(path),{readOnly:true});
  try{
    for(const table of ['posts','captured_posts'])if(tableExists(db,table)){
      if(count(db,table)>1000000)throw new Error('Backup cleanup scan exceeds its configured bound.');
      for(const row of db.prepare(`SELECT id FROM ${table}`).iterate())if(ids.has(row.id))return true;
    }
    return false;
  }finally{db.close();}
}
function matchingArtifacts(root,ids) {
  const result={backups:[],restores:[],reports:[],uninspectable:[]};
  for(const folder of ['backups','restores']){const directory=resolve(root,folder);
  if(existsSync(directory)){
    privateDirectory(directory);
    const files=readdirSync(directory);if(files.length>2000)throw new Error('Backup inventory exceeds its configured bound.');
    for(const name of files.filter(name=>folder==='backups'?backupName.test(name):/^(?:restore-|\.restore-build-)[a-zA-Z0-9._-]+\.sqlite$/.test(name))){const path=resolve(directory,name);
      try{regularFile(path);const contains=backupContains(path,ids);if(name.startsWith('.building-')||name.startsWith('.restore-build-')||contains)result[folder].push(path);}catch{result.uninspectable.push(path);}
    }
  }
  }
  for(const directoryName of ['reports','operations']){
    const directory=resolve(root,directoryName);if(!existsSync(directory))continue;privateDirectory(directory);
    const files=readdirSync(directory);if(files.length>5000)throw new Error('Diagnostic inventory exceeds its configured bound.');
    for(const name of files.filter(name=>/^[a-zA-Z0-9._-]+\.json$/.test(name))){const path=resolve(directory,name);
      try{regularFile(path,{maxBytes:20000000});const source=readFileSync(path,'utf8');const found=[...source.matchAll(/"(?:postId|post_id|id)"\s*:\s*"(\d{1,30})"/g)].some(m=>ids.has(m[1]));if(found)result.reports.push(path);}
      catch{result.uninspectable.push(path);}
    }
  }
  return result;
}

export function previewSourceRemoval(databasePath,ids) {
  validateRemovalIds(ids);databasePath=resolve(databasePath);regularFile(databasePath);const db=new DatabaseSync(databasePath,{readOnly:true});
  try{
    let posts=0,captures=0,reviews=0;
    for(const id of ids){posts+=db.prepare('SELECT COUNT(*) AS n FROM posts WHERE id=?').get(id).n;captures+=db.prepare('SELECT COUNT(*) AS n FROM captured_posts WHERE id=?').get(id).n;reviews+=db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE post_id=?').get(id).n;}
    return {postIds:ids,posts,captures,topicReviews:reviews,...matchingArtifacts(dirname(databasePath),new Set(ids)),executed:false};
  }finally{db.close();}
}

export function removeSources(databasePath,ids) {
  validateRemovalIds(ids);databasePath=resolve(databasePath);regularFile(databasePath);
  const root=privateDirectory(dirname(databasePath)),release=acquirePrivateLock(root);let store;
  try{
    const journal=recordRemovals(removalJournalPath(databasePath),ids,{alreadyLocked:true});
    store=openStore(databasePath);
    atomic(store.db,()=>{applyRemovalJournal(store.db,journal);fault(store.db,'removal-cleanup-pending',new Date().toISOString());});
    const artifacts=matchingArtifacts(root,new Set(journal.entries.map(e=>e.postId))),removed=[];
    for(const path of [...artifacts.backups,...artifacts.restores,...artifacts.reports]){
      regularFile(path);unlinkSync(path);removed.push(path);
      if(path.endsWith('.sqlite'))for(const suffix of ['-wal','-shm'])if(existsSync(path+suffix)){regularFile(path+suffix);if(statSync(path+suffix).size)throw new Error('Snapshot changed during cleanup; inspect the remaining sidecar.');unlinkSync(path+suffix);}
      const manifest=path+'.manifest.json';if(existsSync(manifest)){regularFile(manifest);unlinkSync(manifest);}
      syncDirectory(dirname(path));
    }
    const compaction=compactDatabase(store.db);
    if(!artifacts.uninspectable.length)store.db.prepare("UPDATE operation_faults SET resolved_at=? WHERE id='removal-cleanup-pending'").run(new Date().toISOString());
    return {postIds:ids,executed:true,complete:!artifacts.uninspectable.length,removedArtifacts:removed,uninspectable:artifacts.uninspectable,removalJournalEntries:journal.entries.length,...compaction,
      note:'Current archive rows, derived indexes, known backup snapshots and matching diagnostic JSON are covered. External exports, original import files, filesystem snapshots and third-party copies need separate handling.'};
  }finally{if(store)store.close();release();}
}
