// Acquire news context from the authorized public sources.
//
//   node src/context-refresh.js                 fetch every source, store new/changed items
//   node src/context-refresh.js --sources=a,b   only those registry ids
//   node src/context-refresh.js --dry-run       fetch and report, write nothing
//   node src/context-refresh.js --reconsider=YYYY-MM-DD [--since=<version>]
//         which of that day's empty/macro-only classifications now have
//         evidence → data/news/reconsider.json
//
// Runs in GitHub Actions (.github/workflows/news-context.yml), where egress
// is open; a Claude Code session cannot reach news hosts at all, which is
// why every network call goes through an injectable `fetchImpl` and the
// tests use fixtures. One feed per source; article bodies only where the
// registry says bodies: true, at most max_bodies_per_source new ones a
// run, paced, size-capped, and skipped when the site's robots.txt
// disallows the path for everyone. A source that fails is reported and
// marked in status.json; the run fails only when every source failed.
import { settings, readJSON, writeJSON, readJSONL } from './util.js';
import { archivePath, topicsPath } from './store.js';
import {
  loadSources, parseFeed, extractArticle, stripHtml, itemId, storeItems, readStatus, loadNews,
  reconsiderCandidates, STATUS_FILE, RECONSIDER_FILE, ITEMS_FILE
} from './news-context.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The feed registry grants access to these publishers, not arbitrary URLs
// embedded in a feed or page. Check every redirect before sending a request.
export function allowedPublicUrl(value, { base, allowedHosts } = {}) {
  const u = new URL(value, base);
  const host = u.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || (u.port && !['80', '443'].includes(u.port))
    || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':')) throw new Error('Disallowed news URL');
  if (allowedHosts?.length && !allowedHosts.some((h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`))) throw new Error('News URL is outside the registered publisher hosts');
  u.hash = '';
  return u.href;
}

// Bounded GET: timeout, byte cap (the body is read in chunks and cut off
// at max_bytes rather than buffered whole), one identifying User-Agent.
export async function fetchText(url, { fetchImpl = fetch, timeoutMs = 15000, maxBytes = 2_000_000, userAgent = 'caucus-pulse/0.1', allowedHosts = [new URL(url).hostname] } = {}) {
  let current = allowedPublicUrl(url, { allowedHosts });
  const signal = AbortSignal.timeout(timeoutMs);
  let res;
  for (let redirects = 0; redirects <= 5; redirects++) {
    res = await fetchImpl(current, { headers: { 'User-Agent': userAgent, Accept: 'text/html,application/xml,application/rss+xml,application/atom+xml,text/xml;q=0.9,*/*;q=0.5' }, redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(res.status)) break;
    const location = res.headers?.get('location');
    if (!location || redirects === 5) throw new Error('Invalid or excessive news redirects');
    await res.body?.cancel?.();
    current = allowedPublicUrl(location, { base: current, allowedHosts });
  }
  const status = res.status;
  let text = '';
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      chunks.push(value);
      if (size >= maxBytes) { try { await reader.cancel(); } catch { /* cut off */ } break; }
    }
    text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8').slice(0, maxBytes);
  } else {
    text = String(await res.text()).slice(0, maxBytes);
  }
  return { status, ok: res.ok, text, url: allowedPublicUrl(res.url || current, { base: current, allowedHosts }) };
}

// robots.txt for everyone ("User-agent: *" group): a Disallow prefix that
// covers the article path means we do not fetch the body. Fetch failures
// are treated as "no rules" — the registry already limits us to public
// news sites that publish for readers.
export function robotsAllows(robotsTxt, pathname) {
  const lines = String(robotsTxt ?? '').split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
  let star = false;
  const disallow = [];
  for (const line of lines) {
    const [k, ...rest] = line.split(':');
    const v = rest.join(':').trim();
    const key = k.trim().toLowerCase();
    if (key === 'user-agent') star = v === '*';
    else if (star && key === 'disallow' && v) disallow.push(v);
  }
  return !disallow.some((prefix) => prefix !== '/' ? pathname.startsWith(prefix) : true);
}

const robotsCache = new Map();
async function bodyAllowed(url, opts) {
  try {
    const u = new URL(url);
    if (!robotsCache.has(u.origin)) {
      const r = await fetchText(`${u.origin}/robots.txt`, { ...opts, timeoutMs: 8000, maxBytes: 200_000 }).catch(() => null);
      robotsCache.set(u.origin, r?.ok ? r.text : '');
    }
    return robotsAllows(robotsCache.get(u.origin), u.pathname);
  } catch { return false; }
}

// One source → items ready to store. Feed items become headline-only
// records; for bodies: true sources the article page is fetched for items
// the store does not already have, and readable passages are added.
export async function refreshSource(source, { cfg, fetchImpl = fetch, known = new Map(), now = new Date().toISOString(), log = () => {} } = {}) {
  const allowedHosts = source.allowed_hosts || [new URL(source.url).hostname];
  const fetchOpts = { fetchImpl, timeoutMs: cfg.fetch?.timeout_ms, maxBytes: cfg.fetch?.max_bytes, userAgent: cfg.user_agent, allowedHosts };
  const started = Date.now();
  const feed = await fetchText(source.url, fetchOpts);
  if (!feed.ok) return { source: source.id, ok: false, httpStatus: feed.status, error: `feed HTTP ${feed.status}`, items: [] };
  const parsed = parseFeed(feed.text);
  if (!parsed.items.length) return { source: source.id, ok: false, httpStatus: feed.status, error: `feed parsed as ${parsed.format} with no items`, items: [] };
  const items = [];
  let bodies = 0;
  let bodiesSkipped = 0;
  for (const f of parsed.items.slice(0, source.max_items || 50)) {
    let url;
    try { url = allowedPublicUrl(f.link, { base: feed.url, allowedHosts }); } catch { bodiesSkipped++; continue; }
    const id = itemId(url);
    const base = { id, sourceId: source.id, publisher: source.publisher, url, feedLink: url, feedUrl: source.url, title: f.title, publishedAt: f.publishedAt, fetchedAt: now, extract: 'headline-only', passages: [], summary: f.summary || '', lang: null };
    const prior = known.get(id);
    if (prior) {
      // Retain the last readable excerpt while attempting a refresh. A
      // timeout is acquisition failure, not a publisher correction.
      Object.assign(base, { id: prior.id, url: prior.url, passages: prior.passages, extract: prior.extract, extractReason: prior.extractReason || null, lang: prior.lang, publishedAt: f.publishedAt || prior.publishedAt, fetchError: prior.fetchError, fetchedAt: prior.fetchedAt, bodyFetchedAt: prior.bodyFetchedAt, bodyAttemptedAt: prior.bodyAttemptedAt, lastSeenAt: now });
    }
    const lastAttempt = Date.parse(prior?.bodyAttemptedAt || prior?.bodyFetchedAt || prior?.fetchedAt || 0);
    const summaryOnly = prior?.extractReason === 'public-audio-summary-only' && !prior?.fetchError;
    const retryHours = !summaryOnly && (prior?.fetchError || prior?.extract === 'failed' || prior?.extract === 'headline-only') ? 24 : (cfg.fetch?.body_refresh_hours ?? 6);
    const due = !prior || !Number.isFinite(lastAttempt) || Date.parse(now) - lastAttempt >= retryHours * 3_600_000;
    if (source.bodies && due && bodies < (cfg.fetch?.max_bodies_per_source ?? 15)) {
      if (!(await bodyAllowed(url, fetchOpts))) { bodiesSkipped++; items.push(base); continue; }
      bodies++;
      await sleep(cfg.fetch?.pace_ms ?? 1000);
      base.bodyAttemptedAt = now;
      try {
        const page = await fetchText(url, fetchOpts);
        if (page.ok) {
          const art = extractArticle(page.text, { url: page.url, passageChars: cfg.fetch?.passage_chars, maxPassages: cfg.fetch?.max_passages });
          let canonical = page.url;
          try { canonical = allowedPublicUrl(art.canonical || page.url, { base: page.url, allowedHosts }); } catch { /* retain actual fetched publisher URL */ }
          // A recognized public audio-only layout proves the old body was a
          // summary/notice, unlike a timeout or an unknown layout. Correct it.
          if (art.extract === 'body' || prior?.extract !== 'body' || art.extractReason === 'public-audio-summary-only') {
            Object.assign(base, { url: canonical, publishedAt: f.publishedAt || art.publishedAt, passages: art.passages, extract: art.extract, extractReason: art.extractReason || null, lang: art.lang, title: base.title || art.title, bodyFetchedAt: now, fetchError: null });
            base.id = itemId(base.url);
          } else {
            base.fetchError = 'No readable article passages on refresh; retaining earlier excerpt';
          }
        } else {
          if (prior?.extract !== 'body') base.extract = 'failed';
          base.fetchError = `HTTP ${page.status}`;
        }
      } catch (e) {
        if (prior?.extract !== 'body') base.extract = 'failed';
        base.fetchError = String(e.message || e).slice(0, 120);
      }
    }
    items.push(base);
  }
  log(`[context-refresh] ${source.id}: ${parsed.format}, ${parsed.items.length} feed item(s), ${bodies} body fetch(es)${bodiesSkipped ? `, ${bodiesSkipped} skipped by robots.txt` : ''} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return { source: source.id, ok: true, httpStatus: feed.status, format: parsed.format, feedItems: parsed.items.length, bodies, bodiesSkipped, items };
}

export async function refreshAll({ cfg = loadSources(), only = null, fetchImpl = fetch, dryRun = false, now = new Date().toISOString(), log = console.log, statusFile = STATUS_FILE, itemsFile = ITEMS_FILE } = {}) {
  const sources = cfg.sources.filter((s) => !only || only.includes(s.id));
  // A source removed from the registry leaves status.json too, so the file
  // describes the registry as it is, not as it was.
  const registered = new Set(cfg.sources.map((s) => s.id));
  // Keep stale bodies available too: refreshSource needs them as a fallback
  // when the publisher is temporarily unreadable. Attempt clocks are separate
  // from the time new content was first observed.
  const known = new Map();
  for (const it of loadNews({ file: itemsFile, statusFile }).items) {
    known.set(it.id, it);
    if (it.feedLink) known.set(itemId(it.feedLink), it);
  }
  const status = readStatus(statusFile);
  for (const id of Object.keys(status.sources)) if (!registered.has(id)) delete status.sources[id];
  const results = [];
  const toStore = [];
  for (const s of sources) {
    let r;
    try { r = await refreshSource(s, { cfg, fetchImpl, known, now, log }); } catch (e) { r = { source: s.id, ok: false, error: String(e.message || e).slice(0, 160), items: [] }; }
    if (!r.ok) log(`[context-refresh] ${s.id}: FAILED — ${r.error}`);
    results.push(r);
    toStore.push(...r.items);
    status.sources[s.id] = { lastFetchAt: now, ok: r.ok, httpStatus: r.httpStatus ?? null, format: r.format ?? null, feedItems: r.feedItems ?? 0, bodies: r.bodies ?? 0, error: r.error ?? null };
  }
  const stored = dryRun ? { added: 0, changed: 0, version: status.contextVersion, dryRun: true } : storeItems(toStore, { file: itemsFile, statusFile, now });
  if (!dryRun) { const s = readStatus(statusFile); s.sources = status.sources; writeJSON(statusFile, s); }
  const okCount = results.filter((r) => r.ok).length;
  log(`[context-refresh] ${okCount}/${sources.length} source(s) ok, ${toStore.length} item(s) seen, ${stored.added} new, ${stored.changed} changed → context version ${stored.version}${dryRun ? ' (dry run, nothing written)' : ''}`);
  return { results, stored, okCount, total: sources.length };
}

async function main() {
  const arg = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split('=').slice(1).join('=') : null; };
  const reconsider = arg('reconsider');
  if (reconsider) {
    const day = readJSON(topicsPath(reconsider), null);
    if (!day) { console.log(`[context-refresh] no topics file for ${reconsider}`); return; }
    const posts = readJSONL(archivePath(reconsider));
    const since = Number(arg('since') ?? 0);
    const queue = reconsiderCandidates(day, posts, { sinceVersion: since });
    writeJSON(RECONSIDER_FILE, { date: reconsider, sinceVersion: since, contextVersion: readStatus().contextVersion, generatedAt: new Date().toISOString(), posts: queue });
    console.log(`[context-refresh] ${reconsider}: ${queue.length} post(s) with empty or macro-only topics now have evidence newer than version ${since} → data/news/reconsider.json`);
    return;
  }
  const only = arg('sources')?.split(',').map((s) => s.trim()).filter(Boolean) || null;
  const { okCount, total } = await refreshAll({ only, dryRun: process.argv.includes('--dry-run') });
  if (total && okCount === 0) { console.error('[context-refresh] every source failed'); process.exit(1); }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
