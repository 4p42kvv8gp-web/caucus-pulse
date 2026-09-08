import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {createAccessVerifier,accessFromEnvironment} from '../src/access.js';
import {openStore} from '../src/db.js';
import {createServer} from '../src/server.js';
import {normalizePost} from '../src/normalize.js';
import http from 'node:http';

const pair=await generateKeyPair('RS256',{modulusLength:2048}),second=await generateKeyPair('RS256',{modulusLength:2048});
const jwk={...await exportJWK(pair.publicKey),kid:'synthetic-key',alg:'RS256',use:'sig'};
const config={teamDomain:'https://synthetic-team.cloudflareaccess.com',audience:'a'.repeat(64),ownerEmail:'owner@example.invalid',publicOrigin:'https://pulse.example.invalid'};
const now=Date.now(),seconds=Math.floor(now/1000);
async function token(claims={},header={},key=pair.privateKey){return new SignJWT({iss:config.teamDomain,aud:[config.audience],sub:'synthetic-owner',email:config.ownerEmail,iat:seconds,exp:seconds+3600,...claims}).setProtectedHeader({alg:'RS256',kid:'synthetic-key',typ:'JWT',...header}).sign(key);}
const request=value=>({headers:{'cf-access-jwt-assertion':value}});
function verifier(){const calls=[];const access=createAccessVerifier(config,{clock:()=>now,fetcher:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({keys:[jwk]}),{status:200});}});return {access,calls};}

test('private access verifies signature, application, issuer, owner and bounded session claims',async()=>{
  const {access,calls}=verifier(),valid=await token();
  assert.deepEqual(await access.verifyRequest(request(valid)),{reviewer:'access:synthetic-owner',owner:true});
  await access.verifyRequest(request(valid));assert.equal(calls.length,1);assert.equal(calls[0].url,config.teamDomain+'/cdn-cgi/access/certs');
  assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.credentials,'omit');
  for(const claims of [{aud:['b'.repeat(64)]},{iss:'https://different.cloudflareaccess.com'},{email:'someone-else@example.invalid'},{exp:seconds-60},{iat:seconds+60},{iat:seconds-90000,exp:seconds+100},{exp:seconds+90000},{sub:''}])await assert.rejects(access.verifyRequest(request(await token(claims))),e=>e.code==='ACCESS_DENIED');
  await assert.rejects(access.verifyRequest(request(await token({}, {},second.privateKey))),e=>e.code==='ACCESS_DENIED');
  await assert.rejects(access.verifyRequest(request(await token({}, {jku:'https://attacker.invalid/keys'}))),e=>e.code==='ACCESS_DENIED');
  assert.equal(calls.length,1,'Untrusted token headers never choose a remote key URL');
});

test('missing, malformed, algorithm-confused and oversized tokens fail without key requests',async()=>{
  const {access,calls}=verifier();
  for(const value of [undefined,[],['one','two'],'not-a-token','x'.repeat(16001),'e30.e30.invalid'])await assert.rejects(access.verifyRequest(request(value)),e=>e.code==='ACCESS_DENIED');
  const symmetric=await new SignJWT({iss:config.teamDomain}).setProtectedHeader({alg:'HS256'}).sign(new Uint8Array(32));
  await assert.rejects(access.verifyRequest(request(symmetric)),e=>e.code==='ACCESS_DENIED');assert.equal(calls.length,0);
});

test('unavailable or oversized verification keys never open access and repeated failures are bounded',async()=>{
  const valid=await token();let calls=0;
  const failed=createAccessVerifier(config,{clock:()=>now,fetcher:async()=>{calls++;return new Response('Unavailable',{status:503});}});
  await assert.rejects(failed.verifyRequest(request(valid)),e=>e.code==='ACCESS_UNAVAILABLE');
  await assert.rejects(failed.verifyRequest(request(valid)),e=>e.code==='ACCESS_UNAVAILABLE');assert.equal(calls,1);
  const huge=createAccessVerifier(config,{clock:()=>now,fetcher:async()=>new Response('x'.repeat(262145),{status:200})});
  await assert.rejects(huge.verifyRequest(request(valid)),e=>e.code==='ACCESS_UNAVAILABLE');
  let cancelled=false;
  const oversizedHeader=createAccessVerifier(config,{clock:()=>now,fetcher:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'Content-Length':'262145'}})});
  await assert.rejects(oversizedHeader.verifyRequest(request(valid)),e=>e.code==='ACCESS_UNAVAILABLE');assert.equal(cancelled,true);
});

test('incomplete hosting configuration cannot silently fall back to unauthenticated local mode',()=>{
  assert.equal(accessFromEnvironment({}),null);
  assert.throws(()=>accessFromEnvironment({NODE_ENV:'production'}),/requires cloudflare-access/);
  assert.throws(()=>accessFromEnvironment({CAUCUS_PUBLIC_ORIGIN:config.publicOrigin}),/requires cloudflare-access/);
  assert.throws(()=>createAccessVerifier({...config,teamDomain:'https://attacker.invalid'}),/team domain/);
  assert.throws(()=>createAccessVerifier({...config,publicOrigin:'http://pulse.example.invalid'}),/HTTPS/);
  assert.throws(()=>createAccessVerifier({...config,publicOrigin:'https://pulse.example.invalid/path'}),/origin/);
  assert.throws(()=>createAccessVerifier({...config,audience:''}),/audience/);
});

test('protected pages and APIs require the owner even through loopback, and reviews record verified identity',async()=>{
  const store=openStore();store.upsertAccount({authorId:'1',memberId:'synthetic',memberName:'Synthetic Member',handle:'Synthetic'});
  store.ingest(normalizePost({id:'1',author_id:'1',text:'Synthetic source wording.',created_at:'2026-09-08T00:00:00Z'}));store.analyzePending();
  const {access}=verifier(),server=createServer(store,{access});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`,valid=await token();
  try{
    for(const path of ['/','/app.js','/api/dashboard','/api/posts/1','/api/incidents','/api/operations','/api/captures/unverified'])assert.equal((await fetch(base+path)).status,401,path);
    const health=await fetch(base+'/healthz');assert.equal(health.status,200);assert.deepEqual(await health.json(),{ok:true});
    const response=await fetch(base+'/api/posts/1',{headers:{'cf-access-jwt-assertion':valid,Host:'pulse.example.invalid',Origin:config.publicOrigin}});assert.equal(response.status,200);const post=await response.json();
    assert.equal((await fetch(base+'/api/posts/1',{headers:{'cf-access-jwt-assertion':valid,Origin:'https://attacker.invalid'}})).status,403);
    const saved=await fetch(base+'/api/posts/1/feedback',{method:'POST',headers:{'Content-Type':'application/json','cf-access-jwt-assertion':valid,Origin:config.publicOrigin},body:JSON.stringify({sourceHash:post.contentHash,predictionHash:post.analysisHash,reviewId:post.reviewId,labels:[],decision:'no-supported-topic',reason:'Synthetic owner review.'})});
    assert.equal(saved.status,200);assert.equal((await saved.json()).feedback[0].reviewer,'access:synthetic-owner');
    const dashboard=await(await fetch(base+'/api/dashboard',{headers:{'cf-access-jwt-assertion':valid}})).json();assert.equal(dashboard.access.mode,'private-access');
    assert.equal((await fetch(base+'/api/posts/1/feedback',{method:'POST',headers:{'Content-Type':'application/json','cf-access-jwt-assertion':valid},body:'{}'})).status,403);
    assert.equal((await fetch(base+'/?'+ 'x'.repeat(8200),{headers:{'cf-access-jwt-assertion':valid}})).status,414);
    const malformed=await new Promise((resolve,reject)=>{const req=http.request(base,{path:'http://[',headers:{'cf-access-jwt-assertion':valid}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});assert.equal(malformed,400);
    assert.equal((await fetch(base+'/healthz')).status,200,'Malformed requests leave the listener running');
  }finally{await new Promise(resolve=>server.close(resolve));store.close();}
});
