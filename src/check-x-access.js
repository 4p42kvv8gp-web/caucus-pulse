// Sanitized X credential check. Prints status codes and counts only — never
// the token, never post text. Works in both auth modes: with X_BEARER_TOKEN
// set it sends the header itself; without one it sends bare requests and
// relies on a proxy-injected credential (claude.ai/code "API credentials"
// registered for api.x.com), reporting which mode authenticated. Free calls by default; --probe spends at most
// ~$0.03 (one 5-post list page) to confirm paid access and to settle whether
// the list-tweets endpoint accepts since_id.
//
//   node src/check-x-access.js            # free: /2/usage/tweets, /2/usage/credits
//   node src/check-x-access.js --probe    # + one 5-post list page + since_id probe
import { settings } from './util.js';
import { usageTweets } from './x.js';

const API = 'https://api.x.com/2';
const probe = process.argv.includes('--probe');

function candidates() {
  const raw = process.env.X_BEARER_TOKEN || '';
  let decoded = null;
  try { decoded = decodeURIComponent(raw); } catch { /* not encoded */ }
  return [...new Set([raw, decoded].filter(Boolean))];
}

async function call(path, tok) {
  const res = await fetch(`${API}${path}`, {
    headers: tok ? { Authorization: `Bearer ${tok}` } : {},
    redirect: 'error',
    signal: AbortSignal.timeout(30_000)
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

function summarize(body) {
  if (!body || typeof body !== 'object') return 'non-json';
  const keys = Object.keys(body);
  const out = { keys };
  if (Array.isArray(body.data)) out.dataCount = body.data.length;
  if (body.meta) out.meta = Object.keys(body.meta);
  if (body.errors) out.errors = body.errors.map((e) => e.title || e.type || 'error');
  if (body.title) out.title = body.title;
  if (body.detail) out.detail = String(body.detail).slice(0, 120);
  return out;
}

async function main() {
  const toks = candidates();
  // '' = bare request, authenticated (if at all) by the egress proxy.
  const proxyMode = !toks.length;
  if (proxyMode) {
    console.log('X_BEARER_TOKEN: absent — trying a bare request for a proxy-injected credential (api.x.com)');
    toks.push('');
  } else {
    console.log(`X_BEARER_TOKEN: present (${toks[0].length} chars, ${toks.length} form(s) to try)`);
  }

  // Which token form authenticates? Free usage endpoint, through the shared
  // client (x.usageTweets) so the same code path the narrative layer's
  // reconcile step uses is what gets checked here.
  let tok = null;
  for (const t of toks) {
    const saved = process.env.X_BEARER_TOKEN;
    if (t) process.env.X_BEARER_TOKEN = t; else { delete process.env.X_BEARER_TOKEN; process.env.X_PROXY_AUTH = '1'; }
    try {
      const u = await usageTweets(1);
      console.log('GET /2/usage/tweets?days=1 → 200', JSON.stringify({
        projectUsage: u.projectUsage, projectCap: u.projectCap, capResetDay: u.capResetDay, dailyRows: u.days.length
      }));
      tok = t;
    } catch (e) {
      console.log(`GET /2/usage/tweets?days=1 → ${e.status || 'error'} ${String(e.message).slice(0, 120)}`);
    } finally {
      if (saved === undefined) delete process.env.X_BEARER_TOKEN; else process.env.X_BEARER_TOKEN = saved;
    }
    if (tok !== null) break;
  }
  if (tok === null) {
    console.log(proxyMode
      ? 'RESULT: no credential — X_BEARER_TOKEN is unset and the proxy did not authenticate the bare request'
      : 'RESULT: token rejected on the free usage endpoint (401/403) — check the key');
    process.exit(proxyMode ? 2 : 1);
  }
  console.log(`AUTH MODE: ${proxyMode ? 'proxy-injected credential (set X_PROXY_AUTH=1 for the poller)' : 'X_BEARER_TOKEN'}`);

  const credits = await call('/usage/credits', tok);
  console.log(`GET /2/usage/credits → ${credits.status}`, JSON.stringify(summarize(credits.body)));
  if (credits.status === 200 && credits.body?.data) {
    const d = credits.body.data;
    console.log('  balance fields:', Object.keys(d).join(', '));
  }

  if (!probe) { console.log('RESULT: credential authenticates. Re-run with --probe to spend ~$0.03 confirming paid list access + since_id support.'); return; }

  const listId = process.env.X_LIST_ID || settings.list_id;
  if (!listId) { console.log('PROBE SKIPPED: no X_LIST_ID / settings.list_id'); return; }
  const page = await call(`/lists/${listId}/tweets?max_results=5&tweet.fields=created_at,author_id`, tok);
  console.log(`GET /2/lists/${listId}/tweets?max_results=5 → ${page.status}`, JSON.stringify(summarize(page.body)));
  const newest = page.body?.data?.[0]?.id || page.body?.meta?.newest_id;
  if (page.status !== 200 || !newest) { console.log('RESULT: paid list read failed — see status above'); return; }
  const ages = (page.body.data || []).map((t) => Math.round((Date.now() - new Date(t.created_at)) / 60000));
  console.log(`  ${page.body.data.length} posts returned; ages (minutes): ${ages.join(', ')}`);

  const since = await call(`/lists/${listId}/tweets?max_results=5&since_id=${newest}`, tok);
  console.log(`GET /2/lists/${listId}/tweets?since_id=${newest} → ${since.status}`, JSON.stringify(summarize(since.body)));
  const supported = since.status === 200;
  console.log(`RESULT: paid access OK · since_id ${supported ? 'ACCEPTED (0 rows expected, ' + (since.body?.data?.length || 0) + ' returned)' : 'REJECTED — poller will use boundary-stop mode'}`);
}

main().catch((e) => { console.error('check failed:', e.message); process.exit(1); });
