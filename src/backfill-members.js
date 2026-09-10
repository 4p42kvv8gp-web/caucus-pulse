// Historical backfill by member timeline. The List timeline only serves its
// newest ~800 posts, so the poller's history starts about a day back. This
// walks every on-List account's own timeline back N days (default 21) and
// appends whatever the archive lacks — the run that turns Momentum's 7-day
// baselines from empty into real.
//
// Resumable: progress (per-user done/next token) lives in
// data/backfill-progress.json (gitignored). Re-run to continue after a budget
// stop, a rate-limit wait, or a crash. Every page is billed whether or not
// we keep it, so the ledger is written before the archive.
//
// Posts older than 24h at capture carry settled engagement numbers already,
// so the capture metrics are written straight into data/metrics/ for those
// days (marked fromCapture) instead of paying for a second read.
//
//   node --use-env-proxy src/backfill-members.js [--days=21] [--max-reads=N] [--dry-run] [--stop-at-limit]
//
// --stop-at-limit: on the first rate-limit hit, flush and exit (reporting when
// the window resets) instead of sleeping through it — for a bounded run.
//
// Env: X_DAILY_READ_BUDGET applies (default 8000). X_BACKFILL_MIN_REMAINING
// (default 2) leaves that many rate-limit calls unused per window.
import fs from 'node:fs';
import * as x from './x.js';
import { p, etDate, readJSON, writeJSON, readJSONL } from './util.js';
import { loadAuthors } from './authors.js';
import {
  loadState, saveState, addUsage, budgetExhausted, dailyBudget, estCost,
  appendToArchive, archivePath, metricsPath
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
    for (const t of readJSONL(archivePath(date))) ids.add(t.id);
  }
  return ids;
}

// Seed data/metrics/<date>.json from capture metrics for posts that were
// already ≥24h old when fetched. refresh.js treats an existing entry as done,
// so these never get re-billed; the nightly 24h pass still runs for fresh days.
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

export async function backfillMembers({
  days = Number(arg('days', 21)),
  maxReads = Number(arg('max-reads', Infinity)),
  dryRun = process.argv.includes('--dry-run'),
  stopAtLimit = process.argv.includes('--stop-at-limit'),
  minRemaining = Number(process.env.X_BACKFILL_MIN_REMAINING || 2)
} = {}) {
  const resetIn = (resetAt) => resetAt ? `${Math.max(0, Math.round((resetAt - Date.now()) / 1000))}s (at ${new Date(resetAt).toISOString()})` : 'unknown';
  if (!x.isConfigured()) throw new Error('X auth not configured: set X_BEARER_TOKEN, or X_PROXY_AUTH=1 where the egress proxy injects the credential');

  const startTime = new Date(Date.now() - days * 86_400_000);
  startTime.setUTCSeconds(0, 0);
  const startISO = startTime.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const startDate = etDate(new Date(startTime.getTime() - 3 * 86_400_000));

  const authors = loadAuthors().byId;
  const members = Object.entries(authors)
    .filter(([, a]) => a.onList !== false)
    .map(([id, a]) => ({ id, handle: a.handle }))
    .sort((a, b) => a.handle.localeCompare(b.handle));

  const progress = readJSON(progressPath, { startISO: null, users: {} });
  if (progress.startISO && progress.startISO !== startISO) {
    // A different window than the one in progress: keep going with the stored
    // window so resumed pages stay consistent, but say so.
    console.warn(`[backfill-members] resuming the earlier window ${progress.startISO} (asked for ${startISO}); delete ${progressPath} to restart`);
  }
  progress.startISO ||= startISO;
  const windowStart = progress.startISO;

  const pending = members.filter((m) => !progress.users[m.id]?.done);
  console.log(`[backfill-members] ${members.length} on-List accounts, ${pending.length} to go, window from ${windowStart}${dryRun ? ' (dry run: no reads)' : ''}`);
  if (dryRun || !pending.length) return { captured: 0, reads: 0, remaining: pending.length };

  const state = loadState();
  const seen = archivedIds(startDate);
  const capturedAt = new Date().toISOString();
  let reads = 0;
  let captured = 0;
  let allRecords = [];
  let stopped = null;

  const flush = () => {
    if (!allRecords.length) return;
    const dates = appendToArchive(allRecords);
    const seeded = seedMetricsFromCapture(allRecords, capturedAt);
    console.log(`[backfill-members] flushed ${allRecords.length} post(s) → ${dates.sort().join(', ')}; ${seeded} metrics seeded from capture`);
    allRecords = [];
    writeJSON(progressPath, progress);
    saveState(state);
  };

  outer: for (const m of pending) {
    const u = (progress.users[m.id] ||= { handle: m.handle, done: false, next: null, pages: 0, captured: 0 });
    while (true) {
      if (budgetExhausted(state)) { stopped = `daily X read budget reached (${dailyBudget()})`; break outer; }
      if (reads >= maxReads) { stopped = `--max-reads=${maxReads} reached`; break outer; }

      const res = await x.userTweetsPage(m.id, { startTime: windowStart, paginationToken: u.next, pageSize: 100 });
      if (res.rateLimited) {
        if (stopAtLimit) { stopped = `rate limited at @${m.handle}; window resets in ${resetIn(res.resetAt)}`; break outer; }
        const waitMs = Math.min(16 * 60_000, Math.max(5_000, (res.resetAt || Date.now() + 60_000) - Date.now() + 2_000));
        console.warn(`[backfill-members] rate limited at @${m.handle} — sleeping ${Math.round(waitMs / 1000)}s`);
        flush();
        await sleep(waitMs);
        continue;
      }
      addUsage(state, { posts: res.usage });
      reads += res.usage;
      u.pages++;
      saveState(state); // ledger first

      let fresh = 0;
      for (const t of res.tweets) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        allRecords.push(x.toRecord(t, capturedAt));
        fresh++;
      }
      u.captured += fresh;
      captured += fresh;

      if (!res.nextToken || !res.tweets.length) { u.done = true; break; }
      u.next = res.nextToken;

      // Stay under the per-window limit rather than bouncing off 429s.
      if (res.remaining != null && res.remaining <= minRemaining && res.resetAt) {
        if (stopAtLimit) { stopped = `rate-limit window nearly spent (${res.remaining} left); resets in ${resetIn(res.resetAt)}`; break outer; }
        const waitMs = Math.max(1_000, res.resetAt - Date.now() + 2_000);
        console.warn(`[backfill-members] ${res.remaining} calls left in window — sleeping ${Math.round(waitMs / 1000)}s`);
        flush();
        await sleep(waitMs);
      }
    }
    if (u.done) console.log(`[backfill-members] @${m.handle}: ${u.pages} page(s), ${u.captured} new`);
    if (allRecords.length >= 500) flush();
  }

  flush();
  const remaining = members.filter((mm) => !progress.users[mm.id]?.done).length;
  const today = state.usage[etDate()] || { posts: 0, users: 0 };
  console.log(`[backfill-members] ${reads} reads this run, ${captured} new post(s), ${remaining} account(s) still to go${stopped ? ` — stopped: ${stopped}; re-run to continue` : ''}; today's reads: ${today.posts + today.users}/${dailyBudget()} (~$${estCost(today).toFixed(2)})`);
  return { captured, reads, remaining, stopped };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  backfillMembers().catch((e) => { console.error(e); process.exit(1); });
}
