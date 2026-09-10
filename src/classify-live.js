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
import { loadTaxonomy, systemPrompt, parseJsonLoose, anchorIndex } from './taxonomy.js';
import { mergeParsed, classifierLine, withQuoting, anchoredAssignments, mergeTopics } from './classify.js';
import { quotedResolver } from './quoted.js';
import { correctionExamples } from './corrections.js';

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

// Quoted context for a fresh poll: the records carry `quoted` when capture
// asked for referenced posts; the side store and the archive cover the rest.
// A broken data/quoted.json must not stop live tagging either.
function resolver() {
  try { return quotedResolver(); } catch (e) {
    console.warn(`[classify-live] quoted context skipped: ${e.message}`);
    return () => null;
  }
}

export async function classifyLive(records) {
  if (process.env.CLASSIFY_LIVE === 'false' || !anthropicConfigured()) return null;
  const originals = records.filter((t) => t.type !== 'retweet');
  if (!originals.length) return null;
  const tax = loadTaxonomy();
  const items = withQuoting(originals, resolver());
  const system = [{ type: 'text', text: systemPrompt(tax, { examples: precedents(tax) }), cache_control: { type: 'ephemeral' } }];
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
        content: chunk.map(classifierLine).join('\n')
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

  // Story anchors settle a story for anything quoting, answering or
  // retweeting an anchored post — over whatever the model said.
  const anchored = anchoredAssignments(records, anchorIndex(tax));
  for (const [id, topics] of Object.entries(anchored)) out.assignments[id] = mergeTopics(topics, out.assignments[id]);

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
  return { tagged: Object.keys(out.assignments).length, incidents: Object.keys(out.incidents).length, quoting: items.filter((t) => t.quoting).length, anchored: Object.keys(anchored).length };
}
