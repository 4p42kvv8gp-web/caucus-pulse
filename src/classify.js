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
// The building blocks (planDay → chunkRequests → collectResults → writeDay)
// are exported so classify-range.js can put many days into one batch.
import { anthropicClient, refreshIdentityToken } from './anthropic-auth.js';
import { settings, daysAgoEt, readJSON, writeJSON } from './util.js';
import { loadState, saveState, loadDay, topicsPath, archivePath } from './store.js';
import { readJSONL } from './util.js';
import { loadTaxonomy, systemPrompt, validAssignments, parseJsonLoose } from './taxonomy.js';

export { loadTaxonomy, renderTaxonomy, validAssignments, parseJsonLoose } from './taxonomy.js';

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
          content: chunk.map((t) => JSON.stringify({ id: t.id, text: t.text })).join('\n')
        }]
      }
    });
  }
  return requests;
}

export function mergeParsed(parsed, tax, out) {
  for (const a of parsed.assignments || []) {
    out.assignments[a.id] = validAssignments(a.topics, tax);
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

const emptyOut = () => ({ assignments: {}, incidents: {}, emergingMap: new Map(), failedChunks: 0 });
const finishOut = (o) => ({ assignments: o.assignments, incidents: o.incidents, emerging: [...o.emergingMap.values()], failedChunks: o.failedChunks });

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
export function planDay(date, { deferInCorpus = false } = {}) {
  const tweets = loadDay(date);
  const prior = priorAssignments(date);
  const corpus = deferInCorpus ? corpusIds(date) : null;
  const inherited = {};
  const deferred = [];
  const toClassify = [];
  for (const t of tweets) {
    if (t.type === 'retweet' && prior[t.refId]) inherited[t.id] = prior[t.refId];
    else if (t.type === 'retweet' && corpus?.has(t.refId)) deferred.push(t);
    else toClassify.push(t);
  }
  return { date, tweets, toClassify, inherited, deferred };
}

// Write data/topics/<date>.json from a plan and its batch result. Re-reads
// prior days' assignments so deferred retweets inherit from days written
// earlier in the same run.
export function writeDay(plan, result, model) {
  const { date, tweets, toClassify, deferred } = plan;
  const { assignments, incidents, emerging, failedChunks } = result;
  const inherited = { ...plan.inherited };
  const prior = deferred.length ? priorAssignments(date) : {};
  for (const t of tweets) {
    if (t.type !== 'retweet' || inherited[t.id]) continue;
    if (assignments[t.refId]) inherited[t.id] = assignments[t.refId];
    else if (prior[t.refId]) inherited[t.id] = prior[t.refId];
  }
  const unclassified = [...toClassify, ...deferred].filter((t) => !(t.id in assignments) && !(t.id in inherited)).map((t) => t.id);

  writeJSON(topicsPath(date), {
    date,
    model,
    classifiedAt: new Date().toISOString(),
    assignments: { ...assignments, ...inherited },
    incidents,
    emerging,
    unclassified,
    failedChunks
  });
  return { classified: Object.keys(assignments).length, inherited: Object.keys(inherited).length, incidents: Object.keys(incidents).length, emerging: emerging.length, unclassified: unclassified.length, failedChunks };
}

export function summarize(date, s) {
  return `[classify] ${date}: ${s.classified} classified, ${s.inherited} inherited, ${s.incidents} incident-flagged, ${s.emerging} emerging clusters, ${s.unclassified} unclassified${s.failedChunks ? `, ${s.failedChunks} chunk(s) failed` : ''}`;
}

async function main() {
  const dateArg = process.argv.find((a) => a.startsWith('--date='));
  const date = dateArg ? dateArg.split('=')[1] : daysAgoEt(1);
  const model = process.env.CLASSIFY_MODEL || settings.classify.model;
  const tax = loadTaxonomy();
  const plan = planDay(date);
  if (!plan.tweets.length) { console.log(`[classify] no tweets archived for ${date} — nothing to do`); return; }
  if (readJSON(topicsPath(date), null)) { console.log(`[classify] ${date} already classified — skipping`); return; }

  const client = await anthropicClient();
  const state = loadState();
  let batchId = state.pendingBatch?.date === date ? state.pendingBatch.id : null;

  if (!batchId) {
    const requests = chunkRequests(plan.toClassify, tax, model);
    const batch = await client.messages.batches.create({ requests });
    batchId = batch.id;
    state.pendingBatch = { id: batchId, date };
    saveState(state);
    console.log(`[classify] submitted batch ${batchId}: ${plan.toClassify.length} tweets in ${requests.length} requests (${Object.keys(plan.inherited).length} retweets inherit)`);
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
