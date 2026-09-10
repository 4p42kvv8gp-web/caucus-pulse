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
import { anthropicClient, refreshIdentityToken } from './anthropic-auth.js';
import { settings, daysAgoEt, readJSON, writeJSON } from './util.js';
import { loadState, saveState, loadDay, topicsPath } from './store.js';
import { loadTaxonomy, systemPrompt, validAssignments, parseJsonLoose } from './taxonomy.js';

export { loadTaxonomy, renderTaxonomy, validAssignments, parseJsonLoose } from './taxonomy.js';

function chunkRequests(items, tax, model) {
  const per = settings.classify.tweets_per_request || 40;
  const system = [{ type: 'text', text: systemPrompt(tax), cache_control: { type: 'ephemeral' } }];
  const requests = [];
  for (let i = 0; i < items.length; i += per) {
    const chunk = items.slice(i, i + per);
    requests.push({
      custom_id: `chunk-${i / per}`,
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

async function collectResults(client, batchId, tax) {
  const out = { assignments: {}, incidents: {}, emergingMap: new Map() };
  let failedChunks = 0;
  for await (const result of await client.messages.batches.results(batchId)) {
    if (result.result.type !== 'succeeded') { failedChunks++; continue; }
    const textBlock = result.result.message.content.find((b) => b.type === 'text');
    const parsed = textBlock && parseJsonLoose(textBlock.text);
    if (!parsed) { failedChunks++; continue; }
    mergeParsed(parsed, tax, out);
  }
  return { ...out, emerging: [...out.emergingMap.values()], failedChunks };
}

// Look up an original tweet's assignment for retweet inheritance — checks
// the day being classified plus the two days before it.
function priorAssignments(date) {
  const map = {};
  for (let d = 2; d >= 0; d--) {
    const dt = new Date(`${date}T12:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() - d);
    const file = readJSON(topicsPath(dt.toISOString().slice(0, 10)), null);
    if (file) Object.assign(map, file.assignments);
  }
  return map;
}

async function main() {
  const dateArg = process.argv.find((a) => a.startsWith('--date='));
  const date = dateArg ? dateArg.split('=')[1] : daysAgoEt(1);
  const model = process.env.CLASSIFY_MODEL || settings.classify.model;
  const tax = loadTaxonomy();
  const tweets = loadDay(date);
  if (!tweets.length) { console.log(`[classify] no tweets archived for ${date} — nothing to do`); return; }
  if (readJSON(topicsPath(date), null)) { console.log(`[classify] ${date} already classified — skipping`); return; }

  const prior = priorAssignments(date);
  const inherited = {};
  const toClassify = [];
  for (const t of tweets) {
    if (t.type === 'retweet' && prior[t.refId]) inherited[t.id] = prior[t.refId];
    else toClassify.push(t);
  }

  const client = await anthropicClient();
  const state = loadState();
  let batchId = state.pendingBatch?.date === date ? state.pendingBatch.id : null;

  if (!batchId) {
    const requests = chunkRequests(toClassify, tax, model);
    const batch = await client.messages.batches.create({ requests });
    batchId = batch.id;
    state.pendingBatch = { id: batchId, date };
    saveState(state);
    console.log(`[classify] submitted batch ${batchId}: ${toClassify.length} tweets in ${requests.length} requests (${Object.keys(inherited).length} retweets inherit)`);
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

  const { assignments, incidents, emerging, failedChunks } = await collectResults(client, batchId, tax);
  // Retweets of originals classified in this very batch inherit now too.
  for (const t of tweets) {
    if (t.type === 'retweet' && !inherited[t.id] && assignments[t.refId]) {
      inherited[t.id] = assignments[t.refId];
    }
  }
  const unclassified = toClassify.filter((t) => !(t.id in assignments)).map((t) => t.id);

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
  state.pendingBatch = null;
  saveState(state);
  console.log(`[classify] ${date}: ${Object.keys(assignments).length} classified, ${Object.keys(inherited).length} inherited, ${Object.keys(incidents).length} incident-flagged, ${emerging.length} emerging clusters, ${unclassified.length} unclassified${failedChunks ? `, ${failedChunks} chunk(s) failed` : ''}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
