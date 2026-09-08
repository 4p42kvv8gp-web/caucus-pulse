import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openStore } from './db.js';
import { dashboardData, phraseData } from './dashboard.js';
import { promoteCaptured } from './roster.js';
import { createCredentialStore } from './credentials.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const settings = JSON.parse(readFileSync(resolve(root, 'config/settings.json'), 'utf8'));
const staticFiles = new Map([
  ['/', ['site/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['site/app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['site/style.css', 'text/css; charset=utf-8']]
]);

function filtersFrom(url) {
  const result = Object.fromEntries(['query', 'memberId', 'topic', 'type', 'since', 'until'].map(k => [k, url.searchParams.get(k) ?? '']));
  for (const k of ['since', 'until']) {
    if (result[k]) {
      if (!Number.isFinite(Date.parse(result[k]))) throw new Error('Invalid date filter.');
      result[k] = new Date(result[k]).toISOString();
    }
  }
  return result;
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

export function createServer(store, { credentials = createCredentialStore(resolve(root, 'data/secrets')) } = {}) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const port = server.address()?.port;
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    function json(status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
    if (!allowedHosts.includes(req.headers.host)) return json(403, { error: 'Local access only.' });
    if (req.headers.origin && !allowedHosts.some(host => req.headers.origin === `http://${host}`)) return json(403, { error: 'Origin is not allowed.' });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    try {
      if (req.method === 'GET' && staticFiles.has(url.pathname)) {
        const [file, type] = staticFiles.get(url.pathname);
        res.writeHead(200, { 'Content-Type': type }); return res.end(readFileSync(resolve(root, file)));
      }
      if (req.method === 'GET' && url.pathname === '/api/dashboard') return json(200, { ...dashboardData(store, filtersFrom(url), settings), connection: credentials.status() });
      if (req.method === 'POST' && url.pathname === '/api/settings/x-credential') {
        if (!allowedHosts.some(host => req.headers.origin === `http://${host}`)) return json(403, { error: 'Save credentials from the local connection form.' });
        const value = await readJson(req);
        if (!value || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'bearerToken')) throw new Error('Invalid credential request.');
        return json(200, { ...credentials.save(value.bearerToken), accessVerified: false, collectionStarted: false });
      }
      if (req.method === 'GET' && url.pathname === '/api/phrases') return json(200, phraseData(store, url.searchParams.get('phrase'), filtersFrom(url)));
      const match = url.pathname.match(/^\/api\/posts\/(\d+)(\/feedback)?$/);
      if (match) {
        if (!store.getPost(match[1])) return json(404, { error: 'Post not found.' });
        if (req.method === 'GET' && !match[2]) return json(200, store.getPost(match[1]));
        if (req.method === 'POST' && match[2]) return json(200, store.saveFeedback(match[1], await readJson(req)));
      }
      return json(404, { error: 'Not found.' });
    } catch (error) {
      const safe = /^(Invalid |Expected JSON|Request is too large|Provide up to|Remove duplicate|Enter an exact)/.test(error.message);
      return json(safe ? 400 : 500, { error: safe ? error.message : 'The request could not be completed. Source data is retained.' });
    }
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const store = openStore(process.env.CAUCUS_DB_PATH ?? resolve(root, 'data/pulse.sqlite'));
  function processLocalRecords() { promoteCaptured(store); store.analyzePending(); }
  processLocalRecords();
  const server = createServer(store);
  const port = Number(process.env.PORT ?? 4317);
  server.listen(port, '127.0.0.1', () => console.log(`Caucus Pulse local preview: http://127.0.0.1:${server.address().port}`));
  const interval = setInterval(processLocalRecords, 60_000);
  function shutdown() { clearInterval(interval); server.close(() => { store.close(); process.exit(0); }); }
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
