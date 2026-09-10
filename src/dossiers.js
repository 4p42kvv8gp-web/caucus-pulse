// Story dossiers — the story layer's long-term memory.
//
// One file per developing story under data/dossiers/<story-key>.json: a
// header (what the story is called, where it sits, since when, its status)
// plus an APPEND-ONLY ledger of daily entries — who posted, who joined, how
// it was framed, the top posts, the press that covered it, the corrections
// editors filed and the judgments other layers made (merges, lookalikes,
// corroboration). A past day's entry is never rewritten: a run recomputes
// only its target day (the nightly's "yesterday", or --date) and appends
// days that have no entry yet. What the archive said about a day when the
// day was closed is what the dossier remembers about it.
//
// On top of the ledger sits a rolling summary written by Claude (<= 120
// words: what the story is, how it developed, who leads it, how the framing
// shifted, open questions). It is regenerated only when the entry set
// changes — cached by a content hash — so quiet stories cost nothing.
//
// Which stories get a dossier (storyRoster):
//   - taxonomy subtopics marked `story: true` (status active, or retired
//     when the subtopic carries `retired:`) — posts come from the nightly
//     assignments, live tags filling the current day;
//   - candidates promoted into the taxonomy (data/stories.json → promoted);
//   - story candidates the placement pass called a story but nobody has
//     promoted yet (status provisional) — posts come from the candidate's
//     emerging-cluster ids. Several candidates that placed to one key are
//     one story. When such a story is promoted its key survives, so the
//     dossier continues across provisional → active without a seam.
//
// The memory is fed back by src/memory.js (story summaries as a "Memory"
// block in the judging prompts) and read by report.js ("what changed since
// yesterday") and docs/dossiers/*.md (the same ledger, human-readable).
//
//   node --use-env-proxy src/dossiers.js                 # target = yesterday ET
//   node --use-env-proxy src/dossiers.js --date=2026-09-09
//   node --use-env-proxy src/dossiers.js --no-llm        # ledger only, keep old summaries
//   node --use-env-proxy src/dossiers.js --max-calls=40  # summary call cap (default 40)
//   node --use-env-proxy src/dossiers.js --key=<story> --resummarize   # rewrite one summary on demand
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { p, settings, readJSON, writeJSON, daysAgoEt, etDate } from './util.js';
import { loadDay, topicsPath, metricsPath } from './store.js';
import { loadAuthors, splitByRoster } from './authors.js';
import { loadTaxonomy, parseJsonLoose } from './taxonomy.js';
import { minePhrases } from './syntax.js';
import { anthropicClient, anthropicConfigured } from './anthropic-auth.js';

export const dossiersDir = p('data', 'dossiers');
export const dossierPath = (key) => p('data', 'dossiers', `${key}.json`);
export const dossierDocsDir = p('docs', 'dossiers');
export const dossierDocPath = (key) => p('docs', 'dossiers', `${key}.md`);
// Same file classify-live.js writes; spelled out here so memory.js →
// dossiers.js never has to import the classifier to find a path.
const liveTopicsPath = (date) => p('data', 'topics-live', `${date}.json`);

export const SUMMARY_MAX_WORDS = 120;   // hard cap on what is stored
export const SUMMARY_ASK_WORDS = 100;   // what the model is asked for, so the cap rarely bites
export const SUMMARY_VERSION = 2;       // bump when the summary prompt changes: every summary regenerates once
export const DEFAULT_MAX_CALLS = 40;
const QUOTE_MAX = 120;
const TOP_POSTS = 3;
const LEADERS = 5;
const FRAMING_N = 2;

const CAUCUS_KEYS = [...new Set(Object.values(settings.caucus_keys || {}))]; // display order: CPC, NewDem, CBC, …
const isoDay = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? null : String(v).slice(0, 10));
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cmpId = (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

export function engagementOf(m) {
  if (!m || m.unavailable) return 0;
  return (m.likes || 0) + (m.retweets || 0) + (m.replies || 0) + (m.quotes || 0);
}

// A post quote for the ledger: whitespace collapsed, cut at a word boundary.
export function quoteOf(text, max = QUOTE_MAX) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
}

export function sha1(value) {
  return crypto.createHash('sha1').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

// ── Roster: which stories get a dossier ─────────────────────────────────

// tax: config/taxonomy.yaml as loaded; stories: data/stories.json (or null).
// → [{key, label, macro, sub, since, aliases, anchors, status, source,
//     candidateKeys}] sorted by key. `sub` is set for stories that live in
// the taxonomy (their posts come from assignments); `candidateKeys` names
// the stories.json candidates whose ids also count.
export function storyRoster(tax, stories) {
  const roster = new Map();
  const taken = new Set();
  for (const macro of Object.keys(tax || {}).sort()) {
    for (const sub of Object.keys(tax[macro].subtopics || {}).sort()) {
      const s = tax[macro].subtopics[sub];
      if (!s?.story) continue;
      // Story keys are the subtopic slug; two macros sharing one slug is
      // rare enough that the second gets a qualified key.
      const key = taken.has(sub) ? `${macro}--${sub}` : sub;
      taken.add(key);
      // HOOK(night-story-promotion): retirement lands here — a `retired:
      // YYYY-MM-DD` (or `status: retired`) on the subtopic keeps the
      // dossier and marks it retired; nothing is ever deleted.
      const retired = s.retired || s.status === 'retired';
      roster.set(key, {
        key, label: String(s.label), macro, sub,
        since: isoDay(s.since) || null,
        aliases: (s.aliases || []).map(String),
        anchors: (s.anchors || []).map(String), // HOOK(night-quoted-context): `anchors:` — post ids that define the story
        status: retired ? 'retired' : 'active',
        retired: retired ? isoDay(s.retired) || true : null,
        source: 'taxonomy',
        candidateKeys: []
      });
    }
  }
  const promoted = new Set(stories?.promoted || []);
  const cands = (stories?.candidates || []).filter((c) => c.placement?.kind === 'story' && c.placement.key);
  for (const c of cands.sort((a, b) => cmpStr(a.key, b.key))) {
    const pl = c.placement;
    const qualified = `${pl.macro}/${pl.key}`;
    const existing = roster.get(pl.key) || (pl.macro && roster.get(`${pl.macro}--${pl.key}`));
    if (existing) {
      existing.candidateKeys.push(c.key);
      continue;
    }
    roster.set(pl.key, {
      key: pl.key, label: String(pl.label || c.label), macro: pl.macro || null, sub: null,
      since: c.firstSeen || null,
      aliases: (pl.aliases || []).map(String),
      anchors: [],
      status: promoted.has(qualified) ? 'active' : 'provisional',
      retired: null,
      source: promoted.has(qualified) ? 'promoted' : 'candidate',
      candidateKeys: [c.key]
    });
  }
  // A candidate's `since` is the earliest first-seen across the candidates
  // that placed to it; a taxonomy story keeps its declared `since`.
  for (const r of roster.values()) {
    if (r.source === 'taxonomy' && r.since) continue;
    const firsts = r.candidateKeys.map((k) => cands.find((c) => c.key === k)?.firstSeen).filter(Boolean).sort();
    if (firsts[0] && (!r.since || firsts[0] < r.since)) r.since = firsts[0];
  }
  return [...roster.values()].sort((a, b) => cmpStr(a.key, b.key));
}

// Does an assignment list carry this story? ([macro, sub] pair)
export function assignedTo(topics, story) {
  if (!story.sub || !Array.isArray(topics)) return false;
  return topics.some((t) => Array.isArray(t) && t[0] === story.macro && t[1] === story.sub);
}

// ── One day's entry ─────────────────────────────────────────────────────

// Framing for the day, strongest source first:
//   why-it-moved  — the reason Claude wrote for the day's movers (why.js)
//   families      — message families (paraphrases grouped by meaning)
//   phrases       — top shared 2-4-grams among the day's original posts
// HOOK(night-why-it-moved): `why` is data/why/<date>.json → {stories|topics:
//   {<key>: {reason, framing?: [..]}}} — any string in framing/reason counts.
// HOOK(night-message-families): `families` is data/families/<date>.json →
//   {families: [{name|label, members|handles: [...], ids: [...], stories?: [..]}]}.
export function framingFor(story, posts, { why = null, families = null } = {}) {
  const fromWhy = why?.stories?.[story.key] || why?.topics?.[`${story.macro}/${story.sub}`] || why?.topics?.[story.key] || null;
  if (fromWhy) {
    const items = [...(Array.isArray(fromWhy.framing) ? fromWhy.framing : []), fromWhy.reason].filter(Boolean).map(String);
    if (items.length) return { framing: items.slice(0, FRAMING_N), source: 'why-it-moved' };
  }
  const ids = new Set(posts.map((t) => t.id));
  const fams = (families?.families || []).filter((f) => (f.stories || []).includes(story.key) || (f.ids || []).some((id) => ids.has(id)));
  if (fams.length) {
    const ranked = fams.map((f) => ({ name: String(f.name || f.label || ''), n: (f.ids || []).filter((id) => ids.has(id)).length }))
      .filter((f) => f.name).sort((a, b) => b.n - a.n || cmpStr(a.name, b.name));
    if (ranked.length) return { framing: ranked.slice(0, FRAMING_N).map((f) => f.name), source: 'message-families' };
  }
  const originals = posts.filter((t) => t.type !== 'retweet');
  const phrases = minePhrases(originals, { minMembers: 2, minNgram: 2, maxNgram: 4 })
    .sort((a, b) => b.members - a.members || b.tweets - a.tweets || cmpStr(a.phrase, b.phrase));
  if (phrases.length) return { framing: phrases.slice(0, FRAMING_N).map((x) => x.phrase), source: 'phrases' };
  return { framing: [], source: 'none' };
}

// The day's entry. Pure: everything it reads arrives as arguments, in a
// fixed key order so the file is byte-stable across runs.
//   posts        — the story's posts that day (House roster, originals + retweets)
//   seenMembers  — handles that appeared on this story on earlier entries
//   press/corrections/judgments — already filtered to this day (see buildDossier)
export function computeEntry(story, date, {
  posts = [], authorsById = {}, metrics = {}, seenMembers = new Set(),
  why = null, families = null, press = [], corrections = [], judgments = []
} = {}) {
  const originals = posts.filter((t) => t.type !== 'retweet').sort((a, b) => cmpId(a.id, b.id));
  const retweets = posts.filter((t) => t.type === 'retweet');
  const handleOf = (t) => authorsById[t.authorId]?.handle || t.authorId;
  const byMember = new Map();
  for (const t of originals) byMember.set(handleOf(t), (byMember.get(handleOf(t)) || 0) + 1);
  const members = [...byMember.keys()].sort((a, b) => cmpStr(a.toLowerCase(), b.toLowerCase()));

  const byCaucus = {};
  for (const k of CAUCUS_KEYS) byCaucus[k] = 0;
  const seenCaucus = new Map();
  for (const t of originals) {
    const h = handleOf(t);
    if (seenCaucus.has(h)) continue;
    seenCaucus.set(h, true);
    for (const tag of authorsById[t.authorId]?.caucuses || []) {
      const k = settings.caucus_keys?.[tag];
      if (k && k in byCaucus) byCaucus[k]++;
    }
  }

  const eng = (t) => engagementOf(metrics[t.id]) || engagementOf(t.metricsAtCapture);
  const topPosts = originals.slice().sort((a, b) => eng(b) - eng(a) || cmpId(a.id, b.id)).slice(0, TOP_POSTS)
    .map((t) => ({ id: t.id, handle: handleOf(t), eng: eng(t), quote: quoteOf(t.text) }));
  const leaders = [...byMember.entries()].sort((a, b) => b[1] - a[1] || cmpStr(a[0].toLowerCase(), b[0].toLowerCase()))
    .slice(0, LEADERS).map(([handle, n]) => ({ handle, posts: n }));
  const { framing, source } = framingFor(story, posts, { why, families });

  return {
    date,
    posts: originals.length,
    retweets: retweets.length,
    members: members.length,
    byCaucus,
    newMembers: members.filter((h) => !seenMembers.has(h)),
    leaders,
    framing,
    framingSource: source,
    topPosts,
    ids: originals.map((t) => t.id),
    press: press.slice().sort((a, b) => cmpStr(a.date, b.date) || cmpStr(a.outlet, b.outlet) || cmpStr(a.subject, b.subject)),
    corrections: corrections.slice().sort((a, b) => cmpStr(a.on, b.on) || cmpId(a.id, b.id)),
    judgments: judgments.slice().sort((a, b) => cmpStr(a.kind, b.kind) || cmpStr(String(a.id), String(b.id)) || cmpStr(a.reason, b.reason))
  };
}

const isEmptyEntry = (e) => !e.posts && !e.retweets && !e.press.length && !e.corrections.length && !e.judgments.length;
const sigPress = (x) => `${x.date}|${x.outlet}|${x.subject}`;
const sigCorrection = (x) => `${x.id}|${x.on}|${x.kind}`;
const sigJudgment = (x) => `${x.kind}|${x.id}|${x.reason}`;

// ── The dossier ─────────────────────────────────────────────────────────

// Build (or extend) one dossier. Pure over its inputs:
//   existing   — the dossier on disk, or null
//   targetDate — the day being (re)computed; entries dated before it are
//                frozen and copied through untouched
//   dates      — candidate days, ascending (the archive days in the window)
//   dayData(date) → {posts, metrics, why, families}: the story's posts that day
//   press      — [{outlet, subject, date}] for the story, any day
//   corrections— [{id, on, kind, note}] for the story, any day
//   judgments  — [{kind, id, reason}] for the story (undated)
// Dated items (press, corrections) land on the first computed day on or
// after their own date that is not frozen; undated judgments land on the
// target day. Anything a frozen entry already records is never repeated.
export function buildDossier(story, existing, { targetDate, dates, dayData, authorsById = {}, press = [], corrections = [], judgments = [] }) {
  const frozen = (existing?.entries || []).filter((e) => e.date !== targetDate);
  const byDate = new Map(frozen.map((e) => [e.date, e]));
  const seenMembers = new Set();
  const recorded = { press: new Set(), corrections: new Set(), judgments: new Set() };
  const absorb = (e) => {
    for (const h of e.newMembers || []) seenMembers.add(h);
    for (const x of e.press || []) recorded.press.add(sigPress(x));
    for (const x of e.corrections || []) recorded.corrections.add(sigCorrection(x));
    for (const x of e.judgments || []) recorded.judgments.add(sigJudgment(x));
  };
  // Frozen entries are absorbed in date order before anything is computed:
  // a member first seen on a frozen day is never "new" again, and items a
  // frozen entry already records are never repeated.
  for (const e of frozen.slice().sort((a, b) => cmpStr(a.date, b.date))) absorb(e);

  const entries = [];
  const since = story.since || existing?.since || null;
  const window = dates.filter((d) => d <= targetDate && (!since || d >= since));
  for (const date of window) {
    if (byDate.has(date)) { entries.push(byDate.get(date)); continue; }
    const isTarget = date === targetDate;
    const pending = {
      press: press.filter((x) => (x.date || '').slice(0, 10) <= date && !recorded.press.has(sigPress(x))),
      corrections: corrections.filter((x) => x.on <= date && !recorded.corrections.has(sigCorrection(x))),
      judgments: isTarget ? judgments.filter((x) => !recorded.judgments.has(sigJudgment(x))) : []
    };
    const data = dayData(date) || {};
    const entry = computeEntry(story, date, {
      posts: data.posts || [], metrics: data.metrics || {}, why: data.why || null, families: data.families || null,
      authorsById, seenMembers, ...pending
    });
    if (isEmptyEntry(entry)) continue;
    absorb(entry);
    entries.push(entry);
  }
  // Entries after the target (a --date re-run behind an existing ledger) stay.
  for (const e of frozen) if (e.date > targetDate) entries.push(e);
  entries.sort((a, b) => cmpStr(a.date, b.date));

  // "Seen" = a House member posted or amplified; press-only days don't count.
  const active = entries.filter((e) => e.posts > 0 || e.retweets > 0);
  const firstSeen = active[0]?.date || existing?.firstSeen || null;
  const lastSeen = active.at(-1)?.date || existing?.lastSeen || null;
  // Anchors: the taxonomy's, else the ones already on file, else the most
  // engaged post the ledger has seen (fixed once chosen, so the story keeps
  // its defining post even when a later day is louder).
  let anchors = story.anchors?.length ? story.anchors : existing?.anchors || [];
  if (!anchors.length) {
    const best = entries.flatMap((e) => e.topPosts).sort((a, b) => b.eng - a.eng || cmpId(a.id, b.id))[0];
    if (best) anchors = [best.id];
  }

  const dossier = {
    key: story.key,
    label: story.label,
    macro: story.macro,
    sub: story.sub || null,
    since,
    anchors,
    aliases: story.aliases || [],
    status: story.status,
    source: story.source,
    candidateKeys: story.candidateKeys || [],
    firstSeen,
    lastSeen,
    entries,
    summary: existing?.summary || null
  };
  dossier.hash = entriesHash(dossier);
  return dossier;
}

// What the summary is keyed by: the header facts and the entry ledger — not
// the summary itself, not timestamps.
export function entriesHash(dossier) {
  return sha1({ label: dossier.label, status: dossier.status, since: dossier.since, entries: dossier.entries });
}

export function loadDossiers(dir = dossiersDir) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const d = readJSON(path.join(dir, f), null);
    if (d?.key) out.set(d.key, d);
  }
  return out;
}

// ── Sources: press, corrections, judgments ──────────────────────────────

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Newsletter hits for a story: data/context.json entries keyed by candidate
// key, placement key or label (docs/OUTSIDE_CONTEXT.md), plus anything under
// data/narratives/<story-key>/ that looks like {items|matches: [{outlet|sender,
// subject|title, date}]}.
// HOOK(night-outside-context): the narratives layer writes its judged
// article/X-search matches there; the tolerant reader below picks them up.
export function pressFor(story, context, narrativesDir = p('data', 'narratives')) {
  const want = new Set([story.key, story.label, ...(story.candidateKeys || [])].map(norm).filter(Boolean));
  const out = [];
  for (const [k, e] of Object.entries(context?.stories || {})) {
    if (!(want.has(norm(k)) || want.has(norm(e?.key)) || want.has(norm(e?.label)))) continue;
    for (const m of e.matches || []) out.push({ outlet: String(m.sender || m.from || ''), subject: String(m.subject || ''), date: String(m.date || '').slice(0, 10) });
  }
  const dir = path.join(narrativesDir, story.key);
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      const doc = readJSON(path.join(dir, f), null);
      for (const m of doc?.items || doc?.matches || []) {
        if (!(m?.subject || m?.title)) continue;
        out.push({ outlet: String(m.outlet || m.sender || m.source || ''), subject: String(m.subject || m.title), date: String(m.date || m.publishedAt || '').slice(0, 10) });
      }
    }
  }
  const seen = new Set();
  return out.filter((x) => x.date && x.subject && !seen.has(sigPress(x)) && seen.add(sigPress(x)));
}

// Corrections that touched the story: a corrected post now assigned to it
// ("onto"), or a post the story had counted that a correction moved away
// ("off"). Reads the `corrected` map corrections.js writes into
// data/topics/<date>.json.
export function correctionsFor(story, topicsByDate, knownIds) {
  const out = [];
  for (const date of Object.keys(topicsByDate).sort()) {
    const file = topicsByDate[date];
    for (const [id, rec] of Object.entries(file?.corrected || {})) {
      const on = String(rec.on || date).slice(0, 10);
      const onto = assignedTo(file.assignments?.[id], story);
      const kind = onto ? 'onto' : knownIds.has(id) ? 'off' : null;
      if (!kind) continue;
      out.push({ id, on, kind, note: rec.note ? quoteOf(rec.note, 140) : '' });
    }
  }
  return out;
}

// Judgments other layers recorded about the story. Every reader is
// tolerant: a missing cache contributes nothing.
export function judgmentsFor(story, { stories = null, lookalikes = null, incidents = null } = {}) {
  const out = [];
  const mine = new Set([story.key, ...(story.candidateKeys || [])]);
  // stories.json: merges applied with evidence, and duplicate groups the
  // confirmation pass endorsed.
  for (const c of stories?.candidates || []) {
    if (!mine.has(c.key)) continue;
    for (const m of c.mergedFrom || []) out.push({ kind: 'merge', id: m.key, reason: `${m.by || 'merge'}: ${m.reason || ''}`.trim() });
  }
  for (const g of stories?.confirmation?.groups || []) {
    if (!(g.keys || []).some((k) => mine.has(k))) continue;
    const others = (g.keys || []).filter((k) => !mine.has(k)).sort();
    if (others.length) out.push({ kind: 'merge', id: others.join('+'), reason: `confirmed: ${g.reason || ''}`.trim() });
  }
  // HOOK(night-semantic-integration): data/lookalikes.json — posts the
  // semantic index put next to a story that the classifier left unlabeled,
  // each judged by Claude with a reason. Accepted shapes:
  //   {stories: {<key>: [{id, reason}]}}  or  [{story, id, reason}]
  const la = Array.isArray(lookalikes) ? lookalikes.filter((x) => mine.has(x.story)) : (lookalikes?.stories?.[story.key] || []);
  for (const x of la) if (x?.id) out.push({ kind: 'lookalike', id: String(x.id), reason: String(x.reason || '') });
  // HOOK(night-incident-corroboration): data/incidents.json merge log —
  //   {merges: [{story?, from, into, reason}]} and per-incident
  //   {corroboration: [{id, reason, story?}]}; entries naming this story
  //   (or an incident tagged with it) become "corroboration" judgments.
  for (const m of incidents?.merges || []) {
    if (m.story && !mine.has(m.story)) continue;
    if (!m.story) continue;
    out.push({ kind: 'corroboration', id: `${m.from}→${m.into}`, reason: String(m.reason || '') });
  }
  for (const inc of incidents?.incidents || []) {
    for (const c of inc.corroboration || []) {
      if (!mine.has(c.story || inc.story)) continue;
      out.push({ kind: 'corroboration', id: String(c.id || inc.id), reason: String(c.reason || '') });
    }
  }
  const seen = new Set();
  return out.filter((x) => !seen.has(sigJudgment(x)) && seen.add(sigJudgment(x)));
}

// ── Rolling summary (Claude) ────────────────────────────────────────────

export function trimWords(text, max = SUMMARY_MAX_WORDS) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  return words.length <= max ? words.join(' ') : words.slice(0, max).join(' ').replace(/[,;:]$/, '') + '…';
}

export function summaryInput(dossier) {
  const lines = dossier.entries.map((e) => {
    const parts = [`${e.date}: ${e.posts} posts by ${e.members} members${e.retweets ? ` + ${e.retweets} retweets by members` : ''}`];
    if (e.newMembers.length) parts.push(`new: ${e.newMembers.map((h) => '@' + h).join(' ')}`);
    if (e.leaders.length) parts.push(`most active: ${e.leaders.slice(0, 3).map((l) => `@${l.handle}(${l.posts})`).join(' ')}`);
    if (e.framing.length) parts.push(`framing (${e.framingSource}): ${e.framing.map((f) => JSON.stringify(f)).join(', ')}`);
    if (e.topPosts[0]) parts.push(`top post @${e.topPosts[0].handle}: ${JSON.stringify(e.topPosts[0].quote)}`);
    if (e.press.length) parts.push(`press: ${e.press.map((x) => `${x.outlet} — ${x.subject}`).join('; ')}`);
    if (e.corrections.length) parts.push(`corrections: ${e.corrections.map((c) => `${c.kind} ${c.id}${c.note ? ` (${c.note})` : ''}`).join('; ')}`);
    if (e.judgments.length) parts.push(`judgments: ${e.judgments.map((j) => `${j.kind} ${j.id}: ${j.reason}`).join('; ')}`);
    return '- ' + parts.join(' | ');
  });
  return [
    `Story: ${dossier.label} (key ${dossier.key}; macro ${dossier.macro || 'none'}; status ${dossier.status}; since ${dossier.since || 'unknown'}; seen ${dossier.firstSeen} → ${dossier.lastSeen})`,
    dossier.aliases.length ? `Aliases: ${dossier.aliases.join(', ')}` : null,
    dossier.anchors.length ? `Anchor post ids: ${dossier.anchors.join(', ')}` : null,
    dossier.summary?.text ? `Previous summary (as of ${dossier.summary.asOf}): ${dossier.summary.text}` : null,
    '',
    'Daily entries (measured numbers; "posts" are originals, "retweets" amplification by members; framing = shared phrases unless a reason is named):',
    ...lines
  ].filter((x) => x != null).join('\n');
}

export const SUMMARY_SYSTEM = `You keep the running dossier on one developing story that US House Democrats are posting about on X. From the daily entries, write the rolling summary for the Leader's communications staff: about ${SUMMARY_ASK_WORDS} words of plain prose (never more than ${SUMMARY_MAX_WORDS}: anything past that is cut off), no bullets, no headings, no preamble. Cover, in this order and briefly: what the story is; how it developed day to day; who leads it (name handles); how the framing shifted; then finish with the open questions — end on a complete sentence. State only what the entries support; when the evidence is thin (one member, one day, retweets only) say so plainly. The numbers are measured; everything else is your judgment — write it as one, and never invent an event the entries do not show.`;

export async function summarizeDossier(dossier, { client, model, asOf } = {}) {
  client ||= await anthropicClient();
  model ||= process.env.DOSSIER_MODEL || process.env.CLASSIFY_MODEL || settings.classify.model;
  const res = await client.messages.create({
    model,
    max_tokens: 1200,
    system: SUMMARY_SYSTEM,
    messages: [{ role: 'user', content: summaryInput(dossier) }]
  });
  if (res.stop_reason === 'refusal') return null;
  const text = res.content.find((b) => b.type === 'text')?.text?.trim();
  if (!text) return null;
  if (res.stop_reason === 'max_tokens') console.warn(`[dossiers] summary for ${dossier.key} hit max_tokens — stored as returned`);
  return { text: trimWords(text), asOf: asOf || dossier.lastSeen || etDate(), model, hash: dossier.hash, prompt: SUMMARY_VERSION };
}

// Is the summary on file written from this ledger, by this prompt?
export function summaryCurrent(dossier) {
  return Boolean(dossier.summary) && dossier.summary.hash === dossier.hash && dossier.summary.prompt === SUMMARY_VERSION;
}

// Regenerate the summary only when the ledger (or the prompt) changed since
// it was written — or on demand (`force`, the --resummarize flag) when a
// stored summary reads badly. `budget` is shared across a run: {calls, max}.
export async function refreshSummary(dossier, { client, model, asOf, force = false, budget = { calls: 0, max: DEFAULT_MAX_CALLS } } = {}) {
  if (!force && summaryCurrent(dossier)) return { dossier, regenerated: false, reason: 'unchanged' };
  if (budget.calls >= budget.max) return { dossier, regenerated: false, reason: 'call cap' };
  budget.calls++;
  const summary = await summarizeDossier(dossier, { client, model, asOf });
  if (!summary) return { dossier, regenerated: false, reason: 'no reply' };
  return { dossier: { ...dossier, summary }, regenerated: true, reason: 'entries changed' };
}

// ── Diffs for the report ────────────────────────────────────────────────

// What changed on `date` versus the story's previous entry: [{key, label,
// status, entry, prev, newMembers, framingShift, press}] for stories with
// an entry that day (most posts first), plus `quiet`: stories that posted
// the day before and not on `date`.
export function diffDossiers(dossiers, date) {
  const list = dossiers instanceof Map ? [...dossiers.values()] : dossiers || [];
  const changed = [];
  const quiet = [];
  for (const d of list.slice().sort((a, b) => cmpStr(a.key, b.key))) {
    const idx = d.entries.findIndex((e) => e.date === date);
    if (idx < 0) {
      const last = d.entries.filter((e) => e.date < date && e.posts > 0).at(-1);
      if (last && daysBetween(last.date, date) === 1) quiet.push({ key: d.key, label: d.label, status: d.status, last });
      continue;
    }
    const entry = d.entries[idx];
    const prev = d.entries.slice(0, idx).filter((e) => e.posts > 0).at(-1) || null;
    const framingShift = Boolean(prev && entry.framing.length && prev.framing.join('|') !== entry.framing.join('|'));
    changed.push({
      key: d.key, label: d.label, status: d.status, entry, prev,
      newMembers: entry.newMembers, framingShift, press: entry.press,
      summary: d.summary?.text || null
    });
  }
  changed.sort((a, b) => b.entry.posts - a.entry.posts || cmpStr(a.key, b.key));
  return { changed, quiet };
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

// ── Markdown ────────────────────────────────────────────────────────────

const md = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderDossierMarkdown(d) {
  const lines = [`# ${d.label}`, ''];
  lines.push(`- Key: \`${d.key}\` · macro: ${d.macro ? `\`${d.macro}\`` : '_none yet_'}${d.sub ? ` · taxonomy id \`${d.macro}/${d.sub}\`` : ''}`);
  lines.push(`- Status: **${d.status}** (${d.source}) · since ${d.since || '?'} · seen ${d.firstSeen || '?'} → ${d.lastSeen || '?'}`);
  if (d.aliases.length) lines.push(`- Aliases: ${d.aliases.join(', ')}`);
  if (d.anchors.length) lines.push(`- Anchor post${d.anchors.length > 1 ? 's' : ''}: ${d.anchors.map((id) => `\`${id}\``).join(', ')}`);
  if (d.candidateKeys.length) lines.push(`- Story candidates folded in: ${d.candidateKeys.map((k) => `\`${k}\``).join(', ')}`);
  lines.push('', '## Summary', '');
  if (d.summary?.text) {
    lines.push(d.summary.text, '', `_Judgment by ${d.summary.model || 'Claude'}, as of ${d.summary.asOf}; regenerated only when the ledger below changes._`);
  } else lines.push('_No summary yet (the ledger is written before the model runs, or the run had no credential)._');
  lines.push('', '## Timeline', '', 'Measured per day; a past day is never rewritten. "New" = first day on this story.', '');
  lines.push('| Date | Posts | RTs | Members | New members | Framing | Top post |', '|---|---:|---:|---:|---|---|---|');
  for (const e of d.entries) {
    const top = e.topPosts[0] ? `@${e.topPosts[0].handle}: "${md(e.topPosts[0].quote)}"` : '';
    const framing = e.framing.length ? `${e.framing.map((f) => `"${md(f)}"`).join(', ')} _(${e.framingSource})_` : '';
    lines.push(`| ${e.date} | ${e.posts} | ${e.retweets} | ${e.members} | ${e.newMembers.map((h) => '@' + h).join(' ')} | ${framing} | ${top} |`);
  }
  const press = d.entries.flatMap((e) => e.press.map((x) => ({ ...x, day: e.date })));
  const corrections = d.entries.flatMap((e) => e.corrections.map((x) => ({ ...x, day: e.date })));
  const judgments = d.entries.flatMap((e) => e.judgments.map((x) => ({ ...x, day: e.date })));
  if (press.length) {
    lines.push('', '## Press (newsletter hits — context, not verification)', '');
    for (const x of press) lines.push(`- ${x.date} · ${md(x.outlet)} — ${md(x.subject)}`);
  }
  if (corrections.length) {
    lines.push('', '## Corrections (editors)', '');
    for (const x of corrections) lines.push(`- ${x.on} · ${x.kind} · \`${x.id}\`${x.note ? ` — ${md(x.note)}` : ''}`);
  }
  if (judgments.length) {
    lines.push('', '## Judgments (from other layers)', '');
    for (const x of judgments) lines.push(`- ${x.day} · ${x.kind} · \`${md(x.id)}\` — ${md(x.reason)}`);
  }
  lines.push('', `_Ledger hash \`${d.hash.slice(0, 12)}\`; source data/dossiers/${d.key}.json. See docs/MEMORY.md._`);
  return lines.join('\n') + '\n';
}

export function renderDossierIndex(dossiers) {
  const list = [...(dossiers instanceof Map ? dossiers.values() : dossiers)].sort((a, b) => cmpStr(b.lastSeen || '', a.lastSeen || '') || cmpStr(a.key, b.key));
  const lines = ['# Story dossiers', '', 'One page per developing story: header, rolling summary (Claude), append-only daily ledger. Regenerated nightly from `data/dossiers/*.json`; see `docs/MEMORY.md` for what persists where.', ''];
  lines.push('| Story | Status | Macro | Since | Last seen | Days | Posts | RTs | Members ever |', '|---|---|---|---|---|---:|---:|---:|---:|');
  for (const d of list) {
    const posts = d.entries.reduce((a, e) => a + e.posts, 0);
    const retweets = d.entries.reduce((a, e) => a + (e.retweets || 0), 0);
    const members = new Set(d.entries.flatMap((e) => e.newMembers)).size;
    lines.push(`| [${md(d.label)}](${d.key}.md) | ${d.status} | ${d.macro || '—'} | ${d.since || '?'} | ${d.lastSeen || '?'} | ${d.entries.filter((e) => e.posts > 0 || e.retweets > 0).length} | ${posts} | ${retweets} | ${members} |`);
  }
  return lines.join('\n') + '\n';
}

// ── Nightly entry point ─────────────────────────────────────────────────

function archiveDates() {
  const dir = p('data', 'archive');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6)).sort();
}

// Everything a day contributes, loaded once and shared by every story.
function dayLoader(authorsById) {
  const cache = new Map();
  return (date) => {
    if (cache.has(date)) return cache.get(date);
    const nightly = readJSON(topicsPath(date), null);
    const live = readJSON(liveTopicsPath(date), null);
    const day = {
      posts: splitByRoster(loadDay(date), authorsById).house,
      assignments: { ...(live?.assignments || {}), ...(nightly?.assignments || {}) },
      topics: nightly,
      metrics: readJSON(metricsPath(date), {}),
      why: readJSON(p('data', 'why', `${date}.json`), null),          // HOOK(night-why-it-moved)
      families: readJSON(p('data', 'families', `${date}.json`), null) // HOOK(night-message-families)
    };
    cache.set(date, day);
    return day;
  };
}

export async function buildAllDossiers({ targetDate = daysAgoEt(1), llm = anthropicConfigured(), maxCalls = DEFAULT_MAX_CALLS, only = null, resummarize = false, log = console.log } = {}) {
  const tax = loadTaxonomy();
  const stories = readJSON(p('data', 'stories.json'), null);
  const context = readJSON(p('data', 'context.json'), null);
  const lookalikes = readJSON(p('data', 'lookalikes.json'), null);
  const incidents = readJSON(p('data', 'incidents.json'), null);
  const authorsById = loadAuthors().byId;
  const existing = loadDossiers();
  const dates = archiveDates().filter((d) => d <= targetDate);
  const loadDate = dayLoader(authorsById);
  const candidateIds = new Map((stories?.candidates || []).map((c) => [c.key, new Set(c.ids || [])]));

  const roster = storyRoster(tax, stories).filter((s) => !only || s.key === only);
  const budget = { calls: 0, max: maxCalls };
  const client = llm && roster.length ? await anthropicClient() : null;
  const results = [];
  fs.mkdirSync(dossiersDir, { recursive: true });
  fs.mkdirSync(dossierDocsDir, { recursive: true });

  for (const story of roster) {
    const ids = new Set(story.candidateKeys.flatMap((k) => [...(candidateIds.get(k) || [])]));
    const prev = existing.get(story.key) || null;
    const knownIds = new Set([...ids, ...(prev?.entries || []).flatMap((e) => e.ids || [])]);
    const topicsByDate = Object.fromEntries(dates.map((d) => [d, loadDate(d).topics]).filter(([, t]) => t));
    const dayData = (date) => {
      const day = loadDate(date);
      const posts = day.posts.filter((t) => ids.has(t.id) || assignedTo(day.assignments[t.id], story)
        || (t.type === 'retweet' && t.refId && (ids.has(t.refId) || assignedTo(day.assignments[t.refId], story))));
      return { posts, metrics: day.metrics, why: day.why, families: day.families };
    };
    let dossier = buildDossier(story, prev, {
      targetDate, dates, dayData, authorsById,
      press: pressFor(story, context),
      corrections: correctionsFor(story, topicsByDate, knownIds),
      judgments: judgmentsFor(story, { stories, lookalikes, incidents })
    });
    // A story with nothing on the House roster (its posts came from senators
    // or accounts off the roster) gets no dossier until a House member posts.
    if (!dossier.entries.length && !prev) {
      log(`  ${story.key.padEnd(28)} ${story.status.padEnd(11)} skipped: no House posts in the window`);
      continue;
    }
    let summaryNote = 'kept';
    if (client) {
      try {
        const r = await refreshSummary(dossier, { client, asOf: targetDate, budget, force: resummarize });
        dossier = r.dossier;
        summaryNote = r.regenerated ? 'regenerated' : r.reason;
      } catch (e) {
        summaryNote = `failed (${e.message})`;
        console.warn(`[dossiers] summary failed for ${story.key}: ${e.message}`);
      }
    } else if (!dossier.summary) summaryNote = 'no model';
    // updatedAt moves only when the ledger or the summary did, so an
    // unchanged story leaves an unchanged file (and a quiet git diff).
    const changed = !prev || prev.hash !== dossier.hash || prev.summary?.hash !== dossier.summary?.hash || prev.summary?.prompt !== dossier.summary?.prompt || prev.summary?.text !== dossier.summary?.text;
    dossier.updatedAt = changed ? new Date().toISOString() : prev.updatedAt || null;
    if (changed || !fs.existsSync(dossierPath(story.key))) writeJSON(dossierPath(story.key), dossier);
    fs.writeFileSync(dossierDocPath(story.key), renderDossierMarkdown(dossier));
    results.push({ dossier, changed, summaryNote });
    const today = dossier.entries.find((e) => e.date === targetDate);
    log(`  ${dossier.key.padEnd(28)} ${dossier.status.padEnd(11)} ${String(dossier.entries.length).padStart(3)} day(s)  ${today ? `${targetDate}: ${today.posts} posts, ${today.members} members, ${today.newMembers.length} new` : `${targetDate}: quiet`}  summary ${summaryNote}`);
  }
  const all = new Map(results.map((r) => [r.dossier.key, r.dossier]));
  for (const [k, d] of existing) if (!all.has(k)) all.set(k, d); // dossiers whose story left the roster keep their page
  fs.writeFileSync(path.join(dossierDocsDir, 'README.md'), renderDossierIndex(all));
  return { results, budget, targetDate };
}

async function main() {
  const dateArg = process.argv.find((a) => a.startsWith('--date='));
  const targetDate = dateArg ? dateArg.split('=')[1] : daysAgoEt(1);
  const capArg = process.argv.find((a) => a.startsWith('--max-calls='));
  const onlyArg = process.argv.find((a) => a.startsWith('--key='));
  const llm = !process.argv.includes('--no-llm') && anthropicConfigured();
  const { results, budget } = await buildAllDossiers({
    targetDate, llm,
    maxCalls: capArg ? Number(capArg.split('=')[1]) : DEFAULT_MAX_CALLS,
    only: onlyArg ? onlyArg.split('=')[1] : null,
    resummarize: process.argv.includes('--resummarize') // rewrite the summary even when the ledger is unchanged (pair with --key=)
  });
  const changed = results.filter((r) => r.changed).length;
  const regenerated = results.filter((r) => r.summaryNote === 'regenerated').length;
  console.log(`[dossiers] ${targetDate}: ${results.length} dossier(s), ${changed} changed, ${regenerated} summar${regenerated === 1 ? 'y' : 'ies'} regenerated (${budget.calls}/${budget.max} calls)${llm ? '' : ' — no model, summaries kept'}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
