import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/db.js';
import {normalizePost} from '../src/normalize.js';
import {prepareVoiceSession} from '../src/voice-session.js';

test('voice preparation preserves source text and review versions without inventing lessons or held-out answers',()=>{
  const store=openStore();try{
    store.upsertAccount({authorId:'1',memberId:'synthetic',memberName:'Synthetic Member',handle:'Synthetic'});
    for(const [id,text] of [['1','🌧 Medicaid\n  notice: “unchanged.”'],['2','A separate synthetic Medicaid source.']]){
      store.ingest(normalizePost({id,author_id:'1',text,created_at:'2026-09-08T00:00:00Z'}));store.analyzePending();
    }
    store.saveFeedback('1',{decision:'classified',labels:[{topic:'Health care',subtopic:'Medicaid'}],reason:'Synthetic decision.'});
    const before=store.getPost('1');const session=prepareVoiceSession(store);
    assert.deepEqual(session.cards.map(c=>c.postId),['2','1']);assert.equal(session.cards[0].currentJudgment,null);
    const card=session.cards[1];assert.equal(card.source.text,before.text);assert.equal(card.predictionHash,before.analysisHash);assert.equal(card.reviewId,before.reviewId);assert.equal(card.currentJudgment.feedbackId,before.feedback[0].id);
    assert.deepEqual(store.getPost('1'),before);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM learning_holdouts').get().n,0);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM evaluation_runs').get().n,0);
    assert.deepEqual(prepareVoiceSession(store,{postIds:['1'],limit:1}).cards.map(c=>c.postId),['1']);
    assert.throws(()=>prepareVoiceSession(store,{postIds:['999']}),/missing/);assert.throws(()=>prepareVoiceSession(store,{limit:9}),/size/);assert.throws(()=>prepareVoiceSession(store,{postIds:['1','1']}),/IDs/);
  }finally{store.close();}
});
