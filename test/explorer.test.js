import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/db.js';
import { normalizePost } from '../src/normalize.js';
import { atomic } from '../src/sqlite.js';
import { explorerPage,explorerSummary,searchSelection } from '../src/explorer.js';
import { dashboardData } from '../src/dashboard.js';
import { createServer } from '../src/server.js';

function setup(path) {
  const store = openStore(path);
  for (const [id,member,type] of [['101','one','official'],['102','one','personal'],['103','two','campaign']])
    store.upsertAccount({authorId:id,memberId:member,memberName:`Synthetic ${member}`,handle:`Synthetic${id}`,accountType:type});
  return store;
}
function add(store,id,text='Medicare and Medicaid remain available.',extra={}) {
  const post = normalizePost({id:String(id),author_id:'101',created_at:'2026-09-07T23:50:00Z',text,...extra},{kind:'historical-calibration'});
  store.ingest(post); return post;
}
const ids = result => result.posts.map(p => p.id);

test('bounded pages preserve long posts and large string IDs without hydrating the archive', () => {
  const store = setup();
  try {
    for (let i=0;i<123;i++) add(store,(9007199254740993000n+BigInt(i)).toString(),i===122 ? 'Long complete wording. '.repeat(500) : undefined);
    let reads=0; const get=store.getPost;
    store.getPost=id => { reads++; return get(id); };
    store.listPosts=() => { throw new Error('Unbounded hydration is forbidden in the dashboard.'); };
    const data=dashboardData(store,{}, {mode:'test',budget:{}});
    assert.equal(reads,50); assert.equal(data.posts.length,50); assert.equal(data.page.totalPosts,123);
    assert.equal(data.coverage.postCount,123); assert.equal(data.page.hasMore,true);
    assert.equal(data.posts[0].id,'9007199254740993122');
    assert.equal(data.posts[0].text,'Long complete wording. '.repeat(500));
    assert.equal(Object.hasOwn(data.posts[0],'raw'),false);
    assert.ok(JSON.parse(store.db.prepare('SELECT normalized_json FROM posts WHERE id=?').get(data.posts[0].id).normalized_json).raw);
  } finally { store.close(); }
});

test('chronological cursors traverse equal timestamps exactly once and bind to the selection', () => {
  const store=setup();
  try {
    for (const id of ['1','2','9','10','11','99']) add(store,id);
    add(store,'3',undefined,{created_at:'2026-09-08T00:01:00Z'});
    const expected=['3','99','9','2','11','10','1']; const seen=[];
    let cursor='';
    do {
      const page=explorerPage(store,{query:'MEDICAID'},{limit:2,cursor});
      seen.push(...ids(page)); cursor=page.page.nextCursor;
    } while (cursor);
    assert.deepEqual(seen,expected);
    const first=explorerPage(store,{query:'MEDICAID'},{limit:2});
    assert.throws(() => explorerPage(store,{query:'Medicare'},{cursor:first.page.nextCursor}),/these filters/);
    assert.equal(explorerPage(store,{query:'missing'}).page.nextCursor,null);
  } finally { store.close(); }
});

test('new posts, edits, reviews, and removals invalidate pagination instead of mixing archive versions', () => {
  const store=setup();
  try {
    add(store,'1'); add(store,'2');
    for (const mutate of [() => add(store,'3'),() => add(store,'1','Changed wording.'),
      () => store.saveFeedback('2',{labels:[],reason:'Synthetic review only.'},'synthetic-reviewer'),() => store.removePost('3')]) {
      const cursor=explorerPage(store,{}, {limit:1}).page.nextCursor;
      mutate();
      assert.throws(() => explorerPage(store,{}, {cursor}),error => error.code==='EXPLORER_CHANGED');
    }
  } finally { store.close(); }
});

test('literal search preserves Unicode, negation, accents, spacing, punctuation, and query operators', () => {
  const store=setup();
  const text='📰 CAFÉ ÄRGER 東京です. We will not close. Two  spaces. Say "blue OR green". 100%_done. İSTANBUL.';
  try {
    add(store,'1',text); add(store,'2','We will close.');
    for (const query of ['café','É','ärger','東京です','東京','📰','will not','Two  spaces','"blue OR green"','100%_done','İSTANBUL',' ','%.']) {
      const expected=text.toLowerCase().includes(query.toLowerCase()) ? ['1'] : [];
      if (query===' ') expected.push('2');
      assert.deepEqual(ids(explorerPage(store,{query})).sort(),expected.sort(),query);
    }
    for (const query of ['cafe','Two spaces',"' OR 1=1 --",'" OR *','not close!', 'ISTANBUL']) assert.equal(explorerPage(store,{query}).page.totalPosts,0,query);
    assert.equal(explorerPage(store,{query:'é'}).page.queryMode,'short-substring-scan');
    assert.equal(explorerPage(store,{query:'café'}).page.queryMode,'trigram-with-literal-check');
  } finally { store.close(); }
});

test('current corrections, explicit empty decisions, and source changes drive filters and full-selection rollups', () => {
  const store=setup();
  try {
    add(store,'1'); add(store,'2',undefined,{author_id:'102'}); add(store,'3',undefined,{author_id:'103'});
    store.analyzePending();
    let data=dashboardData(store,{}, {mode:'test',budget:{}}, {limit:1});
    assert.equal(data.posts.length,1); assert.equal(data.topics[0].posts,3); assert.equal(data.topics[0].members,2);
    assert.equal(explorerPage(store,{topic:'Health care',subtopic:'Medicaid'}).page.totalPosts,3);
    store.saveFeedback('1',{labels:[{topic:'Community',subtopic:'Clinic'}],reason:'Synthetic correction.',ruleProposal:'Synthetic proposed rule.'},'synthetic-reviewer');
    assert.equal(explorerPage(store,{topic:'Health care'}).page.totalPosts,2);
    assert.deepEqual(ids(explorerPage(store,{topic:'Community'})),['1']);
    assert.equal(explorerPage(store,{topic:'Community',subtopic:'Medicaid'}).page.totalPosts,0);
    store.saveFeedback('1',{labels:[],reason:'Needs more context.'},'synthetic-reviewer');
    assert.equal(explorerPage(store,{topic:'Community'}).page.totalPosts,0);
    assert.equal(explorerSummary(store).coverage.reviewedPosts,1);
    assert.equal(explorerSummary(store).coverage.pendingRuleProposals,1);
    add(store,'1','A different library notice.');
    assert.equal(explorerSummary(store).coverage.reviewedPosts,0);
    assert.equal(explorerPage(store,{query:'Medicaid'}).page.totalPosts,2);
    assert.equal(explorerPage(store,{query:'library'}).page.totalPosts,1);
  } finally { store.close(); }
});

test('member, account type, source type, and half-open date filters use immutable post attribution', () => {
  const store=setup();
  try {
    add(store,'1'); add(store,'2',undefined,{author_id:'102',created_at:'2026-09-08T00:10:00Z',referenced_tweets:[{type:'quoted',id:'22'}]});
    store.db.prepare('UPDATE posts SET attribution_json=? WHERE id=?').run(JSON.stringify({memberId:'original-member',memberName:'Synthetic Original',handle:'Original',identityNote:'Synthetic',accountType:'official'}),'1');
    store.upsertAccount({authorId:'101',memberId:'later-member',memberName:'Synthetic Later',handle:'Later',accountType:'campaign'});
    assert.deepEqual(ids(explorerPage(store,{memberId:'original-member',accountType:'official'})),['1']);
    assert.equal(explorerPage(store,{memberId:'later-member'}).page.totalPosts,0);
    assert.deepEqual(ids(explorerPage(store,{type:'quote',accountType:'personal'})),['2']);
    assert.deepEqual(ids(explorerPage(store,{since:'2026-09-07T23:50:00Z',until:'2026-09-08T00:10:00Z'})),['1']);
    assert.equal(explorerPage(store,{since:'2026-09-07T23:00:00Z',until:'2026-09-08T00:20:00Z'}).page.totalPosts,2);
  } finally { store.close(); }
});

test('edits, source removal, cascades and rollbacks keep the text index consistent', () => {
  const store=setup();
  try {
    add(store,'1','Original exact wording.');
    const before=explorerPage(store).page.revision;
    assert.throws(() => atomic(store.db,() => { add(store,'1','Rolled back wording.'); throw new Error('Synthetic interruption'); }),/interruption/);
    assert.equal(explorerPage(store,{query:'Original'}).page.totalPosts,1);
    assert.equal(explorerPage(store,{query:'Rolled back'}).page.totalPosts,0);
    assert.equal(explorerPage(store).page.revision,before);
    add(store,'1','Replacement exact wording.');
    assert.equal(explorerPage(store,{query:'Original'}).page.totalPosts,0);
    store.analyzePending(); store.saveFeedback('1',{labels:[{topic:'Synthetic'}],reason:'Synthetic review.'},'synthetic-reviewer');
    store.removePost('1');
    assert.equal(explorerPage(store,{query:'Replacement'}).page.totalPosts,0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM post_search_labels').get().n,0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM post_search').get().n,0);
    assert.equal(store.ingest(normalizePost({id:'1',author_id:'101',created_at:'2026-09-07T12:00:00Z',text:'Replacement exact wording.'})).removed,true);
    assert.equal(explorerPage(store).page.totalPosts,0);
    store.db.exec("INSERT INTO post_search_fts(post_search_fts,rank) VALUES('integrity-check',1)");
  } finally { store.close(); }
});

test('persistent indexes reopen and migrate existing version-five source records and reviews', () => {
  const dir=mkdtempSync(join(tmpdir(),'pulse-explorer-')); const file=join(dir,'test.sqlite'); let store=setup(file);
  try {
    add(store,'1','Preserved café wording.'); store.analyzePending();
    store.saveFeedback('1',{labels:[{topic:'Synthetic reviewed topic'}],reason:'Synthetic review.'},'synthetic-reviewer');
    // Reconstruct version five by removing subsequent disposable indexes and their triggers.
    store.db.exec('DROP TRIGGER embedding_post_insert; DROP TRIGGER embedding_post_update; DROP TABLE embedding_passages; DROP TABLE embedding_jobs; DROP TABLE embedding_models;');
    for (const {name} of store.db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'explorer_%'").all()) store.db.exec(`DROP TRIGGER "${name}"`);
    store.db.exec('DROP TABLE post_search_fts; DROP TABLE post_search_labels; DROP TABLE post_search; DROP VIEW post_search_source; DROP TABLE explorer_revision; DROP INDEX feedback_current_source; UPDATE schema_version SET version=5;');
    store.close(); store=openStore(file);
    assert.equal(store.db.prepare('SELECT version FROM schema_version').get().version,7);
    assert.deepEqual(ids(explorerPage(store,{query:'CAFÉ',topic:'Synthetic reviewed topic'})),['1']);
    assert.equal(store.getPost('1').feedback.length,1);
    store.close(); store=openStore(file);
    add(store,'2','Reopened café index.');
    assert.equal(explorerPage(store,{query:'CAFÉ'}).page.totalPosts,2);
    store.db.exec("INSERT INTO post_search_fts(post_search_fts,rank) VALUES('integrity-check',1)");
  } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('the query planner uses text, chronology, member, and topic indexes', () => {
  const store=setup();
  try {
    for (const [filters,pattern] of [[{query:'Medicaid'},/VIRTUAL TABLE INDEX/],[{},/explorer_chronology/],
      [{memberId:'one'},/explorer_member/],[{topic:'Health care'},/explorer_topic/]]) {
      const selection=searchSelection(filters);
      const plan=store.db.prepare(`EXPLAIN QUERY PLAN SELECT s.post_id ${selection.from} ORDER BY s.created_at DESC,s.post_id DESC LIMIT 50`).all(...selection.values).map(r=>r.detail).join('\n');
      assert.match(plan,pattern);
    }
  } finally { store.close(); }
});

test('invalid pagination and filters fail explicitly, without treating search text as executable SQL', () => {
  const store=setup();
  try {
    for (const options of [{limit:0},{limit:101},{limit:1.5},{cursor:'!'},{cursor:'a'.repeat(1600)}]) assert.throws(()=>explorerPage(store,{},options),/Invalid/);
    for (const filters of [{query:'x'.repeat(2001)},{query:22},{query:'a\0b'},{since:'bad'},{since:'2026-09-08',until:'2026-09-07'},{type:'unknown'},{accountType:'invented'}]) assert.throws(()=>explorerPage(store,filters),/Invalid/);
  } finally { store.close(); }
});

test('HTTP pages expose full-selection counts and return a recoverable conflict for changed archives', async () => {
  const store=setup(); for (let i=1;i<=6;i++) add(store,i);
  const server=createServer(store); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const root=`http://127.0.0.1:${server.address().port}`;
  try {
    const first=await (await fetch(`${root}/api/posts?limit=2`)).json();
    assert.equal(first.posts.length,2); assert.equal(first.page.totalPosts,6);
    const params=new URLSearchParams({limit:'2',cursor:first.page.nextCursor});
    const next=await fetch(`${root}/api/dashboard?${params}`);
    assert.equal(next.status,200); assert.equal((await next.json()).coverage.postCount,6);
    add(store,'7');
    const stale=await fetch(`${root}/api/posts?${params}`);
    assert.equal(stale.status,409); assert.equal((await stale.json()).code,'EXPLORER_CHANGED');
    for (const query of ['limit=0','limit=abc','limit=101','cursor=!','accountType=unknown','subtopic='+encodeURIComponent('x'.repeat(161))]) assert.equal((await fetch(`${root}/api/dashboard?${query}`)).status,400,query);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM budget_requests').get().n,0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM feedback').get().n,0);
  } finally { await new Promise(resolve=>server.close(resolve)); store.close(); }
});
