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
import fs from 'node:fs';
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

export function addUsage(state, { posts = 0, users = 0 }) {
  const day = etDate();
  const u = (state.usage[day] ||= { posts: 0, users: 0 });
  u.posts += posts;
  u.users += users;
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
  const u = state.usage[etDate()] || { posts: 0, users: 0 };
  return u.posts + u.users >= dailyBudget();
}

export function estCost({ posts = 0, users = 0 }) {
  return posts * 0.005 + users * 0.01;
}

// Every archive day on disk, oldest first.
export function archiveDates() {
  const dir = p('data', 'archive');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6)).sort();
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

// Every archived post, oldest file first, deduped by id across files (a
// post captured near midnight ET can land in two day files). Dates in the
// archive directory are the source of truth for what exists.
export function archiveDates() {
  let names;
  try { names = fs.readdirSync(p('data', 'archive')); } catch { return []; }
  return names.filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).map((n) => n.slice(0, 10)).sort();
}

export function loadArchive() {
  const seen = new Set();
  const out = [];
  for (const date of archiveDates()) {
    for (const t of readJSONL(archivePath(date))) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
  }
  return out;
}
