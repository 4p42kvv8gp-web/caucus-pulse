import test from 'node:test';
import assert from 'node:assert/strict';
import {uniqueSpan,reviewedEvent,caseSources,incidentBrief} from '../site/incident-helpers.js';

test('review evidence keeps Unicode offsets and rejects altered or ambiguous wording',()=>{
  const text='📰 Flooding near North School. North School is open.';
  assert.deepEqual(uniqueSpan(text,'Flooding near North School.'),{start:3,end:30,text:'Flooding near North School.'});
  assert.throws(()=>uniqueSpan(text,'North School'),/more than once/);
  assert.throws(()=>uniqueSpan(text,'flooding near'),/exactly/);
  const event=reviewedEvent(text,{description:'Flooding reported near a school.',development:'reported-incident',evidence:'Flooding near North School.',location:'North School',districtRelation:'not-established'});
  assert.deepEqual(event.location.evidence[0],{start:17,end:29,text:'North School'});
  assert.equal(text.slice(event.evidence[0].start,event.evidence[0].end),event.evidence[0].text);
  assert.throws(()=>reviewedEvent(text,{description:'Test',development:'update',evidence:'North School is open.',location:'Unmentioned City',districtRelation:'not-established'}),/exactly/);
  assert.throws(()=>reviewedEvent(text,{description:'Test',development:'update',evidence:'North School is open.',districtRelation:'explicitly-stated',districtEvidence:'North School is open.'},'repost'),/reposting member/);
});

test('source digests deduplicate posts without dropping interpretations or claiming verified conditions',()=>{
  const post={id:'1',memberId:'member',memberName:'Synthetic Member',handle:'Synthetic',createdAt:'2026-09-08T00:00:00Z',type:'quote',text:'Original wording with “quotes” and\nnewlines.',sourceUrl:'https://x.com/Synthetic/status/1'};
  const candidate={basis:'model-suggestion',event:{description:'One source interpretation.'}};
  const record={title:'Synthetic case',status:'watching',sources:[{post,candidate},{post,candidate:{basis:'human-source-review',event:{description:'Another interpretation.'}}}],stale:[{postId:'2'}],omittedOversizedSources:1};
  assert.equal(caseSources(record).length,1);assert.equal(caseSources(record)[0].candidates.length,2);
  const brief=incidentBrief(record);assert.equal(brief.split(post.text).length-1,1);assert.ok(brief.includes('Another interpretation.'));
  assert.ok(brief.includes('1 archived source posts'));assert.ok(brief.includes('not been independently verified'));
  assert.ok(brief.includes('1 outdated links'));assert.ok(brief.includes('1 sources outside display limits'));assert.ok(brief.includes(post.sourceUrl));
});
