import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openStore } from './db.js';
import { dashboardData, phraseData } from './dashboard.js';
import { promoteCaptured } from './roster.js';
import { createCredentialStore } from './credentials.js';
import { learningStatus, postLearningHistory } from './learning-context.js';
import { evaluationReport } from './evaluation.js';
import { languageData } from './language.js';
import { explorerPage,searchFilters,reviewQueue } from './explorer.js';
import { embeddingStatus,processEmbeddingJobs } from './embedding-store.js';
import { createEmbeddingClient } from './embedding-client.js';
import { semanticSearch } from './semantic-search.js';
import { createLocalClassifierClient } from './classifier-client.js';
import { classificationStatus, queueClassification, processClassificationJobs } from './classifier-jobs.js';
import { subjectGroups } from './subject-groups.js';
import {incidentDesk,postIncidents,saveIncidentReview,createIncidentCase,incidentCase,updateIncidentCase} from './incidents.js';
import {accessFromEnvironment} from './access.js';
import {operationalStatus} from './operational-status.js';
import {drainLocalQueue} from './local-processing.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const settings = JSON.parse(readFileSync(resolve(root, 'config/settings.json'), 'utf8'));
const staticFiles = new Map([
  ['/', ['site/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['site/app.js', 'text/javascript; charset=utf-8']],
  ['/incident-desk.js', ['site/incident-desk.js', 'text/javascript; charset=utf-8']],
  ['/incident-helpers.js', ['site/incident-helpers.js', 'text/javascript; charset=utf-8']],
  ['/overview.js', ['site/overview.js', 'text/javascript; charset=utf-8']],
  ['/source-text.js', ['site/source-text.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['site/style.css', 'text/css; charset=utf-8']]
]);

function filtersFrom(url) {
  const result = Object.fromEntries(['query', 'memberId', 'topic', 'subtopic', 'type', 'accountType', 'since', 'until'].map(k => [k, url.searchParams.get(k) ?? '']));
  for (const k of ['since', 'until']) {
    if (result[k]) {
      if (!Number.isFinite(Date.parse(result[k]))) throw new Error('Invalid date filter.');
      result[k] = new Date(result[k]).toISOString();
    }
  }
  return result;
}

function pageOptions(url) {
  const options = { cursor:url.searchParams.get('cursor') ?? '' };
  if (url.searchParams.has('limit')) {
    const value = url.searchParams.get('limit');
    if (!/^\d+$/.test(value)) throw new Error('Invalid page size.');
    options.limit = Number(value);
  }
  return options;
}

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('Expected JSON.');
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32_768) throw new Error('Request is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Invalid JSON.'); }
}

export function createServer(store, { credentials = createCredentialStore(resolve(root, 'data/secrets')),semantic = null, classifier = null,access=null } = {}) {
  let grouping=false;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if(access)res.setHeader('Strict-Transport-Security','max-age=86400');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const port = server.address()?.port;
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`,...(access?[access.publicHost]:[])];
    const allowedOrigins=access?[access.publicOrigin]:allowedHosts.map(host=>`http://${host}`);
    function json(status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
    if (!allowedHosts.includes(req.headers.host)) return json(403, { error: 'Workspace host is not allowed.' });
    if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) return json(403, { error: 'Origin is not allowed.' });
    if(access&&!['GET','HEAD'].includes(req.method)&&req.headers.origin!==access.publicOrigin)return json(403,{error:'Use the authorized workspace origin for changes.'});
    if(typeof req.url!=='string'||req.url.length>8192)return json(414,{error:'Request URL is too long.'});
    let url;try{url=new URL(req.url, `http://127.0.0.1:${port}`);}catch{return json(400,{error:'Invalid request URL.'});}
    try {
      if(req.method==='GET'&&url.pathname==='/healthz')return json(200,{ok:true});
      let identity={reviewer:'local-user'};
      if(access){try{identity=await access.verifyRequest(req);}catch(error){return json(error.status===503?503:401,{error:error.status===503?'Private access verification is temporarily unavailable.':'Sign in with the authorized workspace account.',code:error.status===503?'ACCESS_UNAVAILABLE':'ACCESS_DENIED'});}}
      if (req.method === 'GET' && staticFiles.has(url.pathname)) {
        const [file, type] = staticFiles.get(url.pathname);
        res.writeHead(200, { 'Content-Type': type }); return res.end(readFileSync(resolve(root, file)));
      }
      if (req.method === 'GET' && url.pathname === '/api/dashboard') {
        const connection=credentials.status();
        return json(200, { ...dashboardData(store, filtersFrom(url), settings, pageOptions(url)),access:{mode:access?'private-access':'local'}, connection, classification: classificationStatus(store), classifierRuntime: classifier?.runtime?.status() ?? {ready:false,busy:false,queued:0},
          operationalStatus:operationalStatus(store,settings,{classifier,semantic,connection}) });
      }
      if(req.method==='GET'&&url.pathname==='/api/operations')return json(200,operationalStatus(store,settings,{classifier,semantic,connection:credentials.status()}));
      if (req.method === 'GET' && url.pathname === '/api/posts') return json(200, explorerPage(store, filtersFrom(url), pageOptions(url)));
      if (req.method === 'GET' && url.pathname === '/api/review-queue') return json(200, reviewQueue(store, filtersFrom(url)));
      if(req.method==='GET'&&url.pathname==='/api/incidents')return json(200,incidentDesk(store,filtersFrom(url)));
      if(req.method==='POST'&&url.pathname==='/api/incidents/cases')return json(201,createIncidentCase(store,await readJson(req)));
      const incidentCaseMatch=url.pathname.match(/^\/api\/incidents\/cases\/([a-f0-9-]{36})$/);
      if(incidentCaseMatch){
        if(req.method==='GET')return json(200,incidentCase(store,incidentCaseMatch[1]));
        if(req.method==='PATCH')return json(200,updateIncidentCase(store,incidentCaseMatch[1],await readJson(req)));
      }
      const incidentPostMatch=url.pathname.match(/^\/api\/posts\/(\d+)\/incidents$/);
      if(incidentPostMatch){
        if(req.method==='GET')return json(200,postIncidents(store,incidentPostMatch[1]));
        if(req.method==='POST')return json(200,saveIncidentReview(store,incidentPostMatch[1],await readJson(req)));
      }
      if (req.method === 'GET' && url.pathname === '/api/classification') return json(200, {
        ...classificationStatus(store), runtime: classifier?.runtime?.status() ?? {ready:false,busy:false,queued:0}, state: classifier?.state ?? 'not-started'
      });
      const classifierMatch = url.pathname.match(/^\/api\/posts\/(\d+)\/classification$/);
      if (req.method === 'POST' && classifierMatch) {
        const body = await readJson(req);
        if (!body || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.sourceHash)) throw new Error('Invalid classification request.');
        if (!classifier?.runtime?.status().ready) return json(503, {error:'The local classifier is not ready. Source posts remain available.',code:'CLASSIFIER_UNAVAILABLE'});
        const result = queueClassification(store, classifierMatch[1], body.sourceHash);
        classifier.process?.();
        return json(202, result);
      }
      if (req.method === 'GET' && url.pathname === '/api/semantic') return json(200, {
        ...embeddingStatus(store,semantic?.name??'minilm'),runtime:semantic?.runtime?.status()??{ready:false,busy:false,queued:0},
        state:semantic?.state??'not-started'
      });
      if (req.method === 'POST' && url.pathname === '/api/semantic/search') {
        const body=await readJson(req);
        if (!body || Array.isArray(body) || Object.keys(body).some(k=>!['query','filters','limit'].includes(k)) ||
            typeof body.query!=='string' || !body.query.trim() || body.query.length>2000 || body.query.includes('\0') ||
            (body.filters!==undefined && (!body.filters || typeof body.filters!=='object' || Array.isArray(body.filters)))) throw new Error('Invalid semantic search request.');
        const filters=searchFilters(body.filters??{}),limit=body.limit??20;
        if (!Number.isInteger(limit) || limit<1 || limit>50) throw new Error('Invalid semantic search result limit.');
        if (!semantic?.runtime?.status().ready) return json(503,{error:'Local semantic search is not ready. Source posts remain available.',code:'SEMANTIC_UNAVAILABLE'});
        const embedding=await semantic.runtime.embedQuery(body.query);
        return json(200,semanticSearch(store,embedding,{name:semantic.name,filters,limit}));
      }
      if (req.method === 'POST' && url.pathname === '/api/settings/x-credential') {
        if (!allowedOrigins.includes(req.headers.origin)) return json(403, { error: 'Save credentials from the authorized connection form.' });
        const value = await readJson(req);
        if (!value || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'bearerToken')) throw new Error('Invalid credential request.');
        return json(200, { ...credentials.save(value.bearerToken), accessVerified: false, collectionStarted: false });
      }
      if (req.method === 'GET' && url.pathname === '/api/phrases') return json(200, phraseData(store, url.searchParams.get('phrase'), filtersFrom(url)));
      if (req.method === 'GET' && url.pathname === '/api/learning') return json(200, learningStatus(store));
      if (req.method === 'GET' && url.pathname === '/api/language') {
        const options = {};
        for (const key of ['minWords','minMembers','limit','windowHours']) if (url.searchParams.has(key)) {
          const value = url.searchParams.get(key);
          if (!/^\d+$/.test(value)) throw new Error('Invalid language option.');
          options[key] = Number(value);
        }
        return json(200, languageData(store, { ...filtersFrom(url), subtopic: url.searchParams.get('subtopic') ?? '' }, options));
      }
      if(req.method==='GET'&&url.pathname==='/api/emerging'){
        if(grouping)return json(429,{error:'Subject grouping is already running. Try again shortly.',code:'DISCOVERY_BUSY'});
        const options={name:semantic?.name??'minilm'};
        for(const key of ['threshold','minMembers','minPosts','limit','windowHours'])if(url.searchParams.has(key))options[key]=Number(url.searchParams.get(key));
        grouping=true;
        try{return json(200,await subjectGroups(store,filtersFrom(url),options));}
        finally{grouping=false;}
      }
      const learningMatch = url.pathname.match(/^\/api\/posts\/(\d+)\/learning$/);
      if (req.method === 'GET' && learningMatch) {
        if (!store.getPost(learningMatch[1])) return json(404, { error: 'Post not found.' });
        return json(200, postLearningHistory(store, learningMatch[1]));
      }
      const evaluationMatch = url.pathname.match(/^\/api\/evaluations\/([a-f0-9-]+)$/);
      if (req.method === 'GET' && evaluationMatch) return json(200, evaluationReport(store, evaluationMatch[1]));
      const match = url.pathname.match(/^\/api\/posts\/(\d+)(\/feedback)?$/);
      if (match) {
        if (!store.getPost(match[1])) return json(404, { error: 'Post not found.' });
        if (req.method === 'GET' && !match[2]) return json(200, store.getPost(match[1]));
        if (req.method === 'POST' && match[2]) {
          const body=await readJson(req);
          if(!body||Array.isArray(body)||Object.keys(body).some(k=>!['sourceHash','predictionHash','reviewId','labels','decision','reason','ruleProposal'].includes(k))||
            !/^[a-f0-9]{64}$/.test(body.sourceHash??'')||!/^[a-f0-9]{64}$/.test(body.predictionHash??'')||
            (body.reviewId!==null&&!/^[a-f0-9-]{36}$/.test(body.reviewId??'')))throw new Error('Invalid review versions: reload the post before saving.');
          return json(200, store.saveFeedback(match[1],body,identity.reviewer));
        }
      }
      return json(404, { error: 'Not found.' });
    } catch (error) {
      if (error.code === 'EXPLORER_CHANGED') return json(409, { error:error.message,code:error.code });
      if (error.code === 'CLASSIFIER_STALE' || error.code === 'PREDICTION_CHANGED' || error.code==='REVIEW_CHANGED') return json(409, {error:error.message,code:error.code});
      if (error.code === 'CLASSIFIER_NOT_FOUND') return json(404, {error:'Post not found.'});
      if(error.code==='INCIDENT_CHANGED')return json(409,{error:error.message,code:error.code});
      if(error.code==='INCIDENT_NOT_FOUND')return json(404,{error:error.message,code:error.code});
      if(error.code==='DISCOVERY_CHANGED')return json(409,{error:error.message,code:error.code});
      if(error.code==='DISCOVERY_UNAVAILABLE')return json(503,{error:error.message,code:error.code});
      if (['SEMANTIC_UNAVAILABLE','SEMANTIC_BUSY','SEMANTIC_INPUT_LIMIT'].includes(error.code)) return json(
        error.code==='SEMANTIC_INPUT_LIMIT'?400:error.code==='SEMANTIC_BUSY'?429:503,{error:error.message,code:error.code});
      const safe = /^(Invalid |Expected JSON|Request is too large|Provide up to|Remove duplicate|Enter an exact)/.test(error.message);
      return json(safe ? 400 : 500, { error: safe ? error.message : 'The request could not be completed. Source data is retained.' });
    }
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.maxHeadersCount=40;server.maxRequestsPerSocket=100;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const access=accessFromEnvironment();
  const store = openStore(process.env.CAUCUS_DB_PATH ?? resolve(root, 'data/pulse.sqlite'));
  function processLocalRecords() { promoteCaptured(store); store.analyzePending(); }
  processLocalRecords();
  const semantic={name:settings.intelligence?.localEmbeddings?.model??'minilm',runtime:null,state:'disabled'};
  const classifier={runtime:null,state:'disabled',process:()=>void processLocalClassifications()};
  const modelLifetime=new AbortController();
  let embeddingPass=false,classifierPass=false,stopping=false;
  async function processLocalClassifications() {
    if (stopping || classifierPass || !classifier.runtime?.status().ready) return;
    classifierPass=true;
    try { await drainLocalQueue({ready:()=>classifier.runtime.status().ready,stopping:()=>stopping,
      runPass:()=>processClassificationJobs(store,classifier.runtime,{limit:settings.intelligence?.localClassifier?.postsPerPass??5,stopping:()=>stopping})}); }
    catch { classifier.state='worker-needs-attention'; }
    finally { classifierPass=false; }
  }
  async function processLocalEmbeddings() {
    if (stopping || embeddingPass || !semantic.runtime?.status().ready) return;
    embeddingPass=true;
    try { await drainLocalQueue({ready:()=>semantic.runtime.status().ready,stopping:()=>stopping,
      runPass:()=>processEmbeddingJobs(store,semantic.runtime,{limit:settings.intelligence?.localEmbeddings?.postsPerPass??25,stopping:()=>stopping})}); }
    catch { semantic.state='worker-needs-attention'; }
    finally { embeddingPass=false; }
  }
  let warmup=Promise.resolve();
  if (settings.intelligence?.localEmbeddings?.enabled) {
    semantic.state='starting';
    warmup=createEmbeddingClient({name:semantic.name,modelRoot:resolve(root,'data/models'),signal:modelLifetime.signal})
      .then(async runtime=>{semantic.runtime=runtime;semantic.state='ready';if(stopping)await runtime.close();else await processLocalEmbeddings();})
      .catch(()=>{semantic.state='model-unavailable';});
  }
  let classifierWarmup=Promise.resolve();
  if(settings.intelligence?.localClassifier?.enabled && process.env.CAUCUS_DISABLE_LOCAL_CLASSIFIER!=='1'){
    classifier.state='starting';
    classifierWarmup=createLocalClassifierClient({signal:modelLifetime.signal})
      .then(async runtime=>{classifier.runtime=runtime;classifier.state='ready';if(stopping)await runtime.close();else await processLocalClassifications();})
      .catch(()=>{classifier.state='model-unavailable';});
  }
  const server = createServer(store,{semantic,classifier,access});
  const port = Number(process.env.PORT ?? 4317);
  server.listen(port, '127.0.0.1', () => console.log(`Caucus Pulse local preview: http://127.0.0.1:${server.address().port}`));
  const interval = setInterval(()=>{processLocalRecords();void processLocalEmbeddings();void processLocalClassifications();},60_000);
  async function shutdown() {
    if(stopping)return;stopping=true;clearInterval(interval);modelLifetime.abort();
    const closed=new Promise(resolve=>server.close(resolve));
    await Promise.all([warmup,classifierWarmup]);await Promise.all([semantic.runtime?.close(),classifier.runtime?.close()]);await closed;
    // Let a cancelled inference finish its fenced bookkeeping before closing SQLite.
    while(embeddingPass||classifierPass)await new Promise(resolve=>setImmediate(resolve));
    store.close();process.exit(0);
  }
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
