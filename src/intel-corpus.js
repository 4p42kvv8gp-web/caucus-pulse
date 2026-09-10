// Unified corpus for the narrative layer (docs/NARRATIVE_INTELLIGENCE.md §4, §7.2).
// Pure over files already on disk: archive rows (+ 24h metrics), List
// day-files, tonight's search samples and quotes, deduped by id with merged
// provenance, then assigned to stories by deterministic alias matching and
// mapped to a voice by the roster that resolved the author.
import { settings, etDate, readJSON } from './util.js';
import { loadDay, metricsPath } from './store.js';
import { tokenize } from './syntax.js';
import { authorInfo, readListDays, listEntries, PRESS_KEYS, DELEGATION_KEYS, GOP_KEYS, EXPERT_KEYS } from './intel-lists.js';

const DAY = 86_400_000;
export const VOICES = ['caucus', 'gop', 'press', 'delegation', 'expert', 'organic'];

export function engagementOf(m) {
  if (!m || m.unavailable) return 0;
  return (m.likes || 0) + (m.retweets || 0) + (m.replies || 0) + (m.quotes || 0);
}

function metricsFromApi(t) {
  const m = t.public_metrics || t.metrics || {};
  return {
    likes: m.like_count ?? m.likes ?? 0, retweets: m.retweet_count ?? m.retweets ?? 0,
    replies: m.reply_count ?? m.replies ?? 0, quotes: m.quote_count ?? m.quotes ?? 0,
    impressions: m.impression_count ?? m.impressions ?? 0
  };
}

// A raw API tweet or an archive/list/evidence record → the unified row shape.
export function toRow(t, source, { authorsById = {}, rosters = null, carriers = null, metrics = null } = {}) {
  const refs = t.referenced_tweets || [];
  const type = t.type || (refs.find((r) => r.type === 'retweeted') ? 'retweet' : refs.find((r) => r.type === 'quoted') ? 'quote' : refs.find((r) => r.type === 'replied_to') ? 'reply' : 'tweet');
  const refId = t.refId ?? (refs[0]?.id || null);
  const authorId = String(t.authorId || t.author_id || '');
  const info = authorInfo(authorId, { authorsById, rosters, carriers });
  const m = metrics?.[t.id] && !metrics[t.id].unavailable ? metrics[t.id] : (t.metricsAtCapture || (t.public_metrics || t.metrics ? metricsFromApi(t) : null));
  return {
    id: String(t.id),
    authorId,
    author: info ? { handle: info.handle, name: info.name, followers: info.followers, roster: info.rosters, verifiedType: info.verifiedType, status: info.status, caucuses: info.caucuses, member: info.member, source: info.source } : null,
    createdAt: t.createdAt || t.created_at,
    type,
    refId,
    lang: t.lang || null,
    text: String(t.text || ''),
    engN: type === 'retweet' ? 0 : engagementOf(m),
    sources: [source]
  };
}

// Dedupe by id, merging provenance; the first occurrence's text/metrics win
// unless a later one carries engagement the first lacked.
export function unifyRows(rows) {
  const byId = new Map();
  for (const r of rows) {
    const prev = byId.get(r.id);
    if (!prev) { byId.set(r.id, { ...r, sources: [...r.sources] }); continue; }
    for (const s of r.sources) {
      if (!prev.sources.some((q) => q.kind === s.kind && q.key === s.key && q.sort === s.sort)) prev.sources.push(s);
    }
    if (!prev.engN && r.engN) prev.engN = r.engN;
    if (!prev.author && r.author) prev.author = r.author;
    if (!prev.text && r.text) prev.text = r.text;
  }
  return [...byId.values()];
}

// The roster that resolved the author decides the voice; a List capture
// resolves it too (a row from the house-gop day-file is GOP even before the
// roster is pulled). Non-House accounts on the caucus List (senators,
// former members, orgs) are 'excluded' so they count nowhere, as everywhere
// else in the product.
export function voiceOf(row) {
  const a = row.author;
  if (a?.status === 'house') return 'caucus';
  if (a?.status && a.status !== 'house') return 'excluded';
  const keys = new Set([...(a?.roster || []), ...row.sources.filter((s) => s.kind === 'list').map((s) => s.key)]);
  if (keys.has('house-democrats')) return 'caucus';
  if (GOP_KEYS.some((k) => keys.has(k))) return 'gop';
  if (PRESS_KEYS.some((k) => keys.has(k))) return 'press';
  if (DELEGATION_KEYS.some((k) => keys.has(k))) return 'delegation';
  if (EXPERT_KEYS.some((k) => keys.has(k))) return 'expert';
  return 'organic';
}

// Deterministic alias matching over syntax.tokenize output: an alias
// matches when its token sequence appears contiguously in the text.
export function aliasTokens(aliases) {
  return [...new Set((aliases || []).map((a) => tokenize(String(a)).join(' ')).filter((s) => s.length >= 3))];
}
export function matchesAliases(text, tokenizedAliases) {
  if (!tokenizedAliases?.length) return false;
  const padded = ` ${tokenize(text).join(' ')} `;
  return tokenizedAliases.some((a) => padded.includes(` ${a} `));
}

// rows → Map<storyKey, rows[]>: archive rows the classifier already put in
// the story (story.ids) are assigned regardless of wording; everything else
// by alias match. A row may belong to several stories.
export function assignStories(rows, stories) {
  const out = new Map();
  const prepared = stories.map((s) => ({ key: s.key, ids: new Set(s.ids || []), aliases: aliasTokens([...(s.aliases || []), s.label]) }));
  for (const s of prepared) out.set(s.key, []);
  for (const row of rows) {
    for (const s of prepared) {
      if (s.ids.has(row.id) || matchesAliases(row.text, s.aliases)) out.get(s.key).push(row);
    }
  }
  return out;
}

// ── loading ──────────────────────────────────────────────────────────────
export function windowDates(days, today = etDate()) {
  const base = new Date(`${today}T12:00:00Z`).getTime();
  return Array.from({ length: days }, (_, i) => etDate(new Date(base - (days - 1 - i) * DAY)));
}

// Archive + metrics + List day-files (+ evidence posts) for the window.
export function loadCorpus({ days = 7, today = etDate(), authorsById = {}, rosters = null, carriers = null, listKeys = listEntries().filter((e) => e.scan).map((e) => e.key), evidence = [] } = {}) {
  const dates = windowDates(days, today);
  const rows = [];
  for (const date of dates) {
    const metrics = readJSON(metricsPath(date), {});
    for (const t of loadDay(date)) rows.push(toRow(t, { kind: 'archive', key: date }, { authorsById, rosters, carriers, metrics }));
  }
  for (const key of listKeys) {
    for (const t of readListDays(key, days, { today })) rows.push(toRow(t, { kind: 'list', key, fetchedAt: t.capturedAt || null }, { authorsById, rosters, carriers }));
  }
  for (const ev of evidence) {
    for (const t of ev.posts || []) {
      for (const src of t.sources || [{ kind: 'search', key: ev.story }]) rows.push(toRow(t, { ...src, key: src.key || ev.story }, { authorsById, rosters, carriers }));
    }
  }
  const unified = unifyRows(rows).map((r) => ({ ...r, voice: voiceOf(r) }));
  return { rows: unified, dates, listKeys };
}

// Caucus keys (CPC, NewDem, …) for an author, in settings.caucus_keys order —
// the same mapping sitedata.caucusKeysOf uses.
export function caucusKeysOf(author) {
  const keys = new Set();
  for (const tag of author?.caucuses || []) {
    const k = settings.caucus_keys?.[tag];
    if (k) keys.add(k);
  }
  return [...keys];
}
export const KEYS = [...new Set(Object.values(settings.caucus_keys || {}))];
