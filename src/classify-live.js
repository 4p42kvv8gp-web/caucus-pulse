// Poll-time incremental classification — tags each poll's NEW posts so the
// dashboard feed carries topic chips all day instead of waiting for the
// nightly batch. One prompt-cached request per poll (the taxonomy system
// block is byte-identical between polls, so ~90% of the input bills at the
// cache-read rate). The nightly batch re-classifies the whole day at half
// price and its output is authoritative; these live tags only fill the gap.
//
// Skips silently when no Anthropic credential is configured (API key or
// workload identity federation — see anthropic-auth.js) or CLASSIFY_LIVE=false —
// capture must never fail because classification can't run.
import { anthropicClient, anthropicConfigured } from './anthropic-auth.js';
import { settings, etDate, readJSON, writeJSON, p } from './util.js';
import { loadTaxonomy, systemPrompt, parseJsonLoose } from './taxonomy.js';
import { mergeParsed } from './classify.js';
import { correctionExamples } from './corrections.js';
import { memoryForClassifier } from './memory.js';

export const liveTopicsPath = (date) => p('data', 'topics-live', `${date}.json`);

// The editors' most recent corrections, rendered into the system prompt as
// precedents. A broken corrections.yaml must not stop live tagging — warn
// and classify without them.
// TODO(corrections): give classify.js chunkRequests the same
// systemPrompt(tax, { examples }) so the nightly batch learns from the
// precedents too; classify.js is off-limits tonight (2026-09-10).
function precedents(tax) {
  try {
    return correctionExamples(settings.classify.correction_examples ?? 8, { tax });
  } catch (e) {
    console.warn(`[classify-live] corrections skipped: ${e.message}`);
    return [];
  }
}

// Long-term memory: the story dossiers' rolling summaries (src/memory.js),
// as a SECOND cached system block after the taxonomy. It changes only when
// a dossier changed (nightly), so the taxonomy block's cache prefix is
// untouched and the memory block itself is cached across the day's polls.
// A broken dossier file must not stop live tagging — warn and go without.
// TODO(memory): give classify.js chunkRequests the same second block; the
// nightly batch classifies without memory until classify.js is opened up.
function memory() {
  try {
    return memoryForClassifier();
  } catch (e) {
    console.warn(`[classify-live] memory skipped: ${e.message}`);
    return '';
  }
}

export function systemBlocks(tax, { examples = [], memoryText = '' } = {}) {
  const blocks = [{ type: 'text', text: systemPrompt(tax, { examples }), cache_control: { type: 'ephemeral' } }];
  if (memoryText) blocks.push({ type: 'text', text: memoryText, cache_control: { type: 'ephemeral' } });
  return blocks;
}

export async function classifyLive(records) {
  if (process.env.CLASSIFY_LIVE === 'false' || !anthropicConfigured()) return null;
  const items = records.filter((t) => t.type !== 'retweet');
  if (!items.length) return null;
  const tax = loadTaxonomy();
  const system = systemBlocks(tax, { examples: precedents(tax), memoryText: memory() });
  const model = process.env.CLASSIFY_MODEL || settings.classify.model;
  const client = await anthropicClient();

  const out = { assignments: {}, incidents: {}, emergingMap: new Map() };
  const per = settings.classify.tweets_per_request || 40;
  for (let i = 0; i < items.length; i += per) {
    const chunk = items.slice(i, i + per);
    const res = await client.messages.create({
      model,
      max_tokens: 8000,
      system,
      messages: [{
        role: 'user',
        content: chunk.map((t) => JSON.stringify({ id: t.id, text: t.text })).join('\n')
      }]
    });
    if (res.stop_reason === 'refusal') continue;
    const textBlock = res.content.find((b) => b.type === 'text');
    const parsed = textBlock && parseJsonLoose(textBlock.text);
    if (parsed) mergeParsed(parsed, tax, out);
  }

  // Retweets in the same poll inherit their original's fresh tags.
  for (const t of records) {
    if (t.type === 'retweet' && out.assignments[t.refId]) out.assignments[t.id] = out.assignments[t.refId];
  }

  // Merge into per-day live files (a poll near midnight ET can span days).
  const byDate = new Map();
  for (const t of records) {
    if (!(t.id in out.assignments) && !(t.id in out.incidents)) continue;
    const date = etDate(t.createdAt);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(t.id);
  }
  for (const [date, ids] of byDate) {
    const file = liveTopicsPath(date);
    const existing = readJSON(file, { date, assignments: {}, incidents: {} });
    for (const id of ids) {
      if (out.assignments[id]) existing.assignments[id] = out.assignments[id];
      if (out.incidents[id]) existing.incidents[id] = out.incidents[id];
    }
    existing.model = model;
    existing.updatedAt = new Date().toISOString();
    writeJSON(file, existing);
  }
  return { tagged: Object.keys(out.assignments).length, incidents: Object.keys(out.incidents).length };
}
