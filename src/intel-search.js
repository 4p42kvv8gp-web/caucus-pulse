// Story probes, phrase counts, incident probes and owner queries for the
// narrative layer (docs/NARRATIVE_INTELLIGENCE.md §7.3–§7.5, §12.3). Every
// X call goes through intel-budget.billedCall: reservation → ledger →
// spend log → tool-result cache, so a rerun on the same UTC day is free and
// a rerun on the same ET day skips a story already sampled (evidence file).
import path from 'node:path';
import * as xClient from './x.js';
import { p, settings, etDate, readJSON, daysAgoEt } from './util.js';
import { billedCall } from './intel-budget.js';
import { storyQueries, phraseQuery, quotesQuery, incidentQuery, assertValid } from './intel-queries.js';
import { writeAtomic, authorInfo, isOfficial, officialSet, resolveAuthors, loadProbes } from './intel-lists.js';
import { loadOwnerQueries } from './intel-context.js';
import { bucketStats } from './intel-measure.js';
import { storiesPath } from './stories.js';
import { syntaxPath } from './store.js';

export const narrativesDir = p('data', 'narratives');
export const evidencePath = (key, date) => p('data', 'narratives', key, `${date}.json`);
export const recordPath = (key) => p('data', 'narratives', `${key}.json`);
export const indexPath = p('data', 'narratives', 'index.json');
export const searchDir = p('data', 'narratives', 'search');
export const incidentSearchPath = (id) => path.join(searchDir, 'incidents', `${id}.json`);
export const queriesSearchPath = path.join(searchDir, 'queries.json');
export const questionsDir = p('data', 'narratives', 'questions');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export { bucketStats, hourlyStats } from './intel-measure.js';
const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / DAY);

// ── §7.3 candidates ──────────────────────────────────────────────────────
// stories.json candidates grouped by placement key (two candidates that
// place into `epstein-files` are one story), filtered by the nightly rules,
// plus the owner's custom/pinned stories. `only` (from --stories) names
// keys explicitly and bypasses the member/recency filters — an operator's
// ask — but an excluded key is still reported.
export function storyCandidates({
  storyFile = readJSON(storiesPath, null), owner = loadOwnerQueries(), exclude = settings.intel?.exclude || [],
  today = etDate(), minMembers = 3, withinDays = 2, only = null, max = settings.intel?.counts_stories ?? 30
} = {}) {
  const groups = new Map();
  for (const c of storyFile?.candidates || []) {
    const pl = c.placement;
    if (!pl || pl.kind !== 'story' || !pl.key) continue;
    const g = groups.get(pl.key) || { key: pl.key, label: pl.label, macro: pl.macro || null, kind: 'story', candidateKeys: [], aliases: [], ids: new Set(), who: new Set(), members: 0, posts: 0, firstSeen: null, lastSeen: null };
    g.candidateKeys.push(c.key);
    for (const a of pl.aliases || []) if (!g.aliases.some((x) => x.toLowerCase() === String(a).toLowerCase())) g.aliases.push(String(a));
    for (const id of c.ids || []) g.ids.add(id);
    for (const w of c.who || []) g.who.add(w);
    g.members = Math.max(g.members, c.members || 0, g.who.size);
    g.posts += c.posts || 0;
    if (!g.firstSeen || (c.firstSeen && c.firstSeen < g.firstSeen)) g.firstSeen = c.firstSeen || g.firstSeen;
    if (!g.lastSeen || (c.lastSeen && c.lastSeen > g.lastSeen)) g.lastSeen = c.lastSeen || g.lastSeen;
    groups.set(pl.key, g);
  }
  const placed = [...groups.values()].map((g) => ({ ...g, ids: [...g.ids], who: [...g.who] }));
  const custom = (owner.stories || []).map((s) => ({ key: s.key, label: s.label, macro: s.macro || null, kind: 'story', custom: true, candidateKeys: [], aliases: s.aliases || [], ids: [], who: [], members: 0, posts: 0, firstSeen: null, lastSeen: null }));
  const excluded = new Set([...(exclude || []), ...(owner.exclude || [])]);
  const pinned = new Set(owner.pin || []);
  const candidates = [];
  const skipped = [];
  const all = [...placed, ...custom];
  for (const s of all) {
    const explicit = Boolean(only?.includes(s.key));
    if (only && !explicit) continue;
    const isPinned = pinned.has(s.key) || s.custom;
    if (excluded.has(s.key) && !explicit) { skipped.push({ key: s.key, reason: 'excluded (settings.intel.exclude / config/intel-queries.json)' }); continue; }
    if (!explicit && !isPinned) {
      if (s.members < minMembers) { skipped.push({ key: s.key, reason: `members ${s.members} < ${minMembers}` }); continue; }
      if (!s.lastSeen || daysBetween(s.lastSeen, today) > withinDays) { skipped.push({ key: s.key, reason: `lastSeen ${s.lastSeen || 'never'} older than ${withinDays} days` }); continue; }
    }
    candidates.push({ ...s, pinned: isPinned, explicit, excludedByConfig: excluded.has(s.key) });
  }
  for (const k of only || []) if (!all.some((s) => s.key === k)) skipped.push({ key: k, reason: 'unknown story key (not a placed story in data/stories.json, not in config/intel-queries.json)' });
  candidates.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.posts - a.posts || b.members - a.members);
  for (const s of candidates.slice(max)) skipped.push({ key: s.key, reason: `beyond counts_stories (${max})` });
  return { candidates: candidates.slice(0, max), skipped };
}

// ── counts (one unit per request) ────────────────────────────────────────
async function countsCall(ctx, x, { query, kind, story = null, stage, granularity = 'day', startTime = null, now }) {
  const res = await billedCall(ctx, {
    endpoint: 'counts', purpose: 'intel', story, stage, expected: 1, query,
    args: { query, granularity, startTime },
    exec: () => x.countsRecent(query, { granularity, startTime: startTime || undefined })
  });
  if (!res.result) {
    return { q: query, kind, granularity, buckets: [], total: null, fetchedAt: null, cacheHit: false, units: 0, skipped: res.refused ? 'refused' : res.rateLimited ? 'rate limited' : res.error ? `error ${res.error.status || ''}`.trim() : res.dryRun ? 'dry-run' : 'unknown' };
  }
  return { q: query, kind, granularity, buckets: res.result.buckets, total: res.result.total, fetchedAt: res.at || now.toISOString(), cacheHit: res.cacheHit, units: res.units };
}

// §7.3 counts pass: organic + originals per candidate (2 units), control once.
export async function countsPass(stories, { ctx, x = xClient, now = new Date(), control = settings.intel?.control_query } = {}) {
  const byStory = {};
  const ctrl = await countsCall(ctx, x, { query: control, kind: 'control', stage: 'control', now });
  let units = ctrl.units || 0;
  for (const s of stories) {
    let q;
    try { q = storyQueries(s); } catch (e) { byStory[s.key] = { error: e.message }; continue; }
    s.queries = q;
    const organic = await countsCall(ctx, x, { query: q.organic, kind: 'organic', story: s.key, stage: 'stories', now });
    const originals = await countsCall(ctx, x, { query: q.originals, kind: 'originals', story: s.key, stage: 'stories', now });
    units += (organic.units || 0) + (originals.units || 0);
    byStory[s.key] = { organic, originals, queries: q };
  }
  return { byStory, control: ctrl, units };
}

// §7.3 rank: lift × log(1 + caucusPosts) × (1 + momentum/100)
export function rankStories(stories, counts, { now = Date.now(), momentum = {} } = {}) {
  return stories.map((s) => {
    const c = counts.byStory?.[s.key];
    const st = bucketStats(c?.originals?.buckets, { now });
    const lift = st.lift ?? 0;
    const caucusPosts = s.ids?.length || s.posts || 0;
    const mo = momentum[s.key] || 0;
    return { ...s, lift, baselineThin: st.baselineThin, countsToday: st.countsToday, score: Math.round(1000 * lift * Math.log(1 + caucusPosts) * (1 + mo / 100)) / 1000 };
  }).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.score - a.score || b.posts - a.posts);
}

// ── rows ─────────────────────────────────────────────────────────────────
export function compactRow(t, info, source) {
  const refs = t.referenced_tweets || [];
  const type = refs.find((r) => r.type === 'retweeted') ? 'retweet' : refs.find((r) => r.type === 'quoted') ? 'quote' : refs.find((r) => r.type === 'replied_to') ? 'reply' : 'tweet';
  const m = t.public_metrics || {};
  return {
    id: t.id, authorId: t.author_id, handle: info?.handle || null, rosters: info?.rosters || [], status: info?.status || null,
    createdAt: t.created_at, type, refId: refs[0]?.id || null, lang: t.lang || null,
    text: String(t.text || '').slice(0, 280),
    metrics: { likes: m.like_count ?? 0, retweets: m.retweet_count ?? 0, replies: m.reply_count ?? 0, quotes: m.quote_count ?? 0, impressions: m.impression_count ?? 0 },
    sources: source ? [source] : []
  };
}
const engOf = (r) => (r.type === 'retweet' ? 0 : (r.metrics?.likes || 0) + (r.metrics?.retweets || 0) + (r.metrics?.replies || 0) + (r.metrics?.quotes || 0));

// ── §7.3 sampling plan for one story (full mode only) ────────────────────
export async function sampleStory(story, { ctx, x = xClient, now = new Date(), probes = loadProbes(), topPostId = null, authorsById = {}, rosters = null, carriers = null, saveCarriers = true } = {}) {
  const q = story.queries || storyQueries(story);
  const capsStory = settings.intel?.story || {};
  const out = { counts: [], pages: [], quotes: null, posts: new Map(), skipped: [], units: 0, cacheHits: 0 };
  const remaining = () => (ctx.reservation ? ctx.reservation.remaining({ story: story.key, stage: 'stories' }) : Infinity);
  const addPost = (t, source) => {
    const prev = out.posts.get(t.id);
    if (prev) { prev.sources.push(source); return; }
    out.posts.set(t.id, compactRow(t, authorInfo(t.author_id, { authorsById, rosters, carriers }), source));
  };
  const why = (res) => (res.refused ? `refused (${remaining()} units left)` : res.rateLimited ? 'rate limited' : res.error ? `error ${res.error.status || ''}`.trim() : res.dryRun ? 'dry-run' : 'unknown');

  // 1. hour-granularity counts over the last 72h (acceleration)
  // startTime floored to the hour: the cache key must not carry a fresh timestamp on every run
  const hourStart = new Date(Math.floor((now.getTime() - 72 * HOUR) / HOUR) * HOUR).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const hourly = await countsCall(ctx, x, { query: q.originals, kind: 'hourly', story: story.key, stage: 'stories', granularity: 'hour', startTime: hourStart, now });
  out.counts.push(hourly);
  out.units += hourly.units || 0;
  if (hourly.cacheHit) out.cacheHits++;

  // 2–3. one relevancy page (≤100) and one recency page (≤50), originals only, assistants excluded
  let searchBudget = capsStory.search_posts ?? 200;
  for (const [sort, want] of [['relevancy', 100], ['recency', 50]]) {
    const size = Math.min(want, searchBudget, remaining());
    if (size < 10) { out.skipped.push(`${sort} page: only ${size} units left`); continue; }
    const res = await billedCall(ctx, {
      endpoint: 'search', purpose: 'intel', story: story.key, stage: 'stories', expected: size, query: q.sample,
      args: { query: q.sample, sortOrder: sort, maxResults: size },
      exec: () => x.searchRecent(q.sample, { maxResults: size, sortOrder: sort })
    });
    if (!res.result) { out.skipped.push(`${sort} page: ${why(res)}`); continue; }
    searchBudget -= res.units;
    out.units += res.units;
    if (res.cacheHit) out.cacheHits++;
    const tweets = res.result.tweets || [];
    const times = tweets.map((t) => t.created_at).filter(Boolean).sort();
    const source = { kind: 'search', key: story.key, query: q.sample, sort, fetchedAt: res.at || now.toISOString() };
    out.pages.push({ q: q.sample, sort, maxResults: size, fetchedAt: source.fetchedAt, oldest: times[0] || null, newest: times.at(-1) || null, n: tweets.length, ids: tweets.map((t) => t.id), cacheHit: res.cacheHit, units: res.units });
    for (const t of tweets) addPost(t, source);
  }

  // 4. quotes of the story's top caucus post
  if (topPostId) {
    const size = Math.min(capsStory.quotes ?? 50, remaining());
    if (size < 10) out.skipped.push(`quotes: only ${size} units left`);
    else if (probes.quotesOperator == null) out.skipped.push('quotes: operator not probed yet');
    else {
      const viaSearch = probes.quotesOperator === true;
      const query = viaSearch ? assertValid(quotesQuery(topPostId), { probes }) : null;
      const res = await billedCall(ctx, {
        endpoint: viaSearch ? 'search' : 'quote_tweets', purpose: 'intel', story: story.key, stage: 'stories', expected: size, query,
        args: viaSearch ? { query, sortOrder: 'recency', maxResults: size } : { id: topPostId, maxResults: size },
        exec: () => (viaSearch ? x.searchRecent(query, { maxResults: size, sortOrder: 'recency' }) : x.quoteTweetsPage(topPostId, { maxResults: size }))
      });
      if (!res.result) out.skipped.push(`quotes: ${why(res)}`);
      else {
        out.units += res.units;
        if (res.cacheHit) out.cacheHits++;
        const tweets = res.result.tweets || [];
        const source = { kind: 'quotes', key: story.key, query: query || `quote_tweets/${topPostId}`, sort: 'recency', fetchedAt: res.at || now.toISOString() };
        out.quotes = { ofId: topPostId, via: viaSearch ? 'search' : 'quote_tweets', ids: tweets.map((t) => t.id), n: tweets.length, cacheHit: res.cacheHit, units: res.units };
        for (const t of tweets) addPost(t, source);
      }
    }
  }

  // 5. author resolution: unresolved authors seen in ≥2 sampled posts or in the top 5 by engagement
  const rows = [...out.posts.values()];
  const byAuthor = new Map();
  for (const r of rows) byAuthor.set(r.authorId, (byAuthor.get(r.authorId) || 0) + 1);
  const top5 = new Set(rows.slice().sort((a, b) => engOf(b) - engOf(a)).slice(0, 5).map((r) => r.authorId));
  const want = [...byAuthor.entries()].filter(([id, n]) => (n >= 2 || top5.has(id)) && !authorInfo(id, { authorsById, rosters, carriers })).map(([id]) => id);
  out.resolution = { wanted: want.length, resolved: 0, unresolved: want.length, units: 0 };
  if (want.length) {
    const cap = Math.min(capsStory.user_lookups ?? 20, Math.floor(remaining() / 2), Math.floor((ctx.reservation?.remaining({ stage: 'users' }) ?? Infinity) / 2));
    if (cap < 1) out.skipped.push(`users: ${want.length} unresolved, no units left`);
    else {
      const r = await resolveAuthors(want, { ctx, x, authorsById, rosters, carriers, cap, story: story.key, now, save: saveCarriers });
      out.units += r.units;
      out.resolution = { wanted: want.length, resolved: r.resolved.size, unresolved: r.unresolved.length, units: r.units };
      for (const row of rows) {
        const info = r.resolved.get(row.authorId);
        if (info && !row.handle) { row.handle = info.handle; row.rosters = info.rosters; row.status = info.status; }
      }
    }
  }
  return { ...out, posts: rows, queries: q };
}

// §7.3 probe: idempotent per ET date; writes data/narratives/<key>/<date>.json
export async function probeStory(story, { ctx, x = xClient, now = new Date(), force = false, counts = null, ...rest } = {}) {
  const date = etDate(now);
  const file = evidencePath(story.key, date);
  const existing = readJSON(file, null);
  if (existing && !force) return { evidence: existing, file, skipped: `sampled today already (${file.replace(/^.*data\//, 'data/')}; --force to resample)` };
  if (ctx.dryRun) return { evidence: null, file, skipped: 'dry-run' };
  const sample = await sampleStory(story, { ctx, x, now, ...rest });
  const c = counts?.byStory?.[story.key] || {};
  const allCounts = [c.organic, c.originals, ...sample.counts].filter(Boolean);
  const units = sample.units + (c.organic?.units || 0) + (c.originals?.units || 0);
  const evidence = {
    story: story.key, label: story.label, date, generatedAt: now.toISOString(),
    queries: sample.queries,
    counts: allCounts,
    control: counts?.control || null,
    pages: sample.pages,
    quotes: sample.quotes,
    resolution: sample.resolution || null,
    skipped: sample.skipped,
    posts: sample.posts,
    units, usd: Math.round(units * 0.005 * 1000) / 1000,
    cacheHits: sample.cacheHits + allCounts.filter((k) => k.cacheHit).length
  };
  writeAtomic(file, evidence);
  return { evidence, file, skipped: null };
}

// ── §7.4 phrase-level outside signal ─────────────────────────────────────
export function topPhrases(n = settings.intel?.phrases_outside ?? 12, { today = etDate() } = {}) {
  for (let d = 0; d < 3; d++) {
    const f = readJSON(syntaxPath(etDate(new Date(new Date(`${today}T12:00:00Z`).getTime() - d * DAY))), null);
    if (f?.phrases?.length) return f.phrases.slice().sort((a, b) => b.members - a.members).slice(0, n).map((ph) => ({ text: ph.phrase, members: ph.members, date: f.date }));
  }
  return [];
}

export async function phraseOutside(phrases, { ctx, x = xClient, now = new Date() } = {}) {
  const out = {};
  let units = 0;
  for (const ph of phrases) {
    const q = phraseQuery(ph.text);
    const c = await countsCall(ctx, x, { query: q, kind: 'phrase', stage: 'phrases', now });
    units += c.units || 0;
    out[ph.text] = { q, ...bucketStats(c.buckets, { now: now.getTime() }), fetchedAt: c.fetchedAt, cacheHit: c.cacheHit, skipped: c.skipped || null, members: ph.members };
  }
  return { byPhrase: out, units };
}

// ── §7.5 incident probes and owner saved queries ─────────────────────────
function tagOf(info, official) {
  if (isOfficial(info, official)) return 'official';
  if (info?.rosters?.some((k) => ['cap-hill-reporters', 'congressional-media', 'house-news', 'labor-reporters', 'ny-news', 'international-news', 'national-press'].includes(k))) return 'press';
  if (info?.status === 'house') return 'member';
  return 'unverified';
}

async function searchPage(ctx, x, { query, size, story = null, stage, key, now }) {
  const res = await billedCall(ctx, {
    endpoint: 'search', purpose: 'intel', story, stage, expected: size, query,
    args: { query, sortOrder: 'recency', maxResults: size },
    exec: () => x.searchRecent(query, { maxResults: size, sortOrder: 'recency' })
  });
  if (!res.result) return { tweets: [], units: 0, cacheHit: false, skipped: res.refused ? 'refused' : res.rateLimited ? 'rate limited' : res.error ? `error ${res.error.status || ''}`.trim() : res.dryRun ? 'dry-run' : 'unknown', fetchedAt: null };
  return { tweets: res.result.tweets || [], units: res.units, cacheHit: res.cacheHit, skipped: null, fetchedAt: res.at || now.toISOString() };
}

async function tagRows(tweets, { ctx, x, authorsById, rosters, carriers, official, lookups, key, now }) {
  const ids = [...new Set(tweets.map((t) => t.author_id))];
  const unknown = ids.filter((id) => !authorInfo(id, { authorsById, rosters, carriers }));
  let units = 0;
  if (unknown.length && lookups > 0) {
    const r = await resolveAuthors(unknown.slice(0, lookups), { ctx, x, authorsById, rosters, carriers, cap: lookups, story: key, now });
    units += r.units;
  }
  const rows = tweets.map((t) => {
    const info = authorInfo(t.author_id, { authorsById, rosters, carriers });
    const m = t.public_metrics || {};
    return { id: t.id, authorId: t.author_id, handle: info?.handle || null, tag: tagOf(info, official), at: t.created_at, text: String(t.text || '').slice(0, 280), engN: (m.like_count || 0) + (m.retweet_count || 0) + (m.reply_count || 0) + (m.quote_count || 0) };
  }).sort((a, b) => (a.at < b.at ? 1 : -1));
  return { rows, units };
}

export async function probeIncident(incident, { ctx, x = xClient, now = new Date(), authorsById = {}, rosters = null, carriers = null, official = officialSet() } = {}) {
  const query = incidentQuery(incident);
  const size = Math.min(settings.intel?.incidents?.search_posts ?? 50, ctx.reservation ? ctx.reservation.remaining({ stage: 'incidents' }) : 50);
  if (size < 10) return { skipped: `incident ${incident.id}: only ${size} units left`, query };
  const page = await searchPage(ctx, x, { query, size, stage: 'incidents', key: incident.id, now });
  if (page.skipped) return { skipped: `incident ${incident.id}: ${page.skipped}`, query };
  const tagged = await tagRows(page.tweets, { ctx, x, authorsById, rosters, carriers, official, lookups: settings.intel?.incidents?.user_lookups ?? 10, key: incident.id, now });
  const out = {
    incidentId: incident.id, kind: incident.kind, place: incident.place, query, ranAt: page.fetchedAt, cacheHit: page.cacheHit,
    units: page.units + tagged.units, rows: tagged.rows,
    officialSources: [...new Set(tagged.rows.filter((r) => r.tag === 'official' && r.handle).map((r) => `@${r.handle}`))]
  };
  writeAtomic(incidentSearchPath(incident.id), out);
  return { result: out, units: out.units };
}

export async function runOwnerQueries(queries, { ctx, x = xClient, now = new Date(), authorsById = {}, rosters = null, carriers = null, official = officialSet() } = {}) {
  const prev = readJSON(queriesSearchPath, { queries: [] });
  const out = [];
  let units = 0;
  for (const q of queries) {
    const size = Math.min(q.max_results, ctx.reservation ? ctx.reservation.remaining({ stage: 'incidents' }) : q.max_results);
    if (size < 10) { out.push({ ...q, skipped: `only ${size} units left`, ranAt: null, results: prev.queries?.find((p) => p.key === q.key)?.results || [] }); continue; }
    const page = await searchPage(ctx, x, { query: q.query, size, stage: 'incidents', key: q.key, now });
    if (page.skipped) { out.push({ ...q, skipped: page.skipped, ranAt: null, results: [] }); continue; }
    const tagged = await tagRows(page.tweets, { ctx, x, authorsById, rosters, carriers, official, lookups: 0, key: q.key, now });
    units += page.units;
    out.push({ key: q.key, label: q.label, scope: q.scope, query: q.query, max_results: q.max_results, ranAt: page.fetchedAt, cacheHit: page.cacheHit, units: page.units, results: tagged.rows });
  }
  const file = { generatedAt: now.toISOString(), queries: out };
  if (!ctx.dryRun) writeAtomic(queriesSearchPath, file);
  return { result: file, units };
}
