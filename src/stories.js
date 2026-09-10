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
//   4. writes data/stories.json — the dashboard's Emerging panel and the
//      daily report read it — and, with --promote, appends approved
//      candidates to config/taxonomy.yaml so the next classification run
//      assigns them directly.
//
//   node --use-env-proxy src/stories.js                 # rebuild candidates (+1 small Claude call for new ones)
//   node --use-env-proxy src/stories.js --no-llm        # merge + score only
//   node --use-env-proxy src/stories.js --promote=key1,key2
//   node --use-env-proxy src/stories.js --days=30       # look-back window (default 30)
import fs from 'node:fs';
import { anthropicClient, anthropicConfigured } from './anthropic-auth.js';
import { p, settings, readJSON, writeJSON, daysAgoEt } from './util.js';
import { loadDay, topicsPath } from './store.js';
import { loadTaxonomy, renderTaxonomy, parseJsonLoose } from './taxonomy.js';

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
    if (!groups.has(r)) groups.set(r, { labels: new Map(), ids: new Set(), dates: new Set() });
    const g = groups.get(r);
    g.labels.set(c.label, (g.labels.get(c.label) || 0) + c.ids.length);
    for (const id of c.ids) g.ids.add(id);
    g.dates.add(c.date);
  });
  return [...groups.values()].map((g) => ({
    label: [...g.labels.entries()].sort((a, b) => b[1] - a[1])[0][0],
    labels: [...g.labels.keys()],
    ids: [...g.ids],
    dates: [...g.dates].sort()
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
      key: slug(g.label),
      label: g.label,
      labels: g.labels,
      posts: posts.length,
      members: members.size,
      days: g.dates.length,
      firstSeen: posts[0].date,
      lastSeen: posts.at(-1).date,
      eng,
      cm: caucusKeys.map((k) => [...members].filter((a) => (authorsById[a]?.caucuses || []).includes(k)).length),
      who: [...members].map((a) => authorsById[a]?.handle).filter(Boolean).slice(0, 12),
      ids: posts.map((x) => x.id),
      sample: best.text,
      samples: posts.slice(0, 3).map((x) => x.text.slice(0, 200))
    };
  }).filter(Boolean).sort((a, b) => b.posts - a.posts || b.members - a.members);
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

// Append promoted candidates to config/taxonomy.yaml as text (js-yaml dump
// would strip the file's comments). Inserts under the macro's subtopics.
export function promoteToTaxonomy(yamlText, items) {
  let text = yamlText;
  for (const it of items) {
    const macroRe = new RegExp(`^${it.macro}:\\n((?:  .*\\n)*)`, 'm');
    const m = text.match(macroRe);
    if (!m) throw new Error(`macro "${it.macro}" not found in taxonomy.yaml`);
    let block = m[1];
    const aliases = it.aliases?.length ? `\n      aliases: [${it.aliases.map((a) => JSON.stringify(a)).join(', ')}]` : '';
    const entry = `    ${it.key}:\n      label: ${JSON.stringify(it.label)}${aliases}\n      story: true\n      since: ${it.since}\n`;
    if (/^  subtopics: \{\}\n/m.test(block)) block = block.replace(/^  subtopics: \{\}\n/m, `  subtopics:\n${entry}`);
    else if (/^  subtopics:\n/m.test(block)) block = block.replace(/^  subtopics:\n/m, `  subtopics:\n${entry}`);
    else block = block + `  subtopics:\n${entry}`;
    text = text.replace(macroRe, `${it.macro}:\n${block}`);
  }
  return text;
}

async function main() {
  const days = Number(arg('days', 30));
  const noLlm = process.argv.includes('--no-llm');
  const promote = arg('promote', '').split(',').map((s) => s.trim()).filter(Boolean);
  const tax = loadTaxonomy();
  const authorsById = readJSON(p('data', 'authors.json'), { byId: {} }).byId;
  const caucusKeys = [...new Set(Object.values(settings.caucus_keys))]; // same order as sitedata's KEYS

  const clusters = gatherClusters(days);
  const merged = mergeClusters(clusters);
  const postsById = loadPosts(days);
  const candidates = scoreCandidates(merged, postsById, authorsById, caucusKeys);
  const prev = readJSON(storiesPath, { placements: {} });
  const placements = { ...(prev.placements || {}) };

  const fresh = candidates.filter((c) => !placements[c.key]);
  if (fresh.length && !noLlm && anthropicConfigured()) {
    const top = fresh.slice(0, 60);
    console.log(`[stories] asking the model to place ${top.length} new candidate(s)`);
    Object.assign(placements, await placeCandidates(top, tax));
  }

  // Apply model merges (a later cluster judged to be the same subject as an earlier one).
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  for (const c of candidates) {
    const into = placements[c.key]?.mergeInto;
    if (into && byKey.has(into) && into !== c.key) {
      const t = byKey.get(into);
      const ids = new Set([...t.ids, ...c.ids]);
      t.ids = [...ids]; t.posts = ids.size;
      t.labels = [...new Set([...t.labels, ...c.labels])];
      t.days = new Set([...(t._dates || [t.firstSeen, t.lastSeen]), c.firstSeen, c.lastSeen]).size;
      byKey.delete(c.key);
    }
  }
  const final = [...byKey.values()].map((c) => ({ ...c, placement: placements[c.key] || null }))
    .sort((a, b) => b.posts - a.posts || b.members - a.members);

  writeJSON(storiesPath, {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    promoted: prev.promoted || [],
    placements,
    candidates: final.map(({ samples, ...c }) => c)
  });

  const stories = final.filter((c) => c.placement?.kind === 'story');
  const gaps = final.filter((c) => c.placement?.kind === 'gap');
  console.log(`[stories] ${clusters.length} daily clusters → ${final.length} candidates (${stories.length} stories, ${gaps.length} taxonomy gaps, ${final.length - stories.length - gaps.length} unplaced/noise)`);
  for (const c of final.slice(0, 20)) {
    const pl = c.placement;
    console.log(`  ${String(c.posts).padStart(3)} posts ${String(c.members).padStart(3)} members ${c.days}d  ${pl ? `[${pl.kind}] ${pl.macro || '-'}/${pl.key} "${pl.label}"` : c.label}`);
  }

  if (promote.length) {
    const items = promote.map((k) => {
      const c = final.find((x) => x.placement?.key === k || x.key === k);
      if (!c?.placement?.macro) throw new Error(`cannot promote "${k}": no candidate with a macro placement`);
      return { macro: c.placement.macro, key: c.placement.key, label: c.placement.label, aliases: c.placement.aliases, since: c.firstSeen };
    });
    const file = p('config', 'taxonomy.yaml');
    fs.writeFileSync(file, promoteToTaxonomy(fs.readFileSync(file, 'utf8'), items));
    const data = readJSON(storiesPath);
    data.promoted = [...new Set([...(data.promoted || []), ...items.map((i) => `${i.macro}/${i.key}`)])];
    writeJSON(storiesPath, data);
    console.log(`[stories] promoted ${items.map((i) => `${i.macro}/${i.key}`).join(', ')} → config/taxonomy.yaml (re-run classification to apply)`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
