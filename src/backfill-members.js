// Historical backfill by member timeline. The List timeline has a bounded
// available window; it cannot establish complete historical coverage. This
// walks every on-List account's own timeline back N days (default 21) and
// appends whatever the archive lacks.
//
// Resumable: progress (per-user done/next token) lives in
// data/backfill-progress.json (gitignored). Re-run to continue after a budget
// stop, a rate-limit wait, or a crash. Returned resources enter the local
// conservative counter before archival; X billing deduplication is separate.
//
// Posts older than 24h at capture carry a historical metric observation,
// so the capture metrics are written straight into data/metrics/ for those
// days (marked fromCapture) instead of paying for a second read.
//
// Pages are fetched with the referenced-post expansions (poll.js
// includeReferenced; X_INCLUDE_REFERENCED=false turns it off) so quotes and
// replies land with their quoted context. Included posts and authors count
// toward --max-reads and the daily returned-resource guard.
//
//   node --use-env-proxy src/backfill-members.js [--days=21] [--max-reads=N] [--dry-run] [--stop-at-limit]
//
// --stop-at-limit: on the first rate-limit hit, flush and exit (reporting when
// the window resets) instead of sleeping through it — for a bounded run.
//
// The daily read budget (settings.daily_read_budget, or X_DAILY_READ_BUDGET
// as a one-off override) applies. X_BACKFILL_MIN_REMAINING
// (default 2) leaves that many rate-limit calls unused per window.
import fs from 'node:fs';
import * as x from './x.js';
import { p, etDate, readJSON, writeJSON, readJSONL } from './util.js';
import { loadAuthors } from './authors.js';
import { includeReferenced } from './poll.js';
import {
  loadState, saveState, addUsage, dailyBudget, estCost,
  appendToArchive, archivePath, metricsPath, unarchivedRecords, boundedPageSize
} from './store.js';

export const progressPath = p('data', 'backfill-progress.json');
const arg = (name, dflt) => {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : dflt;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every id already archived on any day inside [start-3d, today] — the dedupe
// set. Reads every archive file in the window once.
export function archivedIds(startDate) {
  const ids = new Set();
  const dir = p('data', 'archive');
  if (!fs.existsSync(dir)) return ids;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const date = f.slice(0, -6);
    if (date < startDate) continue;
    for (const t of readJSONL(archivePath(date), { strict: true })) ids.add(t.id);
  }
  return ids;
}

// Seed data/metrics/<date>.json from capture metrics for posts that were
// already ≥24h old when fetched. These are timestamped observations, not a
// promise that engagement is final or that a later API request is free.
export function seedMetricsFromCapture(records, capturedAt, minAgeMs = 24 * 3600_000) {
  const byDate = new Map();
  for (const r of records) {
    if (r.type === 'retweet') continue;
    if (Date.parse(capturedAt) - Date.parse(r.createdAt) < minAgeMs) continue;
    const date = etDate(r.createdAt);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(r);
  }
  let seeded = 0;
  for (const [date, recs] of byDate) {
    const file = metricsPath(date);
    const existing = readJSON(file, {});
    for (const r of recs) {
      if (existing[r.id]) continue;
      existing[r.id] = { ...r.metricsAtCapture, refreshedAt: capturedAt, fromCapture: true };
      seeded++;
    }
    writeJSON(file, existing);
  }
  return seeded;
}

export function loadBackfillProgress(file = progressPath) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { startISO: null, users: {} };
    throw e;
  }
  let progress;
  try { progress = JSON.parse(text); } catch (e) {
    throw new Error('Member-backfill progress is invalid; refusing to restart paid collection silently', { cause: e });
  }
  if (!progress || typeof progress.users !== 'object' || !progress.users || Array.isArray(progress.users)
      || (progress.startISO != null && (typeof progress.startISO !== 'string' || !Number.isFinite(Date.parse(progress.startISO))))) {
    throw new Error('Member-backfill progress has an invalid shape');
  }
  for (const u of Object.values(progress.users)) {
    if (!u || typeof u !== 'object' || Array.isArray(u)
        || (u.next != null && (typeof u.next !== 'string' || !u.next))
        || (u.done != null && typeof u.done !== 'boolean')
        || ['pages', 'captured'].some((k) => u[k] != null && (!Number.isSafeInteger(u[k]) || u[k] < 0))) {
      throw new Error('Member-backfill progress has an invalid account continuation');
    }
  }
  return progress;
}

export async function backfillMembers({
  days = Number(arg('days', 21)), maxReads = Number(arg('max-reads', Infinity)),
  dryRun = process.argv.includes('--dry-run'), stopAtLimit = process.argv.includes('--stop-at-limit'),
  minRemaining = Number(process.env.X_BACKFILL_MIN_REMAINING || 2),
  restartPagination = process.argv.includes('--restart-pagination'),
  state = loadState(), authors = loadAuthors().byId, progress = loadBackfillProgress(),
  persist = saveState, saveProgress = (value) => writeJSON(progressPath, value),
  fetchPage = x.userTweetsPage, archive = appendToArchive, unseen = unarchivedRecords,
  seedMetrics = seedMetricsFromCapture, now = () => new Date().toISOString(),
  sleepFn = sleep, configured = x.isConfigured(), includeReferences = includeReferenced()
} = {}) {
  if (!configured) throw new Error('X auth not configured');
  if (!Number.isFinite(days) || days <= 0 || !(maxReads === Infinity || (Number.isFinite(maxReads) && maxReads >= 0))) {
    throw new Error('days must be positive and maxReads must be nonnegative');
  }
  const startTime = new Date(Date.parse(now()) - days * 86_400_000);
  startTime.setUTCSeconds(0, 0);
  const startISO = startTime.toISOString().replace(/\.\d{3}Z$/, 'Z');
  if (progress.startISO && progress.startISO !== startISO) {
    console.warn(`[backfill-members] resuming the stored window ${progress.startISO}`);
  }
  progress.startISO ||= startISO;
  const windowStart = progress.startISO;
  const members = Object.entries(authors)
    .filter(([, a]) => a.onList !== false && !a.stale)
    .map(([id, a]) => ({ id, handle: a.handle }))
    .sort((a, b) => a.handle.localeCompare(b.handle));
  const pending = members.filter((m) => !progress.users[m.id]?.done);
  console.log(`[backfill-members] ${members.length} on-List accounts, ${pending.length} pending, window from ${windowStart}${dryRun ? ' (dry run)' : ''}`);
  if (dryRun) return { captured: 0, reads: 0, remaining: pending.length, complete: pending.length === 0 };
  if (!pending.length) {
    saveProgress(progress);
    return { captured: 0, reads: 0, remaining: 0, complete: true };
  }
  let reads = 0, captured = 0, stopped = null;
  // Even an entirely empty/duplicate page advances durable account progress.
  saveProgress(progress);
  outer: for (const m of pending) {
    const u = (progress.users[m.id] ||= { handle: m.handle, done: false, next: null, pages: 0, captured: 0 });
    if (restartPagination) {
      u.next = null;
      u.recoveryRequired = null;
      u.restartedAt = now();
      saveProgress(progress);
    }
    if (u.recoveryRequired) { stopped = `recovery required for @${m.handle}: ${u.recoveryRequired}`; break; }
    while (!u.done) {
      const retryDelay = Date.parse(u.retryAt) - Date.parse(now());
      if (retryDelay > 0) {
        if (stopAtLimit) { stopped = `rate limited at @${m.handle} until ${u.retryAt}`; break outer; }
        await sleepFn(Math.min(60_000, retryDelay + 2_000));
        continue;
      }
      const pageSize = boundedPageSize(state, { desired: 100, includeReferenced: includeReferences, maxReads: maxReads - reads });
      if (!pageSize) { stopped = `insufficient read headroom for the next page (${dailyBudget()} daily ceiling, ${maxReads} run ceiling)`; break outer; }
      let res;
      try {
        res = await fetchPage(m.id, { startTime: windowStart, paginationToken: u.next, pageSize, includeReferenced: includeReferences });
      } catch (e) {
        if (e.status === 400 && u.next) u.recoveryRequired = 'pagination-token-rejected';
        u.lastError = { at: now(), status: e.status || null };
        saveProgress(progress);
        stopped = `request failed for @${m.handle}${e.status ? ` (HTTP ${e.status})` : ''}`;
        break outer;
      }
      if (res.rateLimited) {
        u.retryAt = res.resetAt ? new Date(res.resetAt).toISOString() : null;
        saveProgress(progress);
        if (stopAtLimit) { stopped = `rate limited at @${m.handle}`; break outer; }
        const waitMs = Math.min(60_000, Math.max(5_000, (res.resetAt || Date.parse(now()) + 60_000) - Date.parse(now()) + 2_000));
        await sleepFn(waitMs);
        continue;
      }
      addUsage(state, { posts: res.usage, users: res.userReads || 0 });
      reads += res.usage + (res.userReads || 0);
      persist(state); // no account continuation is advanced by this ledger write
      const capturedAt = now();
      let records;
      try {
        const observed = res.tweets.map((t) => x.toRecord(t, capturedAt, res.includes));
        records = unseen(observed);
        archive(records);
        seedMetrics(observed, capturedAt);
      } catch (e) {
        u.recoveryRequired = 'archive-write-failed';
        saveProgress(progress);
        throw e;
      }
      captured += records.length;
      u.captured = (u.captured || 0) + records.length;
      u.pages = (u.pages || 0) + 1;
      const repeatedToken = res.nextToken && res.nextToken === u.next;
      u.next = res.nextToken || null;
      u.done = !res.nextToken;
      u.lastPageAt = capturedAt;
      delete u.lastError;
      delete u.retryAt;
      // Archive and metrics are durable first. A crash before this save only
      // repeats a page; unarchivedRecords prevents duplicate archival.
      if (repeatedToken) u.recoveryRequired = 'pagination-not-advancing';
      saveProgress(progress);
      if (repeatedToken) { stopped = `pagination did not advance for @${m.handle}`; break outer; }
      if (!u.done && res.remaining != null && res.remaining <= minRemaining && res.resetAt) {
        u.retryAt = new Date(res.resetAt).toISOString();
        saveProgress(progress);
        if (stopAtLimit) { stopped = `rate-limit window nearly spent for @${m.handle}`; break outer; }
      }
    }
  }
  saveProgress(progress);
  const remaining = members.filter((m) => !progress.users[m.id]?.done).length;
  const today = state.usage[etDate()] || { posts: 0, users: 0 };
  console.log(`[backfill-members] ${reads} returned objects, ${captured} new post(s), ${remaining} account(s) pending${stopped ? ` — ${stopped}` : ''}; today's counter ${today.posts + today.users}/${dailyBudget()} (before billing deduplication, ~$${estCost(today).toFixed(2)})`);
  return { captured, reads, remaining, stopped, complete: remaining === 0 };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  backfillMembers().then((r) => { if (!r.complete) process.exitCode = 2; }).catch((e) => { console.error(e); process.exitCode = 1; });
}
