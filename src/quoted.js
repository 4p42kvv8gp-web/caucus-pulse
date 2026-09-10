// Quoted context: what a quote or reply is reacting to.
//
// The owner's rule: "a post that is a quote tweet on Coxon's tweet with
// millions of views, even if it doesn't mention him, should count." A quote
// or reply record in the archive carries only refId; its own text may never
// name the subject. This module resolves the post it points at, in order:
//   1. the record itself — `quoted`, captured with the post when the poller
//      asked X for referenced-post expansions (x.js includeReferenced);
//   2. data/quoted.json — the side store src/quotes-backfill.js fills for
//      posts archived before capture carried context (and for anything the
//      poller missed);
//   3. the archive — the quoted post may be a caucus post we already hold
//      (a member quoting another member), with its 24h metrics in
//      data/metrics/ when the refresh has run.
// Every path returns the same shape: {id, authorId, handle, text, metrics}
// with metrics {likes, retweets, replies, quotes, impressions?}; null when
// nothing is known. Retweets are not quotes — their original is inherited
// by the classifier, not read as context — so they resolve to null.
//
// data/quoted.json: { "<quoted id>": {authorId, handle, text, metrics,
// fetchedAt} | {unavailable: true, fetchedAt} }. `unavailable` records a
// deleted/protected post so the backfill never re-bills the lookup.
import { p, readJSON, writeJSON } from './util.js';
import { loadDay, metricsPath } from './store.js';
import { loadAuthors } from './authors.js';
import { snowflakeDates } from './corrections.js';

export const quotedPath = p('data', 'quoted.json');
export const QUOTABLE = new Set(['quote', 'reply']);

export function loadQuoted() {
  return readJSON(quotedPath, {});
}

export function saveQuoted(quoted) {
  writeJSON(quotedPath, quoted);
}

const METRIC_KEYS = ['likes', 'retweets', 'replies', 'quotes', 'impressions'];
function pickMetrics(m) {
  const out = {};
  for (const k of METRIC_KEYS) if (m && typeof m[k] === 'number') out[k] = m[k];
  return out;
}

function shape(id, src) {
  return {
    id,
    authorId: src.authorId ?? null,
    handle: src.handle ?? null,
    text: src.text ?? '',
    metrics: pickMetrics(src.metrics)
  };
}

// id → archive record, reading each candidate day file once. The archive
// day of a post is within a day of its snowflake timestamp, so at most
// three files per miss; hits and misses are both remembered.
export function archiveLookup({ loadDay: loadDayFn = loadDay } = {}) {
  const days = new Map();
  const found = new Map();
  const day = (d) => {
    if (!days.has(d)) days.set(d, new Map(loadDayFn(d).map((t) => [t.id, t])));
    return days.get(d);
  };
  return (id) => {
    if (found.has(id)) return found.get(id);
    let hit = null;
    for (const d of snowflakeDates(id)) {
      hit = day(d).get(id) || null;
      if (hit) break;
    }
    found.set(id, hit);
    return hit;
  };
}

// Settled metrics for an archived post: data/metrics/<day>.json (the 24h
// refresh, which carries impressions) when present, else what capture saw.
export function archiveMetrics({ readMetrics = (date) => readJSON(metricsPath(date), {}) } = {}) {
  const files = new Map();
  const file = (d) => {
    if (!files.has(d)) files.set(d, readMetrics(d) || {});
    return files.get(d);
  };
  return (rec) => {
    for (const d of snowflakeDates(rec.id)) {
      const m = file(d)[rec.id];
      if (m && !m.unavailable) return m;
    }
    return rec.metricsAtCapture || {};
  };
}

// Resolve one post's quoted context. deps (tests): quoted (the side store
// object), archive (id → record | null), authorsById, metricsFor (record →
// metrics). Prefer quotedResolver() when resolving many posts: it builds the
// deps once and caches the day files it reads.
export function quotedContext(post, deps = {}) {
  if (!post || !QUOTABLE.has(post.type) || !post.refId) return null;
  if (post.quoted && typeof post.quoted === 'object') return shape(post.refId, post.quoted);

  const store = deps.quoted ?? loadQuoted();
  const entry = store[post.refId];
  if (entry && !entry.unavailable) return shape(post.refId, entry);

  const archive = deps.archive ?? archiveLookup();
  const orig = archive(post.refId);
  if (!orig) return null;
  const authorsById = deps.authorsById ?? loadAuthors().byId;
  const metricsFor = deps.metricsFor ?? archiveMetrics();
  return shape(post.refId, {
    authorId: orig.authorId,
    handle: authorsById[orig.authorId]?.handle ?? null,
    text: orig.text,
    metrics: metricsFor(orig)
  });
}

// post → context, with every source loaded once for the run.
export function quotedResolver(deps = {}) {
  const shared = {
    quoted: deps.quoted ?? loadQuoted(),
    archive: deps.archive ?? archiveLookup(deps),
    authorsById: deps.authorsById ?? loadAuthors().byId,
    metricsFor: deps.metricsFor ?? archiveMetrics(deps)
  };
  return (post) => quotedContext(post, shared);
}

// The classifier's view of a context: what it needs to judge the subject
// and its reach, nothing else. Text is capped so a long quoted thread does
// not crowd out the post itself; impressions are given only when known (an
// archived original that has not had its 24h refresh has none, and 0 would
// read as "no reach").
export const QUOTING_TEXT_MAX = 400;
export function quotingFor(ctx) {
  if (!ctx) return null;
  const out = { handle: ctx.handle ?? null, text: String(ctx.text ?? '').slice(0, QUOTING_TEXT_MAX) };
  if (typeof ctx.metrics?.impressions === 'number') out.impressions = ctx.metrics.impressions;
  return out;
}
