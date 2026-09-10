// Story layer: turn the nightly classifier's per-day "emerging clusters"
// into cross-day STORY CANDIDATES, and promote approved ones into the
// taxonomy as developing stories ("Immigration → Liam Ramos", not just
// "Immigration → detention").
//
// Each nightly run emits emerging clusters with free-text labels; the same
// subject comes back under slightly different labels on different days
// ("9/11 remembrance", "9-11-remembrance & first responders"). This script:
//   1. merges clusters across days by label similarity (union-find),
//   2. scores each candidate (posts, distinct members, days active, spread),
//   3. asks Claude once to place each candidate under a macro topic, give it
//      a stable key/label/aliases, and say whether it is a developing story
//      (a specific named event) or a generic taxonomy gap,
//   4. folds candidates that are one subject under different labels. A merge
//      needs evidence: shared post ids, a placement merge hint corroborated by
//      a shared label token, or a second small Claude pass that sees EVERY
//      story candidate at once (placement runs in batches of 20, so true
//      duplicates in different batches never met) and confirms duplicate
//      groups with a reason. Unsupported hints are dropped — the model once
//      folded generic "celebrity tribute" clusters into a Dolly Parton story —
//      and a gap never folds into a story.
//   5. writes data/stories.json — the dashboard's Emerging panel and the
//      daily report read it — and, with --promote, appends approved
//      candidates to config/taxonomy.yaml so the next classification run
//      assigns them directly.
//   6. --auto-promote: the story is the unit, so promotion is continuous —
//      every story candidate with a macro that clears settings.stories
//      (posts, members, days) is written to the taxonomy the same night as a
//      PROVISIONAL developing story (capped per night); the owner prunes from
//      the daily report instead of approving one by one. Taxonomy gaps are
//      listed, never auto-promoted: where a generic subject lives is a call
//      for a human.
//   7. --retire: a provisional story with no assignments for
//      settings.stories.retire_after_quiet_days is marked retired: true in
//      the YAML — it leaves the classifier prompt, its key stays for history.
//   A taxonomy edit made here is only seen by the NEXT classification run.
//
//   node --use-env-proxy src/stories.js                 # rebuild candidates (+1 small Claude call for new ones)
//   node --use-env-proxy src/stories.js --no-llm        # merge + score only
//   node --use-env-proxy src/stories.js --explain       # per candidate: daily clusters + merges behind it
//   node --use-env-proxy src/stories.js --confirm       # re-run the duplicate confirmation over all stories
//   node --use-env-proxy src/stories.js --promote=key1,key2
//   node --use-env-proxy src/stories.js --auto-promote  # promote everything over the thresholds (nightly)
//   node --use-env-proxy src/stories.js --retire        # retire quiet provisional stories (nightly)
//   node --use-env-proxy src/stories.js --days=30       # look-back window (default 30)
import fs from 'node:fs';
import { anthropicClient, anthropicConfigured } from './anthropic-auth.js';
import { p, settings, readJSON, writeJSON, daysAgoEt, etDate, addDays } from './util.js';
import { loadDay, topicsPath } from './store.js';
import { loadTaxonomy, renderTaxonomy, parseJsonLoose, ymd } from './taxonomy.js';

export const storiesPath = p('data', 'stories.json');
const arg = (name, dflt) => {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : dflt;
};

const STOP = new Set(['and', 'the', 'of', 'a', 'an', 'in', 'on', 'for', 'to', 'vs', 'amp', 'tribute', 'tributes', 'issues', 'issue', 'policy', 'news']);
export function labelTokens(label) {
  return new Set(String(label).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
    .map((w) => w.replace(/s$/, ''))
    .filter((w) => w.length > 1 && !STOP.has(w)));
}
export function similar(a, b) {
  if (!a.size || !b.size) return false;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const jaccard = inter / (a.size + b.size - inter);
  const containment = inter / Math.min(a.size, b.size);
  return jaccard >= 0.5 || (containment >= 0.99 && Math.min(a.size, b.size) >= 1 && inter >= 1 && Math.abs(a.size - b.size) <= 2);
}

// Union-find merge of {label, ids, date} clusters by label similarity.
// `sources` keeps the daily clusters behind each group so --explain can show
// where a candidate's posts came from.
export function mergeClusters(clusters) {
  const toks = clusters.map((c) => labelTokens(c.label));
  const parent = clusters.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      if (similar(toks[i], toks[j])) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  clusters.forEach((c, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, { labels: new Map(), ids: new Set(), dates: new Set(), sources: [] });
    const g = groups.get(r);
    g.labels.set(c.label, (g.labels.get(c.label) || 0) + c.ids.length);
    for (const id of c.ids) g.ids.add(id);
    g.dates.add(c.date);
    g.sources.push({ date: c.date, label: c.label, n: c.ids.length });
  });
  return [...groups.values()].map((g) => ({
    label: [...g.labels.entries()].sort((a, b) => b[1] - a[1])[0][0],
    labels: [...g.labels.keys()],
    ids: [...g.ids],
    dates: [...g.dates].sort(),
    sources: g.sources.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  }));
}

export function slug(label) {
  return String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

function gatherClusters(days) {
  const out = [];
  for (let d = 0; d < days; d++) {
    const date = daysAgoEt(d);
    const file = readJSON(topicsPath(date), null);
    for (const e of file?.emerging || []) if (e.ids?.length) out.push({ label: e.label, ids: e.ids, date });
  }
  return out;
}

function loadPosts(days) {
  const byId = new Map();
  for (let d = 0; d < days + 1; d++) {
    const date = daysAgoEt(d);
    for (const t of loadDay(date)) byId.set(t.id, { ...t, date });
  }
  return byId;
}

export function scoreCandidates(merged, postsById, authorsById, caucusKeys) {
  return merged.map((g) => {
    const posts = g.ids.map((id) => postsById.get(id)).filter(Boolean);
    if (!posts.length) return null;
    posts.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    const members = new Set(posts.map((x) => x.authorId));
    const eng = posts.reduce((a, x) => a + ((x.metricsAtCapture?.likes || 0) + (x.metricsAtCapture?.retweets || 0) + (x.metricsAtCapture?.replies || 0) + (x.metricsAtCapture?.quotes || 0)), 0);
    const best = posts.slice().sort((a, b) => {
      const e = (x) => (x.metricsAtCapture?.likes || 0) + (x.metricsAtCapture?.retweets || 0);
      return e(b) - e(a);
    })[0];
    return {
      // A merged group keeps the surviving candidate's key so its cached
      // placement still applies; a fresh group is keyed by its label.
      key: g.key || slug(g.label),
      label: g.label,
      labels: g.labels,
      posts: posts.length,
      members: members.size,
      days: g.dates.length,
      dates: g.dates,
      firstSeen: posts[0].date,
      lastSeen: posts.at(-1).date,
      eng,
      cm: caucusKeys.map((k) => [...members].filter((a) => (authorsById[a]?.caucuses || []).includes(k)).length),
      who: [...members].map((a) => authorsById[a]?.handle).filter(Boolean).slice(0, 12),
      ids: posts.map((x) => x.id),
      sample: best.text,
      samples: posts.slice(0, 3).map((x) => x.text.slice(0, 200)),
      sources: g.sources || [],
      mergedFrom: g.mergedFrom || []
    };
  }).filter(Boolean).sort((a, b) => b.posts - a.posts || b.members - a.members);
}

// ── Candidate merging ────────────────────────────────────────────────────
// Two candidates may be one subject under labels the union-find could not
// relate ("lake-renaming-stunt" / "place-renaming"). A merge is applied only
// with evidence, strongest first:
//   overlap   — the candidates share post ids
//   confirmed — the confirmation pass (confirmDuplicates, or its cache in
//               stories.json) grouped them
//   hint      — the placement pass said merge_into AND some daily label of
//               each shares a content token. The hint alone is not enough:
//               it is what folded "celebrity-tribute" (no shared token, mixed
//               samples) into a Dolly Parton story.
// Placement kinds must agree: a gap never folds into a story, noise never
// merges; an unplaced candidate may fold into a placed one.

export function kindsCompatible(pa, pb) {
  const ka = pa?.kind || null, kb = pb?.kind || null;
  if (ka === 'noise' || kb === 'noise') return false;
  return !ka || !kb || ka === kb;
}

// Content tokens any daily label of `a` shares with any daily label of `b`.
export function sharedLabelTokens(a, b) {
  const ta = new Set(), tb = new Set();
  for (const l of a.labels || [a.label]) for (const t of labelTokens(l)) ta.add(t);
  for (const l of b.labels || [b.label]) for (const t of labelTokens(l)) tb.add(t);
  return [...ta].filter((t) => tb.has(t));
}

// → { edges: [{a, b, by, reason}], dropped: [{a, b, why}] } over candidate keys.
export function mergeEvidence(candidates, placements = {}, confirmedGroups = []) {
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const edges = [], dropped = [];
  const pairKey = (a, b) => [a, b].sort().join(' ');
  const linked = new Set();
  const consider = (a, b, by, reason) => {
    if (a === b || !byKey.has(a) || !byKey.has(b)) return;
    if (!kindsCompatible(placements[a], placements[b])) {
      dropped.push({ a, b, why: `${by}, but placement kinds differ (${placements[a]?.kind || 'unplaced'} vs ${placements[b]?.kind || 'unplaced'})` });
      return;
    }
    edges.push({ a, b, by, reason });
    linked.add(pairKey(a, b));
  };

  for (let i = 0; i < candidates.length; i++) {
    const ids = new Set(candidates[i].ids);
    for (let j = i + 1; j < candidates.length; j++) {
      const shared = candidates[j].ids.filter((id) => ids.has(id)).length;
      if (shared) consider(candidates[i].key, candidates[j].key, 'overlap', `${shared} shared post(s)`);
    }
  }
  for (const g of confirmedGroups) {
    const keys = [...new Set((g.keys || []).filter((k) => byKey.has(k)))];
    for (let i = 1; i < keys.length; i++) consider(keys[0], keys[i], 'confirmed', g.reason || 'model confirmed the same story');
  }
  for (const c of candidates) {
    const into = placements[c.key]?.mergeInto;
    if (!into || into === c.key || !byKey.has(into)) continue;
    const shared = sharedLabelTokens(c, byKey.get(into));
    if (shared.length) consider(c.key, into, 'hint', `placement hint; labels share "${shared.join('", "')}"`);
    else if (!linked.has(pairKey(c.key, into))) dropped.push({ a: c.key, b: into, why: 'placement hint only: no shared label token, no post overlap, not confirmed' });
  }
  return { edges, dropped };
}

// Fold candidates along the evidence edges. Candidates arrive sorted by
// posts, and the earliest member of each component survives (its key, label
// and cached placement); the rest are recorded in `mergedFrom`. The result is
// re-scored by scoreCandidates, so members/dates/first/last are recomputed
// from the union of posts rather than patched.
export function applyMerges(candidates, edges) {
  const index = new Map(candidates.map((c, i) => [c.key, i]));
  const parent = candidates.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const e of edges) {
    const i = index.get(e.a), j = index.get(e.b);
    if (i == null || j == null) continue;
    const ri = find(i), rj = find(j);
    if (ri !== rj) parent[Math.max(ri, rj)] = Math.min(ri, rj);
  }
  const groups = new Map();
  candidates.forEach((c, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(c);
  });
  return [...groups.values()].map((members) => {
    const [root, ...rest] = members;
    if (!rest.length) return root;
    const why = (key) => edges.find((e) => e.a === key || e.b === key);
    return {
      key: root.key,
      label: root.label,
      labels: [...new Set(members.flatMap((m) => m.labels))],
      ids: [...new Set(members.flatMap((m) => m.ids))],
      dates: [...new Set(members.flatMap((m) => m.dates || []))].sort(),
      sources: members.flatMap((m) => (m.sources || []).map((s) => (m === root ? s : { ...s, via: m.key })))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
      mergedFrom: [
        ...(root.mergedFrom || []),
        ...rest.map((m) => ({ key: m.key, label: m.label, posts: m.posts, by: why(m.key)?.by, reason: why(m.key)?.reason }))
      ]
    };
  });
}

// One Claude call: place each candidate under a macro, name it, and say
// whether it is a developing story or a generic gap in the taxonomy.
// Batches of 20: the model reasons before it answers and that reasoning
// counts against max_tokens, so one reply per 60 candidates gets truncated.
async function placeCandidates(all, tax) {
  const out = {};
  for (let i = 0; i < all.length; i += 20) {
    Object.assign(out, await placeBatch(all.slice(i, i + 20), tax));
  }
  return out;
}

async function placeBatch(candidates, tax) {
  if (!candidates.length) return {};
  const client = await anthropicClient();
  const model = process.env.CLASSIFY_MODEL || settings.classify.model;
  const list = candidates.map((c, i) => `${i + 1}. label: "${c.label}" (${c.posts} posts, ${c.members} members, ${c.days} day(s))\n   samples: ${c.samples.map((s) => JSON.stringify(s)).join(' | ')}`).join('\n');
  const prompt = `You maintain a two-level topic taxonomy for tweets by US House Democrats. Existing taxonomy:

${renderTaxonomy(tax)}

Below are clusters of tweets the classifier could not place (it suggested a label). For EACH cluster decide:
- macro: the existing macro id it belongs under (pick the best fit; use "none" only if nothing fits at all)
- key: a short stable slug (lowercase, hyphens, <= 32 chars)
- label: a crisp display label (<= 40 chars); for a developing story name the specific event/person/place ("Liam Ramos detention", "Dolly Parton Tennessee tribute")
- kind: "story" if this is a specific, time-bound named event/person/place the caucus is reacting to; "gap" if it is a durable subject the taxonomy simply lacks (e.g. "Agriculture & farmers"); "noise" if it is not a coherent subject (greetings, generic tributes with no shared subject)
- aliases: 2-5 short strings the classifier should recognize (names, hashtags, nicknames)
- merge_into: if this cluster is the same subject as an earlier-numbered cluster, that cluster's number; else null

Clusters:
${list}

Reply with ONLY a JSON object: {"placements": [{"n": 1, "macro": "...", "key": "...", "label": "...", "kind": "story|gap|noise", "aliases": [...], "merge_into": null}, ...]}`;
  const res = await client.messages.create({ model, max_tokens: 12000, messages: [{ role: 'user', content: prompt }] });
  const text = res.content.find((b) => b.type === 'text')?.text || '';
  const parsed = parseJsonLoose(text);
  if (!parsed?.placements) {
    console.warn(`[stories] placement reply did not parse (stop_reason=${res.stop_reason}, ${text.length} chars): ${text.slice(0, 300).replace(/\s+/g, ' ')}`);
  }
  const out = {};
  for (const pl of parsed?.placements || []) {
    const c = candidates[pl.n - 1];
    if (!c) continue;
    out[c.key] = {
      macro: tax[pl.macro] ? pl.macro : null,
      key: slug(pl.key || c.key),
      label: String(pl.label || c.label).slice(0, 40),
      kind: ['story', 'gap', 'noise'].includes(pl.kind) ? pl.kind : 'gap',
      aliases: Array.isArray(pl.aliases) ? pl.aliases.map(String).slice(0, 5) : [],
      mergeInto: pl.merge_into ? candidates[pl.merge_into - 1]?.key || null : null
    };
  }
  return out;
}

// Second, smaller call: every story candidate at once (placement batches of
// 20 never let "lake-america-renaming" meet "lake-ontario-renaming"), each
// with its label, daily labels and two samples — the earliest and latest post,
// because a mixed cluster betrays itself at the ends while a real story reads
// the same throughout. Returns [{keys, reason}] for groups the model confirms.
// `client` is injectable so tests feed a canned reply; nothing here touches
// the network unless a real client is created.
export function confirmInput(c, postsById) {
  const text = (id) => postsById.get(id)?.text;
  const samples = [...new Set([text(c.ids[0]), text(c.ids.at(-1))])].filter(Boolean).map((t) => t.slice(0, 240));
  return { key: c.key, label: c.label, labels: c.labels, posts: c.posts, members: c.members, firstSeen: c.firstSeen, lastSeen: c.lastSeen, samples };
}

export async function confirmDuplicates(stories, { client, model } = {}) {
  if (stories.length < 2) return [];
  client ||= await anthropicClient();
  model ||= process.env.CLASSIFY_MODEL || settings.classify.model;
  const list = stories.map((s, i) => {
    const labels = s.labels?.length > 1 ? `; daily labels: ${s.labels.slice(0, 6).join(', ')}` : '';
    return `${i + 1}. "${s.label}" (${s.posts} posts, ${s.members} members, ${s.firstSeen} → ${s.lastSeen}${labels})\n   samples: ${s.samples.map((t) => JSON.stringify(t)).join(' | ')}`;
  }).join('\n');
  const prompt = `Below are candidate developing stories built from tweets by US House Democrats: clusters the classifier could not place, merged across days by label. Some are the SAME specific story under different labels. Find those and nothing else.

Rules:
- A duplicate group is two or more clusters about the same specific named event, person or place (e.g. two clusters both reacting to Trump's order renaming Lake Ontario "Lake America").
- A generic or mixed cluster (tributes to several different people, assorted memorials, unrelated renamings) is NOT a duplicate of a specific story, even if a few of its tweets touch it. Leave it alone.
- Sharing a broad theme is not enough: "9/11 remembrance" and "first responder health care" are different stories.
- When in doubt, do not group.

Clusters:
${list}

Reply with ONLY a JSON object: {"groups": [{"members": [1, 4], "reason": "<one line: what the shared story is>"}, ...]} — an empty list if nothing is a duplicate.`;
  const res = await client.messages.create({ model, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] });
  const text = res.content.find((b) => b.type === 'text')?.text || '';
  const parsed = parseJsonLoose(text);
  if (!parsed?.groups) {
    console.warn(`[stories] confirmation reply did not parse (stop_reason=${res.stop_reason}, ${text.length} chars): ${text.slice(0, 300).replace(/\s+/g, ' ')}`);
    return [];
  }
  const out = [];
  for (const g of Array.isArray(parsed.groups) ? parsed.groups : []) {
    const keys = [...new Set((Array.isArray(g.members) ? g.members : []).map((n) => stories[Number(n) - 1]?.key).filter(Boolean))];
    if (keys.length < 2) continue;
    out.push({ keys, reason: String(g.reason || '').replace(/\s+/g, ' ').trim().slice(0, 200) });
  }
  return out;
}

// Cache of confirmed groups: union with what earlier runs confirmed (a
// placement-style cache — the model is not asked twice about the same keys),
// deduplicated by key set.
export function mergeConfirmedGroups(prev, fresh) {
  const seen = new Set();
  const out = [];
  for (const g of [...(prev || []), ...(fresh || [])]) {
    const keys = [...new Set(g.keys || [])].sort();
    if (keys.length < 2) continue;
    const sig = keys.join(' ');
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({ keys: g.keys, reason: g.reason });
  }
  return out;
}

// The YAML is edited as text so its comments survive (js-yaml dump would
// strip them). A macro block is the column-0 key and every indented line
// after it; a subtopic block is the 4-space key and every line indented
// deeper. Replacements are functions so a "$" in a label is literal.
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const macroBlockRe = (macro) => new RegExp(`^${escapeRe(macro)}:\\n((?:  .*\\n)*)`, 'm');
const subBlockRe = (key) => new RegExp(`^    ${escapeRe(key)}:\\n((?:      .*\\n)*)`, 'm');

// Append promoted candidates to config/taxonomy.yaml. Inserts under the
// macro's subtopics; a key already present under that macro is left alone,
// so replaying a promotion is harmless. Auto-promoted stories also carry
// `provisional: true` (the owner has not confirmed it) and `promoted: <date>`
// (when it entered the taxonomy — the retirement clock starts there, not at
// `since`, which is the story's first post and can be weeks earlier).
export function promoteToTaxonomy(yamlText, items) {
  let text = yamlText;
  for (const it of items) {
    const macroRe = macroBlockRe(it.macro);
    const m = text.match(macroRe);
    if (!m) throw new Error(`macro "${it.macro}" not found in taxonomy.yaml`);
    let block = m[1];
    if (subBlockRe(it.key).test(block)) continue;
    const aliases = it.aliases?.length ? `\n      aliases: [${it.aliases.map((a) => JSON.stringify(a)).join(', ')}]` : '';
    const flags = (it.provisional ? '\n      provisional: true' : '') + (it.promoted ? `\n      promoted: ${ymd(it.promoted)}` : '');
    const entry = `    ${it.key}:\n      label: ${JSON.stringify(it.label)}${aliases}\n      story: true\n      since: ${ymd(it.since)}${flags}\n`;
    if (/^  subtopics: \{\}\n/m.test(block)) block = block.replace(/^  subtopics: \{\}\n/m, () => `  subtopics:\n${entry}`);
    else if (/^  subtopics:\n/m.test(block)) block = block.replace(/^  subtopics:\n/m, () => `  subtopics:\n${entry}`);
    else block = block + `  subtopics:\n${entry}`;
    text = text.replace(macroRe, () => `${it.macro}:\n${block}`);
  }
  return text;
}

// ── Continuous promotion ─────────────────────────────────────────────────
// A macro like "Congress & campaign politics" means nothing to the Leader's
// office on its own; the rows that matter are named, dated stories. So a
// candidate the placement pass called a story, under a macro, that clears
// settings.stories becomes a provisional developing story the same night,
// most posts first, capped per night. Gaps (durable generic subjects) are
// never promoted here — they are returned separately for a human --promote.

export const STORY_DEFAULTS = { auto_promote: true, min_posts: 5, min_members: 3, min_days: 2, max_per_night: 8, retire_after_quiet_days: 21 };
export const storySettings = (s = settings.stories) => ({ ...STORY_DEFAULTS, ...(s || {}) });

// Capitalized function words that are never part of a name: they break a
// run ("The White House" → "White House", "Today Dolly Parton" → "Dolly
// Parton", "CNN The Source" → nothing). "New" is deliberately absent: New
// Mexico, New York.
const CAP_STOP = new Set(['the', 'a', 'an', 'and', 'but', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by', 'as',
  'is', 'are', 'was', 'were', 'be', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'we', 'you', 'he', 'she', 'they',
  'my', 'our', 'your', 'his', 'her', 'their', 'rt', 'today', 'tonight', 'yesterday', 'tomorrow', 'thank', 'thanks', 'happy',
  'proud', 'just', 'now', 'here', 'what', 'when', 'where', 'why', 'how', 'who', 'which', 'if', 'so', 'no', 'yes', 'every',
  'all', 'more', 'please', 'join', 'watch', 'read', 'live', 'breaking', 'via', 'dear', 'rip', 'congrats', 'congratulations']);
const ABBREV = /^(Dr|Mr|Mrs|Ms|Rep|Sen|Gov|Sec|St|Jr|Sr|Lt|Gen|Col)\.$/;

// The proper nouns a story is about, as extra classifier aliases: the most
// frequent capitalized bigrams/trigrams across `texts` ("Lake Ontario",
// "Imagination Library"). Deterministic — ranked by how many texts contain
// the name, then longer, then alphabetical — and skips names already covered
// by `existing` (or by an earlier pick). URLs and @handles are stripped; a
// sentence-ending token or a capitalized function word closes a run, so the
// next sentence's first word never glues on ("...Parton. She").
export function properNounAliases(texts, { existing = [], max = 3 } = {}) {
  const df = new Map();
  for (const raw of texts || []) {
    const seen = new Set();
    const runs = [];
    let run = [];
    const flush = () => { if (run.length) runs.push(run); run = []; };
    for (const tok of String(raw).replace(/https?:\/\/\S+/g, ' ').replace(/@\w+/g, ' ').split(/\s+/)) {
      const ends = /[.!?…]["'”’)]*$/.test(tok) && !ABBREV.test(tok);
      const w = tok.replace(/^[#"'“‘(\[]+/, '').replace(/[.,;:!?"'”’)\]…]+$/, '').replace(/['’]s$/, '');
      if (w.length > 1 && /^[A-Z][A-Za-z0-9'’.-]*$/.test(w) && !CAP_STOP.has(w.toLowerCase())) run.push(w); else flush();
      if (ends) flush();
    }
    flush();
    for (const words of runs) {
      for (let n = 2; n <= 3; n++) for (let i = 0; i + n <= words.length; i++) seen.add(words.slice(i, i + n).join(' '));
    }
    for (const g of seen) df.set(g, (df.get(g) || 0) + 1);
  }
  const need = Math.min(2, (texts || []).length);
  const ranked = [...df.entries()].filter(([, n]) => n >= need)
    .sort((x, y) => y[1] - x[1] || y[0].length - x[0].length || (x[0] < y[0] ? -1 : 1))
    .map(([g]) => g);
  const out = [];
  const covered = (g) => [...existing, ...out].some((e) => {
    const a = String(e).toLowerCase(), b = g.toLowerCase();
    return a.includes(b) || b.includes(a);
  });
  for (const g of ranked) {
    if (out.length >= max) break;
    if (!covered(g)) out.push(g);
  }
  return out;
}

// Placement aliases first, derived names after; case-insensitive dedupe.
export function mergeAliases(placementAliases, derived, max = 8) {
  const out = [], seen = new Set();
  for (const a of [...(placementAliases || []), ...(derived || [])]) {
    const s = String(a).trim();
    const k = s.toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

// An existing subtopic under the macro that already names this story: same
// key, same label, or a shared alias (case-insensitive). Guards against a
// second key for a story the owner (or an earlier night) already added.
export function existingSubtopic(tax, macro, pl) {
  const subs = tax?.[macro]?.subtopics || {};
  if (subs[pl.key]) return pl.key;
  const norm = (s) => String(s).trim().toLowerCase();
  const mine = new Set([pl.label, ...(pl.aliases || [])].filter(Boolean).map(norm));
  for (const [k, sub] of Object.entries(subs)) {
    if ([sub.label, ...(sub.aliases || [])].filter(Boolean).map(norm).some((s) => mine.has(s))) return k;
  }
  return null;
}

// Pure selection: scored candidates (with .placement) in, promotion items
// out — what promoteToTaxonomy writes plus the counts the report shows.
//   items     promoted tonight, by posts desc, at most max_per_night
//   deferred  cleared the thresholds but wait for another night
//   gaps      kind 'gap' candidates (a human decides these)
//   skipped   stories not promoted, with the reason
// `textsOf(c)` supplies the post texts alias derivation reads (defaults to
// the candidate's three samples); `night` is the date written as `promoted`.
export function autoPromote(candidates, storyCfg, { promoted = [], tax = null, textsOf = (c) => c.samples || [], night = null } = {}) {
  const cfg = storySettings(storyCfg);
  const done = new Set(promoted || []);
  const gaps = [], eligible = [], skipped = [];
  const skip = (c, why) => skipped.push({ key: c.key, label: c.placement?.label || c.label, why });
  for (const c of candidates) {
    const pl = c.placement;
    if (!pl || pl.kind === 'noise') continue;
    if (pl.kind === 'gap') { gaps.push(c); continue; }
    if (pl.kind !== 'story') continue;
    if (!pl.macro) { skip(c, 'no macro fits — needs a hand placement'); continue; }
    if (done.has(`${pl.macro}/${pl.key}`)) continue;
    if (tax && !tax[pl.macro]) { skip(c, `macro "${pl.macro}" is no longer in the taxonomy`); continue; }
    const dup = existingSubtopic(tax, pl.macro, pl);
    if (dup) { skip(c, `already in the taxonomy as ${pl.macro}/${dup}`); continue; }
    const short = [];
    if (c.posts < cfg.min_posts) short.push(`${c.posts}/${cfg.min_posts} posts`);
    if (c.members < cfg.min_members) short.push(`${c.members}/${cfg.min_members} members`);
    if (c.days < cfg.min_days) short.push(`${c.days}/${cfg.min_days} days`);
    if (short.length) { skip(c, `below threshold: ${short.join(', ')}`); continue; }
    eligible.push(c);
  }
  eligible.sort((a, b) => b.posts - a.posts || b.members - a.members || b.days - a.days || (a.key < b.key ? -1 : 1));
  // The model can name one story from two candidates — the same placement
  // key, or two keys sharing a label or alias under the macro ("Lake
  // America" on both lake-america-renaming and lake-ontario-renaming). The
  // one with more posts carries it; the other is skipped, and once the first
  // is in the YAML, existingSubtopic keeps skipping it on later nights.
  const namesOf = (pl) => [pl.label, ...(pl.aliases || [])].filter(Boolean).map((s) => String(s).trim().toLowerCase());
  const unique = [];
  for (const c of eligible) {
    const pl = c.placement;
    const names = namesOf(pl);
    const twin = unique.find((o) => o.placement.macro === pl.macro && (o.placement.key === pl.key || namesOf(o.placement).some((n) => names.includes(n))));
    if (twin) { skip(c, `same story as a larger candidate (${twin.placement.macro}/${twin.placement.key})`); continue; }
    unique.push(c);
  }
  const items = unique.slice(0, cfg.max_per_night).map((c) => {
    const pl = c.placement;
    return {
      macro: pl.macro, key: pl.key, label: pl.label,
      aliases: mergeAliases(pl.aliases, properNounAliases(textsOf(c), { existing: pl.aliases || [] })),
      since: c.firstSeen, provisional: true, promoted: night,
      candidate: c.key, posts: c.posts, members: c.members, days: c.days, lastSeen: c.lastSeen
    };
  });
  return { items, deferred: unique.slice(cfg.max_per_night), gaps, skipped };
}

// ── Retirement ───────────────────────────────────────────────────────────

// Subtopic assignments across classified days: "macro/sub" → {posts,
// lastSeen}. `topicsFor(date)` returns the data/topics file (or null), so
// tests feed fixtures and missing days are simply empty.
export function assignmentCounts(dates, topicsFor) {
  const out = new Map();
  for (const date of dates) {
    const file = topicsFor(date);
    for (const topics of Object.values(file?.assignments || {})) {
      for (const [macro, sub] of Array.isArray(topics) ? topics : []) {
        if (!sub) continue;
        const k = `${macro}/${sub}`;
        const e = out.get(k) || { posts: 0, lastSeen: null };
        e.posts++;
        if (!e.lastSeen || date > e.lastSeen) e.lastSeen = date;
        out.set(k, e);
      }
    }
  }
  return out;
}

// Provisional stories to retire: in the taxonomy for at least `quietDays`
// (by `promoted`, else `since`) with zero assignments over that window.
// A story the owner confirmed (provisional removed) is never touched, nor is
// one promoted too recently to have been classified for the whole window.
export function quietStories(tax, counts, { quietDays, today }) {
  const cutoff = addDays(today, -quietDays);
  const out = [];
  for (const [macro, m] of Object.entries(tax || {})) {
    for (const [key, sub] of Object.entries(m.subtopics || {})) {
      if (!sub.story || !sub.provisional || sub.retired) continue;
      const entered = ymd(sub.promoted || sub.since);
      if (!entered || entered > cutoff) continue;
      if (counts.get(`${macro}/${key}`)?.posts) continue;
      out.push({ macro, key, label: sub.label, since: ymd(sub.since), promoted: ymd(sub.promoted), quietDays });
    }
  }
  return out;
}

// Mark subtopics retired in the YAML text, preserving comments and order:
// `retired: true` is appended to each entry's block. renderTaxonomy then
// drops it from the prompt; rollups and history still resolve the key.
export function markRetired(yamlText, items) {
  let text = yamlText;
  for (const it of items) {
    const macroRe = macroBlockRe(it.macro);
    const m = text.match(macroRe);
    if (!m) throw new Error(`macro "${it.macro}" not found in taxonomy.yaml`);
    const subRe = subBlockRe(it.key);
    const s = m[1].match(subRe);
    if (!s) throw new Error(`subtopic "${it.macro}/${it.key}" not found in taxonomy.yaml`);
    if (/^      retired: true\n/m.test(s[1])) continue;
    const block = m[1].replace(subRe, () => `    ${it.key}:\n${s[1]}      retired: true\n`);
    text = text.replace(macroRe, () => `${it.macro}:\n${block}`);
  }
  return text;
}

// Write promotions: the YAML entry, then data/stories.json — `promoted`
// (macro/key strings the dashboard hides from Emerging) and `promotions`
// (the log the daily report reads for "promoted tonight").
function recordPromotions(items, how, night) {
  const file = p('config', 'taxonomy.yaml');
  fs.writeFileSync(file, promoteToTaxonomy(fs.readFileSync(file, 'utf8'), items));
  const data = readJSON(storiesPath);
  data.promoted = [...new Set([...(data.promoted || []), ...items.map((i) => `${i.macro}/${i.key}`)])];
  data.promotions = [...(data.promotions || []), ...items.map((i) => ({ ...i, promoted: night, how }))];
  writeJSON(storiesPath, data);
}

// --explain: for each final candidate, the daily clusters behind it (with the
// folded candidate each came through) and the evidence for every merge; then
// the placement hints that were not applied and why.
function printExplain(final, dropped) {
  console.log('\n[stories] explain — daily clusters and merges behind each candidate');
  for (const c of final) {
    const pl = c.placement;
    console.log(`\n${c.key}  ${pl ? `[${pl.kind}] ${pl.macro || '-'}/${pl.key} "${pl.label}"` : '(unplaced)'}  ${c.posts} posts, ${c.members} members, ${c.days} day(s), ${c.firstSeen} → ${c.lastSeen}`);
    for (const s of c.sources) console.log(`    ${s.date}  ${s.label} (${s.n})${s.via ? `  via ${s.via}` : ''}`);
    for (const m of c.mergedFrom) console.log(`  + ${m.key} (${m.posts} posts) — ${m.by}: ${m.reason}`);
  }
  if (dropped.length) {
    console.log('\nmerge hints not applied:');
    for (const d of dropped) console.log(`  ${d.a} → ${d.b}: ${d.why}`);
  }
}

async function main() {
  const days = Number(arg('days', 30));
  const noLlm = process.argv.includes('--no-llm');
  const explain = process.argv.includes('--explain');
  const reconfirm = process.argv.includes('--confirm');
  const autoFlag = process.argv.includes('--auto-promote');
  const retireFlag = process.argv.includes('--retire');
  const promote = arg('promote', '').split(',').map((s) => s.trim()).filter(Boolean);
  const night = etDate(); // the ET date this run happens on (the nightly runs after the day closes)
  const tax = loadTaxonomy();
  const authorsById = readJSON(p('data', 'authors.json'), { byId: {} }).byId;
  const caucusKeys = [...new Set(Object.values(settings.caucus_keys))]; // same order as sitedata's KEYS

  const clusters = gatherClusters(days);
  const merged = mergeClusters(clusters);
  const postsById = loadPosts(days);
  const candidates = scoreCandidates(merged, postsById, authorsById, caucusKeys);
  const prev = readJSON(storiesPath, { placements: {} });
  const placements = { ...(prev.placements || {}) };
  const llm = !noLlm && anthropicConfigured();

  const fresh = candidates.filter((c) => !placements[c.key]);
  if (fresh.length && llm) {
    const top = fresh.slice(0, 60);
    console.log(`[stories] asking the model to place ${top.length} new candidate(s)`);
    // A failed call degrades to "no placement tonight" rather than aborting:
    // this runs inside the nightly chain, and the stages after it (rollups,
    // report, site data) must not wait on a transient API error.
    try { Object.assign(placements, await placeCandidates(top, tax)); }
    catch (e) { console.warn(`[stories] placement call failed (${e.message}); continuing with cached placements`); }
  }

  // Duplicate confirmation over ALL story candidates. Cached like placements:
  // it re-runs only when a story key it has not seen appears (or --confirm),
  // and confirmed groups accumulate so a merge survives later runs.
  const confirmation = { checked: [], groups: [], ...(prev.confirmation || {}) };
  const storyCands = candidates.filter((c) => placements[c.key]?.kind === 'story');
  const unchecked = storyCands.filter((c) => !confirmation.checked.includes(c.key));
  if (llm && storyCands.length >= 2 && (unchecked.length || reconfirm)) {
    console.log(`[stories] asking the model to confirm duplicates among ${storyCands.length} story candidate(s) (${unchecked.length} unchecked)`);
    try {
      const groups = await confirmDuplicates(storyCands.map((c) => confirmInput(c, postsById)));
      for (const g of groups) console.log(`  confirmed: ${g.keys.join(' + ')} — ${g.reason}`);
      confirmation.groups = mergeConfirmedGroups(confirmation.groups, groups);
      confirmation.checked = storyCands.map((c) => c.key);
      confirmation.checkedAt = new Date().toISOString();
    } catch (e) {
      console.warn(`[stories] confirmation call failed (${e.message}); using cached confirmations only`);
    }
  } else if (reconfirm && !llm) {
    console.warn('[stories] --confirm needs the model (drop --no-llm / configure Anthropic credentials); using cached confirmations only');
  }

  const { edges, dropped } = mergeEvidence(candidates, placements, confirmation.groups);
  const final = scoreCandidates(applyMerges(candidates, edges), postsById, authorsById, caucusKeys)
    .map((c) => ({ ...c, placement: placements[c.key] || null }));
  const mergesApplied = final.reduce((a, c) => a + c.mergedFrom.length, 0);

  // Drop confirmed groups that no longer name two current candidates (keys
  // drift when a cluster's dominant label changes, or slide out of the window).
  const current = new Set(candidates.map((c) => c.key));
  confirmation.groups = confirmation.groups
    .map((g) => ({ ...g, keys: g.keys.filter((k) => current.has(k)) }))
    .filter((g) => g.keys.length >= 2);

  // `sources` (every daily cluster behind a candidate) is for --explain; it
  // would add ~40% to the file, so only `dates` and `mergedFrom` are kept.
  writeJSON(storiesPath, {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    promoted: prev.promoted || [],          // "macro/key" — hidden from the Emerging panel
    promotions: prev.promotions || [],      // log: what was promoted which night (the report reads it)
    retirements: prev.retirements || [],    // log: provisional stories retired for going quiet
    placements,
    confirmation,
    candidates: final.map(({ samples, sources, ...c }) => c)
  });

  const stories = final.filter((c) => c.placement?.kind === 'story');
  const gaps = final.filter((c) => c.placement?.kind === 'gap');
  console.log(`[stories] ${clusters.length} daily clusters → ${final.length} candidates (${stories.length} stories, ${gaps.length} taxonomy gaps, ${final.length - stories.length - gaps.length} unplaced/noise); ${mergesApplied} merge(s) applied, ${dropped.length} hint(s) not applied`);
  for (const c of final.slice(0, 20)) {
    const pl = c.placement;
    console.log(`  ${String(c.posts).padStart(3)} posts ${String(c.members).padStart(3)} members ${c.days}d  ${pl ? `[${pl.kind}] ${pl.macro || '-'}/${pl.key} "${pl.label}"` : c.label}`);
  }
  if (explain) printExplain(final, dropped);

  // --promote=key: an explicit approval by hand, so the entry is written
  // confirmed (no provisional flag) and never retired automatically.
  if (promote.length) {
    const items = promote.map((k) => {
      const c = final.find((x) => x.placement?.key === k || x.key === k);
      if (!c?.placement?.macro) throw new Error(`cannot promote "${k}": no candidate with a macro placement`);
      return {
        macro: c.placement.macro, key: c.placement.key, label: c.placement.label, aliases: c.placement.aliases, since: c.firstSeen,
        candidate: c.key, posts: c.posts, members: c.members, days: c.days, lastSeen: c.lastSeen
      };
    });
    recordPromotions(items, 'manual', night);
    console.log(`[stories] promoted ${items.map((i) => `${i.macro}/${i.key}`).join(', ')} → config/taxonomy.yaml (re-run classification to apply)`);
  }

  // --auto-promote: continuous promotion. The taxonomy change is only seen
  // by the NEXT classification run (tonight's batch already ran).
  if (autoFlag) {
    const cfg = storySettings();
    const data = readJSON(storiesPath);
    const { items, deferred, gaps, skipped } = autoPromote(final, cfg, {
      promoted: data.promoted, tax, night,
      textsOf: (c) => c.ids.map((id) => postsById.get(id)?.text).filter(Boolean)
    });
    const show = (i) => `${i.macro}/${i.key} "${i.label}" — ${i.posts} posts, ${i.members} members, ${i.days} day(s), since ${i.since}`;
    if (!items.length) {
      console.log(`[stories] auto-promote: no story cleared the thresholds (≥${cfg.min_posts} posts, ≥${cfg.min_members} members, ≥${cfg.min_days} days)`);
    } else if (!cfg.auto_promote) {
      console.log(`[stories] auto-promote is off (settings.stories.auto_promote); would promote ${items.length}:`);
      for (const i of items) console.log(`  ${show(i)}`);
    } else {
      recordPromotions(items, 'auto', night);
      console.log(`[stories] auto-promoted ${items.length} provisional stor${items.length === 1 ? 'y' : 'ies'} → config/taxonomy.yaml (applies from the next classification run):`);
      for (const i of items) console.log(`  ${show(i)}; aliases: ${i.aliases.join(', ')}`);
    }
    if (deferred.length) console.log(`[stories] ${deferred.length} more cleared the thresholds and wait for another night (max_per_night=${cfg.max_per_night})`);
    for (const s of skipped.filter((x) => !/^below threshold/.test(x.why))) console.log(`  not promoted ${s.key}: ${s.why}`);
    if (gaps.length) {
      console.log(`[stories] ${gaps.length} taxonomy gap(s) need a human (never auto-promoted): ${gaps.slice(0, 8).map((c) => `${c.placement.macro || '-'}/${c.placement.key} (${c.posts} posts)`).join(', ')}`);
    }
  }

  // --retire: provisional stories that went quiet leave the prompt. Reads
  // the YAML again so a story promoted moments ago is judged from the file.
  if (retireFlag) {
    const cfg = storySettings();
    const quietDays = cfg.retire_after_quiet_days;
    const dates = Array.from({ length: quietDays + 1 }, (_, d) => daysAgoEt(d));
    const counts = assignmentCounts(dates, (date) => readJSON(topicsPath(date), null));
    const quiet = quietStories(loadTaxonomy(), counts, { quietDays, today: night });
    if (!quiet.length) {
      console.log(`[stories] retire: no provisional story has been quiet for ${quietDays} days`);
    } else {
      const file = p('config', 'taxonomy.yaml');
      fs.writeFileSync(file, markRetired(fs.readFileSync(file, 'utf8'), quiet));
      const data = readJSON(storiesPath);
      data.retirements = [...(data.retirements || []), ...quiet.map((q) => ({ ...q, retired: night }))];
      writeJSON(storiesPath, data);
      console.log(`[stories] retired ${quiet.length} quiet provisional stor${quiet.length === 1 ? 'y' : 'ies'}: ${quiet.map((q) => `${q.macro}/${q.key}`).join(', ')} (retired: true in config/taxonomy.yaml; out of the prompt from the next classification run, keys kept for history)`);
    }
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
