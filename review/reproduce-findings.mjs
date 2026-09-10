// Offline evidence against the unmodified source snapshot. No X requests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, 'reference/caucus-pulse');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'caucus-pulse-audit-'));
const output = [];
const originalFetch = globalThis.fetch;
const envNames = ['X_BEARER_TOKEN', 'X_LIST_ID', 'X_MAX_PAGES', 'X_DAILY_READ_BUDGET'];
const originalEnv = Object.fromEntries(envNames.map(key => [key, process.env[key]]));

function setup(name) {
  const dir = path.join(scratch, name);
  fs.cpSync(source, dir, { recursive: true, filter: src => !src.includes('node_modules') && !src.includes('/data/') });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data/state.json'), JSON.stringify({
    sinceId: '100', sinceIdSupported: false, recentNewCounts: [], pendingBatch: null, usage: {}
  }));
  return dir;
}
const load = (dir, name) => import(pathToFileURL(path.join(dir, 'src', name)));
const post = id => ({id, author_id: 'a', created_at: new Date().toISOString(), text: 'sample text'});
const page = (ids, more = false) => new Response(JSON.stringify({
  data: ids.map(post), meta: more ? {next_token: 'older'} : {}
}), {status: 200, headers: {'content-type': 'application/json'}});

try {
  process.env.X_BEARER_TOKEN = 'offline-test-token';
  process.env.X_LIST_ID = '123';
  process.env.X_DAILY_READ_BUDGET = '10000';

  for (const scenario of ['page-limit', 'partial-http-failure']) {
    const dir = setup(scenario);
    process.env.X_MAX_PAGES = scenario === 'page-limit' ? '1' : '5';
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      if (requests === 1) return page(['500', '400'], true);
      return new Response('temporary upstream failure', {status: 503});
    };
    const {pollOnce} = await load(dir, 'poll.js');
    await pollOnce();
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'data/state.json')));
    assert.equal(state.sinceId, '500');
    globalThis.fetch = async () => page(['500', '400', '300', '200', '100']);
    const next = await pollOnce();
    assert.equal(next.captured, 0);
    const archived = fs.readdirSync(path.join(dir, 'data/archive')).flatMap(f =>
      fs.readFileSync(path.join(dir, 'data/archive', f), 'utf8').trim().split('\n').map(JSON.parse)
    );
    assert.deepEqual(archived.map(t => t.id).sort(), ['400', '500']);
    output.push({finding: scenario, checkpoint: state.sinceId, nextPollCaptured: next.captured, permanentlySkipped: ['200', '300']});
  }

  const {toRecord} = await load(source, 'x.js');
  const normalized = toRecord({...post('600'), text: 'short preview',
    note_tweet: {text: 'Complete older-schema long post with all its original phrasing.'},
    note_post: {text: 'Complete newer-schema long post with all its original phrasing.'},
    entities: {hashtags: [{tag: 'Example'}]}, conversation_id: '550'
  }, new Date().toISOString());
  assert.equal(normalized.text, 'short preview');
  assert.equal(normalized.entities, undefined);
  output.push({finding: 'full-content-discarded', savedText: normalized.text, fullLongTextSaved: false, entitiesSaved: false});

  const {minePhrases, tokenize, ngrams} = await load(source, 'syntax.js');
  const sameMemberTwice = [
    {id:'1',authorId:'member-a-official',memberId:'A',text:'Emergency shelter opening',createdAt:'2026-09-01T10:00:00Z'},
    {id:'2',authorId:'member-a-personal',memberId:'A',text:'Emergency shelter opening',createdAt:'2026-09-01T10:01:00Z'},
    {id:'3',authorId:'member-b-official',memberId:'B',text:'Emergency shelter opening',createdAt:'2026-09-01T10:02:00Z'}
  ];
  const options = {minMembers:3,minNgram:2,maxNgram:4};
  const spread = minePhrases(sameMemberTwice,options);
  assert.equal(spread[0].members,3);
  output.push({finding:'accounts-counted-as-members',actualMembers:2,reportedMembers:spread[0].members});

  const extracted = ngrams(tokenize('not a crime'),2,4);
  assert.ok(!extracted.includes('not a crime'));
  const longPhrase='we will not be silent';
  assert.ok(!ngrams(tokenize(longPhrase),2,4).includes(longPhrase));
  output.push({finding:'meaningful-phrases-excluded',missing:['not a crime',longPhrase]});

  const acrossMidnight = sameMemberTwice.map((p,i)=>({...p,authorId:'distinct-member-'+i,
    createdAt:['2026-09-02T03:50:00Z','2026-09-02T03:55:00Z','2026-09-02T04:05:00Z'][i]}));
  const day1=minePhrases(acrossMidnight.slice(0,2),options);
  const day2=minePhrases(acrossMidnight.slice(2),options);
  const window=minePhrases(acrossMidnight,options);
  assert.equal(day1.length,0); assert.equal(day2.length,0); assert.ok(window.length>0);
  output.push({finding:'daily-windows-miss-cross-midnight-spread',distinctMembersWithin15Minutes:3,phrasesDetectedByCurrentDailyRuns:0});

  const dir = setup('budget-overshoot');
  process.env.X_MAX_PAGES='5'; process.env.X_DAILY_READ_BUDGET='1';
  globalThis.fetch=async()=>page(['500','400']);
  const {pollOnce}=await load(dir,'poll.js');
  await pollOnce();
  const state=JSON.parse(fs.readFileSync(path.join(dir,'data/state.json')));
  const reads=Object.values(state.usage).reduce((sum,u)=>sum+u.posts,0);
  assert.equal(reads,2);
  output.push({finding:'daily-budget-not-a-hard-cap',configuredReadBudget:1,readsReturned:reads});

  const report={sourceCommit:'a93d72349104418ca59c9845eb9b949d7f9c77e1',mode:'offline mock responses',findings:output};
  fs.writeFileSync(path.join(here,'reproduced-findings.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} finally {
  globalThis.fetch=originalFetch;
  for(const [key,value] of Object.entries(originalEnv)) {
    if(value===undefined) delete process.env[key]; else process.env[key]=value;
  }
  fs.rmSync(scratch,{recursive:true,force:true});
}
