// One-time backfill: page the list timeline from newest down to X's ~7-day
// horizon, ignoring the poll cursor, and append anything the archive lacks.
// Use it once when the poller first goes live (the first poll only reaches
// X_MAX_PAGES back) — the crons never call this.
//
//   X_BACKFILL_PAGES  max 100-post pages to read (default 30 → ≤3,000 reads,
//                     ≈$15 worst case). The daily read budget still applies.
import * as x from './x.js';
import { listId } from './poll.js';
import { etDate, maxId } from './util.js';
import {
  loadState, saveState, addUsage, budgetExhausted, dailyBudget, estCost,
  recentIds, appendToArchive
} from './store.js';

export async function backfill({ maxPages = Number(process.env.X_BACKFILL_PAGES || 30) } = {}) {
  if (!x.isConfigured()) throw new Error('X auth not configured: set X_BEARER_TOKEN, or X_PROXY_AUTH=1 where the egress proxy injects the credential');
  const id = listId();
  if (!id) throw new Error('No list id: set X_LIST_ID or config/settings.json "list_id"');

  const state = loadState();
  const seen = recentIds(10); // wider than the poller's 3 days — we go back a week
  const capturedAt = new Date().toISOString();
  const records = [];
  let token = null;
  let pages = 0;
  let reads = 0;
  let oldest = null;

  for (; pages < maxPages; pages++) {
    if (budgetExhausted(state)) {
      console.warn(`[backfill] daily X read budget reached (${dailyBudget()}) — stopping at page ${pages}`);
      break;
    }
    const res = await x.listTweetsPage(id, { paginationToken: token, pageSize: 100 });
    if (res.rateLimited) { console.warn('[backfill] rate limited — stopping'); break; }
    addUsage(state, { posts: res.usage });
    reads += res.usage;
    saveState(state); // ledger first: every page is billed whether or not we keep it

    let fresh = 0;
    for (const t of res.tweets) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      records.push(x.toRecord(t, capturedAt));
      state.sinceId = maxId(state.sinceId, t.id);
      fresh++;
    }
    const last = res.tweets.at(-1);
    if (last) oldest = last.created_at;
    console.log(`[backfill] page ${pages + 1}: ${res.tweets.length} read, ${fresh} new (oldest so far ${oldest || '?'})`);
    if (!res.nextToken || !res.tweets.length) { pages++; break; }
    token = res.nextToken;
  }

  const dates = appendToArchive(records);
  saveState(state);
  const today = state.usage[etDate()] || { posts: 0, users: 0 };
  console.log(`[backfill] ${pages} page(s), ${reads} reads, ${records.length} new tweet(s)${dates.length ? ` → ${dates.sort().join(', ')}` : ''}; today's reads: ${today.posts + today.users}/${dailyBudget()} (~$${estCost(today).toFixed(2)})`);
  return { pages, reads, captured: records.length, dates };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  backfill().catch((e) => { console.error(e); process.exit(1); });
}
