// Storage layout (everything under data/ is committed by the workflows —
// git is the datastore and the backup):
//   data/archive/YYYY-MM-DD.jsonl   append-only captured tweets, bucketed by
//                                   the tweet's created_at date (ET)
//   data/metrics/YYYY-MM-DD.json    24h engagement refresh, keyed by tweet id
//   data/topics/YYYY-MM-DD.json     nightly classification output
//   data/syntax/YYYY-MM-DD.json     nightly n-gram phrase output
//   data/phrases.json               phrase first-seen ledger (adoption curves)
//   data/authors.json               author table (weekly refresh)
//   data/rollups/topic-days.json    topic × day × caucus aggregates
//   data/state.json                 cursor + usage metering (this file)
import { p, settings, readJSON, writeJSON, readJSONL, appendJSONL, etDate, daysAgoEt } from './util.js';

export const statePath = p('data', 'state.json');
export const archivePath = (date) => p('data', 'archive', `${date}.jsonl`);
export const metricsPath = (date) => p('data', 'metrics', `${date}.json`);
export const topicsPath = (date) => p('data', 'topics', `${date}.json`);
export const syntaxPath = (date) => p('data', 'syntax', `${date}.json`);

export function loadState() {
  return readJSON(statePath, {
    sinceId: null,          // newest tweet id ever captured
    // Probed 2026-09-10 against list 1841177179872243858: the list-tweets
    // endpoint returns 400 for since_id, so boundary-stop is the real mode.
    // Left runtime-detectable in case X changes it (set null to re-test).
    sinceIdSupported: false,
    recentNewCounts: [],    // new tweets per poll (last 30) → adaptive page size
    pendingBatch: null,     // in-flight Anthropic batch {id, date}
    usage: {}               // {date: {posts, users}} — X reads, for budgeting
  });
}

export function saveState(state) {
  writeJSON(statePath, state);
}

// Every X read lands here before any output is written. `requests` meters
// endpoints billed per request rather than per object (counts). All fields
// stay flat numbers on the day object so src/merge-state.js keeps summing
// them field by field — a nested object there would merge to NaN. When
// purpose is 'intel' the narrative layer's share is also tracked flat, so
// the report can split capture from intelligence spend.
export function addUsage(state, { posts = 0, users = 0, requests = 0, purpose } = {}) {
  const day = etDate();
  const u = (state.usage[day] ||= { posts: 0, users: 0 });
  u.posts += posts;
  u.users += users;
  if (requests) u.requests = (u.requests || 0) + requests;
  if (purpose === 'intel') {
    if (posts) u.intelPosts = (u.intelPosts || 0) + posts;
    if (users) u.intelUsers = (u.intelUsers || 0) + users;
    if (requests) u.intelRequests = (u.intelRequests || 0) + requests;
  }
}

// Objects read today: posts + users + per-request calls (one object each in
// the ledger; the dollar view — a user is 2×, a counts request 1× — lives in
// estCost and the intel spend files).
export function usedToday(state, day = etDate()) {
  const u = state.usage?.[day] || {};
  return (u.posts || 0) + (u.users || 0) + (u.requests || 0);
}

// Daily X read ceiling. config/settings.json "daily_read_budget" is the
// source of truth (git-controlled, so it can be raised without touching repo
// settings); X_DAILY_READ_BUDGET in the environment overrides it for a
// one-off run. 8000 reads ≈ $40 is the fallback if neither is set.
// Tolerates "15,000" / "15_000" (a repo variable typed with separators once
// produced NaN, which silently disabled the guard); anything that still is
// not a positive number falls through to the next source.
export function parseBudget(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/[,_\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function dailyBudget() {
  return parseBudget(process.env.X_DAILY_READ_BUDGET) ?? parseBudget(settings.daily_read_budget) ?? 8000;
}

export function budgetExhausted(state) {
  return usedToday(state) >= dailyBudget();
}

export function estCost({ posts = 0, users = 0, requests = 0 }) {
  return posts * 0.005 + users * 0.01 + requests * 0.005;
}

// What is left of today's ceiling — the number the narrative layer plans
// against (src/intel-budget.js) before it reserves anything.
export function headroom(state) {
  const used = usedToday(state);
  const budget = dailyBudget();
  return { used, budget, remaining: Math.max(0, budget - used) };
}

// Ids captured in the last `days` archive files — the dedupe set for the
// poller (covers boundary-page overlap re-reads and clock skew).
export function recentIds(days = 3) {
  const ids = new Set();
  for (let d = 0; d < days; d++) {
    for (const t of readJSONL(archivePath(daysAgoEt(d)))) ids.add(t.id);
  }
  return ids;
}

// Append records to the archive, bucketed by the tweet's ET calendar date.
export function appendToArchive(records) {
  const byDate = new Map();
  for (const r of records) {
    const date = etDate(r.createdAt);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(r);
  }
  for (const [date, recs] of byDate) {
    // oldest first within the append so the file stays roughly chronological
    recs.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    appendJSONL(archivePath(date), recs);
  }
  return [...byDate.keys()];
}

// A day's archive, deduped by id. Two writers appending the same tweet to
// the same file (a session poll racing an Actions poll, then a union merge)
// leave a duplicate line; the first occurrence wins here so nothing
// downstream double-counts.
export function loadDay(date) {
  const seen = new Set();
  return readJSONL(archivePath(date)).filter((t) => !seen.has(t.id) && seen.add(t.id));
}
