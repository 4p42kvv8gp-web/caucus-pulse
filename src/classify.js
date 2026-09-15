// Factual classification shared by live, nightly and archive-range runs.
// Every model response is checked against its submitted source-ID manifest.
// Partial results are published with durable pending IDs, and later runs retry
// only unresolved work. Batch manifests preserve the original dates, model,
// taxonomy and request membership across restarts.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { anthropicClient, refreshIdentityToken } from './anthropic-auth.js';
import { settings, daysAgoEt, writeJSON } from './util.js';
import { loadState, saveState, loadDay, topicsPath, archivePath, archiveDates } from './store.js';
import { readJSONL } from './util.js';
import { loadTaxonomy, systemPrompt, validAssignments, parseJsonLoose, anchorIndex } from './taxonomy.js';
import { quotedResolver, quotingFor, loadQuoted, archiveLookup } from './quoted.js';
import { sourceContextStatus, createRepostResolver } from './source-context.js';
import { configuredMinSim, storyRow, loadSemanticOrNull } from './semantic.js';
import { embed as sharedEmbed } from './embeddings.js';
import { correctionExamples } from './corrections.js';
import { loadNews, evidenceForPosts, evidenceLine, reconsiderCandidates } from './news-context.js';
import { loadFloor, floorEvidenceForPost } from './floor-context.js';
import { readQueue, saveQueue, submitJob, finishJob, requestManifest, queuePath, withQueueLock } from './classification-queue.js';

export { loadTaxonomy, renderTaxonomy, validAssignments, parseJsonLoose, anchorIndex } from './taxonomy.js';

// Missing interpretation files are normal; unreadable/corrupt files are not
// an empty corpus and must not trigger a silent paid reclassification.
export function readClassificationFile(file, fallback = null) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
  const data = JSON.parse(text);
  if (!data || !data.assignments || typeof data.assignments !== 'object' || Array.isArray(data.assignments)) throw new Error(`Invalid classification file: ${file}`);
  return data;
}

// One input line for the model. Exactly {id, text} unless the item carries
// quoted context and/or similarity candidates — the line is what the
// prompt's "quoting" and "candidates" rules refer to. Key order is fixed so
// a post without extras serialises exactly as it always has.
export function classifierLine(t) {
  const line = { id: t.id, text: t.text };
  const context = sourceContextStatus(t);
  if (t.type === 'retweet') {
    line.type = t.type; line.refId = t.refId ?? null; line.sourceContext = context;
  }
  if (t.createdAt) line.createdAt = t.createdAt;
  if (t.quoting) line.quoting = t.quoting;
  if (t.reposted?.text && !context.incomplete) line.reposting = {
    id: t.reposted.id, authorId: t.reposted.authorId ?? null, handle: t.reposted.handle ?? null,
    text: t.reposted.text, createdAt: t.reposted.createdAt ?? null
  };
  if (t.candidates?.length) line.candidates = t.candidates;
  if (t.evidence?.length) line.evidence = t.evidence.map(evidenceLine);
  if (t.officialAgenda?.length) line.officialAgenda = t.officialAgenda;
  if (Number.isInteger(t.contextVersion)) line.contextVersion = t.contextVersion;
  return JSON.stringify(line);
}

export const makeRepostResolver = () => createRepostResolver({ quoted: loadQuoted(), archive: archiveLookup() });

// Record a baseline without inference, then reopen only when new complete
// original wording differs. Missing context is not a failed classification.
export function sourceReconsideration(previous, tweets) {
  const pending = new Set(pendingIdsFor(tweets, previous));
  return tweets.filter((post) => {
    if (post.type !== 'retweet' || pending.has(post.id) || previous?.corrected?.[post.id]) return false;
    const current = sourceContextStatus(post);
    const provenance = previous?.provenance?.[post.id];
    const baseline = provenance?.sourceContext || provenance?.sourceContextObserved;
    return !current.incomplete && Boolean(baseline?.fingerprint) && baseline.fingerprint !== current.fingerprint;
  }).map((post) => post.id);
}

export function sourceMetadataChanged(previous, tweets) {
  return tweets.some((post) => {
    if (post.type !== 'retweet' || previous?.corrected?.[post.id] || !Object.hasOwn(previous?.assignments || {}, post.id)) return false;
    const current = sourceContextStatus(post), observed = previous?.provenance?.[post.id]?.sourceContextObserved;
    return observed?.fingerprint !== current.fingerprint || (current.incomplete && previous?.needsContext?.[post.id] !== true);
  });
}

// A human correction or a removed source can settle a previously blocked ID
// without selecting any inference work. Persist that diagnostic cleanup too.
export function inputBlockMetadataChanged(previous, tweets) {
  const pending = new Set(pendingIdsFor(tweets, previous));
  return Object.keys(previous?.inputBlocks || {}).some((id) => !pending.has(id) || previous?.corrected?.[id]);
}

// Read one public-source snapshot per run. Request splitting below keeps
// every selected source while bounding each prompt; a cap must not silently
// deprive later posts of the evidence that triggered reconsideration.
export function withEvidence(items, { store = loadNews({ days: 14 }), agenda = loadFloor(), now = Date.now(), ...opts } = {}) {
  const { byPost } = evidenceForPosts(items, { ...opts, items: store.items, version: store.version, k: 2, perChunkCap: Infinity });
  const contextVersion = Number.isInteger(store.version) ? store.version : 0;
  return { items: items.map((t) => ({ ...t, evidence: byPost[t.id] || [],
    officialAgenda: floorEvidenceForPost(t, { agenda, now: new Date(now).toISOString() }), contextVersion })), contextVersion };
}

// Recompute candidates from the current source store, rather than trusting a
// stale JSON queue. Only a changed, relevant source can reopen a completed
// decision; unrelated hourly news updates do not cause another model call.
export function newsReconsideration(previous, tweets, store = loadNews({ days: 14 }), { tax = loadTaxonomy() } = {}) {
  if (!store.items.length) return [];
  const pending = new Set(pendingIdsFor(tweets, previous));
  const ids = [];
  for (const t of tweets) {
    if (pending.has(t.id) || previous?.corrected?.[t.id] || t.type === 'retweet') continue;
    const topics = previous?.assignments?.[t.id];
    if (!topics) continue;
    // Ordinary subtopics such as detention or AI policy do not identify an
    // event. Only a declared story row or emerging entry settles identity.
    const namedStory = topics.some(([macro, sub]) => sub && tax[macro]?.subtopics?.[sub]?.story);
    const emerging = previous?.emerging?.some((entry) => entry.ids?.includes(t.id));
    if ((namedStory || emerging) && !previous?.needsContext?.[t.id]) continue;
    const sinceVersion = previous?.provenance?.[t.id]?.contextVersion || 0;
    const candidateTopics = topics.map(([macro]) => [macro, null]);
    if (reconsiderCandidates({ assignments: { [t.id]: candidateTopics } }, [t], { sinceVersion, items: store.items }).length) ids.push(t.id);
  }
  return ids;
}

// Items with their quoted context attached (a copy per item that has one;
// the rest pass through untouched). `resolve` is post → context.
export function withQuoting(items, resolve) {
  return items.map((t) => {
    const quoting = quotingFor(resolve(t));
    return quoting ? { ...t, quoting } : t;
  });
}

// ── Similarity candidates ────────────────────────────────────────────────

// One hint from a story the post's vector is near: a live taxonomy row
// becomes {story: "macro/sub"}; a retired row becomes nothing (it left the
// prompt on purpose); a story the taxonomy has no row for (a stories.json
// candidate) becomes {emerging: label} so the model reuses the label the
// story pipeline already merges on.
export function candidateHint(story, tax, sim) {
  if (!story) return null;
  const rounded = +Number(sim).toFixed(2);
  const row = storyRow(story, tax);
  if (row) return row.def.retired ? null : { story: row.id, sim: rounded };
  const label = story.label && story.label !== story.key ? story.label : null;
  return label ? { emerging: label, sim: rounded } : null;
}

// Items with `candidates` attached: the top `k` stories within `minSim` of
// each post. Vectors come from the index when the post is embedded; the
// rest are embedded in one batch, or skipped (one warning) when the model is
// not on disk. No semantic layer → the same array back, untouched.
export async function withCandidates(items, semantic, {
  tax = loadTaxonomy(),
  k = settings.semantic?.candidates ?? 3,
  minSim = configuredMinSim(),
  embed = sharedEmbed,
  warn = console.warn
} = {}) {
  if (!semantic || !items.length || !(k > 0)) return items;
  const vectors = new Map();
  const missing = [];
  for (const t of items) {
    const v = semantic.index.get(t.id);
    if (v) vectors.set(t.id, v); else missing.push(t);
  }
  if (missing.length) {
    try {
      const vs = await embed(missing.map((t) => t.text));
      missing.forEach((t, i) => vectors.set(t.id, vs[i]));
    } catch (e) {
      warn(`[classify] similarity hints: ${missing.length} unindexed post(s) skipped (${e.message})`);
    }
  }
  const out = [];
  for (const t of items) {
    const v = vectors.get(t.id);
    if (!v) { out.push(t); continue; }
    const hits = await semantic.relatedStories(v, { k: k * 2, minSim });
    const candidates = hits.map((h) => candidateHint(semantic.story(h.story), tax, h.sim)).filter(Boolean).slice(0, k);
    out.push(candidates.length ? { ...t, candidates } : t);
  }
  return out;
}

export const hintedCount = (items) => items.filter((t) => t.candidates?.length).length;

// custom_id must match ^[a-zA-Z0-9_-]{1,64}$ — a date prefix keeps multi-day
// batches separable ("2026-08-20_chunk-3").
export function classificationExamples(tax, { warn = console.warn } = {}) {
  try { return correctionExamples(settings.classify.correction_examples ?? 8, { tax }); }
  catch (e) { warn(`[classify] correction examples unavailable: ${e.message}`); return []; }
}

export function planChunkRequests(items, tax, model, prefix = '', { examples = classificationExamples(tax), evidenceCap = 12, inputCharsCap = 120_000 } = {}) {
  if (!Number.isSafeInteger(inputCharsCap) || inputCharsCap < 1) throw new Error('Classification input limit must be a positive integer');
  const limit = Math.min(inputCharsCap, 120_000);
  const per = settings.classify.tweets_per_request || 40;
  const system = [{ type: 'text', text: systemPrompt(tax, { examples }), cache_control: { type: 'ephemeral' } }];
  const requests = [];
  const chunks = [];
  const blocked = [];
  let chunk = [], evidenceCount = 0, inputChars = 0;
  for (const item of items) {
    // Serialize once: the measured source and the submitted source must be
    // identical, including complete quoted wording and escaped characters.
    const line = classifierLine(item);
    if (line.length > limit) {
      blocked.push([item.id, { reason: 'input-too-large', inputChars: line.length, limit,
        inputHash: createHash('sha256').update(line).digest('hex') }]);
      continue;
    }
    const count = (item.evidence?.length || 0) + (item.officialAgenda?.length || 0);
    if (chunk.length && (chunk.length >= per || evidenceCount + count > evidenceCap || inputChars + 1 + line.length > limit)) {
      chunks.push(chunk); chunk = []; evidenceCount = 0; inputChars = 0;
    }
    inputChars += line.length + (chunk.length ? 1 : 0);
    chunk.push(line); evidenceCount += count;
  }
  if (chunk.length) chunks.push(chunk);
  for (const [i, chunk] of chunks.entries()) {
    requests.push({
      custom_id: `${prefix}chunk-${i}`,
      params: {
        model,
        max_tokens: 8000,
        system,
        messages: [{
          role: 'user',
          content: chunk.join('\n')
        }]
      }
    });
  }
  return { requests, inputBlocks: Object.fromEntries(blocked) };
}

// Existing callers must never silently lose an oversized source. The live,
// nightly and range runners use the planner and persist its pending reason.
export function chunkRequests(...args) {
  const { requests, inputBlocks } = planChunkRequests(...args);
  if (Object.keys(inputBlocks).length) {
    const error = new Error(`Classification input too large for ${Object.keys(inputBlocks).join(', ')}; use planChunkRequests to retain pending diagnostics`);
    error.inputBlocks = inputBlocks;
    throw error;
  }
  return requests;
}

// ── Story anchors ────────────────────────────────────────────────────────

// Union of topic lists, first occurrence wins, deduped by macro/sub.
export function mergeTopics(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const t of list || []) {
      const [macro, sub = null] = t;
      const key = `${macro}/${sub ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([macro, sub]);
    }
  }
  return out;
}

// {id → [[macro, sub], ...]} for every post that IS an anchor or points at
// one (quote, reply or retweet refId). Deterministic — no model involved.
export function anchoredAssignments(tweets, anchors) {
  const out = {};
  if (!anchors?.size) return out;
  for (const t of tweets) {
    const topics = mergeTopics(anchors.get(t.id), t.refId ? anchors.get(t.refId) : null);
    if (topics.length) out[t.id] = topics;
  }
  return out;
}

export const INCIDENT_KINDS = new Set(['active shooter', 'shooting', 'wildfire', 'flooding', 'severe storm', 'tornado', 'hurricane', 'extreme heat', 'power outage', 'water outage', 'hazmat', 'structure fire', 'explosion', 'plane crash', 'train crash', 'industrial accident', 'infrastructure failure', 'missing persons', 'other']);

// Retain only complete, structurally valid records belonging to this exact
// request. Partial success is useful: missing/rejected IDs remain retryable,
// while unrelated IDs can never enter the corpus through a model response.
export function mergeParsed(parsed, tax, out, expectedIds, { evidenceByPost = {}, contextVersions = {}, sourceContextByPost = {}, quotedContextByPost = {}, inputHash = null } = {}) {
  if (!Array.isArray(expectedIds)) throw new Error('Classification response requires a request ID manifest');
  const expected = new Set(expectedIds);
  const counts = new Map();
  const errors = [];
  const accepted = new Set();
  const rows = Array.isArray(parsed?.assignments) ? parsed.assignments : [];
  if (!Array.isArray(parsed?.assignments)) errors.push({ code: 'invalid-assignments' });
  for (const a of rows) if (typeof a?.id === 'string') counts.set(a.id, (counts.get(a.id) || 0) + 1);
  for (const a of rows) {
    const id = a?.id;
    if (typeof id !== 'string' || !expected.has(id)) { errors.push({ code: 'unexpected-id', id: typeof id === 'string' ? id : null }); continue; }
    if (counts.get(id) !== 1) { errors.push({ code: 'duplicate-id', id }); continue; }
    const supplied = evidenceByPost[id] || [];
    const suppliedIds = new Set(supplied.map((e) => e.id));
    const evidenceUsed = a.evidence_used ?? [];
    if (!Array.isArray(evidenceUsed) || evidenceUsed.some((ref) => typeof ref !== 'string' || !suppliedIds.has(ref)) || new Set(evidenceUsed).size !== evidenceUsed.length) {
      errors.push({ code: 'invalid-evidence-reference', id }); continue;
    }
    if (a.needs_context != null && typeof a.needs_context !== 'boolean') { errors.push({ code: 'invalid-context-status', id }); continue; }
    if (!Array.isArray(a.topics) || a.topics.length > 4 || a.topics.some((t) => !Array.isArray(t) || t.length !== 2 || typeof t[0] !== 'string' || !Object.hasOwn(tax, t[0]) || (t[1] !== null && (typeof t[1] !== 'string' || !t[1].trim())))) {
      errors.push({ code: 'invalid-topics', id }); continue;
    }
    const dropped = [], echoed = [];
    const topics = validAssignments(a.topics, tax, dropped, echoed);
    if (dropped.length) { (out.droppedSubs ||= []).push(...dropped); errors.push({ code: 'unknown-subtopic', id }); continue; }
    let incident = null;
    if (a.incident != null) {
      const v = a.incident;
      const kind = typeof v.kind === 'string' ? v.kind.trim().toLowerCase() : '';
      if (!INCIDENT_KINDS.has(kind) || typeof v.place !== 'string' || !v.place.trim() || v.place.length > 300 || (v.name != null && (typeof v.name !== 'string' || v.name.length > 300))) {
        errors.push({ code: 'invalid-incident', id }); continue;
      }
      incident = { kind, place: v.place.trim(), name: v.name?.trim() || null };
    }
    out.assignments[id] = topics;
    delete out.incidents[id];
    if (incident) out.incidents[id] = incident;
    const sourceContext = sourceContextByPost[id];
    const quotedContext = quotedContextByPost[id];
    (out.provenance ||= {})[id] = { contextVersion: contextVersions[id] || 0, evidenceSupplied: supplied, evidenceUsed, inputHash,
      ...(sourceContext ? { sourceContext } : {}), ...(quotedContext ? { quotedContext } : {}) };
    (out.needsContext ||= {})[id] = sourceContext?.incomplete === true || a.needs_context === true;
    (out.echoedSubs ||= []).push(...echoed);
    accepted.add(id);
  }
  const incompleteEmerging = new Set();
  if (parsed?.emerging != null && !Array.isArray(parsed.emerging)) {
    errors.push({ code: 'invalid-emerging' });
    for (const id of accepted) incompleteEmerging.add(id);
  }
  for (const e of Array.isArray(parsed?.emerging) ? parsed.emerging : []) {
    if (typeof e?.label !== 'string' || !e.label.trim() || e.label.length > 300 || !Array.isArray(e.ids)) {
      errors.push({ code: 'invalid-emerging-entry' });
      for (const id of (Array.isArray(e?.ids) ? e.ids : accepted)) if (accepted.has(id)) incompleteEmerging.add(id);
      continue;
    }
    const ids = [];
    for (const id of e.ids) {
      if (typeof id !== 'string' || !expected.has(id) || !accepted.has(id)) { errors.push({ code: 'invalid-emerging-reference', id: typeof id === 'string' ? id : null }); continue; }
      ids.push(id);
    }
    if (!ids.length) continue;
    const key = e.label.trim().toLowerCase();
    const entry = out.emergingMap.get(key) || { label: e.label.trim(), ids: [] };
    entry.ids = [...new Set([...entry.ids, ...ids])];
    out.emergingMap.set(key, entry);
  }
  for (const id of incompleteEmerging) {
    delete out.assignments[id]; delete out.incidents[id]; accepted.delete(id);
    delete out.provenance?.[id]; delete out.needsContext?.[id];
    for (const [key, entry] of out.emergingMap) {
      entry.ids = entry.ids.filter((ref) => ref !== id);
      if (!entry.ids.length) out.emergingMap.delete(key);
    }
  }
  const retryIds = expectedIds.filter((id) => !accepted.has(id));
  for (const id of retryIds) if (!counts.has(id)) errors.push({ code: 'missing-id', id });
  (out.validationErrors ||= []).push(...errors);
  return { acceptedIds: [...accepted], retryIds, errors };
}

export const emptyOut = () => ({ assignments: {}, incidents: {}, provenance: {}, needsContext: {}, inputBlocks: {}, emergingMap: new Map(), failedChunks: 0, droppedSubs: [], echoedSubs: [], validationErrors: [], requestStatus: {} });
export const finishOut = (o) => ({ assignments: o.assignments, incidents: o.incidents, provenance: o.provenance, needsContext: o.needsContext, inputBlocks: o.inputBlocks || {}, emerging: [...o.emergingMap.values()], failedChunks: o.failedChunks, droppedSubs: o.droppedSubs, echoedSubs: o.echoedSubs, validationErrors: o.validationErrors, requestStatus: o.requestStatus });

// Stream a finished batch's results, grouped by the custom_id prefix before
// "chunk-" (empty string for single-day batches). Returns {prefix → result}.
export async function collectResults(client, batchId, tax, manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('Batch results require their saved request manifest');
  const byPrefix = new Map();
  const received = new Map();
  const bucket = (id) => {
    const prefix = String(id).replace(/chunk-\d+$/, '');
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, emptyOut());
    return byPrefix.get(prefix);
  };
  for await (const result of await client.messages.batches.results(batchId)) {
    const id = result.custom_id;
    if (!Object.hasOwn(manifest, id)) { console.warn(`[classify] ignored unexpected batch result ${String(id)}`); continue; }
    if (received.has(id)) { received.set(id, null); continue; }
    received.set(id, result);
  }
  for (const [id, entry] of Object.entries(manifest)) {
    const out = bucket(id);
    const result = received.get(id);
    if (!result || result.result?.type !== 'succeeded') {
      out.failedChunks++;
      out.requestStatus[id] = { acceptedIds: [], retryIds: entry.ids, error: result?.result?.type || (received.has(id) ? 'duplicate-result' : 'missing-result') };
      continue;
    }
    mergeMessage(result.result.message, tax, out, entry.ids, id, entry);
  }
  return new Map([...byPrefix].map(([k, v]) => [k, finishOut(v)]));
}

// One model reply → out. A refusal or an unparseable reply counts as a
// failed chunk, the same as a batch request that errored.
export function mergeMessage(message, tax, out, expectedIds, requestId = 'request', manifestEntry = {}) {
  const textBlock = message?.stop_reason !== 'refusal' && message?.stop_reason !== 'max_tokens' && message?.content?.find((b) => b.type === 'text');
  const parsed = textBlock && parseJsonLoose(textBlock.text);
  if (!parsed) {
    out.failedChunks++;
    out.requestStatus[requestId] = { acceptedIds: [], retryIds: expectedIds, error: message?.stop_reason || 'unparseable' };
    return;
  }
  const result = mergeParsed(parsed, tax, out, expectedIds, manifestEntry);
  out.requestStatus[requestId] = result;
  if (result.retryIds.length) out.failedChunks++;
}

// The same requests chunkRequests builds for a batch, sent one at a time
// through messages.create. Full price instead of the batch's half, which at
// ~16 requests a day is a couple of dollars — the escape hatch for a batch
// that sits in Anthropic's queue for hours (2026-09-11: 0 of 16 done after
// two hours) while the dashboard shows a day with no topics.
export async function classifySync(client, requests, tax, { log = () => {}, refresh = refreshIdentityToken, onResult = null } = {}) {
  const out = emptyOut();
  for (const [i, req] of requests.entries()) {
    const manifestEntry = requestManifest([req])[req.custom_id];
    const ids = manifestEntry.ids;
    try {
      await refresh();
      const res = await client.messages.create(req.params);
      mergeMessage(res, tax, out, ids, req.custom_id, manifestEntry);
      log(`[classify] sync ${i + 1}/${requests.length}: ${res.stop_reason}, ${res.usage?.output_tokens ?? '?'} output tokens`);
    } catch (e) {
      out.failedChunks++;
      out.requestStatus[req.custom_id] = { acceptedIds: [], retryIds: ids, error: String(e.message || e).slice(0, 300) };
      log(`[classify] sync ${i + 1}/${requests.length} failed: ${e.message}`);
    }
    if (onResult) await onResult(finishOut(out));
  }
  return finishOut(out);
}

// Look up an original tweet's assignment for retweet inheritance — checks
// the day being classified plus the two days before it.
export function priorAssignments(date) {
  const map = {};
  for (let d = 2; d >= 0; d--) {
    const dt = new Date(`${date}T12:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() - d);
    const file = readClassificationFile(topicsPath(dt.toISOString().slice(0, 10)), null);
    if (file) {
      const pending = new Set([...(file.pendingIds || []), ...(file.unclassified || [])]);
      for (const [id, topics] of Object.entries(file.assignments || {})) if (!pending.has(id) || file.corrected?.[id]) map[id] = topics;
    }
  }
  return map;
}

// Ids archived on `date` and the two days before — originals a retweet could
// inherit from once those days are classified (multi-day runs).
function corpusIds(date) {
  const ids = new Set();
  for (let d = 2; d >= 0; d--) {
    const dt = new Date(`${date}T12:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() - d);
    for (const t of readJSONL(archivePath(dt.toISOString().slice(0, 10)), { strict: true })) ids.add(t.id);
  }
  return ids;
}

// Decide what goes to the model for one day. With deferInCorpus, a retweet
// whose original is archived nearby but not classified yet is held back and
// resolved at writeDay time (after the earlier day lands) instead of being
// classified from its truncated "RT @…" text.
//
// Quotes and replies leave with their quoted context attached (`quoting`);
// `anchored` holds the story assignments the taxonomy's anchors settle
// before the model runs. deps (tests): tax, tweets, prior, resolve.
export function planDay(date, {
  deferInCorpus = false,
  tax = loadTaxonomy(),
  tweets = loadDay(date),
  prior = priorAssignments(date),
  resolve = quotedResolver(),
  resolveRepost = makeRepostResolver()
} = {}) {
  tweets = tweets.map((post) => {
    if (post.type !== 'retweet') return post;
    const original = resolveRepost(post);
    return original ? { ...post, reposted: original } : post;
  });
  const corpus = deferInCorpus ? corpusIds(date) : null;
  const inherited = {};
  const deferred = [];
  const toClassify = [];
  for (const t of tweets) {
    if (t.type === 'retweet' && prior[t.refId]) inherited[t.id] = prior[t.refId];
    else if (t.type === 'retweet' && corpus?.has(t.refId)) deferred.push(t);
    else toClassify.push(t);
  }
  const anchored = anchoredAssignments(tweets, anchorIndex(tax));
  return { date, tweets, toClassify: withQuoting(toClassify, resolve), inherited, deferred, anchored };
}

export function pendingIdsFor(tweets, file) {
  const pending = new Set([...(file?.pendingIds || []), ...(file?.unclassified || [])]);
  return tweets.filter((t) => !Object.hasOwn(file?.assignments || {}, t.id) || (pending.has(t.id) && !file?.corrected?.[t.id])).map((t) => t.id);
}

export function dayComplete(tweets, file) {
  return Boolean(file && !pendingIdsFor(tweets, file).length);
}

// Retry only unresolved records. Already completed [] is a valid decision,
// distinct from an absent or pending interpretation.
export function remainingPlan(plan, previous = null, { reconsiderIds = [] } = {}) {
  const pending = new Set([...pendingIdsFor(plan.tweets, previous), ...reconsiderIds.filter((id) => !previous?.corrected?.[id])]);
  return {
    ...plan, previous, reconsiderIds: reconsiderIds.filter((id) => !previous?.corrected?.[id]),
    toClassify: plan.toClassify.filter((t) => pending.has(t.id)),
    deferred: plan.deferred.filter((t) => pending.has(t.id))
  };
}

export function mergeEmerging(groups, { allowed = null, remove = new Set() } = {}) {
  const byLabel = new Map();
  for (const e of groups || []) {
    if (typeof e?.label !== 'string') continue;
    const ids = (Array.isArray(e.ids) ? e.ids : []).filter((id) => (!allowed || allowed.has(id)) && !remove.has(id));
    if (!ids.length) continue;
    const key = e.label.trim().toLowerCase();
    const entry = byLabel.get(key) || { label: e.label.trim(), ids: [] };
    entry.ids = [...new Set([...entry.ids, ...ids])];
    byLabel.set(key, entry);
  }
  return [...byLabel.values()];
}

// The day file's content from a plan and its batch result: retweets inherit
// (from this batch, then from prior days), anchors merge over whatever the
// model said. Anchors do not hide another supported emerging event, and a
// missing model response stays pending even when a deterministic anchor exists. `prior` is injectable (tests);
// by default prior days are re-read so deferred retweets inherit from days
// written earlier in the same run.
export function mergeDay(plan, result, { prior } = {}) {
  const { date, tweets, toClassify, deferred, anchored = {} } = plan;
  const { assignments, failedChunks = 0, droppedSubs = [], echoedSubs = [] } = result;
  const sourceIds = new Set(tweets.map((t) => t.id));
  const previous = plan.previous || {};
  const keepSource = (obj) => Object.fromEntries(Object.entries(obj || {}).filter(([id]) => sourceIds.has(id)));
  const modelIds = new Set(Object.keys(assignments).filter((id) => sourceIds.has(id) && !previous.corrected?.[id]));
  const keepModel = (obj) => Object.fromEntries(Object.entries(obj || {}).filter(([id]) => modelIds.has(id)));
  const base = keepSource(previous.assignments);
  const incidents = keepSource(previous.incidents);
  const provenance = keepSource(previous.provenance);
  const needsContext = keepSource(previous.needsContext);
  for (const id of modelIds) { delete incidents[id]; delete provenance[id]; delete needsContext[id]; }
  Object.assign(incidents, keepModel(result.incidents));
  Object.assign(provenance, keepModel(result.provenance));
  Object.assign(needsContext, keepModel(result.needsContext));
  const inherited = { ...plan.inherited };
  const priorMap = prior ?? (tweets.some((t) => t.type === 'retweet') ? priorAssignments(date) : {});
  for (const t of tweets) {
    if (t.type !== 'retweet') continue;
    if (previous.corrected?.[t.refId] && base[t.refId]) inherited[t.id] = base[t.refId];
    else if (assignments[t.refId]) inherited[t.id] = assignments[t.refId];
    else if (priorMap[t.refId]) inherited[t.id] = priorMap[t.refId];
    else if (base[t.refId] && !(previous.pendingIds || []).includes(t.refId)) inherited[t.id] = base[t.refId];
    if (inherited[t.id] && !previous.corrected?.[t.id]) {
      provenance[t.id] = { ...(provenance[t.refId] || {}), inheritedFrom: t.refId };
      needsContext[t.id] = needsContext[t.refId] || false;
      provenance[t.id].sourceContext = sourceContextStatus(t);
    }
  }
  const merged = { ...base, ...keepSource(assignments), ...inherited };
  for (const [id, topics] of Object.entries(anchored)) merged[id] = mergeTopics(topics, merged[id]);
  for (const id of Object.keys(previous.corrected || {})) if (Object.hasOwn(base, id)) merged[id] = base[id];
  for (const post of tweets) {
    if (post.type !== 'retweet' || !Object.hasOwn(merged, post.id) || previous.corrected?.[post.id]) continue;
    const current = sourceContextStatus(post);
    provenance[post.id] = { ...provenance[post.id], sourceContextObserved: current };
    // Retain the exact submitted fingerprint when a batch finishes after the
    // source changed; the next plan can reconsider that change once.
    if (current.incomplete) needsContext[post.id] = true;
  }
  const anchoredIds = new Set(Object.keys(anchored));
  const oldEmerging = mergeEmerging(previous.emerging, { allowed: sourceIds, remove: modelIds });
  const newEmerging = mergeEmerging(result.emerging, { allowed: modelIds });
  const emerging = mergeEmerging([...oldEmerging, ...newEmerging], { allowed: sourceIds });
  const unclassified = tweets.filter((t) => !(t.id in merged)).map((t) => t.id);
  const previouslyPending = new Set(pendingIdsFor(tweets, previous));
  const settled = new Set(Object.keys(base).filter((id) => !previouslyPending.has(id)));
  for (const id of plan.reconsiderIds || []) if (!previous.corrected?.[id]) settled.delete(id);
  for (const id of [...Object.keys(assignments), ...Object.keys(inherited)]) settled.add(id);
  const pendingIds = tweets.filter((t) => !settled.has(t.id)).map((t) => t.id);
  const pending = new Set(pendingIds);
  const priorInputBlocks = { ...previous.inputBlocks };
  // A newly measured input may fit even when its provider call later fails.
  // Keep it pending for that failure, without retaining a stale size diagnosis.
  for (const id of plan.inputEvaluatedIds || []) delete priorInputBlocks[id];
  const inputBlocks = Object.fromEntries(Object.entries({ ...priorInputBlocks, ...plan.inputBlocks, ...result.inputBlocks })
    .filter(([id]) => sourceIds.has(id) && pending.has(id) && !previous.corrected?.[id]));
  return {
    day: { date, assignments: merged, incidents, provenance, needsContext, inputBlocks, contextVersion: Math.max(0, ...Object.values(provenance).map((p) => p.contextVersion || 0)), emerging, unclassified, pendingIds, complete: !pendingIds.length, anchored, failedChunks, droppedSubs, echoedSubs, validationErrors: result.validationErrors || [], requestStatus: result.requestStatus || {}, corrected: keepSource(previous.corrected) },
    stats: {
      classified: Object.keys(assignments).length,
      inherited: Object.keys(inherited).length,
      anchored: anchoredIds.size,
      incidents: Object.keys(incidents).length,
      emerging: emerging.length,
      unclassified: unclassified.length,
      droppedSubs: droppedSubs.length,
      echoedSubs: echoedSubs.length,
      failedChunks
    }
  };
}

// Write data/topics/<date>.json from a plan and its batch result.
export function writeDay(plan, result, model, { pathFor = topicsPath, write = writeJSON, now = new Date().toISOString() } = {}) {
  const { day, stats } = mergeDay(plan, result);
  write(pathFor(plan.date), {
    date: day.date,
    model,
    classifiedAt: now,
    assignments: day.assignments,
    incidents: day.incidents,
    provenance: day.provenance,
    needsContext: day.needsContext,
    inputBlocks: day.inputBlocks,
    contextVersion: day.contextVersion,
    emerging: day.emerging,
    unclassified: day.unclassified,
    pendingIds: day.pendingIds,
    complete: day.complete,
    anchored: day.anchored,
    failedChunks: day.failedChunks,
    droppedSubs: day.droppedSubs,
    echoedSubs: day.echoedSubs,
    validationErrors: day.validationErrors,
    requestStatus: day.requestStatus,
    ...(Object.keys(day.corrected).length ? { corrected: day.corrected } : {})
  });
  return stats;
}

export function summarize(date, s) {
  return `[classify] ${date}: ${s.classified} classified, ${s.inherited} inherited, ${s.anchored ? `${s.anchored} anchored, ` : ''}${s.incidents} incident-flagged, ${s.emerging} emerging clusters, ${s.unclassified} unclassified${s.droppedSubs ? `, ${s.droppedSubs} SUBTOPIC KEY(S) DROPPED AS UNRESOLVABLE` : ''}${s.echoedSubs ? `, ${s.echoedSubs} subtopic key(s) answered as macro/sub and resolved` : ''}${s.failedChunks ? `, ${s.failedChunks} chunk(s) failed` : ''}`;
}

// Shared runner for nightly and range work. All dates share one durable queue,
// so a later invocation cannot overwrite a batch that is still processing.
async function runClassificationUnlocked({
  dates = archiveDates().filter((d) => d < daysAgoEt(0)),
  source = 'nightly', sync = false, dryRun = false, resumeOnly = false,
  maxWaitMinutes = Number(process.env.CLASSIFY_MAX_WAIT_MINUTES ?? 0),
  model = process.env.CLASSIFY_MODEL || settings.classify.model,
  tax = loadTaxonomy(), queueFile = queuePath,
  client = null, clientFactory = anthropicClient,
  loadDay: loadDayFn = loadDay,
  topicsFor = (date) => readClassificationFile(topicsPath(date), null),
  plan = (date, taxonomy) => planDay(date, { tax: taxonomy }),
  publish = writeDay,
  hints = async (items, taxonomy) => withCandidates(items, loadSemanticOrNull({ warn: (m) => console.warn(`[classify] ${m}`) }), { tax: taxonomy }),
  newsStore = loadNews({ days: 14 }), evidence = (items) => withEvidence(items, { store: newsStore }),
  legacy = null, onLegacyComplete = null,
  refresh = refreshIdentityToken, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  clock = Date.now, log = console.log
} = {}) {
  const queue = readQueue(queueFile);
  const publishCurrent = (pl, out, currentModel) => {
    pl.previous = topicsFor(pl.date) || pl.previous;
    return publish(pl, out, currentModel);
  };
  // Older releases stored only id/date. Reconstruct conservatively from the
  // archived request order once, mark that provenance, then persist it. New
  // batches always retain the manifest from the exact submitted JSONL.
  if (!queue.jobs.length && legacy?.batchId && !queue.completed[legacy.batchId]) {
    const legacyTax = tax;
    const plans = legacy.dates.map((d) => plan(d, legacyTax));
    const requests = plans.flatMap((pl) => chunkRequests(pl.toClassify, legacyTax, model, legacy.prefixDates ? `${pl.date}_` : ''));
    queue.jobs.push({ key: `legacy-${legacy.batchId}`, batchId: legacy.batchId, dates: legacy.dates, source: 'legacy', model, taxonomy: legacyTax, manifest: requestManifest(requests), reconstructedManifest: true, status: 'processing' });
    if (!dryRun) saveQueue(queue, queueFile);
  }
  let job = queue.jobs[0];
  let plans;
  if (job) {
    if (dryRun) return { status: 'pending', batchId: job.batchId, dates: job.dates, submissionUnknown: !job.batchId };
    if (!job.batchId) throw new Error('A classification submission has an unknown outcome. Reconcile its provider batch ID in data/classification-batches.json before submitting again.');
    tax = job.taxonomy;
    model = job.model;
    const submittedIds = new Set(Object.values(job.manifest).flatMap((entry) => entry.ids));
    plans = job.dates.map((d) => {
      const pl = plan(d, tax);
      return remainingPlan(pl, topicsFor(d), { reconsiderIds: pl.tweets.filter((t) => submittedIds.has(t.id)).map((t) => t.id) });
    });
    log(`[classify] resuming ${job.batchId} for ${job.dates.join(', ')}${job.reconstructedManifest ? ' (legacy manifest reconstructed)' : ''}`);
  } else {
    if (resumeOnly) return { status: 'idle', dates: [] };
    plans = [...new Set(dates)].sort().map((d) => {
      const previous = topicsFor(d);
      const pl = plan(d, tax);
      return remainingPlan(pl, previous, { reconsiderIds: [...new Set([
        ...newsReconsideration(previous, pl.toClassify, newsStore, { tax }), ...sourceReconsideration(previous, pl.toClassify)
      ])] });
    }).filter((pl) => pl.toClassify.length || pl.deferred.length || !dayComplete(pl.tweets, pl.previous) || sourceMetadataChanged(pl.previous, pl.tweets) || inputBlockMetadataChanged(pl.previous, pl.tweets));
    const unfinished = plans.map((pl) => pl.date);
    if (!plans.length) {
      if (legacy?.batchId && queue.completed[legacy.batchId] && onLegacyComplete && !dryRun) await onLegacyComplete(legacy.batchId);
      return { status: 'complete', dates: [] };
    }
    if (dryRun) return { status: 'planned', dates: unfinished, pending: plans.reduce((n, pl) => n + pl.toClassify.length + pl.deferred.length, 0) };
    const requests = [];
    for (const pl of plans) {
      pl.toClassify = await hints(pl.toClassify, tax);
      ({ items: pl.toClassify, contextVersion: pl.contextVersion } = await evidence(pl.toClassify));
      pl.inputEvaluatedIds = pl.toClassify.map((item) => item.id);
      const chunkPlan = planChunkRequests(pl.toClassify, tax, model, `${pl.date}_`);
      pl.inputBlocks = chunkPlan.inputBlocks;
      requests.push(...chunkPlan.requests);
    }
    // Record blocked input before authentication or batch submission. A later
    // resume uses the exact paid manifest while these other IDs stay pending.
    for (const pl of plans) publishCurrent(pl, finishOut(emptyOut()), model);
    if (!requests.length) {
      return { status: plans.every((pl) => dayComplete(loadDayFn(pl.date), topicsFor(pl.date))) ? 'complete' : 'partial', dates: unfinished };
    }
    client ||= await clientFactory();
    if (sync) {
      const stats = [];
      for (const pl of plans) {
        const mine = requests.filter((r) => r.custom_id.startsWith(`${pl.date}_`));
        const result = await classifySync(client, mine, tax, { log, refresh, onResult: (partial) => publishCurrent(pl, partial, model) });
        const s = publishCurrent(pl, result, model);
        stats.push({ date: pl.date, ...s });
        log(summarize(pl.date, s));
      }
      return { status: plans.every((pl) => dayComplete(loadDayFn(pl.date), topicsFor(pl.date))) ? 'complete' : 'partial', dates: unfinished, stats };
    }
    job = await submitJob(client, queue, { requests, dates: unfinished, model, taxonomy: tax, source }, { file: queueFile });
    log(`[classify] submitted ${job.batchId}: ${requests.length} request(s), ${unfinished.join(', ')}`);
  }
  client ||= await clientFactory();
  const deadline = clock() + Math.max(0, Number.isFinite(maxWaitMinutes) ? maxWaitMinutes : 0) * 60_000;
  while (true) {
    await refresh();
    const batch = await client.messages.batches.retrieve(job.batchId);
    if (batch.processing_status === 'ended') break;
    if (clock() >= deadline) return { status: 'pending', batchId: job.batchId, dates: job.dates };
    await sleep(Math.min(30_000, Math.max(0, deadline - clock())));
  }
  const results = await collectResults(client, job.batchId, tax, job.manifest);
  const stats = [];
  for (const pl of plans) {
    const result = results.get(`${pl.date}_`) || (job.dates.length === 1 ? results.get('') : null) || finishOut(emptyOut());
    const s = publishCurrent(pl, result, model);
    stats.push({ date: pl.date, ...s });
    log(summarize(pl.date, s));
  }
  finishJob(queue, job);
  saveQueue(queue, queueFile);
  if (onLegacyComplete) await onLegacyComplete(job.batchId);
  return { status: plans.every((pl) => dayComplete(loadDayFn(pl.date), topicsFor(pl.date))) ? 'complete' : 'partial', batchId: job.batchId, dates: job.dates, stats };
}

export async function runClassification(options = {}) {
  return withQueueLock(options.queueFile || queuePath, () => runClassificationUnlocked(options));
}

async function main() {
  const dateArg = process.argv.find((a) => a.startsWith('--date='));
  const dates = dateArg ? [dateArg.split('=')[1]] : archiveDates().filter((d) => d < daysAgoEt(0));
  const old = loadState().pendingBatch;
  const result = await runClassification({
    dates,
    sync: process.argv.includes('--sync') || process.env.CLASSIFY_SYNC === 'true',
    resumeOnly: process.argv.includes('--resume-only'),
    dryRun: process.argv.includes('--dry-run'),
    legacy: old?.id ? { batchId: old.id, dates: [old.date] } : null,
    onLegacyComplete: (id) => {
      const state = loadState();
      if (state.pendingBatch?.id === id) { state.pendingBatch = null; saveState(state); }
    }
  });
  console.log(`[classify] ${result.status}${result.batchId ? ` batch=${result.batchId}` : ''}; dates=${result.dates.join(', ') || 'none'}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
