import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {openStore} from '../src/db.js';
import {normalizePost} from '../src/normalize.js';
import {inspectUnverifiedCaptures} from '../src/capture-inspection.js';
import {createServer} from '../src/server.js';

function capture(store,id,text,{status='awaiting-roster',createdAt='2026-09-08T00:00:00Z'}={}){
  const post=normalizePost({id,author_id:'800',created_at:createdAt,text,private_fixture_marker:'DO-NOT-RETURN-RAW'});
  store.db.prepare('INSERT INTO captured_posts(id,author_id,created_at,captured_at,normalized_json,status) VALUES (?,?,?,?,?,?)').run(id,post.authorId,post.createdAt,post.capturedAt,JSON.stringify(post),status);
}

test('capture inspection preserves full wording without inventing member identity or admitting sources',()=>{
  const store=openStore();try{
    capture(store,'801','Synthetic quote: “No evacuation.”\nFull second line.');capture(store,'802','Already admitted.',{status:'promoted'});capture(store,'803','Removed source.');
    store.db.prepare('INSERT INTO tombstones VALUES (?,?)').run('803','2026-09-08T01:00:00Z');
    const result=inspectUnverifiedCaptures(store);assert.equal(result.coverage.total,1);assert.equal(result.captures[0].text,'Synthetic quote: “No evacuation.”\nFull second line.');
    assert.equal(result.captures[0].identityStatus,'not-established');assert.equal(result.captures[0].includedInMemberCounts,false);
    for(const field of ['raw','memberId','memberName','labels','authorId','provenance'])assert.equal(result.captures[0][field],undefined);
    assert.equal(JSON.stringify(result).includes('DO-NOT-RETURN-RAW'),false);
    for(const table of ['posts','feedback','budget_requests'])assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0);
    store.db.prepare("UPDATE captured_posts SET status='promoted' WHERE id='801'").run();assert.equal(inspectUnverifiedCaptures(store).coverage.total,0);
  }finally{store.close();}
});

test('capture display bounds whole sources and discloses Unicode and page omissions',()=>{
  const store=openStore();try{
    capture(store,'801','😀😀😀');capture(store,'802','small');capture(store,'803','older',{createdAt:'2026-09-07T00:00:00Z'});
    const result=inspectUnverifiedCaptures(store,{limit:2,maxPostCharacters:5,maxSourceCharacters:10});
    assert.equal(result.coverage.total,3);assert.equal(result.coverage.unexamined,1);assert.equal(result.coverage.omittedOversized,1);assert.equal(result.coverage.partial,true);
    assert.deepEqual(result.captures.map(p=>p.text),['small']);assert.equal(result.coverage.sourceCharacters,5);
    assert.throws(()=>inspectUnverifiedCaptures(store,{limit:51}),/Invalid capture/);
  }finally{store.close();}
});

test('capture inspection is a source-bounded read-only API with no provider calls',async()=>{
  const store=openStore();capture(store,'801','Synthetic API source.');const server=createServer(store);server.listen(0,'127.0.0.1');await once(server,'listening');
  try{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/captures/unverified`);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    const value=await response.json();assert.equal(value.captures.length,1);assert.equal(value.captures[0].text,'Synthetic API source.');assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM budget_requests').get().n,0);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();}
});
