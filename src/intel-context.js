// Newsletter context and owner-supplied queries for the narrative layer
// (docs/NARRATIVE_INTELLIGENCE.md §4). Pure: reads two files, no network.
//
//   readContext()          data/context.json — keyed by story-candidate key:
//                          stories.{candidateKey}.{key,label,kind,window,searched,matches[],note}.
//                          There are no URLs in it; matches are `reported`-grade at most.
//   contextFor(story)      the entry for a story, matched the way sitedata.contextKeyFor does
//                          (candidate key, placement key, or label — slug-normalised), with a
//                          `stale` flag when generatedAt is older than 48h and the owner's
//                          low-value senders (White House pool reports) filtered out.
//   loadOwnerQueries()     config/intel-queries.json, validated (bad queries are reported, not run).
import { p, settings, readJSON } from './util.js';
import { contextKeyFor } from './sitedata.js';
import { validate } from './intel-queries.js';

export const contextPath = p('data', 'context.json');
export const ownerQueriesPath = p('config', 'intel-queries.json');

export function readContext() {
  return readJSON(contextPath, null);
}

export function contextFor(story, context = readContext(), { now = Date.now(), staleHours = 48, excludeSenders = settings.intel?.context_exclude_senders || [] } = {}) {
  const out = { available: false, generatedAt: null, stale: false, key: null, matches: [] };
  if (!context?.stories) return out;
  out.available = true;
  out.generatedAt = context.generatedAt || null;
  out.stale = Boolean(out.generatedAt && now - new Date(out.generatedAt).getTime() > staleHours * 3_600_000);
  const cluster = { suggest: story.key, key: story.candidateKeys?.[0] || story.candidateKey || story.key, label: story.label };
  let key = contextKeyFor(cluster, context.stories);
  if (!key) {
    for (const ck of story.candidateKeys || []) { key = contextKeyFor({ suggest: ck }, context.stories); if (key) break; }
  }
  if (!key) return out;
  out.key = key;
  const skip = new Set((excludeSenders || []).map((s) => String(s).toLowerCase()));
  out.matches = (context.stories[key].matches || [])
    .filter((m) => !skip.has(String(m.from || '').toLowerCase()))
    .map((m) => ({
      sender: m.sender || null, from: m.from || null, subject: m.subject || null, date: m.date || null,
      snippet: m.snippet || null, why: m.why || null, threadId: m.threadId || null,
      links: Array.isArray(m.links) ? m.links.filter((u) => /^https?:\/\//.test(u)) : []   // tolerated if the newsletter builder adds it
    }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  out.note = context.stories[key].note || null;
  return out;
}

// → { pin: [], exclude: [], stories: [{key,label,macro,aliases}], queries: [{key,label,scope,query,max_results}], fromSets: {}, problems: [] }
export function loadOwnerQueries(file = ownerQueriesPath) {
  const raw = readJSON(file, null) || {};
  const problems = [];
  const slugOk = (k) => /^[a-z0-9][a-z0-9-]{1,40}$/.test(String(k || ''));
  const stories = [];
  for (const s of Array.isArray(raw.stories) ? raw.stories : []) {
    if (!slugOk(s.key) || !s.label) { problems.push(`stories: entry needs a slug key and a label (${JSON.stringify(s).slice(0, 80)})`); continue; }
    const aliases = Array.isArray(s.aliases) ? s.aliases.map(String).filter((a) => a.trim().length >= 4) : [];
    if (!aliases.length) { problems.push(`stories.${s.key}: needs at least one alias of 4+ chars`); continue; }
    stories.push({ key: s.key, label: String(s.label).slice(0, 60), macro: s.macro || null, aliases });
  }
  const queries = [];
  for (const q of Array.isArray(raw.queries) ? raw.queries : []) {
    if (!slugOk(q.key) || !q.query) { problems.push(`queries: entry needs a slug key and a query (${JSON.stringify(q).slice(0, 80)})`); continue; }
    const v = validate(q.query);
    if (!v.ok) { problems.push(`queries.${q.key}: ${v.reason}`); continue; }
    const max = Math.min(100, Math.max(10, Number(q.max_results) || 50));
    queries.push({ key: q.key, label: q.label || q.key, scope: q.scope || 'adhoc', query: q.query, max_results: max });
  }
  const fromSets = {};
  for (const [k, v] of Object.entries(raw.from_sets || {})) {
    if (!Array.isArray(v)) { problems.push(`from_sets.${k}: must be an array of handles`); continue; }
    fromSets[k] = v.map(String).filter((h) => /^[A-Za-z0-9_]{1,15}$/.test(h));
  }
  return {
    pin: (Array.isArray(raw.pin) ? raw.pin : []).map(String).filter(slugOk),
    exclude: (Array.isArray(raw.exclude) ? raw.exclude : []).map(String).filter(slugOk),
    stories, queries, fromSets, problems
  };
}
