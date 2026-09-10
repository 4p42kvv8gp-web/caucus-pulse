// The one place every X query string for the narrative layer is built and
// validated (docs/NARRATIVE_INTELLIGENCE.md §6). Pure: no I/O, no network.
//
// Rules: ≤512 chars (planned for 480), balanced quotes and parentheses, no
// `expansions`, no wildcards (X recent search has none), never the incident
// desk's `from:list` pseudo-operator, and `list:` / `quotes_of_tweet_id:`
// only once data/narratives/probes.json says the tier supports them.
import { settings } from './util.js';

export const MAX_QUERY = 512;
export const PLAN_QUERY = 480;

// Whole aliases too generic to search on their own (lower-cased). The
// placement model sometimes hands back "Trump" or "Congress" as an alias;
// as an OR-ed term that would swamp the story with everything else.
export const STOP = new Set([
  'trump', 'congress', 'democrats', 'republicans', 'house democrats', 'house republicans', 'america', 'american',
  'americans', 'never forget', 'political violence', 'historical records', 'rewriting history', 'country music icon',
  'first flight', 'trump meme', 'white house', 'the house', 'the senate', 'senate', 'news', 'breaking', 'today',
  'this week', 'right now', 'republican', 'democrat', 'president', 'the president', 'administration', 'bill', 'act'
]);

const clean = (s) => String(s || '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
const quote = (s) => `"${clean(s)}"`;

function excludeClause(excludeFrom) {
  return (excludeFrom || []).filter((h) => /^[A-Za-z0-9_]{1,15}$/.test(h)).map((h) => ` -from:${h}`).join('');
}

// Candidate aliases for a story: ≥4 chars, not generic, de-duplicated
// case-insensitively, label included so a story named "Epstein files
// transparency" matches even when the placement gave no aliases.
export function storyAliases(story) {
  const seen = new Set();
  const out = [];
  for (const raw of [...(story.aliases || []), story.label]) {
    const a = clean(raw);
    const k = a.toLowerCase();
    if (a.length < 4 || STOP.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

function orClause(aliases) {
  return `(${aliases.map(quote).join(' OR ')})`;
}

// Weakest alias first: generic (already gone), then shortest.
function trimAliases(aliases, budget, tail) {
  let list = aliases.slice();
  while (list.length > 1 && `${orClause(list)}${tail}`.length > budget) {
    let weakest = 0;
    for (let i = 1; i < list.length; i++) if (list[i].length < list[weakest].length) weakest = i;
    list.splice(weakest, 1);
  }
  return list;
}

// → { organic, originals, sample, control, aliases, dropped }
export function storyQueries(story, { control = settings.intel?.control_query, excludeFrom = settings.intel?.exclude_from, lang = 'en' } = {}) {
  const all = storyAliases(story);
  if (!all.length) throw new Error(`storyQueries: "${story.key || story.label}" has no usable alias (≥4 chars, not generic)`);
  const langClause = lang ? ` lang:${lang}` : '';
  const sampleTail = `${langClause} -is:retweet${excludeClause(excludeFrom)}`;
  const kept = trimAliases(all, PLAN_QUERY, sampleTail);
  const organic = `${orClause(kept)}${langClause}`;
  const originals = `${organic} -is:retweet`;
  const sample = `${originals}${excludeClause(excludeFrom)}`;
  const ctrl = control || '(Congress OR "House Democrats") -is:retweet lang:en';
  for (const q of [organic, originals, sample, ctrl]) assertValid(q);
  return { organic, originals, sample, control: ctrl, aliases: kept, dropped: all.filter((a) => !kept.includes(a)) };
}

export function phraseQuery(phrase, { lang = 'en' } = {}) {
  const q = `${quote(phrase)} -is:retweet${lang ? ` lang:${lang}` : ''}`;
  assertValid(q);
  return q;
}

// Only valid once probes.json records quotesOperator === true; the caller
// gates on that (validate() enforces it unless allowProbe is passed).
export function quotesQuery(tweetId) {
  if (!/^[0-9]{5,25}$/.test(String(tweetId))) throw new Error(`quotesQuery: bad tweet id ${tweetId}`);
  return `quotes_of_tweet_id:${tweetId} -is:retweet`;
}

export function listQuery(listId) {
  if (!/^[0-9]{1,25}$/.test(String(listId))) throw new Error(`listQuery: bad list id ${listId}`);
  return `list:${listId} -is:retweet`;
}

// Kind → search synonyms. X recent search has no wildcards, so every form
// is spelled out.
export const KIND_TERMS = {
  'extreme heat': ['heat', '"heat wave"', '"cooling center"', '"excessive heat"'],
  heat: ['heat', '"heat wave"', '"cooling center"'],
  wildfire: ['wildfire', '"brush fire"', 'fire', 'evacuation', 'evacuations', 'containment'],
  fire: ['fire', 'wildfire', 'evacuation'],
  flood: ['flood', 'flooding', 'floods', 'evacuation', 'shelter'],
  flooding: ['flood', 'flooding', 'floods', 'evacuation', 'shelter'],
  hurricane: ['hurricane', '"storm surge"', 'evacuation', 'evacuate'],
  'tropical storm': ['storm', 'hurricane', 'flooding', 'evacuation'],
  storm: ['storm', 'flooding', 'outage', 'outages'],
  tornado: ['tornado', 'tornadoes', 'damage', 'shelter'],
  earthquake: ['earthquake', 'quake', 'aftershock'],
  shooting: ['shooting', 'shooter', '"shelter in place"', 'lockdown'],
  'active shooter': ['shooter', 'shooting', '"shelter in place"', 'lockdown'],
  'plane crash': ['crash', 'plane', 'aircraft'],
  crash: ['crash', 'collision'],
  'power outage': ['outage', 'outages', 'power', 'blackout'],
  outage: ['outage', 'outages', 'power'],
  'water main': ['"water main"', '"boil water"', 'water'],
  'boil water': ['"boil water"', 'water', 'advisory'],
  explosion: ['explosion', 'blast', 'evacuation'],
  'train derailment': ['derailment', 'derailed', 'train'],
  'bridge collapse': ['bridge', 'collapse', 'closed']
};

export function placeTokens(place) {
  // "San Diego, CA · CA-50" → "San Diego"; "Kauai, HI" → "Kauai"
  const head = String(place || '').split('·')[0].split(',')[0].trim();
  return head ? [head] : [];
}

export function incidentQuery(incident, { lang = 'en' } = {}) {
  const places = placeTokens(incident.place);
  const kind = String(incident.kind || '').toLowerCase().trim();
  let terms = KIND_TERMS[kind];
  if (!terms) {
    const words = kind.split(/\s+/).filter((w) => w.length > 2);
    terms = words.length ? (words.length > 1 ? [quote(kind), ...words] : words) : ['emergency'];
  }
  if (!places.length) throw new Error(`incidentQuery: incident ${incident.id || ''} has no place`);
  const q = `(${places.map(quote).join(' OR ')}) (${[...new Set(terms)].join(' OR ')}) -is:retweet${lang ? ` lang:${lang}` : ''}`;
  assertValid(q);
  return q;
}

// ≤28 `from:` handles per query, each string ≤512 chars, topic clause appended.
export function fromSetQueries(handles, topic = '', { perQuery = 28, max = MAX_QUERY } = {}) {
  const valid = [...new Set((handles || []).filter((h) => /^[A-Za-z0-9_]{1,15}$/.test(h)))];
  const tail = topic ? ` ${topic.trim()}` : '';
  const out = [];
  let chunk = [];
  const render = (c) => `(${c.map((h) => `from:${h}`).join(' OR ')})${tail}`;
  for (const h of valid) {
    const next = [...chunk, h];
    if (chunk.length && (next.length > perQuery || render(next).length > max)) { out.push(render(chunk)); chunk = [h]; }
    else chunk = next;
  }
  if (chunk.length) out.push(render(chunk));
  for (const q of out) assertValid(q);
  return out;
}

export function validate(q, { probes = null, allowProbe = false } = {}) {
  const s = String(q || '');
  if (!s.trim()) return { ok: false, reason: 'empty query' };
  if (s.length > MAX_QUERY) return { ok: false, reason: `query is ${s.length} chars (max ${MAX_QUERY})` };
  if ((s.match(/"/g) || []).length % 2) return { ok: false, reason: 'unbalanced quotes' };
  let depth = 0;
  for (const c of s) { if (c === '(') depth++; else if (c === ')') depth--; if (depth < 0) break; }
  if (depth !== 0) return { ok: false, reason: 'unbalanced parentheses' };
  if (/\bfrom:list\b/i.test(s)) return { ok: false, reason: '"from:list" is the desk\'s pseudo-operator, not an X operator' };
  if (/expansions/i.test(s)) return { ok: false, reason: '"expansions" is a request parameter, never part of a query' };
  if (/\*/.test(s)) return { ok: false, reason: 'X recent search has no wildcard operator' };
  if (/\blist:\d/i.test(s) && !allowProbe && probes?.listOperator !== true) return { ok: false, reason: 'list: operator not confirmed by probes.json' };
  if (/\bquotes_of_tweet_id:\d/i.test(s) && !allowProbe && probes?.quotesOperator !== true) return { ok: false, reason: 'quotes_of_tweet_id: operator not confirmed by probes.json' };
  return { ok: true };
}

export function assertValid(q, opts) {
  const v = validate(q, opts);
  if (!v.ok) throw new Error(`invalid X query (${v.reason}): ${String(q).slice(0, 120)}`);
  return q;
}
