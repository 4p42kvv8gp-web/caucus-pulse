// Nightly topic classification via the Anthropic Message Batches API (50%
// of standard price, results typically within the hour — right for a job
// that runs at 3am). The taxonomy YAML is the entire "intelligence layer":
// it renders into a prompt-cached system block, tweets go through in chunks,
// and anything that fits nothing comes back as an "emerging cluster" with a
// suggested subtopic for human review in the daily report.
//
// Retweets are never sent to the model: they inherit the original tweet's
// assignment when the original is in the corpus, and only fall back to
// classifying their truncated "RT @…" text when it isn't.
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { p, settings, daysAgoEt, readJSON, writeJSON } from './util.js';
import { loadState, saveState, loadDay, topicsPath } from './store.js';

export function loadTaxonomy() {
  return yaml.load(fs.readFileSync(p('config', 'taxonomy.yaml'), 'utf8')) || {};
}

// Render the taxonomy for the prompt: stable ordering so the cached system
// block stays byte-identical between runs until the YAML actually changes.
export function renderTaxonomy(tax) {
  const lines = [];
  for (const key of Object.keys(tax).sort()) {
    const macro = tax[key];
    lines.push(`- ${key}: ${macro.label}`);
    for (const subKey of Object.keys(macro.subtopics || {}).sort()) {
      const sub = macro.subtopics[subKey];
      const aliases = sub.aliases?.length ? ` (also: ${sub.aliases.join(', ')})` : '';
      lines.push(`  - ${key}/${subKey}: ${sub.label}${aliases}`);
    }
  }
  return lines.join('\n');
}

export function validAssignments(topics, tax) {
  const out = [];
  for (const t of Array.isArray(topics) ? topics : []) {
    const [macro, sub] = Array.isArray(t) ? t : [t, null];
    if (!tax[macro]) continue;
    out.push([macro, sub && tax[macro].subtopics?.[sub] ? sub : null]);
  }
  return out;
}

function systemPrompt(tax) {
  return `You classify tweets from US House Democratic caucus members into a fixed two-level topic taxonomy.

Taxonomy (id: label). A tweet can carry multiple topics. Assign the most
specific level that fits: use "macro/sub" when a subtopic applies, bare
"macro" when only the macro level fits.

${renderTaxonomy(tax)}

Rules:
- Judge the tweet's substance, not incidental word matches.
- Most tweets get 1-2 topics; never more than 4.
- Pure scheduling/greeting/broadcast tweets with no policy content get [].
- If a tweet is clearly about a coherent subject the taxonomy has no home
  for, give it [] and add it to "emerging" with a short suggested subtopic
  label (reuse the same label for tweets about the same subject).

Reply with ONLY a JSON object, no prose:
{"assignments": [{"id": "<tweet id>", "topics": [["macro-id", "sub-id or null"], ...]}, ...],
 "emerging": [{"label": "<suggested subtopic>", "ids": ["<tweet id>", ...]}]}
Include every input tweet id exactly once in "assignments".`;
}

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

export function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall through */ }
  }
  return null;
}

async function collectResults(client, batchId, tax) {
  const assignments = {};
  const emerging = new Map();
  let failedChunks = 0;
  for await (const result of await client.messages.batches.results(batchId)) {
    if (result.result.type !== 'succeeded') { failedChunks++; continue; }
    const textBlock = result.result.message.content.find((b) => b.type === 'text');
    const parsed = textBlock && parseJsonLoose(textBlock.text);
    if (!parsed) { failedChunks++; continue; }
    for (const a of parsed.assignments || []) {
      assignments[a.id] = validAssignments(a.topics, tax);
    }
    for (const e of parsed.emerging || []) {
      const key = String(e.label || '').trim().toLowerCase();
      if (!key) continue;
      const entry = emerging.get(key) || { label: e.label.trim(), ids: [] };
      entry.ids.push(...(e.ids || []));
      emerging.set(key, entry);
    }
  }
  return { assignments, emerging: [...emerging.values()], failedChunks };
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

  const client = new Anthropic();
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
    batch = await client.messages.batches.retrieve(batchId);
    if (batch.processing_status === 'ended') break;
    if (Date.now() > deadline) {
      console.warn(`[classify] batch ${batchId} still ${batch.processing_status} at deadline — will resume on the next nightly run`);
      return; // pendingBatch stays in state; tomorrow's run picks it up
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }

  const { assignments, emerging, failedChunks } = await collectResults(client, batchId, tax);
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
    emerging,
    unclassified,
    failedChunks
  });
  state.pendingBatch = null;
  saveState(state);
  console.log(`[classify] ${date}: ${Object.keys(assignments).length} classified, ${Object.keys(inherited).length} inherited, ${emerging.length} emerging clusters, ${unclassified.length} unclassified${failedChunks ? `, ${failedChunks} chunk(s) failed` : ''}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
