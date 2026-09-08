import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync,statSync,existsSync,symlinkSync,linkSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openStore} from '../src/db.js';
import {normalizePost} from '../src/normalize.js';
import {createBudget} from '../src/budget.js';
import {explorerPage} from '../src/explorer.js';
import {createDatabaseBackup,verifyDatabaseBackup,stageDatabaseRestore,removeSources,previewSourceRemoval,compactDatabase,inspectDatabase} from '../src/archive-operations.js';
import {recordRemovals,readRemovalJournal,removalJournalPath} from '../src/removal-journal.js';
import {acquirePrivateLock} from '../src/private-files.js';

function setup(){const root=mkdtempSync(join(tmpdir(),'pulse-operations-')),path=join(root,'pulse.sqlite'),store=openStore(path);store.upsertAccount({authorId:'1',memberId:'synthetic',memberName:'Synthetic Member',handle:'Synthetic'});return {root,path,store,close(){store.close();rmSync(root,{recursive:true,force:true});}};}
function add(store,id,text=`Synthetic source ${id} includes a distinct subject.`){store.ingest(normalizePost({id:String(id),author_id:'1',created_at:'2026-09-08T00:00:00Z',text}));store.analyzePending();}
const policy={dailyCeilingUsd:25,pilotCeilingUsd:350,reserveUsd:50,resourcePricesUsd:{post:.005,user:.01}};
function budget(store){const now=Date.now(),b=createBudget(store.db,policy,{clock:()=>now});b.recordBalance({prepaidUsd:400,readStartedAt:new Date(now).toISOString()});return b;}

test('a live-WAL backup is consistent, private, verified and independent of credentials',async()=>{
  const f=setup();try{
    add(f.store,1);add(f.store,2);f.store.saveFeedback('1',{labels:[],reason:'Synthetic review.'});
    mkdirSync(join(f.root,'secrets'),{mode:0o700});writeFileSync(join(f.root,'secrets','test-secret'),'synthetic-not-a-real-credential',{mode:0o600});
    const backup=await createDatabaseBackup(f.path);assert.equal(backup.posts,2);assert.equal(backup.topicReviews,1);assert.equal(backup.schema,10);
    assert.equal(statSync(backup.path).mode&0o077,0);assert.equal((await verifyDatabaseBackup(backup.path)).manifestVerified,true);
    assert.equal(readFileSync(backup.path).includes(Buffer.from('synthetic-not-a-real-credential')),false);
    add(f.store,3);assert.equal(inspectDatabase(backup.path).posts,2);assert.equal(f.store.getPost('3').id,'3');
  }finally{f.close();}
});

test('staging an older backup preserves removals and higher spending while blocking activation and paid reads',async()=>{
  const f=setup();try{
    add(f.store,1);add(f.store,2);const b=budget(f.store),request=b.reserveRequest({kind:'post',maxResources:5,purpose:'new-posts'});
    const backup=await createDatabaseBackup(f.path);b.settle(request.id,['1']);
    const later=b.reserveRequest({kind:'post',maxResources:2,purpose:'new-posts'});b.settle(later.id,['2','3']);add(f.store,3);
    recordRemovals(removalJournalPath(f.path),['1']);f.store.removePost('1');
    const outputPath=join(f.root,'restores','restore-synthetic.sqlite');
    const restored=await stageDatabaseRestore(backup.path,{currentPath:f.path,outputPath});
    assert.equal(restored.activated,false);assert.equal(restored.collectionBlocked,true);assert.equal(restored.posts,1);assert.equal(restored.accountedMicro,35000);
    const candidate=openStore(outputPath);try{
      assert.equal(candidate.getPost('1'),null);assert.equal(candidate.getPost('2').id,'2');assert.equal(candidate.getPost('3'),null);
      assert.equal(candidate.db.prepare('SELECT COUNT(*) AS n FROM balance_observations').get().n,0);
      const stagedBudget=budget(candidate);assert.throws(()=>stagedBudget.reserveRequest({kind:'post',maxResources:1,purpose:'new-posts'}),e=>e.code==='billing-review-required');
    }finally{candidate.close();}
    assert.equal(f.store.getPost('3').id,'3','The active archive was not replaced or rolled back');
  }finally{f.close();}
});

test('source removal previews first, purges known snapshots and reports, compacts and prevents replay',async()=>{
  const f=setup();try{
    const wording='Synthetic removable phrase uniquely qzptorvolx.';add(f.store,1,wording);add(f.store,2);
    const backup=await createDatabaseBackup(f.path),restore=await stageDatabaseRestore(backup.path,{currentPath:f.path,outputPath:join(f.root,'restores','restore-before-removal.sqlite')});
    mkdirSync(join(f.root,'reports'),{mode:0o700});const report=join(f.root,'reports','source-test.json'),other=join(f.root,'reports','unrelated.json');
    writeFileSync(report,JSON.stringify({postId:'1',text:wording}),{mode:0o600});writeFileSync(other,JSON.stringify({postId:'2',text:'Other source'}),{mode:0o600});
    const preview=previewSourceRemoval(f.path,['1']);assert.equal(preview.executed,false);assert.equal(preview.posts,1);assert.equal(preview.backups.length,1);assert.equal(preview.restores.length,1);assert.ok(f.store.getPost('1'));
    const removed=removeSources(f.path,['1']);assert.equal(removed.complete,true);assert.equal(f.store.getPost('1'),null);
    assert.equal(existsSync(backup.path),false);assert.equal(existsSync(restore.path),false);assert.equal(existsSync(report),false);assert.equal(existsSync(other),true);
    assert.equal(readFileSync(f.path).includes(Buffer.from(wording)),false);
    assert.equal(f.store.ingest(normalizePost({id:'1',author_id:'1',created_at:'2026-09-08T00:00:00Z',text:wording})).removed,true);
    assert.equal(explorerPage(f.store,{query:'qzptorvolx'}).page.totalPosts,0);assert.equal(explorerPage(f.store,{query:'distinct subject'}).page.totalPosts,1);
  }finally{f.close();}
});

test('a journal committed before interrupted deletion is replayed before an archive can be served',()=>{
  const root=mkdtempSync(join(tmpdir(),'pulse-journal-')),path=join(root,'pulse.sqlite');let store=openStore(path);
  try{
    store.upsertAccount({authorId:'1',memberId:'test',memberName:'Synthetic',handle:'Synthetic'});add(store,1);
    recordRemovals(removalJournalPath(path),['1']);store.close();store=openStore(path);
    assert.equal(store.getPost('1'),null);assert.equal(store.db.prepare("SELECT resolved_at FROM operation_faults WHERE id='removal-cleanup-pending'").get().resolved_at,null);
    const bytes=readFileSync(removalJournalPath(path));assert.ok(bytes.includes(Buffer.from('"postId": "1"')));
    const altered=JSON.parse(bytes);altered.entries[0].postId='2';writeFileSync(removalJournalPath(path),JSON.stringify(altered),{mode:0o600});
    assert.throws(()=>openStore(path),/journal is invalid/);assert.equal(store.getPost('1'),null);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('removal waits for an open managed snapshot and resumes cleanup after its writer closes',async()=>{
  const f=setup();let copy;
  try{
    add(f.store,1);const backup=await createDatabaseBackup(f.path);copy=openStore(backup.path);
    copy.db.prepare("UPDATE posts SET captured_at=captured_at WHERE id='1'").run();
    const first=removeSources(f.path,['1']);assert.equal(first.complete,false);assert.ok(first.uninspectable.includes(backup.path));assert.equal(existsSync(backup.path),true);assert.equal(f.store.getPost('1'),null);
    copy.close();copy=null;const second=removeSources(f.path,['1']);assert.equal(second.complete,true);assert.equal(existsSync(backup.path),false);assert.equal(existsSync(backup.path+'-wal'),false);assert.equal(existsSync(backup.path+'-shm'),false);
  }finally{if(copy)copy.close();f.close();}
});

test('maintenance refuses overlapping operations, unsafe files and overwritten restore destinations',async()=>{
  const f=setup();try{
    add(f.store,1);const release=acquirePrivateLock(f.root);
    try{await assert.rejects(createDatabaseBackup(f.path),/lock already exists/);assert.throws(()=>recordRemovals(removalJournalPath(f.path),['1']),/lock already exists/);}finally{release();}
    const backup=await createDatabaseBackup(f.path);
    await assert.rejects(stageDatabaseRestore(backup.path,{currentPath:f.path,outputPath:f.path}),/never overwritten/);
    symlinkSync(backup.path,join(f.root,'linked.sqlite'));await assert.rejects(verifyDatabaseBackup(join(f.root,'linked.sqlite')),/unsafe/);
    linkSync(backup.path,join(f.root,'hardlinked.sqlite'));await assert.rejects(verifyDatabaseBackup(backup.path),/unsafe/);
    assert.ok(f.store.getPost('1'));
  }finally{f.close();}
});

test('an altered backup cannot pass its saved content hash',async()=>{
  const f=setup();try{add(f.store,1);const backup=await createDatabaseBackup(f.path);appendFileSync(backup.path,'synthetic alteration');await assert.rejects(verifyDatabaseBackup(backup.path),/integrity manifest/);}finally{f.close();}
});

test('stable search row IDs preserve exact search across gaps, compaction and reopened backups',async()=>{
  const f=setup();try{
    add(f.store,1,'First synthetic source.');add(f.store,2,'Second synthetic source.');add(f.store,3,'Third synthetic source.');f.store.removePost('2');
    const before=f.store.db.prepare('SELECT rowid,post_id FROM post_search ORDER BY rowid').all();compactDatabase(f.store.db);
    assert.deepEqual(f.store.db.prepare('SELECT rowid,post_id FROM post_search ORDER BY rowid').all(),before);
    const backup=await createDatabaseBackup(f.path),copy=openStore(backup.path);try{assert.equal(explorerPage(copy,{query:'Third synthetic'}).posts[0].id,'3');assert.equal(explorerPage(copy,{query:'Second synthetic'}).page.totalPosts,0);}finally{copy.close();}
  }finally{f.close();}
});

function legacySearchFixture(db){
  const triggers=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name LIKE 'explorer_%'").all();
  const indexes=db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name='post_search' AND sql IS NOT NULL").all();
  for(const trigger of triggers)db.exec(`DROP TRIGGER ${trigger.name}`);
  db.exec(`CREATE TABLE post_search_legacy (
    post_id TEXT UNIQUE NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,captured_at TEXT NOT NULL,member_id TEXT NOT NULL,member_name TEXT NOT NULL,
    account_type TEXT NOT NULL,type TEXT NOT NULL,provenance_kind TEXT NOT NULL,search_text TEXT NOT NULL,
    labels_json TEXT NOT NULL,reviewed INTEGER NOT NULL,rule_proposals INTEGER NOT NULL);
    INSERT INTO post_search_legacy(rowid,post_id,created_at,captured_at,member_id,member_name,account_type,type,provenance_kind,search_text,labels_json,reviewed,rule_proposals)
    SELECT rowid,post_id,created_at,captured_at,member_id,member_name,account_type,type,provenance_kind,search_text,labels_json,reviewed,rule_proposals FROM post_search;
    DROP TABLE post_search; ALTER TABLE post_search_legacy RENAME TO post_search; UPDATE schema_version SET version=9;`);
  for(const index of indexes)db.exec(index.sql);for(const trigger of triggers)db.exec(trigger.sql);
}

test('schema-nine migration preserves gapped search identities and rolls back completely on failure',()=>{
  const root=mkdtempSync(join(tmpdir(),'pulse-old-search-')),path=join(root,'pulse.sqlite');let store=openStore(path);
  try{
    store.upsertAccount({authorId:'1',memberId:'test',memberName:'Synthetic',handle:'Synthetic'});
    add(store,1,'First test wording.');add(store,2,'Second test wording.');add(store,3,'Third test wording.');store.removePost('2');legacySearchFixture(store.db);
    const before=store.db.prepare('SELECT rowid AS search_rowid,post_id FROM post_search ORDER BY rowid').all();
    store.db.exec("CREATE TRIGGER synthetic_migration_failure BEFORE UPDATE ON schema_version WHEN new.version=10 BEGIN SELECT RAISE(ABORT,'Synthetic migration failure'); END");
    assert.throws(()=>openStore(path),/Synthetic migration failure/);
    assert.equal(store.db.prepare('SELECT version FROM schema_version').get().version,9);
    assert.equal(store.db.prepare('PRAGMA table_info(post_search)').all().some(c=>c.name==='search_id'),false);
    assert.deepEqual(store.db.prepare('SELECT rowid AS search_rowid,post_id FROM post_search ORDER BY rowid').all(),before);
    store.db.exec('DROP TRIGGER synthetic_migration_failure');store.close();store=openStore(path);
    assert.equal(store.db.prepare('SELECT version FROM schema_version').get().version,10);compactDatabase(store.db);
    assert.deepEqual(store.db.prepare('SELECT rowid AS search_rowid,post_id FROM post_search ORDER BY rowid').all(),before);
    assert.equal(explorerPage(store,{query:'Third test wording'}).posts[0].id,'3');
    store.saveFeedback('3',{labels:[{topic:'Synthetic correction'}],reason:'Synthetic correction after migration.'});
    assert.equal(explorerPage(store,{topic:'Synthetic correction'}).posts[0].id,'3');add(store,4,'Fourth test wording.');assert.equal(explorerPage(store,{query:'Fourth test wording'}).posts[0].id,'4');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('backing up the older schema repairs any unstable FTS row mapping in the new snapshot only',async()=>{
  const f=setup();try{
    add(f.store,1,'First legacy test.');add(f.store,2,'Second legacy test.');add(f.store,3,'Third legacy test.');f.store.removePost('2');legacySearchFixture(f.store.db);
    const copy=await createDatabaseBackup(f.path);assert.equal(copy.schema,10);assert.equal(f.store.db.prepare('SELECT version FROM schema_version').get().version,9);
    const store=openStore(copy.path);try{assert.equal(explorerPage(store,{query:'Third legacy test'}).posts[0].id,'3');}finally{store.close();}
  }finally{f.close();}
});
