// Taxonomy + classifier-prompt helpers shared by the nightly batch job
// (classify.js) and the poll-time incremental pass (classify-live.js).
import fs from 'node:fs';
import yaml from 'js-yaml';
import { p } from './util.js';

export function loadTaxonomy() {
  return yaml.load(fs.readFileSync(p('config', 'taxonomy.yaml'), 'utf8')) || {};
}

// YYYY-MM-DD from a taxonomy date field. js-yaml parses an unquoted
// `since: 2026-09-01` as a Date (UTC midnight); a quoted one stays a string.
export function ymd(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return v == null ? null : String(v).slice(0, 10);
}

// Story anchors: a subtopic may carry `anchors: [tweet ids]` — the posts a
// story is built around (Coxon's resignation post; the announcement the
// caucus is quoting). Any post that quotes, replies to or retweets an anchor
// is assigned that story before the model runs (classify.js planDay,
// classify-live.js); the model still adds the post's own topics. Ids never
// reach the prompt — renderTaxonomy prints "[anchored]" instead.
//
// Pending anchor (taxonomy owner: add when the story key exists; the file
// is being rewritten tonight, 2026-09-10, so it is not edited here):
//   coxon-resignation → anchors: ["2097476196791709843"]   (139M impressions)
// See docs/QUOTED_CONTEXT.md.
export function anchorIndex(tax) {
  const index = new Map(); // tweet id → [[macro, sub], ...]
  for (const key of Object.keys(tax || {}).sort()) {
    for (const subKey of Object.keys(tax[key]?.subtopics || {}).sort()) {
      for (const id of tax[key].subtopics[subKey]?.anchors || []) {
        const sid = String(id);
        if (!/^\d+$/.test(sid)) continue;
        if (!index.has(sid)) index.set(sid, []);
        index.get(sid).push([key, subKey]);
      }
    }
  }
  return index;
}

// Render the taxonomy for the prompt: stable ordering so the cached system
// block stays byte-identical between runs until the YAML actually changes.
// A retired subtopic (retired: true — a provisional story that went quiet,
// see stories.js --retire) stays in the YAML so rollups and history keep its
// key and label, but leaves the prompt so the classifier stops seeing it.
// A provisional story renders exactly like a confirmed one: the flag is for
// the owner's review, the model does not need it.
export function renderTaxonomy(tax) {
  const lines = [];
  for (const key of Object.keys(tax).sort()) {
    const macro = tax[key];
    lines.push(`- ${key}: ${macro.label}`);
    for (const subKey of Object.keys(macro.subtopics || {}).sort()) {
      const sub = macro.subtopics[subKey];
      if (sub.retired) continue;
      const aliases = sub.aliases?.length ? ` (also: ${sub.aliases.join(', ')})` : '';
      const story = sub.story ? ` [developing story${sub.since ? ` since ${ymd(sub.since)}` : ''}]` : '';
      const anchored = sub.anchors?.length ? ' [anchored]' : '';
      lines.push(`  - ${key}/${subKey}: ${sub.label}${story}${anchored}${aliases}`);
    }
  }
  return lines.join('\n');
}

// Keeps only taxonomy-valid pairs, collapsing an unknown subtopic to its
// macro, and dedupes the result: two invalid subtopics of one macro used to
// yield [["economy",null],["economy",null]], which rollups tolerated but the
// dashboard's topic chips repeated.
export function validAssignments(topics, tax) {
  const out = [];
  const seen = new Set();
  for (const t of Array.isArray(topics) ? topics : []) {
    const [macro, sub] = Array.isArray(t) ? t : [t, null];
    if (!tax[macro]) continue;
    const pair = [macro, sub && tax[macro].subtopics?.[sub] ? sub : null];
    const key = `${pair[0]}/${pair[1] || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pair);
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
- Some inputs carry "quoting": the post this one quotes or replies to
  (handle, text, impressions). A quote or reply is about the subject of the
  post it quotes/answers (assign that subject and its story) in addition to
  whatever its own text adds; a quoted post with very high reach is a strong
  signal the story is live.
- Some inputs carry "candidates": stories whose posts this one resembles by
  wording similarity — hints, not labels. One with "story" names a taxonomy
  id you may assign; one with "emerging" is a subject seen before, with the
  label to reuse in "emerging". Assign a candidate only when the tweet's
  text (or its quoted context) supports it; otherwise ignore it.
- Most tweets get 1-2 topics; never more than 4.
- Pure scheduling/greeting/broadcast tweets with no policy content get [].
- If a tweet is clearly about a coherent subject the taxonomy has no home
  for, give it [] and add it to "emerging" with a short suggested subtopic
  label (reuse the same label for tweets about the same subject).
- INCIDENTS: add an "incident" object to an assignment only when ALL hold.
  (a) Community-scale emergency: active shooter or mass shooting, wildfire
      with evacuations, flooding, tornado or severe-storm damage, hurricane
      or tropical-storm impact, hazmat release, major crash or explosion,
      widespread power or water outage, infrastructure failure. A single
      vehicle or rail collision, a contained brush fire with no evacuations
      or one house fire is not.
  (b) Happening now: under way or struck within the last three days as the
      tweet describes it (evacuation orders or warnings, shelter-in-place,
      rescues, outages being restored, damage being assessed, shelters or
      hotlines announced). Aftermath and recovery posts are NOT incidents:
      FEMA/SBA/USDA assistance, application deadlines, disaster-declaration
      requests or approvals, intake-center schedules, "daily storm update"
      newsletters, thank-yous to responders, site visits weeks later,
      anniversaries. "recovering", "recovery", "aftermath", "left behind",
      "is gone", "the August storm", "spent months", "apply by <date>",
      "years ago" mean the event is past: give the tweet its normal topics.
  (c) The member is acting, not reacting: relaying official instructions or
      resources ("evacuate zone …", "call 866-…", "avoid the area", "report
      damage here"), the office in contact with officials or on scene, or a
      way for constituents to get help. "Thoughts and prayers",
      "heartbroken", "horrified to hear", "grateful to first responders"
      posts are reactions even when the event is nearby: do not flag them.
      A tweet using an incident to argue for legislation, funding or a
      policy position is a policy tweet, not an incident, unless it also
      relays live instructions. Hypotheticals, drills and preparedness PSAs
      are never incidents.
  (d) The place is in the tweet: "place" is the city or county the tweet
      names plus the state abbr ("Napa County, CA", "La Habra, CA",
      "Kauaʻi, HI"). Never infer a location from a similarly named past
      event or from what you know about the member; a bare state
      ("Michigan, MI") is not a place. If the tweet names the event
      ("#SteeleFire", "Hurricane Lowell", "Timber Fire") put it in "name".
      No place and no named event: do not flag.
  Not incidents: routine weather advisories and public-safety PSAs (heat
  advisories or warnings, cooling-center lists, flood watches, travel
  advisories, "stay safe and stay alert") unless the tweet reports actual
  impact — an emergency declaration, evacuations, shelters open, outages,
  closures, injuries or deaths.
  Format: {"kind": "<one of: active shooter, shooting, wildfire, flooding,
  severe storm, tornado, hurricane, extreme heat, power outage, water
  outage, hazmat, structure fire, explosion, plane crash, train crash,
  industrial accident, infrastructure failure, missing persons, other>",
  "place": "<city or county, state abbr>", "name": "<event name from the
  tweet, or null>"}. Use exactly the same kind, place and name for every
  tweet about the same event; do not switch between city, county and
  region for one event. Incident tweets still get topics [] unless they
  also carry policy content.
${corrections}
Reply with ONLY a JSON object, no prose:
{"assignments": [{"id": "<tweet id>", "topics": [["macro-id", "sub-id or null"], ...], "incident": {"kind": "...", "place": "...", "name": "... or null"} (omit unless it is one)}, ...],
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
