// The poller: pull everything new from the X List timeline, append to the
// archive, advance the cursor. Runs every 20 minutes from GitHub Actions.
//
// Cursor strategy — the list endpoint may or may not honor since_id (search
// and user timelines do; list tweets has not consistently documented it):
//   1. First run tries since_id. If the API rejects it (400), we remember
//      that (state.sinceIdSupported=false) and never send it again.
//   2. Without since_id we paginate newest-first and stop at the first page
//      that crosses the last-seen id (boundary stop). The tail of that page
//      is a re-read we already have — billed but bounded by one page — so we
//      shrink the page size adaptively toward recent per-poll volume.
// Either way local dedupe (recentIds) keeps the archive exact.
import * as x from './x.js';
import { settings, etDate, idGt, maxId } from './util.js';
import {
  loadState, saveState, addUsage, budgetExhausted, dailyBudget, estCost,
  recentIds, appendToArchive
} from './store.js';

export function listId() {
  return process.env.X_LIST_ID || settings.list_id;
}

// Capture the post a quote/reply points at with the post (x.js
// includeReferenced) — on by default; X_INCLUDE_REFERENCED=false is the kill
// switch. The included posts and their authors are billed reads on top of
// the page: with ~22% of caucus posts being quotes or replies and ~16%
// retweets (whose originals X returns too), a 100-post page brings back
// roughly 35-40 extra post objects and ~30 user objects — about +18% in
// post reads for the quotes and replies alone, up to ~2× the page's dollar
// cost in all. docs/QUOTED_CONTEXT.md has the arithmetic.
export function includeReferenced() {
  return !/^(0|false|no|off)$/i.test(process.env.X_INCLUDE_REFERENCED || '');
}

// Page size when we pay for boundary overlap: aim ~2× the recent per-poll
// volume so bursts rarely need page 2, but quiet polls don't re-read 100.
// Floor is the endpoint's minimum (5) — every row past the boundary is a
// billed re-read, so overnight polls should ask for as little as possible.
// Only the last six polls (~2h) count: a one-off burst (the 465-post first
// capture) must not keep overnight polls paying for 30-row pages all night,
// and a real evening surge should lift the page size within an hour.
//
// The per-poll average only means anything at the scheduled cadence. GitHub's
// cron is best-effort and has skipped hours at a time on this repo, so when
// the last poll is well past due, the backlog is whatever accumulated in that
// gap, not the recent per-poll rate: ask for a full page and let the boundary
// stop decide where to stop.
export function adaptivePageSize(recentNewCounts, max = 100, { minutesSinceLastPoll = null, cadenceMinutes = 20 } = {}) {
  if (minutesSinceLastPoll != null && minutesSinceLastPoll > cadenceMinutes * 2) return max;
  const recent = recentNewCounts.slice(-6);
  if (!recent.length) return max;
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  return Math.min(max, Math.max(5, Math.ceil(avg * 2)));
}

export function minutesSince(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (Date.now() - t) / 60000 : null;
}

// Split a newest-first page at the since-id boundary → the part we keep.
export function newerThan(tweets, sinceId) {
  return sinceId ? tweets.filter((t) => idGt(t.id, sinceId)) : tweets;
}

async function pull(state) {
  const id = listId();
  const maxPages = Number(process.env.X_MAX_PAGES || settings.poll.max_pages || 5);
  const useSinceId = state.sinceIdSupported !== false && Boolean(state.sinceId);
  const gapMinutes = minutesSince(state.lastPollAt);
  const pageSize = state.sinceIdSupported === false
    ? adaptivePageSize(state.recentNewCounts, settings.poll.page_size, { minutesSinceLastPoll: gapMinutes })
    : settings.poll.page_size;
  if (gapMinutes != null && gapMinutes > 60) {
    console.warn(`[poll] ${(gapMinutes / 60).toFixed(1)}h since the last poll (scheduled every 20 min) — draining the backlog at full page size`);
  }

  const raw = [];
  const includes = { tweets: [], users: [] }; // referenced posts + their authors, all pages
  let paginationToken = null;
  let hitBoundary = false;

  for (let page = 0; page < maxPages && !hitBoundary; page++) {
    let res;
    try {
      res = await x.listTweetsPage(id, {
        sinceId: useSinceId ? state.sinceId : undefined,
        paginationToken,
        // after page 1 we're inside a burst — full pages are cheapest
        pageSize: page === 0 ? pageSize : 100,
        includeReferenced: includeReferenced()
      });
    } catch (e) {
      if (e.status === 400 && useSinceId && state.sinceIdSupported === null) {
        console.warn('[poll] list endpoint rejected since_id — switching to boundary-stop mode');
        state.sinceIdSupported = false;
        saveState(state);
        return pull(state); // retry once in the discovered mode
      }
      // A failure past page 0 must not discard already-billed pages.
      if (page === 0) throw e;
      console.warn(`[poll] page ${page + 1} failed (${e.message}) — keeping earlier pages`);
      break;
    }
    if (res.rateLimited) { console.warn('[poll] rate limited — backing off this cycle'); break; }
    if (useSinceId && state.sinceIdSupported === null && res.tweets.length >= 0) {
      state.sinceIdSupported = true; // the param was accepted
    }
    addUsage(state, { posts: res.usage, users: res.userReads || 0 });
    includes.tweets.push(...(res.includes?.tweets || []));
    includes.users.push(...(res.includes?.users || []));

    const fresh = newerThan(res.tweets, state.sinceId);
    raw.push(...fresh);
    hitBoundary = fresh.length < res.tweets.length; // page crossed the cursor
    paginationToken = res.nextToken;
    if (!paginationToken) break;
    if (page === maxPages - 1 && !hitBoundary && res.tweets.length) {
      // Not recoverable by waiting: the cursor advances to the newest id
      // captured, so posts older than this page are below the boundary and
      // no later poll will ask for them again.
      console.warn(`[poll] the backlog is deeper than ${maxPages} pages — posts older than the ${raw.length} captured here fall behind the cursor and need "npm run backfill-members -- --days=1" to recover; raise poll.max_pages in config/settings.json if this repeats`);
    }
  }
  return { raw, includes };
}

export async function pollOnce() {
  if (!x.isConfigured()) throw new Error('X auth not configured: set X_BEARER_TOKEN, or X_PROXY_AUTH=1 where the egress proxy injects the credential');
  if (!listId()) throw new Error('No list id: set X_LIST_ID or config/settings.json "list_id"');

  const state = loadState();
  if (budgetExhausted(state)) {
    console.warn(`[poll] daily X read budget reached (${dailyBudget()}) — skipping until tomorrow (raise daily_read_budget in config/settings.json to change)`);
    saveState(state);
    return { captured: 0 };
  }

  const capturedAt = new Date().toISOString();
  const { raw, includes } = await pull(state);

  const seen = recentIds();
  const records = [];
  for (const t of raw) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    records.push(x.toRecord(t, capturedAt, includes));
    state.sinceId = maxId(state.sinceId, t.id);
  }

  const dates = appendToArchive(records);
  state.recentNewCounts = [...state.recentNewCounts, records.length].slice(-30);
  state.lastPollAt = capturedAt;
  saveState(state);

  const today = state.usage[etDate()] || { posts: 0, users: 0 };
  const quoted = records.filter((r) => r.quoted).length;
  console.log(`[poll] captured ${records.length} new tweet(s)${dates.length ? ` → ${dates.join(', ')}` : ''} (${quoted} with quoted context; ${includes.tweets.length} referenced post(s) + ${includes.users.length} author(s) read); today's reads: ${today.posts + today.users}/${dailyBudget()} (~$${estCost(today).toFixed(2)})`);

  // Post-capture extras are best-effort: the new posts into the embedding
  // index (seconds on the CPU; a one-line skip when the 35 MB model was never
  // downloaded on this checkout), live topic tags for the dashboard feed —
  // which read those vectors for their similarity hints — then a
  // rollups.json rebuild. Dynamic imports keep the capture path
  // dependency-free — if node_modules is absent these steps just skip.
  if (records.length) {
    try {
      const { embedArchive } = await import('./embed-archive.js');
      const r = await embedArchive();
      if (r.skipped) console.log(`[poll] embedding skipped: ${r.skipped} (${r.pending} post(s) not in the index)`);
      else if (r.embedded) console.log(`[poll] embedded ${r.embedded} new post(s) in ${r.seconds}s (index now ${r.total} rows)`);
    } catch (e) {
      console.warn(`[poll] embedding skipped: ${e.message}`);
    }
    try {
      const { classifyLive } = await import('./classify-live.js');
      const r = await classifyLive(records);
      if (r) console.log(`[poll] live-tagged ${r.tagged} post(s)${r.quoting ? ` (${r.quoting} with quoted context)` : ''}${r.hinted ? `, ${r.hinted} with similarity hints` : ''}${r.anchored ? `, ${r.anchored} anchored` : ''}${r.incidents ? `, ${r.incidents} incident-flagged` : ''}`);
    } catch (e) {
      console.warn(`[poll] live classification skipped: ${e.message}`);
    }
  }
  try {
    const { buildIncidents } = await import('./incidents.js');
    await buildIncidents({ withIntel: false }); // grouping only; intel is nightly
    const { buildSiteData } = await import('./sitedata.js');
    buildSiteData();
  } catch (e) {
    console.warn(`[poll] site data rebuild skipped: ${e.message}`);
  }
  return { captured: records.length };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  pollOnce().catch((e) => { console.error(e); process.exit(1); });
}
