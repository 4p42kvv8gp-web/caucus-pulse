// Capture the List timeline with a durable per-page continuation. sinceId is
// the last completed interval boundary, not simply the newest observed ID.
// The List endpoint defaults to local boundary filtering; setting
// sinceIdSupported=null explicitly permits a capability probe.
import * as x from './x.js';
import { settings, etDate, idGt, maxId } from './util.js';
import {
  loadState, saveState, addUsage, dailyBudget, estCost,
  boundedPageSize, unarchivedRecords, appendToArchive
} from './store.js';

export function listId() {
  return process.env.X_LIST_ID || settings.list_id;
}

// Referenced posts and authors are retained as context. Returned resources
// count against the conservative read guard; provider billing deduplication
// is separate from this local counter.
export function includeReferenced() {
  return !/^(0|false|no|off)$/i.test(process.env.X_INCLUDE_REFERENCED || '');
}

// Adapt response size to recent volume; use full pages after a missed
// cadence. Five is the client's compatibility floor, not a pricing unit.
// Repeated resources can be deduplicated by X within its UTC billing day.
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

function boundedPages(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > 1000) throw new Error('maxPages must be an integer between 1 and 1000');
  return n;
}

function validatedRunIdentity(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.runId !== 'string' || !/^[1-9]\d*$/.test(value.runId)
      || !Number.isSafeInteger(value.runAttempt) || value.runAttempt < 1) {
    throw new Error('Invalid GitHub capture run identity');
  }
  return { runId: value.runId, runAttempt: value.runAttempt };
}

// A shell with leftover GitHub variables is not an Actions capture. Read the
// identity once per invocation, and keep IDs as strings without rounding.
export function githubRunIdentity(env = process.env) {
  if (env.GITHUB_ACTIONS !== 'true') return null;
  if (typeof env.GITHUB_RUN_ATTEMPT !== 'string' || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT)) {
    throw new Error('Invalid GitHub capture run identity');
  }
  return validatedRunIdentity({ runId: env.GITHUB_RUN_ID, runAttempt: Number(env.GITHUB_RUN_ATTEMPT) });
}

// Checkpoint each received page before publishing its continuation. The
// completed cursor does not move until the entire interval is drained.
// Dependencies keep all acceptance tests offline and outside the real data.
export async function collectListPages(state, {
  id = listId(), maxPages = 10, progressKey = 'pollProgress',
  baseSinceId = state.sinceId, advanceCursor = true,
  fetchPage = x.listTweetsPage, persist = saveState,
  archive = appendToArchive, unseen = unarchivedRecords,
  now = () => new Date().toISOString(), includeReferences = includeReferenced(),
  restartPagination = false
} = {}) {
  maxPages = boundedPages(maxPages);
  let progress = state[progressKey];
  if (progress && progress.listId !== id) {
    throw new Error('The configured List changed while a capture interval is unfinished; recover that interval before replacing its source');
  }
  if (!progress) {
    progress = state[progressKey] = {
      listId: id, baseSinceId: baseSinceId || null, newestId: baseSinceId || null,
      nextToken: null, startedAt: now(), pages: 0, captured: 0, recoveryRequired: null
    };
  }
  if (restartPagination) {
    progress.nextToken = null;
    progress.pages = 0;
    progress.recoveryRequired = null;
    progress.restartCount = (progress.restartCount || 0) + 1;
    progress.restartedAt = now();
  }
  const records = [], dates = new Set();
  let pages = 0, postsRead = 0, usersRead = 0, completed = false;
  let reason = progress.recoveryRequired?.reason || (Date.parse(progress.retryAt) > Date.parse(now()) ? 'rate-limited' : null);
  persist(state);
  if (reason) return { records, dates: [], pages, postsRead, usersRead, complete: false, reason };

  for (; pages < maxPages;) {
    const useSinceId = state.sinceIdSupported !== false && Boolean(progress.baseSinceId);
    const desired = progress.pages > 0 ? 100 : adaptivePageSize(state.recentNewCounts || [], settings.poll.page_size, {
      minutesSinceLastPoll: minutesSince(state.lastPollAt)
    });
    const pageSize = boundedPageSize(state, { desired, includeReferenced: includeReferences });
    if (!pageSize) { reason = 'budget'; break; }
    let res;
    try {
      res = await fetchPage(id, {
        sinceId: useSinceId ? progress.baseSinceId : undefined,
        paginationToken: progress.nextToken,
        pageSize, includeReferenced: includeReferences
      });
    } catch (e) {
      if (e.status === 400 && useSinceId && state.sinceIdSupported === null && !progress.nextToken) {
        state.sinceIdSupported = false;
        persist(state);
        continue;
      }
      reason = e.status === 400 && progress.nextToken ? 'pagination-token-rejected' : 'request-failed';
      if (reason === 'pagination-token-rejected') progress.recoveryRequired = { reason, at: now() };
      progress.lastError = { at: now(), status: e.status || null, kind: reason };
      break;
    }
    if (res.rateLimited) {
      reason = 'rate-limited';
      progress.retryAt = res.resetAt ? new Date(res.resetAt).toISOString() : null;
      break;
    }
    if (useSinceId && state.sinceIdSupported === null) state.sinceIdSupported = true;
    const capturedAt = now();
    if (progressKey === 'pollProgress') state.lastPollSuccessAt = capturedAt;
    addUsage(state, { posts: res.usage, users: res.userReads || 0 });
    postsRead += res.usage; usersRead += res.userReads || 0;
    persist(state); // retain the read ledger even if the archive write fails

    const fresh = newerThan(res.tweets, progress.baseSinceId);
    let pageRecords;
    try {
      pageRecords = unseen(fresh.map((t) => x.toRecord(t, capturedAt, res.includes)));
      for (const date of archive(pageRecords)) dates.add(date);
    } catch (e) {
      reason = 'archive-write-failed';
      progress.recoveryRequired = { reason, at: now() };
      persist(state);
      throw e;
    }
    records.push(...pageRecords);
    const newest = fresh.reduce((id, t) => maxId(id, t.id), progress.newestId);
    const crossedBoundary = fresh.length < res.tweets.length;
    const repeatedToken = res.nextToken && res.nextToken === progress.nextToken;
    progress.newestId = newest;
    progress.pages++;
    progress.captured = (progress.captured || 0) + pageRecords.length;
    progress.lastPageAt = capturedAt;
    progress.nextToken = res.nextToken || null;
    delete progress.lastError;
    delete progress.retryAt;
    pages++;
    if (crossedBoundary || (!res.nextToken && (!progress.baseSinceId || useSinceId))) {
      completed = true;
      if (advanceCursor) state.sinceId = maxId(state.sinceId, newest);
      state[progressKey] = null;
    } else if (repeatedToken) {
      reason = 'pagination-not-advancing';
      progress.recoveryRequired = { reason, at: now() };
    } else if (!res.nextToken) {
      // The provider ran out before an established boundary was observed.
      // Keep the old cursor and all captured pages; don't call it complete.
      reason = 'boundary-not-reached';
      progress.recoveryRequired = { reason, at: now(), oldestReturnedId: res.tweets.at(-1)?.id || null };
    }
    persist(state); // all records are durable before nextToken/cursor advances
    if (completed || reason) break;
  }
  if (!completed && !reason) reason = 'page-cap';
  persist(state);
  return { records, dates: [...dates], pages, postsRead, usersRead, complete: completed, reason, intervalCaptured: progress.captured || 0 };
}

export async function pollOnce({
  state = loadState(), id = listId(), maxPages = process.env.X_MAX_PAGES || settings.poll.max_pages || 10,
  fetchPage = x.listTweetsPage, persist = saveState, archive = appendToArchive,
  unseen = unarchivedRecords, now = () => new Date().toISOString(),
  afterCapture = true, configured = x.isConfigured(),
  includeReferences = includeReferenced(), restartPagination = process.argv.includes('--restart-pagination'),
  runIdentity = githubRunIdentity()
} = {}) {
  if (!configured) throw new Error('X auth not configured: set X_BEARER_TOKEN, or X_PROXY_AUTH=1 where the egress proxy injects the credential');
  if (!id) throw new Error('No list id: set X_LIST_ID or config/settings.json "list_id"');
  const completedRun = validatedRunIdentity(runIdentity);
  state.lastPollAttemptAt = now();
  state.lastPollOutcome = 'running';
  persist(state);
  let result;
  try {
    result = await collectListPages(state, { id, maxPages, fetchPage, persist, archive, unseen, now, includeReferences, restartPagination });
  } catch (e) {
    state.lastPollOutcome = state.pollProgress?.recoveryRequired?.reason || 'failed';
    persist(state);
    throw e;
  }
  const { records, dates } = result;
  state.lastPollOutcome = result.complete ? 'complete' : result.reason;
  if (result.complete) {
    state.recentNewCounts = [...(state.recentNewCounts || []), result.intervalCaptured].slice(-30);
    state.lastPollAt = now();
    // These markers describe the completed interval, never merely an attempt
    // or successful page. Publish them in the same state write as lastPollAt.
    if (completedRun) {
      state.lastPollRunId = completedRun.runId;
      state.lastPollRunAttempt = completedRun.runAttempt;
    } else {
      delete state.lastPollRunId;
      delete state.lastPollRunAttempt;
    }
  }
  persist(state);
  const today = state.usage[etDate()] || { posts: 0, users: 0 };
  console.log(`[poll] captured ${records.length} new post(s)${dates.length ? ` → ${dates.join(', ')}` : ''}; ${result.complete ? 'interval complete' : `interval unfinished: ${result.reason}`}; returned objects today: ${today.posts + today.users}/${dailyBudget()} (before provider billing deduplication, ~$${estCost(today).toFixed(2)})`);
  if (!afterCapture) return { captured: records.length, complete: result.complete, reason: result.reason, pages: result.pages };

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
  }
  // A quiet capture cycle can still repair a pending classification job.
  {
    try {
      const { classifyLive } = await import('./classify-live.js');
      const r = await classifyLive(records);
      if (r) console.log(`[poll] live-tagged ${r.tagged} post(s)${r.quoting ? ` (${r.quoting} with quoted context)` : ''}${r.hinted ? `, ${r.hinted} with similarity hints` : ''}${r.anchored ? `, ${r.anchored} anchored` : ''}${r.incidents ? `, ${r.incidents} incident-flagged` : ''}${r.dropped ? `, ${r.dropped} SUBTOPIC KEY(S) DROPPED AS UNRESOLVABLE` : ''}${r.echoed ? `, ${r.echoed} echoed macro/sub key(s) resolved` : ''}`);
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
  return { captured: records.length, complete: result.complete, reason: result.reason, pages: result.pages };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  pollOnce().then((r) => { if (!r.complete) process.exitCode = 2; }).catch((e) => { console.error(e); process.exitCode = 1; });
}
