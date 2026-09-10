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

export const liveTopicsPath = (date) => p('data', 'topics-live', `${date}.json`);

export async function classifyLive(records) {
  if (process.env.CLASSIFY_LIVE === 'false' || !anthropicConfigured()) return null;
  const items = records.filter((t) => t.type !== 'retweet');
  if (!items.length) return null;
  const tax = loadTaxonomy();
  const model = process.env.CLASSIFY_MODEL || settings.classify.model;
  const client = await anthropicClient();

  const out = { assignments: {}, incidents: {}, emergingMap: new Map() };
  const per = settings.classify.tweets_per_request || 40;
  for (let i = 0; i < items.length; i += per) {
    const chunk = items.slice(i, i + per);
    const res = await client.messages.create({
      model,
      max_tokens: 8000,
      system: [{ type: 'text', text: systemPrompt(tax), cache_control: { type: 'ephemeral' } }],
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
