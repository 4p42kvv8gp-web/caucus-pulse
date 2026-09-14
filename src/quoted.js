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
// Every path returns {id, authorId, handle, text, createdAt, metrics}
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
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const numericId = (value) => typeof value === 'string' && /^\d{1,25}$/.test(value);
const textPresent = (value) => typeof value === 'string' && value.trim().length > 0;
const knownDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
function pickMetrics(m) {
  const out = {};
  for (const k of METRIC_KEYS) if (m && typeof m[k] === 'number') out[k] = m[k];
  return out;
}

function shape(id, src) {
  // Legacy embedded/cache records omitted their ID; their matched reference
  // supplies it. An explicit conflicting ID cannot be relabeled as this source.
  if (!numericId(id) || !object(src) || src.unavailable === true || !textPresent(src.text)
    || (src.id != null && src.id !== id)) return null;
  return {
    id,
    authorId: typeof src.authorId === 'string' && src.authorId.trim() ? src.authorId : null,
    handle: src.handle ?? null,
    text: src.text,
    createdAt: knownDate(src.createdAt),
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
  if (!post || !QUOTABLE.has(post.type) || !numericId(post.refId)) return null;
  const embedded = shape(post.refId, post.quoted);
  if (embedded) return embedded;

  const store = deps.quoted ?? loadQuoted();
  const entry = Object.hasOwn(store, post.refId) ? shape(post.refId, store[post.refId]) : null;
  if (entry) return entry;

  const archive = deps.archive ?? archiveLookup();
  const orig = archive(post.refId);
  const original = shape(post.refId, orig);
  if (!original) return null;
  const authorsById = deps.authorsById ?? loadAuthors().byId;
  const metricsFor = deps.metricsFor ?? archiveMetrics();
  return { ...original, handle: authorsById[orig.authorId]?.handle ?? original.handle,
    metrics: pickMetrics(metricsFor(orig)) };
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

// The classifier receives the full captured wording and the original's own
// identity/date. Request batching bounds inputs without silently removing the
// end of a source. Unknown original dates are not replaced by the quote date.
// Impressions are supplied only when known; provider envelopes stay outside
// the model input.
export function quotingFor(ctx) {
  if (!object(ctx) || ctx.unavailable === true || !textPresent(ctx.text)) return null;
  const out = { id: numericId(ctx.id) ? ctx.id : null,
    authorId: typeof ctx.authorId === 'string' && ctx.authorId.trim() ? ctx.authorId : null,
    handle: ctx.handle ?? null, text: ctx.text, createdAt: knownDate(ctx.createdAt) };
  if (typeof ctx.metrics?.impressions === 'number') out.impressions = ctx.metrics.impressions;
  return out;
}
