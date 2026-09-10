// Taxonomy + classifier-prompt helpers shared by the nightly batch job
// (classify.js) and the poll-time incremental pass (classify-live.js).
import fs from 'node:fs';
import yaml from 'js-yaml';
import { p } from './util.js';

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
      const story = sub.story ? ` [developing story${sub.since ? ` since ${sub.since}` : ''}]` : '';
      lines.push(`  - ${key}/${subKey}: ${sub.label}${story}${aliases}`);
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

// Editors' corrections as few-shot precedents, one JSON line each in the
// same shape the model answers with. The caller (corrections.js) hands them
// over already sorted and without timestamps: this block sits inside the
// cached system prompt, so it must be byte-identical between runs until
// config/corrections.yaml itself changes.
export function renderExamples(examples) {
  return (examples || [])
    .map((e) => JSON.stringify({ text: e.text, topics: e.topics, ...(e.why ? { why: e.why } : {}) }))
    .join('\n');
}

export function systemPrompt(tax, { examples = [] } = {}) {
  const corrections = examples.length ? `
Corrections from the editors (follow these precedents). These posts were
re-labeled by hand; classify the same subjects the same way:
${renderExamples(examples)}
` : '';
  return `You classify tweets from US House Democratic caucus members into a fixed two-level topic taxonomy, and you flag district emergencies.

Taxonomy (id: label). A tweet can carry multiple topics. Assign the most
specific level that fits: use "macro/sub" when a subtopic applies, bare
"macro" when only the macro level fits.

${renderTaxonomy(tax)}

Rules:
- Judge the tweet's substance, not incidental word matches.
- Subtopics marked [developing story] are specific named events, people or
  places the caucus is reacting to. When a tweet is about that story, assign
  the story (it still counts toward its macro) rather than the generic
  sibling subtopic.
- Most tweets get 1-2 topics; never more than 4.
- Pure scheduling/greeting/broadcast tweets with no policy content get [].
- If a tweet is clearly about a coherent subject the taxonomy has no home
  for, give it [] and add it to "emerging" with a short suggested subtopic
  label (reuse the same label for tweets about the same subject).
- INCIDENTS: when a tweet responds to a breaking district emergency the
  member is personally handling (active shooter, flood, wildfire, major
  accident, infrastructure failure — not national policy news), add an
  "incident" object to that assignment: {"kind": "<2-3 word type, e.g.
  'active shooter', 'flooding', 'wildfire'>", "place": "<city/area, state
  abbr>"}. Reuse identical kind+place strings for tweets about the same
  event. Incident tweets still get topics [] unless they also carry policy
  content.
${corrections}
Reply with ONLY a JSON object, no prose:
{"assignments": [{"id": "<tweet id>", "topics": [["macro-id", "sub-id or null"], ...], "incident": {"kind": "...", "place": "..."} (omit unless it is one)}, ...],
 "emerging": [{"label": "<suggested subtopic>", "ids": ["<tweet id>", ...]}]}
Include every input tweet id exactly once in "assignments".`;
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

// Title-case a snake_case key the way the dashboard does; acronyms stay caps.
const ACRONYMS = { aca: 'ACA', ice: 'ICE', gop: 'GOP', dc: 'DC', usps: 'USPS', fema: 'FEMA', va: 'VA', ai: 'AI', snap: 'SNAP' };
export function labelOf(k) {
  return String(k)
    .replace(/^new macro: /, 'New macro · ')
    .split(' / ')
    .map((part) => part.split(/[_\s-]+/)
      .map((w) => ACRONYMS[w.toLowerCase()] || (w.charAt(0).toUpperCase() + w.slice(1)))
      .join(' '))
    .join(' / ');
}
