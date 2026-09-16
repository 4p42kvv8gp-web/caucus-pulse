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
import path from 'node:path';
import { p, settings, writeJSON, readJSONL, appendJSONL, etDate, daysAgoEt } from './util.js';

export const statePath = p('data', 'state.json');
export const archivePath = (date) => p('data', 'archive', `${date}.jsonl`);
export const metricsPath = (date) => p('data', 'metrics', `${date}.json`);
export const topicsPath = (date) => p('data', 'topics', `${date}.json`);
export const syntaxPath = (date) => p('data', 'syntax', `${date}.json`);

export function loadState(file = statePath) {
  const defaults = {
    sinceId: null,
    sinceIdSupported: false,
    recentNewCounts: [],
    pendingBatch: null,
    usage: {}
  };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') {
      let archives = [];
      try { archives = fs.readdirSync(path.join(path.dirname(file), 'archive')); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      if (archives.some((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))) {
        throw new Error('Capture state is missing beside an existing archive; refusing to reset its cursor and read ledger');
      }
      return defaults;
    }
    throw e;
  }
  let stored;
  try { stored = JSON.parse(text); } catch (e) {
    throw new Error('data/state.json is invalid; refusing to reset the capture cursor or read ledger', { cause: e });
  }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)
      || !stored.usage || typeof stored.usage !== 'object' || Array.isArray(stored.usage)
      || (stored.sinceId != null && (typeof stored.sinceId !== 'string' || !/^\d+$/.test(stored.sinceId)))) {
    throw new Error('data/state.json has an invalid capture/usage shape; restore a verified state before collection');
  }
  for (const u of Object.values(stored.usage)) {
    if (!u || typeof u !== 'object' || Array.isArray(u) || ['posts', 'users'].some((k) => !Number.isSafeInteger(u[k] ?? 0) || (u[k] ?? 0) < 0)) {
      throw new Error('data/state.json has invalid read counters; collection stopped');
    }
  }
  if (stored.recentNewCounts != null && (!Array.isArray(stored.recentNewCounts) || stored.recentNewCounts.some((n) => !Number.isSafeInteger(n) || n < 0))) {
    throw new Error('data/state.json has invalid recent capture counts');
  }
  if (Object.hasOwn(stored, 'lastPollRunId') || Object.hasOwn(stored, 'lastPollRunAttempt')) {
    if (typeof stored.lastPollRunId !== 'string' || !/^[1-9]\d*$/.test(stored.lastPollRunId)
        || !Number.isSafeInteger(stored.lastPollRunAttempt) || stored.lastPollRunAttempt < 1
        || typeof stored.lastPollAt !== 'string' || !Number.isFinite(Date.parse(stored.lastPollAt))) {
      throw new Error('data/state.json has an invalid completed capture run identity');
    }
  }
  if (stored.sinceIdSupported != null && typeof stored.sinceIdSupported !== 'boolean') throw new Error('Invalid sinceIdSupported state');
  for (const key of ['pollProgress', 'listBackfillProgress']) {
    const progress = stored[key];
    if (progress == null) continue;
    if (typeof progress !== 'object' || Array.isArray(progress)
        || typeof progress.listId !== 'string'
        || !Number.isSafeInteger(progress.pages) || progress.pages < 0
        || (progress.nextToken != null && (typeof progress.nextToken !== 'string' || !progress.nextToken))
        || ['baseSinceId', 'newestId'].some((k) => progress[k] != null && (typeof progress[k] !== 'string' || !/^\d+$/.test(progress[k])))) {
      throw new Error(`data/state.json has invalid ${key}; collection stopped without resetting its continuation`);
    }
  }
  return { ...defaults, ...stored };
}

export function saveState(state) {
  writeJSON(statePath, state);
}

export function addUsage(state, { posts = 0, users = 0 }) {
  if (![posts, users].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid returned-resource count');
  const day = etDate();
  const u = (state.usage[day] ||= { posts: 0, users: 0 });
  u.posts = (u.posts || 0) + posts;
  u.users = (u.users || 0) + users;
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

export function remainingReads(state) {
  const u = state.usage[etDate()] || { posts: 0, users: 0 };
  return Math.max(0, dailyBudget() - (u.posts || 0) - (u.users || 0));
}

export function budgetExhausted(state) {
  return remainingReads(state) <= 0;
}

// Conservative returned-object allowance. Each requested post can reference
// at most the three reference types, with one included post and author per
// reference. This reserves 1 + 3 + 3 reads when expansions are enabled.
// This is a read guard, not an assertion about the provider's deduped bill.
export function boundedPageSize(state, { desired = 100, includeReferenced = false, maxReads = Infinity, minimum = 5 } = {}) {
  const headroom = Math.min(remainingReads(state), Math.max(0, maxReads));
  const size = Math.min(100, Math.max(0, Math.floor(desired)), Math.floor(headroom / (includeReferenced ? 7 : 1)));
  return size >= minimum ? size : 0;
}

export function estCost({ posts = 0, users = 0 }) {
  return posts * 0.005 + users * 0.01;
}

// Every archive day on disk (YYYY-MM-DD.jsonl only), oldest first.
export function archiveDates() {
  let names;
  try { names = fs.readdirSync(p('data', 'archive')); } catch { return []; }
  return names.filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).map((n) => n.slice(0, 10)).sort();
}

// Ids captured in the last `days` archive files — the dedupe set for the
// poller (covers boundary-page overlap re-reads and clock skew).
export function recentIds(days = 3) {
  const ids = new Set();
  for (let d = 0; d < days; d++) {
    for (const t of readJSONL(archivePath(daysAgoEt(d)), { strict: true })) ids.add(t.id);
  }
  return ids;
}

// Check only the dates touched by a page; retries remain idempotent even
// after a multi-day pause, beyond the old three-day recent-id cache.
export function unarchivedRecords(records, { pathFor = archivePath } = {}) {
  const idsByDate = new Map();
  return records.filter((r) => {
    const date = etDate(r.createdAt);
    if (!idsByDate.has(date)) idsByDate.set(date, new Set(readJSONL(pathFor(date), { strict: true }).map((t) => t.id)));
    const ids = idsByDate.get(date);
    if (ids.has(r.id)) return false;
    ids.add(r.id);
    return true;
  });
}

// The single-writer workflow serializes writers. Idempotence handles a crash
// after an archive append but before publication of its continuation token.
export function appendToArchive(records, { pathFor = archivePath } = {}) {
  const byDate = new Map();
  for (const r of unarchivedRecords(records, { pathFor })) {
    const date = etDate(r.createdAt);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(r);
  }
  for (const [date, recs] of byDate) {
    recs.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    appendJSONL(pathFor(date), recs);
  }
  return [...byDate.keys()];
}

// A day's archive, deduped by id. Two writers appending the same tweet to
// the same file (a session poll racing an Actions poll, then a union merge)
// leave a duplicate line; the first occurrence wins here so nothing
// downstream double-counts.
export function loadDay(date) {
  const seen = new Set();
  return readJSONL(archivePath(date), { strict: true }).filter((t) => !seen.has(t.id) && seen.add(t.id));
}

// Every archived post, oldest file first, deduped by id across files (a
// post captured near midnight ET can land in two day files). archiveDates()
// above is the source of truth for what exists.
export function loadArchive() {
  const seen = new Set();
  const out = [];
  for (const date of archiveDates()) {
    for (const t of readJSONL(archivePath(date), { strict: true })) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
  }
  return out;
}
