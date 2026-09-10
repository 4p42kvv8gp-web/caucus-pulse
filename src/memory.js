// Memory fed back into the judging steps. The dossiers (src/dossiers.js)
// are the long-term store; this module turns them into what a prompt can
// use: one story's context (storyContext), the stories a post is probably
// about (nearbyStoryContext), and a byte-stable "Memory" block that the
// classifier and the duplicate-confirmation pass prepend to their prompts.
//
// Byte-stable matters: the live classifier's system blocks are prompt-cached,
// and the confirmation pass is cached by its inputs. So every list here is
// sorted by key, every date comes from the ledger (never the wall clock),
// and the block only changes when a dossier changed.
//
// Where it is wired tonight (2026-09-10):
//   - classify-live.js: memoryForClassifier() as a second cached system block
//   - stories.js confirmDuplicates: memoryForStories(keys) inside the prompt
// Hooks for the rest (each takes the same block):
//   TODO(classify.js): chunkRequests should add memoryForClassifier() as a
//     second system block exactly like classify-live.js — classify.js was
//     off-limits tonight, so the nightly batch still classifies without memory.
//   HOOK(night-why-it-moved): why.js — memoryForStories(keys of the movers)
//     before the driving posts, so "why it moved" reads against yesterday.
//   HOOK(night-semantic-integration): feed lookalikes — nearbyStoryContext(post)
//     for each unlabeled neighbour, and its summary in the judging prompt.
//   HOOK(night-incident-corroboration): incidents corroborate —
//     memoryForStories(keys of stories the incidents are tagged with).
import fs from 'node:fs';
import { p, daysAgoEt } from './util.js';
import { loadDay } from './store.js';
import { loadDossiers } from './dossiers.js';

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const RECENT_DAYS = 3;
const LEADERS = 5;
export const CLASSIFIER_STORY_LIMIT = 12;

let cached = null;
export function memoryDossiers({ dossiers = null, reload = false } = {}) {
  if (dossiers) return dossiers instanceof Map ? dossiers : new Map(dossiers.map((d) => [d.key, d]));
  if (!cached || reload) cached = loadDossiers();
  return cached;
}

// One story's memory: {key, label, macro, status, since, lastSeen, anchors,
// aliases, summary, summaryAsOf, recentFramings, leaders}, or null.
//   recentFramings — framings from the last three posting days, oldest
//                    first, deduplicated (first occurrence wins)
//   leaders        — handles by posts across the whole ledger, ties by handle
export function storyContext(storyKey, { dossiers } = {}) {
  const d = memoryDossiers({ dossiers }).get(storyKey);
  if (!d) return null;
  const posting = (d.entries || []).filter((e) => e.posts > 0).slice().sort((a, b) => cmpStr(a.date, b.date));
  const recentFramings = [];
  for (const e of posting.slice(-RECENT_DAYS)) for (const f of e.framing || []) if (!recentFramings.includes(f)) recentFramings.push(f);
  const posts = new Map();
  for (const e of d.entries || []) for (const l of e.leaders || []) posts.set(l.handle, (posts.get(l.handle) || 0) + (l.posts || 0));
  const leaders = [...posts.entries()].sort((a, b) => b[1] - a[1] || cmpStr(a[0].toLowerCase(), b[0].toLowerCase()))
    .slice(0, LEADERS).map(([handle, n]) => ({ handle, posts: n }));
  return {
    key: d.key,
    label: d.label,
    macro: d.macro || null,
    status: d.status,
    since: d.since || d.firstSeen || null,
    lastSeen: d.lastSeen || null,
    anchors: d.anchors || [],
    aliases: d.aliases || [],
    summary: d.summary?.text || null,
    summaryAsOf: d.summary?.asOf || null,
    recentFramings,
    leaders
  };
}

export function allStoryContexts({ dossiers, statuses = null } = {}) {
  const map = memoryDossiers({ dossiers });
  return [...map.keys()].sort().map((k) => storyContext(k, { dossiers: map }))
    .filter((c) => c && (!statuses || statuses.includes(c.status)));
}

// ── nearby stories ──────────────────────────────────────────────────────

const normText = (s) => ` ${String(s || '').toLowerCase().replace(/&amp;/g, '&').replace(/[‘’]/g, "'").replace(/[^a-z0-9']+/g, ' ').trim()} `;

// Alias match: how many of the story's names (label + aliases) the text
// contains as whole phrases. Cheap, explainable, and the fallback until the
// semantic index lands.
export function aliasScore(text, ctx) {
  const hay = normText(text);
  const terms = [ctx.label, ...(ctx.aliases || [])].map((t) => normText(t).trim()).filter((t) => t.length >= 3);
  const matched = [...new Set(terms)].filter((t) => hay.includes(` ${t} `)).sort();
  return { score: matched.length, terms: matched };
}

// HOOK(night-semantic-integration): src/semantic.js exporting
//   nearestStories(text, k) → [{key, score, reason?}]
// is used when present; nothing here imports it statically.
async function semanticModule(override) {
  if (override !== undefined) return override;
  if (!fs.existsSync(p('src', 'semantic.js'))) return null;
  try { return await import('./semantic.js'); } catch { return null; }
}

// The k stories a post is most likely about: [{...storyContext, match:
// {by: 'semantic'|'alias', score, terms|reason}}]. `post` is text or a post
// id (looked up in the last `days` archive days). Empty when nothing matches.
export async function nearbyStoryContext(post, k = 2, { dossiers, loadDay: loadDayFn = loadDay, days = 3, semantic } = {}) {
  let text = String(post ?? '');
  if (/^\d{8,}$/.test(text)) {
    text = '';
    for (let d = 0; d < days && !text; d++) text = loadDayFn(daysAgoEt(d)).find((t) => t.id === post)?.text || '';
    if (!text) return [];
  }
  const map = memoryDossiers({ dossiers });
  const contexts = allStoryContexts({ dossiers: map });
  const sem = await semanticModule(semantic);
  if (sem?.nearestStories) {
    const hits = await sem.nearestStories(text, k);
    return (hits || []).map((h) => {
      const ctx = contexts.find((c) => c.key === h.key);
      return ctx && { ...ctx, match: { by: 'semantic', score: h.score ?? null, reason: h.reason || null } };
    }).filter(Boolean).slice(0, k);
  }
  return contexts.map((c) => ({ ...c, match: { by: 'alias', ...aliasScore(text, c) } }))
    .filter((c) => c.match.score > 0)
    .sort((a, b) => b.match.score - a.match.score || cmpStr(a.key, b.key))
    .slice(0, k);
}

// ── the Memory block ────────────────────────────────────────────────────

const MEMORY_RULES = 'These are judgments written from each story\'s ledger, not counts. Use them to recognise a post that belongs to a developing story and to keep one story under one name. A story marked "provisional" has no taxonomy id yet: a post about it gets [] for topics and goes in "emerging" under the story\'s label, so its days link up.';

export function renderMemory(contexts, { asOf = null, rules = MEMORY_RULES } = {}) {
  const list = (contexts || []).filter(Boolean).slice().sort((a, b) => cmpStr(a.key, b.key));
  if (!list.length) return '';
  const stamp = asOf || list.map((c) => c.lastSeen || '').sort().at(-1) || '';
  const lines = [`Memory — story dossiers (long-term${stamp ? `; as of ${stamp}` : ''}). ${rules}`];
  for (const c of list) {
    const facts = [c.key, c.status, c.since ? `since ${c.since}` : null, c.lastSeen ? `last ${c.lastSeen}` : null,
      c.leaders.length ? `leads ${c.leaders.slice(0, 3).map((l) => '@' + l.handle).join(' ')}` : null,
      c.aliases.length ? `aliases: ${c.aliases.join(', ')}` : null].filter(Boolean);
    lines.push(`- ${c.label} [${facts.join('; ')}]`);
    lines.push(`  Summary: ${c.summary || '(no summary yet — ledger only)'}`);
    if (c.recentFramings.length) lines.push(`  Framing lately: ${c.recentFramings.map((f) => JSON.stringify(f)).join(', ')}`);
  }
  return lines.join('\n');
}

// Stories the classifier should hold in mind: active and provisional ones,
// the most recently seen first (ties by key), capped, then rendered in key
// order so the block is byte-identical whatever order they were chosen in.
export function memoryForClassifier({ dossiers, limit = CLASSIFIER_STORY_LIMIT } = {}) {
  const chosen = allStoryContexts({ dossiers, statuses: ['active', 'provisional'] })
    .sort((a, b) => cmpStr(b.lastSeen || '', a.lastSeen || '') || cmpStr(a.key, b.key))
    .slice(0, limit);
  return renderMemory(chosen);
}

// The given stories (any status) — for a judging step that already knows
// which stories it is looking at. Unknown keys are skipped.
export function memoryForStories(keys, { dossiers } = {}) {
  const map = memoryDossiers({ dossiers });
  const contexts = [...new Set(keys || [])].map((k) => storyContext(k, { dossiers: map })).filter(Boolean);
  return renderMemory(contexts);
}
