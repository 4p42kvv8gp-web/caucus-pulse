import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/db.js';
import {normalizePost} from '../src/normalize.js';
import {learningStatus,reserveHoldouts,postLearningHistory} from '../src/learning-context.js';
import {runSemanticAnalysis} from '../src/intelligence.js';

function setup(){const store=openStore();store.upsertAccount({authorId:'1',memberId:'synthetic',memberName:'Synthetic Member',handle:'Synthetic'});return store;}
function add(store,id,text='Synthetic Medicaid source.'){store.ingest(normalizePost({id,author_id:'1',text,created_at:'2026-09-08T00:00:00Z'}));store.analyzePending();}
function review(store,id,decision,labels=[],ruleProposal=null){return store.saveFeedback(id,{decision,labels,ruleProposal,reason:'Synthetic test judgment.'});}

test('learning summaries use only the newest current-source decision and distinguish abstention from uncertainty',()=>{
  const store=setup();try{
    for(const id of ['1','2','3'])add(store,id);
    review(store,'1','classified',[{topic:'Health care',subtopic:'Medicaid'}],'Synthetic rule to test.');
    review(store,'2','no-supported-topic');review(store,'3','needs-context');reserveHoldouts(store,['2']);
    let status=learningStatus(store);assert.equal(status.reviewedPosts,3);assert.equal(status.classifiedReviews,1);assert.equal(status.explicitEmptyReviews,1);assert.equal(status.unresolvedReviews,1);assert.equal(status.proposedRules,1);assert.equal(status.heldOutPosts,1);assert.equal(status.automaticTraining,false);assert.deepEqual(status.topicCoverage.map(x=>({...x})),[{topic:'Health care',reviewedPosts:1}]);
    review(store,'1','needs-context');status=learningStatus(store);assert.equal(status.classifiedReviews,0);assert.equal(status.proposedRules,0);assert.deepEqual(status.topicCoverage,[]);
    add(store,'2','Edited source with different wording.');status=learningStatus(store);assert.equal(status.reviewedPosts,2);assert.equal(status.explicitEmptyReviews,0);
    store.removePost('3');assert.equal(learningStatus(store).reviewedPosts,1);
  }finally{store.close();}
});

test('semantic learning history has an explicit bound without deleting older runs',async()=>{
  const store=setup();try{
    add(store,'1');
    for(let i=0;i<54;i++)await runSemanticAnalysis({store,postId:'1',providerName:'Synthetic',model:'fixture',provider:async request=>({postId:'1',sourceHash:request.input.sourceHash,labels:[],entities:[],events:[],functions:[],summary:'Synthetic output.',limitations:[]}),now:()=>Date.now()+i});
    const history=postLearningHistory(store,'1');assert.equal(history.runCount,54);assert.equal(history.runs.length,50);assert.equal(history.runsOmitted,4);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM analysis_runs').get().n,54);
  }finally{store.close();}
});
