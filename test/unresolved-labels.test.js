import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {openStore} from '../src/db.js';
import {normalizePost} from '../src/normalize.js';
import {explorerPage,explorerSummary} from '../src/explorer.js';
import {createEvaluationSet} from '../src/evaluation.js';
import {prepareAnalysis} from '../src/intelligence.js';

const labels=[{topic:'Health care',subtopic:'Medicaid'}];
function setup(path){const store=openStore(path);store.upsertAccount({authorId:'1',memberId:'synthetic',memberName:'Synthetic Member',handle:'Synthetic'});add(store,'1');return store;}
function add(store,id,text='Synthetic Medicaid notice.'){store.ingest(normalizePost({id,author_id:'1',text,created_at:'2026-09-08T00:00:00Z'}));store.analyzePending();}
function review(store,decision){return store.saveFeedback('1',{decision,labels:decision==='no-supported-topic'?[]:labels,reason:'Synthetic interpretation.'});}
function legacyView(store){
  const row=store.db.prepare("SELECT sql FROM sqlite_schema WHERE type='view' AND name='post_search_source'").get();
  const old=row.sql.replace(/CASE WHEN f\.sequence IS NULL[\s\S]*? AS labels_json/,"COALESCE(json_extract(f.feedback_json,'$.labels'),json_extract(n.analysis_json,'$.labels'),'[]') AS labels_json");
  assert.notEqual(old,row.sql);store.db.exec('DROP VIEW post_search_source');store.db.exec(old);store.db.exec('UPDATE schema_version SET version=10');
}

test('uncertain labels remain review drafts and do not enter topic counts, filters, examples or expected answers',()=>{
  const store=setup();try{
    const proposal=store.getPost('1').analysis;let post=review(store,'needs-context');
    assert.deepEqual(post.labels,[]);assert.equal(post.labelStatus,'needs-context');assert.deepEqual(post.feedback[0].labels,labels);assert.deepEqual(post.analysis,proposal);
    assert.equal(explorerPage(store,{topic:'Health care'}).page.totalPosts,0);assert.deepEqual(explorerSummary(store,{}).topics,[]);assert.equal(explorerPage(store,{query:'Medicaid'}).page.totalPosts,1);
    add(store,'2','Another synthetic Medicaid notice.');assert.deepEqual(prepareAnalysis(store,'2').input.reviewedExamples,[]);assert.throws(()=>createEvaluationSet(store,{title:'Invalid unresolved answer',postIds:['1']}),/unresolved/);
    post=review(store,'classified');assert.equal(post.labelStatus,'human-accepted');assert.deepEqual(post.labels,labels);assert.equal(post.feedback[0].previousAcceptedLabels,null);assert.equal(explorerPage(store,{topic:'Health care'}).page.totalPosts,2);
    post=review(store,'no-supported-topic');assert.deepEqual(post.labels,[]);assert.equal(post.labelStatus,'human-accepted');assert.deepEqual(createEvaluationSet(store,{title:'Explicit empty answer',postIds:['1']}).cases[0].expected,[]);
  }finally{store.close();}
});

test('editing a source invalidates its unresolved review and restores provisional classification for the new wording',()=>{
  const store=setup();try{review(store,'needs-context');add(store,'1','A revised Medicaid statement.');const post=store.getPost('1');assert.equal(post.labelStatus,'model-provisional');assert.equal(post.labels[0].topic,'Health care');assert.equal(post.reviewId,null);assert.equal(post.feedback[0].appliesToCurrentText,false);}finally{store.close();}
});

test('schema 11 repairs legacy uncertain label indexes without changing sources, proposals or review history',()=>{
  const directory=mkdtempSync(join(tmpdir(),'pulse-uncertain-migration-')),path=join(directory,'archive.sqlite');let store=setup(path);
  try{legacyView(store);review(store,'needs-context');assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM post_search_labels').get().n,1);
    const before=store.getPost('1'),rowId=store.db.prepare('SELECT search_id FROM post_search').get().search_id;store.close();store=openStore(path);
    assert.equal(store.db.prepare('SELECT version FROM schema_version').get().version,11);assert.equal(store.db.prepare('SELECT search_id FROM post_search').get().search_id,rowId);assert.equal(explorerPage(store,{topic:'Health care'}).page.totalPosts,0);
    assert.equal(explorerPage(store,{query:'Medicaid'}).page.totalPosts,1);assert.deepEqual(store.getPost('1').feedback,before.feedback);assert.deepEqual(store.getPost('1').analysis,before.analysis);assert.equal(store.getPost('1').text,before.text);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('a failed uncertainty migration rolls back both the view and the materialized labels',()=>{
  const directory=mkdtempSync(join(tmpdir(),'pulse-uncertain-rollback-')),path=join(directory,'archive.sqlite');let store=setup(path);
  try{legacyView(store);review(store,'needs-context');store.db.exec("CREATE TRIGGER synthetic_stop BEFORE UPDATE ON schema_version WHEN new.version=11 BEGIN SELECT RAISE(ABORT,'Synthetic migration stop'); END");store.close();store=null;
    assert.throws(()=>openStore(path),/Synthetic migration stop/);const db=new DatabaseSync(path);try{assert.equal(db.prepare('SELECT version FROM schema_version').get().version,10);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM post_search_labels').get().n,1);assert.ok(!db.prepare("SELECT sql FROM sqlite_schema WHERE name='post_search_source'").get().sql.includes('CASE WHEN f.sequence IS NULL'));db.exec('DROP TRIGGER synthetic_stop');}finally{db.close();}
    store=openStore(path);assert.equal(explorerPage(store,{topic:'Health care'}).page.totalPosts,0);
  }finally{store?.close();rmSync(directory,{recursive:true,force:true});}
});
