import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/db.js';
import {normalizePost} from '../src/normalize.js';
import {phraseData,PHRASE_LIMITS} from '../src/phrase-search.js';
import {highlightedText} from '../site/source-text.js';

function setup(){const s=openStore();s.upsertAccount({authorId:'1',memberId:'synthetic',memberName:'Synthetic Member',handle:'Synthetic'});return s;}
function add(s,id,text,extra={}){s.ingest(normalizePost({id:String(id),author_id:'1',text,created_at:'2026-09-08T00:00:00Z',...extra}));}

test('exact search counts the full selection while bounding displayed sources without hydration',()=>{
  const s=setup();try{
    for(let i=0;i<510;i++)add(s,i+1,'Synthetic longer repeated wording.');
    s.listPosts=()=>{throw new Error('Unbounded archive hydration.');};s.getPost=()=>{throw new Error('Review history hydration.');};
    const result=phraseData(s,'longer repeated wording');
    assert.equal(result.matchingPosts,510);assert.equal(result.distinctMembers,1);assert.equal(result.sources.length,500);
    assert.equal(result.coverage.unexaminedMatchingPosts,10);assert.equal(result.coverage.partial,true);
    assert.equal(result.occurrences.length,500);assert.ok(result.sources.every(p=>p.text==='Synthetic longer repeated wording.'));
  }finally{s.close();}
});

test('Unicode, punctuation, negation and overlapping matches retain exact source offsets',()=>{
  const s=setup();try{
    const text='📰 We will not close. We will close. café CAFÉ aaab <script>';
    add(s,1,text);add(s,2,text,{referenced_tweets:[{type:'retweeted',id:'1'}]});
    for(const phrase of ['📰','will not','café','CAFÉ','aa','<script>']){
      const result=phraseData(s,phrase);assert.equal(result.matchingPosts,1);assert.equal(result.sources[0].text,text);
      for(const o of result.occurrences)assert.equal(text.slice(o.span.start,o.span.end),phrase);
    }
    assert.equal(phraseData(s,'Café').matchingPosts,0);assert.equal(phraseData(s,'aa').occurrences.length,2);
    assert.equal(phraseData(s,'will not',{query:'missing'}).matchingPosts,0);
    add(s,1,'Revised source.');assert.equal(phraseData(s,'will not').matchingPosts,0);
    s.removePost('1');assert.equal(phraseData(s,'Revised').matchingPosts,0);
  }finally{s.close();}
});

test('large sources and repeated occurrences disclose omissions while preserving authoritative text',()=>{
  const s=setup();try{
    add(s,1,'x'.repeat(60001));add(s,2,'x'.repeat(5000));
    const result=phraseData(s,'x');assert.equal(result.matchingPosts,2);assert.equal(result.sources.length,1);
    assert.equal(result.sources[0].text.length,5000);assert.equal(result.occurrences.length,PHRASE_LIMITS.occurrences);
    assert.equal(result.coverage.omittedOversizedPosts,1);assert.equal(result.coverage.omittedOccurrences,4000);
    assert.ok(result.coverage.sourceCharacters<=PHRASE_LIMITS.sourceCharacters);assert.ok(result.coverage.responseCharacters<=PHRASE_LIMITS.responseCharacters);
    assert.equal(s.getPost('1').text.length,60001);
  }finally{s.close();}
});

test('highlighting merges overlapping evidence without duplicating or interpreting source markup',()=>{
  const text='📰 aaab <img>';
  const escape=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const result=highlightedText(text,[{start:3,end:5,text:'aa'},{start:4,end:6,text:'aa'}],escape);
  assert.equal(result,'📰 <mark class="phrase-match">aaa</mark>b &lt;img&gt;');
  assert.throws(()=>highlightedText(text,[{start:3,end:5,text:'wrong'}],escape),/changed/);
});
