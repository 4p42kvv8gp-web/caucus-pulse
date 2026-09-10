// Quoted-context backfill for posts already in the archive.
//
// The poller now captures the post a quote or reply points at alongside the
// post (x.js includeReferenced → record.quoted). Everything archived before
// that, and anything the poller misses, has only refId. This script fetches
// the DISTINCT referenced ids of quote and reply posts that data/quoted.json
// does not yet know and stores them there (src/quoted.js), so the classifier
// can read what a member was reacting to.
//
// What it does not fetch: referenced posts that are themselves in the
// archive (a member quoting a member) — quotedContext resolves those locally
// for free, per the never-re-bill rule. Deleted/protected posts come back
// as nothing and are recorded `unavailable` so they are never looked up
// twice.
//
// Billing: /2/tweets lookups in batches of 100 — one post read per post
// returned, one user read per distinct author returned (expansions=author_id
// for the handle). Every batch goes through the daily ledger
// (addUsage/saveState) before its results are written, honours the daily
// budget, and the file is written after every batch, so a stopped run
// resumes exactly where it left off. Most-quoted ids go first, so a capped
// run buys the context that matters most.
//
//   node --use-env-proxy src/quotes-backfill.js [--max-reads=N] [--dry-run] [--no-replies]
import * as x from './x.js';
import { etDate } from './util.js';
import { loadState, saveState, addUsage, budgetExhausted, dailyBudget, estCost, loadDay, archiveDates } from './store.js';
import { loadQuoted, saveQuoted, QUOTABLE } from './quoted.js';

const arg = (name, dflt) => {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : dflt;
};

// Which referenced ids to fetch, most-referenced first: distinct refIds of
// quote (and reply) posts, minus ids the side store already has (fetched or
// unavailable) and ids that are in the archive themselves. Returns
// [{id, n}] where n is how many archived posts point at the id.
export function selectRefIds(posts, quoted = {}, { archivedIds = new Set(), includeReplies = true } = {}) {
  const counts = new Map();
  for (const t of posts) {
    if (!t.refId || !QUOTABLE.has(t.type)) continue;
    if (t.type === 'reply' && !includeReplies) continue;
    counts.set(t.refId, (counts.get(t.refId) || 0) + 1);
  }
  return [...counts]
    .filter(([id]) => !quoted[id] && !archivedIds.has(id))
    .map(([id, n]) => ({ id, n }))
    .sort((a, b) => b.n - a.n || (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

// Fetch `todo` in batches, writing the store and the ledger after each.
// deps (tests): lookupTweets, state, quoted, save, now, budgetExhausted.
export async function fetchQuoted(todo, {
  maxReads = Infinity,
  lookupTweets = x.lookupTweets,
  state = loadState(),
  quoted = loadQuoted(),
  save = saveQuoted,
  saveState: saveStateFn = saveState,
  exhausted = budgetExhausted,
  now = () => new Date().toISOString(),
  log = console.log
} = {}) {
  let reads = 0, userReads = 0, fetched = 0, unavailable = 0, batches = 0;
  let stopped = null;
  for (let i = 0; i < todo.length;) {
    if (exhausted(state)) { stopped = `daily X read budget reached (${dailyBudget()})`; break; }
    if (reads >= maxReads) { stopped = `--max-reads=${maxReads} reached`; break; }
    // A batch never asks for more ids than the cap has room for (a returned
    // post is a read); the cursor moves by what was asked, never past it.
    const batch = todo.slice(i, i + Math.min(100, maxReads - reads));
    const res = await lookupTweets(batch.map((t) => t.id), { withText: true });
    if (res.rateLimited) { stopped = 'rate limited'; break; }
    i += batch.length;
    batches++;
    addUsage(state, { posts: res.usage, users: res.userReads || 0 });
    reads += res.usage;
    userReads += res.userReads || 0;
    saveStateFn(state); // ledger first: the reads are billed whether or not the write below lands

    const fetchedAt = now();
    for (const { id } of batch) {
      const t = res.tweetsById.get(id);
      if (t) {
        const { bookmarks, ...metrics } = t.metrics; // the same five-key shape record.quoted carries
        quoted[id] = { authorId: t.authorId, handle: t.handle, text: t.text, metrics, fetchedAt };
        fetched++;
      } else {
        quoted[id] = { unavailable: true, fetchedAt };
        unavailable++;
      }
    }
    save(quoted);
    log(`[quotes-backfill] batch ${batches}: ${batch.length} asked, ${res.tweetsById.size} returned (${res.usage} post + ${res.userReads || 0} user reads)`);
  }
  return { reads, userReads, fetched, unavailable, batches, stopped, remaining: Math.max(0, todo.length - fetched - unavailable) };
}

export async function quotesBackfill({
  maxReads = Number(arg('max-reads', Infinity)),
  dryRun = process.argv.includes('--dry-run'),
  includeReplies = !process.argv.includes('--no-replies')
} = {}) {
  const posts = [];
  for (const d of archiveDates()) posts.push(...loadDay(d));
  const archivedIds = new Set(posts.map((t) => t.id));
  const quoted = loadQuoted();
  const todo = selectRefIds(posts, quoted, { archivedIds, includeReplies });
  const known = Object.keys(quoted).length;
  console.log(`[quotes-backfill] ${posts.length} archived posts; ${todo.length} referenced id(s) to fetch (${known} already in data/quoted.json, ${todo.reduce((a, t) => a + t.n, 0)} posts point at them)${dryRun ? ' — dry run, no reads' : ''}`);
  if (dryRun || !todo.length) return { reads: 0, userReads: 0, fetched: 0, unavailable: 0, remaining: todo.length };
  if (!x.isConfigured()) throw new Error('X auth not configured: set X_BEARER_TOKEN, or X_PROXY_AUTH=1 where the egress proxy injects the credential');

  const state = loadState();
  const r = await fetchQuoted(todo, { maxReads, state, quoted });
  const today = state.usage[etDate()] || { posts: 0, users: 0 };
  console.log(`[quotes-backfill] ${r.reads} post + ${r.userReads} user reads (~$${estCost({ posts: r.reads, users: r.userReads }).toFixed(2)}), ${r.fetched} fetched, ${r.unavailable} unavailable, ${r.remaining} still to go${r.stopped ? ` — stopped: ${r.stopped}; re-run to continue` : ''}; today's reads: ${today.posts + today.users}/${dailyBudget()} (~$${estCost(today).toFixed(2)})`);
  return r;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  quotesBackfill().catch((e) => { console.error(e); process.exit(1); });
}
