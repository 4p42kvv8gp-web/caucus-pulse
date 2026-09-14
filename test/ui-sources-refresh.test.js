import test from 'node:test';
import assert from 'node:assert/strict';
import { postUrl, profileUrl, sourceLink, handleLink, newsEvidence, captureLabel, startRefresh } from '../site/ui.js';
import { compactQuote, publicProvenance, rosterPersonKey } from '../src/sitedata.js';

test('post links preserve exact numeric IDs and reject unsafe/generated IDs', () => {
  const id = '2091220000000000001';
  assert.equal(postUrl({ id }), `https://x.com/i/web/status/${id}`);
  assert.equal(postUrl({ sourceId:id, id:'story-name' }), `https://x.com/i/web/status/${id}`);
  for (const bad of ['2091220june', '2095923725ангел', '1/evil', 'javascript:alert(1)', '', 2091220000000000001]) assert.equal(postUrl({ id:bad }), null);
  assert.match(sourceLink({id}, '<img onerror=alert(1)>'), /&lt;img/);
  assert.match(handleLink('@RepOne', {id}), new RegExp(`/status/${id}`));
  assert.equal(profileUrl('@RepOne'), 'https://x.com/RepOne');
  assert.equal(profileUrl('x" onclick="bad'), null);
});

test('quoted sources retain identity, and public provenance excludes private or invented source fields', () => {
  assert.equal(compactQuote({id:'42',handle:'Reporter',text:'context'}).id, '42');
  assert.equal(compactQuote({id:'made-up',text:'context'}).id, null);
  const p = publicProvenance({contextVersion:3, sender:'private@example.com', subject:'private subject', evidenceSupplied:[{id:'news-1',url:'https://example.com/report',publisher:'Public Source',text:'Public passage',fetchedAt:'2026-09-13T21:00:00Z',publishedAfterPost:true,sender:'private@example.com'}],evidenceUsed:['news-1','invented']});
  assert.deepEqual(p.evidenceUsed,['news-1']);
  assert.ok(!JSON.stringify(p).includes('private'));
  assert.equal(p.evidenceSupplied[0].publishedAfterPost,true);
  const html = newsEvidence(p.evidenceSupplied,{used:p.evidenceUsed});
  assert.match(html,/used by classifier/);
  assert.match(html,/published after post/);
  assert.match(html,/https:\/\/example.com\/report/);
  assert.equal(newsEvidence([{id:'bad',url:'javascript:alert(1)',text:'bad'}]),'');
});

test('roster identity joins official and campaign accounts without inventing unknown people', () => {
  assert.equal(rosterPersonKey({member:'José Example'}),rosterPersonKey({member:'Jose  Example',handle:'campaign'}));
  assert.equal(rosterPersonKey({name:'An account',handle:'unknown'}),null);
});

test('freshness refers to completed capture, and flags incomplete/stale attempts', () => {
  const d={today:'2026-09-13',lastPollAt:'2026-09-13T12:00:00Z',lastPollSuccessAt:'2026-09-13T13:59:00Z',lastPollOutcome:'page_cap',captureInProgress:true};
  const label=captureLabel(d,null,Date.parse('2026-09-13T14:00:00Z'));
  assert.match(label,/8:00 AM/);
  assert.match(label,/stale/);
  assert.match(label,/newer attempt incomplete/);
  assert.match(captureLabel(d,new Error('offline')),/showing last loaded data/);
});

test('refresh is serialized; a failed read retains the previous successful data', async () => {
  let tick, resolve, calls=0, data=null, error=null;
  const refresh=startRefresh({load:()=>{calls++;return new Promise((r)=>{resolve=r;});},onData:(d)=>{data=d;},onError:(e)=>{error=e;},setIntervalFn:(fn,ms)=>{tick=fn;assert.equal(ms,120000);return 1;}});
  await tick(); assert.equal(calls,1);
  resolve({version:1}); await new Promise((r)=>setImmediate(r));
  assert.deepEqual(data,{version:1});
  const pending=refresh.refresh(); resolve(null); await pending;
  assert.deepEqual(data,{version:1}); assert.ok(error);
});

test('hosted Pages reads current public repository data while local preview stays local', async () => {
  const {dataBaseUrl}=await import('../site/ui.js');
  assert.equal(dataBaseUrl({hostname:'4p42kvv8gp-web.github.io',pathname:'/caucus-pulse/site/index.html'}),'https://raw.githubusercontent.com/4p42kvv8gp-web/caucus-pulse/main/site/data/');
  assert.equal(dataBaseUrl({hostname:'127.0.0.1',pathname:'/site/index.html'}),'./data/');
  assert.equal(dataBaseUrl({hostname:'malicious.github.io.evil.com',pathname:'/repo/'}),'./data/');
});

test('legacy incident source identity is restored only from exact archived evidence', async () => {
  const {hydrateIncidentSources}=await import('../src/sitedata.js');
  const post={id:'12345',text:'No evacuation order.',createdAt:'2026-09-13T12:00:00Z'};
  const incident={tweetIds:['12345'],status:'active',timeline:[{text:post.text,time:post.createdAt}],evidence:{span:post.text}};
  const out=hydrateIncidentSources(incident,[post]);
  assert.equal(out.timeline[0].sourceId,'12345');
  assert.equal(out.evidence.sourceId,'12345');
  assert.equal(out.status,'provisional');
  assert.equal(out.lifecycle,'active');
  assert.equal(hydrateIncidentSources({...incident,timeline:[{text:'Evacuation order.',time:post.createdAt}]},[post]).timeline[0].sourceId,undefined);
});
