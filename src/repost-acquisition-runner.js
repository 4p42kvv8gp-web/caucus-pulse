// One durable lookup for recent missing repost originals. All I/O is injected;
// the caller must hold the shared writer lock and publish each checkpoint.
import { createHash } from 'node:crypto';
import { selectRepostReferences, applyRepostResponse } from './repost-acquisition-contract.js';
import { sourceContextStatus, createRepostResolver } from './source-context.js';

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const id = (v) => typeof v === 'string' && /^\d{1,25}$/.test(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const statuses = new Set(['intent', 'response-saved', 'applied', 'uncertain', 'rate-limited']);
const validDate = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));

export function validateAcquisitionState(state) {
  if (!object(state) || state.version !== 1 || !object(state.receipts)) throw new Error('Invalid repost acquisition ledger; refusing to reset attempts');
  const attempted = new Set();
  for (const [key, r] of Object.entries(state.receipts)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !object(r) || !statuses.has(r.status)
        || !Array.isArray(r.ids) || !r.ids.length || r.ids.length > 25 || r.ids.some((v) => !id(v))
        || new Set(r.ids).size !== r.ids.length || r.requestHash !== hash(r.ids)
        || !validDate(r.startedAt) || !/^\d{4}-\d{2}-\d{2}$/.test(r.usageDay)) throw new Error('Invalid repost acquisition receipt');
    for (const value of r.ids) {
      if (r.status === 'rate-limited') continue; // a definite rejection can be retried after reset
      if (attempted.has(value)) throw new Error('Repeated repost reference in acquisition ledger');
      attempted.add(value);
    }
    if (['response-saved', 'applied', 'rate-limited'].includes(r.status)) {
      validateResponse(r.response);
      if (!validDate(r.respondedAt) || r.responseHash !== hash(r.response)) throw new Error('Saved repost response changed');
      if (r.status === 'rate-limited' && (r.response.rateLimited !== true || !validDate(r.retryAt))) throw new Error('Invalid rate-limit retry observation');
    }
  }
  return attempted;
}

function validateResponse(response) {
  if (!object(response) || !Array.isArray(response.tweets) || !Array.isArray(response.errors)
      || !count(response.usage) || !count(response.userReads)
      || response.tweets.some((v) => !Array.isArray(v) || v.length !== 2 || !id(v[0]) || !object(v[1]))) throw new Error('Invalid saved repost response');
  return response;
}

export function serializeRepostResponse(result) {
  if (!object(result) || !(result.tweetsById instanceof Map)) throw new Error('Invalid repost lookup result');
  return validateResponse(clone({ tweets: [...result.tweetsById], errors: result.errors ?? [],
    usage: result.usage, userReads: result.userReads ?? 0, rateLimited: result.rateLimited === true,
    resetAt: result.resetAt ?? null, raw: result.raw ?? null }));
}

// The application key lives in the same atomic file as the counters. A local
// crash between state/cache/receipt writes therefore cannot account twice.
export function applyAcquisitionUsage(state, key, receipt) {
  if (!object(state) || !object(state.usage)) throw new Error('Invalid X usage state');
  const out = clone(state);
  out.repostAcquisitionUsage ??= {};
  if (!object(out.repostAcquisitionUsage)) throw new Error('Invalid repost usage receipt map');
  const value = { day: receipt.usageDay, posts: receipt.response.usage, users: receipt.response.userReads, responseHash: receipt.responseHash };
  if (Object.hasOwn(out.repostAcquisitionUsage, key)) {
    if (JSON.stringify(out.repostAcquisitionUsage[key]) !== JSON.stringify(value)) throw new Error('Repost usage receipt changed');
    return out;
  }
  const day = (out.usage[value.day] ||= { posts: 0, users: 0 });
  for (const name of ['posts', 'users']) {
    if (!count(day[name] ?? 0) || !count(value[name]) || !count((day[name] ?? 0) + value[name])) throw new Error('Invalid repost read counters');
    day[name] = (day[name] ?? 0) + value[name];
  }
  out.repostAcquisitionUsage[key] = value;
  return out;
}

export async function runRepostAcquisition(posts, {
  state, loadQuoted, saveQuoted, loadUsage, saveUsage, save, checkpoint,
  lookup, archive = () => null, remainingReads = () => Infinity, beforeLookup = async () => {},
  now = () => new Date().toISOString(), usageDay, runId = 'local', maxIds = 25
} = {}) {
  const attemptedIds = validateAcquisitionState(state);
  if ([loadQuoted, saveQuoted, loadUsage, saveUsage, save, checkpoint, lookup, archive, remainingReads, beforeLookup, now, usageDay].some((fn) => typeof fn !== 'function')) throw new Error('Invalid acquisition dependencies');
  const timestamp = () => {
    const value = now();
    if (!validDate(value)) throw new Error('Invalid acquisition clock');
    return value;
  };
  const persist = async () => { await save(state); await checkpoint(); };
  const result = { calls: 0, requested: 0, fetched: 0, localRecovered: 0, unavailable: 0, unresolved: 0, replayed: 0, uncertain: 0, rateLimited: 0, outstanding: 0 };
  const finish = async () => {
    const cache = await loadQuoted();
    const resolve = createRepostResolver({ quoted: cache, archive });
    const reviewIds = new Set(Object.values(state.receipts).flatMap((r) => r.status === 'uncertain' ? r.ids : r.outcome?.unresolved || []));
    result.outstanding = [...reviewIds].filter((value) => !cache[value]?.unavailable && !resolve({ type: 'retweet', refId: value })).length;
    return result;
  };
  const currentUsage = await loadUsage();
  for (const [key, receipt] of Object.entries(state.receipts)) {
    if (!['applied', 'rate-limited'].includes(receipt.status)) continue;
    if (!Object.hasOwn(currentUsage.repostAcquisitionUsage || {}, key)) throw new Error('Applied acquisition has no matching usage receipt');
    applyAcquisitionUsage(currentUsage, key, receipt); // checks immutable identity
  }
  // A previously published intent is an ambiguous submission even if a crash
  // happened just before the network call. Never make that assumption billable.
  for (const receipt of Object.values(state.receipts)) {
    if (receipt.status === 'intent') {
      receipt.status = 'uncertain'; receipt.uncertainAt = timestamp();
      receipt.error = 'Interrupted after durable intent; automatic resubmission disabled';
      result.uncertain++;
      await persist();
    }
  }
  async function apply(key, receipt) {
    // The raw response must already be durable before derived stores change.
    await persist();
    if (receipt.response.rateLimited === true) {
      // A known 429 is a rejection, not evidence about any original. Save its
      // observation/usage; permit a later bounded attempt after the reset.
      await saveUsage(applyAcquisitionUsage(await loadUsage(), key, receipt));
      receipt.status = 'rate-limited';
      const backoff = Date.parse(receipt.respondedAt) + 20 * 60_000;
      receipt.retryAt = new Date(Math.max(backoff, Number(receipt.response.resetAt) || 0)).toISOString();
      for (const value of receipt.ids) attemptedIds.add(value);
      await persist(); result.rateLimited++;
      return;
    }
    const projected = applyRepostResponse(await loadQuoted(), receipt.ids, receipt.response, { fetchedAt: receipt.respondedAt });
    await saveQuoted(projected.quoted);
    await saveUsage(applyAcquisitionUsage(await loadUsage(), key, receipt));
    receipt.status = 'applied'; receipt.appliedAt = timestamp();
    receipt.outcome = { fetched: projected.fetched, unavailable: projected.unavailable, unresolved: projected.unresolved };
    await persist();
    result.fetched += projected.fetched.length; result.unavailable += projected.unavailable.length;
    result.unresolved += projected.unresolved.length;
  }
  for (const [key, receipt] of Object.entries(state.receipts)) {
    if (receipt.status !== 'response-saved') continue;
    await apply(key, receipt); result.replayed++;
  }
  // An original captured inside another member's repost is already paid for.
  // Promote that exact envelope to the shared cache before skipping its lookup,
  // so other wrappers (and later classifiers) can actually resolve the source.
  let cached = await loadQuoted();
  const initialCache = JSON.stringify(cached);
  for (const post of posts) {
    if (post?.type !== 'retweet' || sourceContextStatus(post).incomplete) continue;
    const original = { ...post.reposted, capturedAt: post.reposted.capturedAt ?? post.capturedAt ?? null };
    const observedAt = [original.fetchedAt, original.capturedAt].find(validDate) || timestamp();
    const projected = applyRepostResponse(cached, [post.refId], { tweets: [[post.refId, original]], errors: [] }, { fetchedAt: observedAt });
    cached = projected.quoted;
    result.localRecovered += projected.fetched.length;
  }
  if (JSON.stringify(cached) !== initialCache) { await saveQuoted(cached); await persist(); }
  for (const receipt of Object.values(state.receipts)) {
    if (receipt.status === 'rate-limited' && Date.parse(receipt.retryAt) > Date.parse(timestamp())) {
      // This is a known endpoint cooldown, including newly arriving IDs.
      result.deferredUntil = receipt.retryAt;
      return finish();
    }
  }
  // Count requested IDs, not returned resources, toward this run's hard cap.
  // Author expansion can return one user per ID, hence the 2x headroom guard.
  const available = Number(await remainingReads(await loadUsage()));
  const limit = Math.min(25, Number.isFinite(maxIds) ? Math.max(0, Math.floor(maxIds)) : 0,
    available === Infinity ? 25 : Math.max(0, Math.floor(available / 2)));
  const todo = selectRepostReferences(posts, { quoted: await loadQuoted(), archive, attemptedIds,
    now: Date.parse(timestamp()), limit });
  if (!todo.length) return finish();
  await beforeLookup(); // missing configuration must not consume an attempt
  const startedAt = timestamp();
  const ids = todo.map((row) => row.id);
  const key = hash({ policy: 'repost-acquisition-v1', ids, startedAt, runId });
  const receipt = { ids, requestHash: hash(ids), startedAt, usageDay: usageDay(startedAt), status: 'intent' };
  state.receipts[key] = receipt;
  await persist(); // a failed remote checkpoint forbids the network call
  let response;
  try {
    result.calls++; result.requested = ids.length;
    response = await lookup(ids, { withText: true });
  } catch (error) {
    receipt.status = 'uncertain'; receipt.uncertainAt = timestamp();
    // Provider errors can contain arbitrary source text. Keep only a typed
    // code here; request URLs, headers, and credentials never enter public data.
    receipt.error = 'Lookup did not return a checkpointable response; automatic resubmission disabled';
    if (Number.isInteger(error?.status)) receipt.httpStatus = error.status;
    result.uncertain++;
    await persist();
    return finish();
  }
  receipt.response = serializeRepostResponse(response); receipt.respondedAt = timestamp();
  receipt.responseHash = hash(receipt.response); receipt.usageDay = usageDay(receipt.respondedAt);
  receipt.status = 'response-saved';
  await persist();
  await apply(key, receipt);
  return finish();
}
