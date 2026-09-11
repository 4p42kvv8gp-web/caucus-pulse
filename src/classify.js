// Nightly topic classification via the Anthropic Message Batches API (50%
// of standard price, results typically within the hour — right for a job
// that runs at 3am). The taxonomy YAML is the entire "intelligence layer":
// it renders into a prompt-cached system block, tweets go through in chunks,
// and anything that fits nothing comes back as an "emerging cluster" with a
// suggested subtopic for human review in the daily report.
//
// The same pass flags district emergencies (incident: {kind, place}) — the
// raw material src/incidents.js groups into the incident desk.
//
// Retweets are never sent to the model: they inherit the original tweet's
// assignment when the original is in the corpus, and only fall back to
// classifying their truncated "RT @…" text when it isn't. Posts already
// tagged by the poll-time pass (data/topics-live/) are still re-classified
// here — the nightly batch is authoritative and costs half as much.
//
// Quotes and replies go to the model with the post they point at
// (`quoting`, resolved by src/quoted.js) — a member reacting to Coxon's
// resignation rarely names it. Story anchors (taxonomy `anchors:`) assign a
// story deterministically to any post that quotes, replies to or retweets
// an anchored post; the model still runs for the post's own topics and the
// two are merged at write time.
//
// Similarity hints (`candidates`, src/semantic.js): when the embedding index
// is on disk, each post also carries the tracked stories its wording sits
// near — a taxonomy id the model may assign, or the label of an emerging
// subject seen before. The prompt calls them hints; the model still decides
// from the text. Without the index the request is byte-identical to before.
//
// The building blocks (planDay → chunkRequests → collectResults → writeDay)
// are exported so classify-range.js can put many days into one batch.
import { anthropicClient, refreshIdentityToken } from './anthropic-auth.js';
import { settings, daysAgoEt, readJSON, writeJSON } from './util.js';
import { loadState, saveState, loadDay, topicsPath, archivePath } from './store.js';
import { readJSONL } from './util.js';
import { loadTaxonomy, systemPrompt, validAssignments, parseJsonLoose, anchorIndex } from './taxonomy.js';
import { quotedResolver, quotingFor } from './quoted.js';
import { configuredMinSim, storyRow, loadSemanticOrNull } from './semantic.js';
import { embed as sharedEmbed } from './embeddings.js';

export { loadTaxonomy, renderTaxonomy, validAssignments, parseJsonLoose, anchorIndex } from './taxonomy.js';

// One input line for the model. Exactly {id, text} unless the item carries
// quoted context and/or similarity candidates — the line is what the
// prompt's "quoting" and "candidates" rules refer to. Key order is fixed so
// a post without extras serialises exactly as it always has.
export function classifierLine(t) {
  const line = { id: t.id, text: t.text };
  if (t.quoting) line.quoting = t.quoting;
  if (t.candidates?.length) line.candidates = t.candidates;
  return JSON.stringify(line);
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
export function chunkRequests(items, tax, model, prefix = '') {
  const per = settings.classify.tweets_per_request || 40;
  const system = [{ type: 'text', text: systemPrompt(tax), cache_control: { type: 'ephemeral' } }];
  const requests = [];
  for (let i = 0; i < items.length; i += per) {
    const chunk = items.slice(i, i + per);
    requests.push({
      custom_id: `${prefix}chunk-${i / per}`,
      params: {
        model,
        max_tokens: 8000,
        system,
        messages: [{
          role: 'user',
          content: chunk.map(classifierLine).join('\n')
        }]
      }
    });
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

export function mergeParsed(parsed, tax, out) {
  for (const a of parsed.assignments || []) {
    out.assignments[a.id] = validAssignments(a.topics, tax, out.droppedSubs, out.echoedSubs);
    if (a.incident?.kind && a.incident?.place) {
      out.incidents[a.id] = { kind: String(a.incident.kind).toLowerCase(), place: String(a.incident.place) };
    }
  }
  for (const e of parsed.emerging || []) {
    const key = String(e.label || '').trim().toLowerCase();
    if (!key) continue;
    const entry = out.emergingMap.get(key) || { label: String(e.label).trim(), ids: [] };
    entry.ids.push(...(e.ids || []));
    out.emergingMap.set(key, entry);
  }
}

const emptyOut = () => ({ assignments: {}, incidents: {}, emergingMap: new Map(), failedChunks: 0, droppedSubs: [], echoedSubs: [] });
const finishOut = (o) => ({ assignments: o.assignments, incidents: o.incidents, emerging: [...o.emergingMap.values()], failedChunks: o.failedChunks, droppedSubs: o.droppedSubs, echoedSubs: o.echoedSubs });

// Stream a finished batch's results, grouped by the custom_id prefix before
// "chunk-" (empty string for single-day batches). Returns {prefix → result}.
export async function collectResults(client, batchId, tax) {
  const byPrefix = new Map();
  for await (const result of await client.messages.batches.results(batchId)) {
    const prefix = String(result.custom_id).replace(/chunk-\d+$/, '');
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, emptyOut());
    const out = byPrefix.get(prefix);
    if (result.result.type !== 'succeeded') { out.failedChunks++; continue; }
    const textBlock = result.result.message.content.find((b) => b.type === 'text');
    const parsed = textBlock && parseJsonLoose(textBlock.text);
    if (!parsed) { out.failedChunks++; continue; }
    mergeParsed(parsed, tax, out);
  }
  return new Map([...byPrefix].map(([k, v]) => [k, finishOut(v)]));
}

// Look up an original tweet's assignment for retweet inheritance — checks
// the day being classified plus the two days before it.
export function priorAssignments(date) {
  const map = {};
  for (let d = 2; d >= 0; d--) {
    const dt = new Date(`${date}T12:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() - d);
    const file = readJSON(topicsPath(dt.toISOString().slice(0, 10)), null);
    if (file) Object.assign(map, file.assignments);
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
    for (const t of readJSONL(archivePath(dt.toISOString().slice(0, 10)))) ids.add(t.id);
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
  resolve = quotedResolver()
} = {}) {
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

// The day file's content from a plan and its batch result: retweets inherit
// (from this batch, then from prior days), anchors merge over whatever the
// model said, and an anchored post is classified by definition — it leaves
// "unclassified" and the emerging clusters. `prior` is injectable (tests);
// by default prior days are re-read so deferred retweets inherit from days
// written earlier in the same run.
export function mergeDay(plan, result, { prior } = {}) {
  const { date, tweets, toClassify, deferred, anchored = {} } = plan;
  const { assignments, incidents, failedChunks, droppedSubs = [], echoedSubs = [] } = result;
  const inherited = { ...plan.inherited };
  const priorMap = prior ?? (deferred.length ? priorAssignments(date) : {});
  for (const t of tweets) {
    if (t.type !== 'retweet' || inherited[t.id]) continue;
    if (assignments[t.refId]) inherited[t.id] = assignments[t.refId];
    else if (priorMap[t.refId]) inherited[t.id] = priorMap[t.refId];
  }
  const merged = { ...assignments, ...inherited };
  for (const [id, topics] of Object.entries(anchored)) merged[id] = mergeTopics(topics, merged[id]);
  const anchoredIds = new Set(Object.keys(anchored));
  const emerging = (result.emerging || [])
    .map((e) => ({ ...e, ids: (e.ids || []).filter((id) => !anchoredIds.has(id)) }))
    .filter((e) => e.ids.length);
  const unclassified = [...toClassify, ...deferred].filter((t) => !(t.id in merged)).map((t) => t.id);
  return {
    day: { date, assignments: merged, incidents, emerging, unclassified, anchored, failedChunks, droppedSubs, echoedSubs },
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
export function writeDay(plan, result, model) {
  const { day, stats } = mergeDay(plan, result);
  writeJSON(topicsPath(plan.date), {
    date: day.date,
    model,
    classifiedAt: new Date().toISOString(),
    assignments: day.assignments,
    incidents: day.incidents,
    emerging: day.emerging,
    unclassified: day.unclassified,
    anchored: day.anchored,
    failedChunks: day.failedChunks,
    droppedSubs: day.droppedSubs,
    echoedSubs: day.echoedSubs
  });
  return stats;
}

export function summarize(date, s) {
  return `[classify] ${date}: ${s.classified} classified, ${s.inherited} inherited, ${s.anchored ? `${s.anchored} anchored, ` : ''}${s.incidents} incident-flagged, ${s.emerging} emerging clusters, ${s.unclassified} unclassified${s.droppedSubs ? `, ${s.droppedSubs} SUBTOPIC KEY(S) DROPPED AS UNRESOLVABLE` : ''}${s.echoedSubs ? `, ${s.echoedSubs} subtopic key(s) answered as macro/sub and resolved` : ''}${s.failedChunks ? `, ${s.failedChunks} chunk(s) failed` : ''}`;
}

async function main() {
  const dateArg = process.argv.find((a) => a.startsWith('--date='));
  const date = dateArg ? dateArg.split('=')[1] : daysAgoEt(1);
  const model = process.env.CLASSIFY_MODEL || settings.classify.model;
  const tax = loadTaxonomy();
  const plan = planDay(date, { tax });
  if (!plan.tweets.length) { console.log(`[classify] no tweets archived for ${date} — nothing to do`); return; }
  if (readJSON(topicsPath(date), null)) { console.log(`[classify] ${date} already classified — skipping`); return; }

  const client = await anthropicClient();
  const state = loadState();
  let batchId = state.pendingBatch?.date === date ? state.pendingBatch.id : null;

  if (!batchId) {
    // Similarity hints need the index (nightly chain: `npm run embed` runs
    // first, so every archived post is already a row); posts it lacks are
    // embedded on the fly when the model is present.
    plan.toClassify = await withCandidates(plan.toClassify, loadSemanticOrNull({ warn: (m) => console.warn(`[classify] ${m}`) }), { tax });
    const requests = chunkRequests(plan.toClassify, tax, model);
    const batch = await client.messages.batches.create({ requests });
    batchId = batch.id;
    state.pendingBatch = { id: batchId, date };
    saveState(state);
    const quoting = plan.toClassify.filter((t) => t.quoting).length;
    console.log(`[classify] submitted batch ${batchId}: ${plan.toClassify.length} tweets in ${requests.length} requests (${quoting} with quoted context, ${hintedCount(plan.toClassify)} with similarity hints, ${Object.keys(plan.inherited).length} retweets inherit, ${Object.keys(plan.anchored).length} anchored)`);
  } else {
    console.log(`[classify] resuming pending batch ${batchId} for ${date}`);
  }

  const deadline = Date.now() + (settings.classify.max_wait_minutes || 55) * 60_000;
  let batch;
  while (true) {
    await refreshIdentityToken(); // federation: keep the OIDC file fresh across a long wait
    batch = await client.messages.batches.retrieve(batchId);
    if (batch.processing_status === 'ended') break;
    if (Date.now() > deadline) {
      console.warn(`[classify] batch ${batchId} still ${batch.processing_status} at deadline — will resume on the next nightly run`);
      return; // pendingBatch stays in state; tomorrow's run picks it up
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }

  const results = await collectResults(client, batchId, tax);
  const result = results.get('') || finishOut(emptyOut());
  const stats = writeDay(plan, result, model);
  state.pendingBatch = null;
  saveState(state);
  console.log(summarize(date, stats));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
