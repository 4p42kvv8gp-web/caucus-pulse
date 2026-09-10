import {createRemoteJWKSet,jwtVerify,customFetch} from 'jose';

export class AccessError extends Error {
  constructor(code='ACCESS_DENIED'){super(code==='ACCESS_UNAVAILABLE'?'Private access verification is temporarily unavailable.':'Sign in with the authorized workspace account.');this.code=code;this.status=code==='ACCESS_UNAVAILABLE'?503:401;}
}

export function createAccessVerifier({teamDomain,audience,ownerEmail,publicOrigin},{fetcher=fetch,clock=()=>Date.now()}={}) {
  if(typeof teamDomain!=='string'||!/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(teamDomain))throw new Error('Configure an exact HTTPS Cloudflare Access team domain.');
  if(typeof audience!=='string'||!/^[a-f0-9]{64}$/.test(audience))throw new Error('Configure the application’s exact Access audience tag.');
  if(typeof ownerEmail!=='string'||ownerEmail.length>254||!/^\S+@[^@\s]+\.[^@\s]+$/.test(ownerEmail))throw new Error('Configure the single authorized workspace owner email.');
  let origin;try{origin=new URL(publicOrigin);}catch{throw new Error('Configure the public HTTPS workspace origin.');}
  if(origin.protocol!=='https:'||origin.origin!==publicOrigin||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('Configure one exact HTTPS workspace origin, without a path or credentials.');
  const jwksUrl=teamDomain+'/cdn-cgi/access/certs';let lastFailure=-Infinity;
  const keys=createRemoteJWKSet(new URL(jwksUrl),{timeoutDuration:5000,cooldownDuration:30000,cacheMaxAge:300000,
    [customFetch]:async(url,options)=>{
      if(url!==jwksUrl||clock()-lastFailure<30000)throw new AccessError('ACCESS_UNAVAILABLE');
      let response;
      try{
        response=await fetcher(jwksUrl,{...options,method:'GET',redirect:'error',credentials:'omit',headers:{Accept:'application/json'}});
        if(response.status!==200||!response.body)throw new Error('Access key service unavailable.');
        const length=Number(response.headers.get('content-length')??0);if(length>262144)throw new Error('Oversized key response.');
        let size=0;const chunks=[];
        for await(const chunk of response.body){size+=chunk.length;if(size>262144)throw new Error('Oversized key response.');chunks.push(chunk);}
        const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(!Array.isArray(body.keys)||!body.keys.length||body.keys.length>8||body.keys.some(k=>!k||k.kty!=='RSA'||(k.alg&&k.alg!=='RS256')||typeof k.kid!=='string'||k.kid.length>200||typeof k.n!=='string'||k.n.length>2000||typeof k.e!=='string'||k.e.length>20||k.d))throw new Error('Invalid public verification keys.');
        if(new Set(body.keys.map(k=>k.kid)).size!==body.keys.length)throw new Error('Duplicate key identifiers.');
        return new Response(JSON.stringify({keys:body.keys}),{status:200,headers:{'Content-Type':'application/json'}});
      }catch{if(response?.body&&!response.body.locked)await response.body.cancel().catch(()=>{});lastFailure=clock();throw new AccessError('ACCESS_UNAVAILABLE');}
    }});
  async function verifyRequest(request) {
    const token=request.headers['cf-access-jwt-assertion'];
    if(typeof token!=='string'||!token||token.length>16000||token.split('.').length!==3)throw new AccessError();
    try{
      const {payload,protectedHeader}=await jwtVerify(token,keys,{issuer:teamDomain,audience,algorithms:['RS256'],requiredClaims:['iss','aud','sub','email','exp','iat'],maxTokenAge:'24h',clockTolerance:30,currentDate:new Date(clock())});
      if(protectedHeader.crit||protectedHeader.jku||protectedHeader.jwk||protectedHeader.x5u||typeof payload.sub!=='string'||!payload.sub||payload.sub.length>200||
        typeof payload.email!=='string'||payload.email.toLowerCase()!==ownerEmail.toLowerCase()||!Number.isSafeInteger(payload.exp)||!Number.isSafeInteger(payload.iat)||payload.exp-payload.iat>86400||payload.exp<=payload.iat)throw new AccessError();
      return {reviewer:`access:${payload.sub}`,owner:true};
    }catch(error){if(error instanceof AccessError)throw error;if(error.code==='ERR_JWKS_TIMEOUT'||error.code==='ERR_JWKS_INVALID'||error.code==='ERR_JWKS_FETCH_FAILED')throw new AccessError('ACCESS_UNAVAILABLE');throw new AccessError();}
  }
  return {mode:'cloudflare-access',publicOrigin:origin.origin,publicHost:origin.host,verifyRequest};
}

export function accessFromEnvironment(env=process.env,options) {
  const fields=['CAUCUS_PUBLIC_ORIGIN','CAUCUS_ACCESS_TEAM_DOMAIN','CAUCUS_ACCESS_AUDIENCE','CAUCUS_OWNER_EMAIL'];
  const mode=env.CAUCUS_AUTH_MODE??'local';
  if(mode==='local'){
    if(env.NODE_ENV==='production'||fields.some(key=>env[key]))throw new Error('Production or public-origin configuration requires cloudflare-access authentication.');
    return null;
  }
  if(mode!=='cloudflare-access')throw new Error('Invalid authentication mode.');
  return createAccessVerifier({teamDomain:env.CAUCUS_ACCESS_TEAM_DOMAIN,audience:env.CAUCUS_ACCESS_AUDIENCE,ownerEmail:env.CAUCUS_OWNER_EMAIL,publicOrigin:env.CAUCUS_PUBLIC_ORIGIN},options);
}
