// Pure contracts for a bounded original-post lookup. Selection never fetches;
// applying a saved response never assumes a missing row was deleted/protected.
import { createRepostResolver } from './source-context.js';

const DAY = 86_400_000;
export const MAX_REPOST_REFERENCES = 25;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const numericId = (value) => typeof value === 'string' && /^\d{1,25}$/.test(value);
const textPresent = (value) => typeof value === 'string' && value.trim().length > 0;
const usable = (record, id, keyed = false) => object(record) && record.unavailable !== true
  && (record.id === id || (keyed && record.id == null)) && textPresent(record.text);
const byId = (a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : a.id.localeCompare(b.id);

export function selectRepostReferences(posts, {
  quoted = {}, archive = () => null, attemptedIds = new Set(), now = Date.now(), limit = MAX_REPOST_REFERENCES
} = {}) {
  if (!Array.isArray(posts) || !(attemptedIds instanceof Set) || !Number.isFinite(Number(now))) {
    throw new Error('Invalid repost acquisition selection inputs');
  }
  const resolve = createRepostResolver({ quoted, archive });
  const resolveEmbedded = createRepostResolver();
  const embedded = new Set();
  // An original already captured with another wrapper is free context even
  // when that other wrapper is outside the current 24-hour selection window.
  for (const post of posts) {
    const original = resolveEmbedded(post);
    if (original) embedded.add(original.id);
  }
  const seen = new Set();
  const counts = new Map();
  const resolvedReferences = new Map();
  for (const post of posts) {
    if (!numericId(post?.id) || seen.has(post.id)) continue;
    seen.add(post.id);
    if (post.type !== 'retweet' || !numericId(post.refId)) continue;
    const age = Number(now) - Date.parse(post.createdAt);
    if (!Number.isFinite(age) || age < 0 || age >= DAY) continue;
    const id = post.refId;
    if (attemptedIds.has(id) || embedded.has(id) || (Object.hasOwn(quoted, id) && quoted[id]?.unavailable === true)) continue;
    if (!resolvedReferences.has(id)) resolvedReferences.set(id, Boolean(resolve(post)));
    if (resolvedReferences.get(id)) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  const cap = Math.min(MAX_REPOST_REFERENCES, Math.max(0, Math.floor(Number(limit)) || 0));
  return [...counts].map(([id, n]) => ({ id, n })).sort((a, b) => b.n - a.n || byId(a, b)).slice(0, cap);
}

const TERMINAL_TYPES = new Set([
  'https://api.twitter.com/2/problems/resource-not-found',
  'https://api.twitter.com/2/problems/not-authorized-for-resource',
  'https://api.x.com/2/problems/resource-not-found',
  'https://api.x.com/2/problems/not-authorized-for-resource'
]);

function terminalForId(error, id) {
  return object(error) && TERMINAL_TYPES.has(error.type)
    && error.resource_type === 'tweet' && (error.parameter == null || error.parameter === 'ids') && error.resource_id === id;
}

const refersTo = (error, id) => object(error)
  && (error.resource_id === id || (error.parameter === 'ids' && error.value === id));

// Arrays identify exactly which requested IDs reached each outcome. Existing
// usable cache entries count as resolved, but not newly fetched. A caller can
// retain raw responses and usage separately without putting them in the cache.
export function applyRepostResponse(quoted, requestedIds, response, { fetchedAt } = {}) {
  if (!object(quoted) || !Array.isArray(requestedIds) || requestedIds.some((id) => !numericId(id))
    || !object(response) || !Array.isArray(response.tweets)
    || typeof fetchedAt !== 'string' || !Number.isFinite(Date.parse(fetchedAt))) {
    throw new Error('Invalid saved repost response');
  }
  const requested = [...new Set(requestedIds)];
  const requestedSet = new Set(requested);
  const rows = new Map();
  const conflicts = new Set();
  const returned = new Set();
  for (const entry of response.tweets) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [id, record] = entry;
    if (requestedSet.has(id)) returned.add(id);
    if (!requestedSet.has(id) || !usable(record, id)) continue;
    if (rows.has(id) && JSON.stringify(rows.get(id)) !== JSON.stringify(record)) conflicts.add(id);
    else rows.set(id, record);
  }
  const out = structuredClone(quoted);
  const fetched = [], unavailable = [], unresolved = [];
  const errors = Array.isArray(response.errors) ? response.errors : [];
  for (const id of requested) {
    if (usable(quoted[id], id, true)) {
      // Acquisition fills gaps only. A newer, shorter representation or a
      // partial response must not replace already usable source material.
      continue;
    }
    const record = conflicts.has(id) ? null : rows.get(id);
    if (record) {
      const selected = { id, text: record.text, fetchedAt,
        capturedAt: typeof record.capturedAt === 'string' && Number.isFinite(Date.parse(record.capturedAt)) ? record.capturedAt : fetchedAt };
      // Retain complete wording and provider source details. Do not infer
      // omitted attribution or metrics, and do not copy unrelated top-level
      // response/private fields into the public source cache.
      for (const key of ['authorId', 'handle', 'createdAt', 'source', 'metrics']) {
        if (Object.hasOwn(record, key)) selected[key] = structuredClone(record[key]);
      }
      out[id] = selected;
      fetched.push(id);
    } else if (!returned.has(id) && !conflicts.has(id) && errors.some((error) => terminalForId(error, id))
      && errors.filter((error) => refersTo(error, id)).every((error) => terminalForId(error, id))) {
      out[id] = { id, unavailable: true, fetchedAt };
      unavailable.push(id);
    } else {
      unresolved.push(id);
    }
  }
  return { quoted: out, fetched, unavailable, unresolved };
}
