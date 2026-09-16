// Incremental classification shares the nightly request/validation contract.
// Missing or rejected records stay pending on disk and retry on later polls,
// including polls that captured nothing new. Nightly results remain separate.
import { anthropicClient, anthropicConfigured } from './anthropic-auth.js';
import { settings, etDate, daysAgoEt, writeJSON, p } from './util.js';
import { loadTaxonomy } from './taxonomy.js';
import { loadDay, topicsPath, archiveDates } from './store.js';
import { planChunkRequests, classifySync, planDay, remainingPlan, pendingIdsFor, writeDay, readClassificationFile, mergeEmerging, emptyOut, finishOut, withCandidates, hintedCount, withEvidence, newsReconsideration, sourceReconsideration, sourceMetadataChanged, inputBlockMetadataChanged, makeRepostResolver } from './classify.js';
import { loadNews } from './news-context.js';
import { readQueue, queuePath, withQueueLock } from './classification-queue.js';
import { quotedResolver } from './quoted.js';
import { loadSemanticOrNull } from './semantic.js';
import { inferenceFailureReason, inferenceReceipt } from './inference-health.js';

export const liveTopicsPath = (date) => p('data', 'topics-live', `${date}.json`);

function resolver() {
  try { return quotedResolver(); } catch (e) {
    console.warn(`[classify-live] quoted context unavailable: ${e.message}`);
    return () => null;
  }
}

async function similarityHints(items, tax) {
  const warn = (m) => console.warn(`[classify-live] ${m}`);
  try { return await withCandidates(items, loadSemanticOrNull({ warn }), { tax, warn }); }
  catch (e) { warn(`similarity hints unavailable: ${e.message}`); return items; }
}

function interpretationTime(file) {
  const timestamps = [file?.updatedAt, file?.classifiedAt].map((value) => Date.parse(value || ''));
  return Math.max(-Infinity, ...timestamps.filter(Number.isFinite));
}

// A settled nightly interpretation overrides provisional live tags unless
// completed live work has newer news or a later, changed source interpretation.
// Observations are separate from model-submitted sources: recording that an
// original arrived cannot imply an earlier model already read it.
export function combineInterpretations(live, nightly) {
  const combined = { ...live, assignments: { ...live?.assignments }, incidents: { ...live?.incidents }, provenance: { ...live?.provenance }, needsContext: { ...live?.needsContext }, corrected: { ...live?.corrected }, inputBlocks: { ...nightly?.inputBlocks, ...live?.inputBlocks }, emerging: [...(live?.emerging || [])] };
  const pending = new Set([...(live?.pendingIds || []), ...(live?.unclassified || [])]);
  const nightlyPending = new Set([...(nightly?.pendingIds || []), ...(nightly?.unclassified || [])]);
  const authoritative = new Set();
  for (const [id, topics] of Object.entries(nightly?.assignments || {})) {
    if (nightlyPending.has(id) && !nightly.corrected?.[id]) continue;
    const liveProvenance = live?.provenance?.[id];
    const nightlyProvenance = nightly?.provenance?.[id];
    const liveIsNewer = interpretationTime(live) > interpretationTime(nightly);
    const observed = liveProvenance?.sourceContextObserved;
    const submitted = liveProvenance?.sourceContext;
    const liveCompleted = Object.hasOwn(live?.assignments || {}, id) && !pending.has(id);
    const newerSourceInterpretation = liveIsNewer && submitted?.incomplete === false
      && submitted.fingerprint && submitted.fingerprint === observed?.fingerprint
      && submitted.fingerprint !== nightlyProvenance?.sourceContext?.fingerprint;
    if (!nightly.corrected?.[id] && (live?.corrected?.[id] || (liveCompleted
      && ((liveProvenance?.contextVersion || 0) > (nightlyProvenance?.contextVersion || 0) || newerSourceInterpretation)))) continue;
    combined.assignments[id] = topics;
    delete combined.inputBlocks[id];
    authoritative.add(id);
    delete combined.incidents[id];
    if (nightly.incidents?.[id]) combined.incidents[id] = nightly.incidents[id];
    delete combined.provenance[id]; delete combined.needsContext[id];
    if (nightly.provenance?.[id]) combined.provenance[id] = nightly.provenance[id];
    if (nightly.needsContext?.[id] != null) combined.needsContext[id] = nightly.needsContext[id];
    if (!nightly.corrected?.[id] && liveIsNewer && observed?.fingerprint) {
      combined.provenance[id] = { ...combined.provenance[id], sourceContextObserved: observed };
      if (observed.incomplete) combined.needsContext[id] = true;
    }
    if (nightly.corrected?.[id]) combined.corrected[id] = nightly.corrected[id];
    pending.delete(id);
  }
  combined.emerging = mergeEmerging([...mergeEmerging(combined.emerging, { remove: authoritative }), ...mergeEmerging(nightly?.emerging, { allowed: authoritative })]);
  combined.pendingIds = [...pending];
  combined.unclassified = [];
  return combined;
}

async function classifyLiveUnlocked(records, {
  enabled = process.env.CLASSIFY_LIVE !== 'false', configured = anthropicConfigured,
  tax = loadTaxonomy(), model = process.env.CLASSIFY_MODEL || settings.classify.model,
  dates = archiveDates().filter((d) => d >= daysAgoEt(1) && d <= daysAgoEt(0)),
  load = loadDay, read = readClassificationFile, write = writeJSON,
  livePath = liveTopicsPath, nightlyPath = topicsPath,
  resolve = resolver(), resolveRepost = makeRepostResolver(), hints = similarityHints,
  newsStore = loadNews({ days: 14 }), evidence = (items) => withEvidence(items, { store: newsStore }),
  queueFile = queuePath,
  client = null, clientFactory = anthropicClient, refresh,
  maxPosts = Number(process.env.CLASSIFY_LIVE_MAX_POSTS || 120),
  requestOptions = {},
  now = () => new Date().toISOString(), warn = console.warn
} = {}) {
  const inBatch = new Set(readQueue(queueFile).jobs.flatMap((job) => Object.values(job.manifest).flatMap((entry) => entry.ids)));
  const selectedDates = [...new Set([...dates, ...records.map((t) => etDate(t.createdAt))])].sort();
  const byDate = new Map(selectedDates.map((date) => [date, new Map(load(date).map((t) => [t.id, t]))]));
  for (const t of records) byDate.get(etDate(t.createdAt)).set(t.id, t);
  const prior = {}, existing = new Map();
  for (const date of selectedDates) {
    const combined = combineInterpretations(read(livePath(date), null), read(nightlyPath(date), null));
    existing.set(date, combined);
    const pending = new Set(pendingIdsFor([...byDate.get(date).values()], combined));
    for (const [id, topics] of Object.entries(combined.assignments)) if (!pending.has(id)) prior[id] = topics;
  }
  const allIds = new Set([...byDate.values()].flatMap((posts) => [...posts.keys()]));
  const plans = [];
  const capacity = Number.isFinite(maxPosts) ? Math.max(0, Math.floor(maxPosts)) : 120;
  for (const date of selectedDates) {
    const tweets = [...byDate.get(date).values()];
    const completePlan = planDay(date, { tax, tweets, prior, resolve, resolveRepost });
    const reconsiderIds = [...new Set([
      ...newsReconsideration(existing.get(date), completePlan.toClassify, newsStore, { tax }),
      ...sourceReconsideration(existing.get(date), completePlan.toClassify)
    ])];
    if (!pendingIdsFor(tweets, existing.get(date)).length && !reconsiderIds.length
      && !sourceMetadataChanged(existing.get(date), completePlan.tweets)
      && !inputBlockMetadataChanged(existing.get(date), completePlan.tweets)) continue;
    const pl = remainingPlan(completePlan, existing.get(date), { reconsiderIds });
    const deferred = pl.toClassify.filter((t) => t.type === 'retweet' && allIds.has(t.refId));
    const deferredIds = new Set(deferred.map((t) => t.id));
    pl.deferred.push(...deferred);
    pl.toClassify = pl.toClassify.filter((t) => !deferredIds.has(t.id) && !inBatch.has(t.id));
    // Reject an oversized source before enrichment and before consuming the
    // per-poll inference allowance. It stays pending with a source-specific
    // diagnostic, while later ordinary sources can still be processed.
    const sizing = planChunkRequests(pl.toClassify, tax, model, 'live_', { ...requestOptions, examples: [] });
    pl.inputBlocks = sizing.inputBlocks;
    pl.inputEvaluatedIds = Object.keys(sizing.inputBlocks);
    pl.toClassify = pl.toClassify.filter((t) => !Object.hasOwn(pl.inputBlocks, t.id));
    plans.push(pl);
  }
  if (!plans.length) return null;
  const publish = (out) => {
    // Earlier dates settle first so a repost can inherit across midnight.
    for (const pl of plans) {
      pl.previous = combineInterpretations(read(livePath(pl.date), null), read(nightlyPath(pl.date), null));
      const accepted = new Set(pl.tweets.map((t) => t.id));
      const result = { ...out, assignments: Object.fromEntries(Object.entries(out.assignments).filter(([id]) => accepted.has(id))), incidents: Object.fromEntries(Object.entries(out.incidents).filter(([id]) => accepted.has(id))) };
      // Include newly settled originals in the shared prior map. mergeDay
      // can use same-result references; cross-day references are explicit.
      for (const [id, topics] of Object.entries(out.assignments)) prior[id] = topics;
      for (const t of pl.deferred) if (prior[t.refId]) pl.inherited[t.id] = prior[t.refId];
      writeDay(pl, result, model, { pathFor: livePath, now: now(), write: (file, data) => write(file, { ...data, updatedAt: now() }) });
    }
  };
  let out = finishOut(emptyOut());
  publish(out); // Record pending IDs before attempting authentication or inference.
  let items = [];
  if (enabled && configured() && capacity > 0) {
    let authAttemptedAt = null;
    try {
      for (const pl of plans) {
        pl.toClassify = await hints(pl.toClassify, tax);
        ({ items: pl.toClassify, contextVersion: pl.contextVersion } = await evidence(pl.toClassify));
        const sizing = planChunkRequests(pl.toClassify, tax, model, 'live_', { ...requestOptions, examples: [] });
        pl.inputEvaluatedIds = [...new Set([...pl.inputEvaluatedIds, ...pl.toClassify.map((item) => item.id)])];
        Object.assign(pl.inputBlocks, sizing.inputBlocks);
        pl.toClassify = pl.toClassify.filter((t) => !Object.hasOwn(pl.inputBlocks, t.id));
      }
      items = plans.flatMap((pl) => pl.toClassify).slice(0, capacity);
      const chosen = new Set(items.map((item) => item.id));
      for (const pl of plans) pl.toClassify = pl.toClassify.filter((item) => chosen.has(item.id));
      publish(out); // persist enriched-input blocks before any provider call
      if (items.length) {
        const { requests } = planChunkRequests(items, tax, model, 'live_', requestOptions);
        if (requests.length && !client) {
          authAttemptedAt = now();
          client = await clientFactory();
          authAttemptedAt = null;
        }
        out = await classifySync(client, requests, tax, { ...(refresh ? { refresh } : {}), now, onResult: (partial) => { out = partial; publish(partial); }, log: warn });
      }
    } catch (e) {
      // Local enrichment/sizing/publication work is not an inference attempt.
      // Only an attempted credential setup may add a receipt here; actual
      // model calls publish their own receipts inside classifySync.
      if (authAttemptedAt) {
        const row = { acceptedIds: [], retryIds: items.map((item) => item.id),
          error: String(e.message || e).slice(0, 300), reasonCode: inferenceFailureReason(e) };
        row.inference = inferenceReceipt(row, { attemptedAt: authAttemptedAt, observedAt: now() });
        out.requestStatus.live_setup = row;
      }
      warn(`[classify-live] work remains pending: ${e.message}`);
    }
  }
  publish(out);
  const pending = plans.reduce((n, pl) => n + pendingIdsFor(pl.tweets, read(livePath(pl.date), null)).length, 0);
  return { tagged: Object.keys(out.assignments).length, incidents: Object.keys(out.incidents).length, quoting: items.filter((t) => t.quoting).length, hinted: hintedCount(items), anchored: plans.reduce((n, pl) => n + Object.keys(pl.anchored).length, 0), dropped: out.droppedSubs.length, echoed: out.echoedSubs.length, pending, complete: pending === 0 };
}

export async function classifyLive(records, options = {}) {
  return withQueueLock(options.queueFile || queuePath, () => classifyLiveUnlocked(records, options));
}
