import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openStore} from '../src/db.js';
import {importRoster,CLERK_SOURCE} from '../src/roster.js';
import {normalizePost} from '../src/normalize.js';
import {accountEvidenceCandidates,applyAccountEvidence} from '../src/account-evidence.js';

const now=Date.parse('2026-09-08T08:00:00Z'),at='2026-09-08T07:00:00.000Z';
const member={memberId:'T000001',name:'Synthetic Test Member',state:'XY',district:'XY01',party:'D',caucus:'D'};
const files={'directory.html':Buffer.from('Synthetic directory fixture.'),'office.html':Buffer.from('Synthetic office fixture, not a real identity proof.')};
function artifact(file,url){return {file,sourceUrl:url,finalUrl:url,retrievedAt:at,bytes:files[file].length,sha256:createHash('sha256').update(files[file]).digest('hex')};}
function setup(){
  const s=openStore();
  importRoster(s.db,{schemaVersion:1,id:'a'.repeat(64),sourceUrl:CLERK_SOURCE,congress:'119',publishedOn:'2026-09-07',retrievedAt:'2026-09-08T00:00:00Z',members:[member]},{now});
  s.db.prepare("INSERT INTO list_inventory_runs(id,list_id,status,page_size,started_at,updated_at) VALUES ('synthetic','123','pending',100,?,?)").run(at,at);
  s.db.prepare('INSERT INTO list_inventory_accounts(run_id,author_id,username,display_name,observed_at,profile_json) VALUES (?,?,?,?,?,?)')
    .run('synthetic','42','RepSynthetic','Representative Synthetic',at,JSON.stringify({id:'42',username:'RepSynthetic'}));
  return s;
}
function report(){return {schemaVersion:1,policy:'house-directory-office-link-v1',createdAt:at,rosterHash:'a'.repeat(64),rosterRetrievedAt:'2026-09-08T00:00:00Z',
  directory:artifact('directory.html','https://www.house.gov/representatives'),observations:[{memberId:member.memberId,district:'XY01',directoryName:'Test Member, Synthetic',status:'observed',page:artifact('office.html','https://synthetic.house.gov/'),profiles:[{handle:'RepSynthetic',url:'https://x.com/RepSynthetic',observedHref:'https://twitter.com/RepSynthetic'}]}]};}
function preview(s,value=report()){return accountEvidenceCandidates(s,value,{loadSource:name=>files[name],listId:'123',now});}

test('official evidence joins a dated roster and observed numeric profile without claiming complete List inventory',()=>{
  const s=setup();try{
    const post=normalizePost({id:'99',author_id:'42',text:'A synthetic community announcement.',created_at:'2026-09-08T04:00:00Z'});
    s.db.prepare('INSERT INTO captured_posts(id,author_id,created_at,captured_at,normalized_json) VALUES (?,?,?,?,?)').run(post.id,post.authorId,post.createdAt,post.capturedAt,JSON.stringify(post));
    const p=preview(s);assert.deepEqual(p.counts,{ready:1});
    assert.equal(p.items[0].binding.evidence.ownershipBasis,'current-observation-window');
    assert.equal(p.items[0].binding.validFrom,'2026-09-07T08:00:00.000Z');
    assert.equal(p.items[0].binding.validUntil,'2026-09-09T00:00:00.000Z');
    assert.equal(applyAccountEvidence(s,p,{now}).promotion.promoted,1);
    assert.match(s.getPost('99').identityNote,/historical ownership is not established/i);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM list_inventories').get().n,0);
    assert.deepEqual(preview(s).counts,{'already-covered':1});
    assert.equal(applyAccountEvidence(s,preview(s),{now}).bindingsAdded,0);
  }finally{s.close();}
});

test('hash drift, wrong district, stale observations, unsafe links and mismatched handles cannot bind',()=>{
  const s=setup();try{
    for(const mutate of [r=>r.directory.sha256='f'.repeat(64),r=>r.observations[0].district='XY02',r=>r.observations[0].page.retrievedAt='2026-09-01T00:00:00Z',
      r=>r.observations[0].page.finalUrl='https://house.gov.example.invalid',r=>r.observations[0].profiles[0].observedHref='https://x.com/SomeoneElse',r=>r.directory.file='../secret.html',r=>r.observations.push(r.observations[0])]){
      const r=report();mutate(r);assert.throws(()=>preview(s,r));
    }
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM account_bindings').get().n,0);
    assert.throws(()=>applyAccountEvidence(s,preview(s),{now:now+60001}),/expired/);
  }finally{s.close();}
});

test('ambiguous office pages, unavailable numeric profiles and account-type uncertainty remain unbound',()=>{
  const s=setup();try{
    let r=report();r.observations[0].profiles=[];assert.deepEqual(preview(s,r).counts,{'no-profile-link':1});
    r=report();r.observations[0].profiles.push(r.observations[0].profiles[0]);assert.deepEqual(preview(s,r).counts,{'multiple-profile-links':1});
    s.db.prepare("UPDATE list_inventory_accounts SET username='CampaignSynthetic'").run();assert.deepEqual(preview(s).counts,{'numeric-profile-not-observed':1});
    s.db.prepare("UPDATE list_inventory_accounts SET username='VoteSynthetic',display_name='Synthetic Candidate'").run();
    r=report();r.observations[0].profiles=[{handle:'VoteSynthetic',url:'https://x.com/VoteSynthetic',observedHref:'https://x.com/VoteSynthetic'}];
    assert.deepEqual(preview(s,r).counts,{'account-type-review':1});
    assert.equal(applyAccountEvidence(s,preview(s,r),{now}).bindingsAdded,0);
  }finally{s.close();}
});

test('the same profile observed with conflicting numeric identities is refused',()=>{
  const s=setup();try{
    s.db.prepare('INSERT INTO list_inventory_accounts(run_id,author_id,username,display_name,observed_at,profile_json) VALUES (?,?,?,?,?,?)').run('synthetic','43','RepSynthetic','Representative Synthetic',at,'{}');
    assert.deepEqual(preview(s).counts,{'conflicting-numeric-profiles':1});
  }finally{s.close();}
});

test('a fresh roster observation extends ownership with adjacent evidence instead of rewriting history',()=>{
  const s=setup();try{
    applyAccountEvidence(s,preview(s),{now});
    const original=s.db.prepare('SELECT * FROM account_bindings').get();
    importRoster(s.db,{schemaVersion:1,id:'b'.repeat(64),sourceUrl:CLERK_SOURCE,congress:'119',publishedOn:'2026-09-07',retrievedAt:'2026-09-08T08:00:00Z',members:[member]},{now});
    const r=report();r.rosterHash='b'.repeat(64);r.rosterRetrievedAt='2026-09-08T08:00:00Z';
    const candidates=preview(s,r);assert.equal(candidates.items[0].status,'ready');
    assert.equal(candidates.items[0].bindings[0].validFrom,original.valid_until);
    assert.equal(applyAccountEvidence(s,candidates,{now}).bindingsAdded,1);
    assert.deepEqual(s.db.prepare('SELECT * FROM account_bindings WHERE id=?').get(original.id),original);
    assert.equal(preview(s,r).items[0].status,'already-covered');
  }finally{s.close();}
});
