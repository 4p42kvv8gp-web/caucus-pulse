// Builds site/data/rollups.json — the single file both dashboard pages read.
// Rebuilt after every poll (cheap, pure derivation) and again in the nightly
// chain once authoritative classification lands. Where the design handoff's
// sample data faked the 7-day window by scaling Today, this builder computes
// both windows for real: every topic/stat carries `t` (today) and `w`
// (trailing 7 days) aggregates, each scoped per caucus.
//
// Engagement honesty: numbers use the 24h-refresh metrics where they exist
// and capture-time metrics otherwise, so today's engagement always lags — by
// design (see the brief), and the dashboard captions say so.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { p, settings, readJSON, writeJSON, daysAgoEt } from './util.js';
import { loadDay, topicsPath, metricsPath, loadState } from './store.js';
import { liveTopicsPath, combineInterpretations } from './classify-live.js';
import { loadAuthors, isHouse, splitByRoster } from './authors.js';
import { loadTaxonomy, labelOf } from './taxonomy.js';
import { momentum } from './momentum.js';
import { minePhrases, tokenize, ngrams } from './syntax.js';
import { incidentsPath } from './incidents.js';
import { loadSemanticOrNull, configuredMinSim } from './semantic.js';
import { loadNews, loadSources, readStatus, retrieveEvidence, evidenceLine } from './news-context.js';
import { buildNewsCoverage } from './news-coverage.js';
import { loadQuoted, archiveLookup, quotedResolver, quotingFor } from './quoted.js';
import { sourceContextStatus, createRepostResolver } from './source-context.js';
import { loadFloor } from './floor-context.js';
import { buildFloorDisplay } from './floor-display.js';
import { buildInferenceHealth } from './inference-health.js';

const KEYS = [...new Set(Object.values(settings.caucus_keys))]; // display order: CPC, NewDem, CBC
const DAY = 86_400_000;

export const rollupsJsonPath = p('site', 'data', 'rollups.json');

// Size guard for rollups.json. The story drill-down ships every captured
// post in the window (`feedAll`, full text) so a row can open to its whole
// feed; a busy week could grow the file past what a phone loads comfortably.
// Above this many bytes, the remaining posts are delivered as complete shards.
export const ROLLUPS_MAX_BYTES = 2_500_000;
export const QUOTED_TEXT_MAX = 200;

// Largest newest-first prefix of `list` whose serialised size (per `sizeOf`,
// which measures the whole file with that prefix in place) stays under
// `maxBytes`. Binary search: ~12 serialisations at most.
export function fitFeedAll(list, sizeOf, maxBytes = ROLLUPS_MAX_BYTES) {
  if (sizeOf(list) < maxBytes) return { feedAll: list, truncated: false };
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (sizeOf(list.slice(0, mid)) < maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return { feedAll: list.slice(0, lo), truncated: true };
}

export function compactQuote(q) {
  if (!q || (!q.text && !q.handle)) return null;
  const text = String(q.text || '');
  return { id: /^\d+$/.test(String(q.id || q.sourceId || '')) ? String(q.id || q.sourceId) : null,
    handle: q.handle ? `@${String(q.handle).replace(/^@/, '')}` : null,
    text: text.length > QUOTED_TEXT_MAX ? text.slice(0, QUOTED_TEXT_MAX - 1).replace(/\s+\S*$/, '') + '…' : text };
}

export function publicProvenance(provenance) {
  if (!provenance) return null;
  const supplied = (provenance.evidenceSupplied || []).filter((e) => /^https?:\/\//.test(e.url || ''))
    .map(({ id, publisher, date, kind, url, text, publishedAt, fetchedAt, observedAt, weekStart, weekEnd, billId, procedure, publishedAfterPost, acquiredAfterPost, truncated }) => ({ id, publisher, date, kind, url, text: String(text || '').slice(0, 600), publishedAt, fetchedAt: fetchedAt || observedAt, publishedAfterPost, acquiredAfterPost, truncated: Boolean(truncated || String(text || '').length > 600),
      ...(kind === 'floor-agenda' ? { observedAt, weekStart, weekEnd, billId, procedure } : {}) }));
  const valid = new Set(supplied.map((e) => e.id));
  return { contextVersion: provenance.contextVersion || 0, evidenceSupplied: supplied,
    evidenceUsed: (provenance.evidenceUsed || []).filter((id) => valid.has(id)) };
}

// Older generated incidents omitted source IDs. Restore them only when an
// archived record agrees on both exact text and timestamp; never infer from
// the order of a model's summary or its source label.
export function hydrateIncidentSources(incident, posts) {
  const candidates = posts.filter((post) => (incident.tweetIds || []).includes(post.id));
  const timeline = (incident.timeline || []).map((entry) => {
    const matches = candidates.filter((post) => post.text === entry.text && post.createdAt === entry.time);
    const source = matches.length === 1 ? matches[0] : null;
    return source ? { ...entry, id: source.id, sourceId: source.id, evidence: entry.evidence ? { ...entry.evidence, sourceId: source.id } : null } : entry;
  });
  const legacy = (incident.timeline || []).some((entry) => !entry.sourceId);
  return { ...incident, timeline,
    ...(legacy ? { status: 'provisional', lifecycle: incident.lifecycle || incident.status, corroboration: { note: 'Member source reports; no independent verification recorded.' } } : {}),
    evidence: incident.evidence && timeline[0]?.sourceId ? { ...incident.evidence, sourceId: timeline[0].sourceId } : incident.evidence };
}

// Live discoveries are peers of placed story candidates, never a fallback.
// Identity joins only exact normalized labels or an explicit stable key in
// the same macro. Shared broad categories or overlapping post IDs alone do
// not establish that two events are the same.
export function combineEmergingSources({ placed = [], raw = [], posts = [], authorsById = {}, now = Date.now() } = {}) {
  const byId = new Map(posts.map((post) => [post.id, post]));
  const norm = (value) => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const groups = [];
  for (const [source, entries] of [['placed', placed], ['live-or-nightly', raw]]) {
    for (const entry of entries) {
      if (!entry || !norm(entry.label)) continue;
      const ids = [...new Set(entry.ids || [])].filter((id) => typeof id === 'string' && /^\d+$/.test(id) && byId.has(id));
      if (!ids.length) continue;
      const label = norm(entry.label);
      const stableKey = entry.key && entry.macro ? `${entry.macro}/${entry.key}` : null;
      const match = groups.find((group) => group.normalizedLabel === label || (stableKey && group.stableKey === stableKey));
      if (match) { match.ids = [...new Set([...match.ids, ...ids])]; match.sources = [...new Set([...match.sources, source])]; }
      else groups.push({ ...entry, ids, normalizedLabel:label, stableKey, sources:[source], provisional:source !== 'placed' });
    }
  }
  return groups.map(({normalizedLabel,stableKey,...group}) => {
    const observed = group.ids.map((id) => byId.get(id));
    const members = new Set(observed.map((post) => rosterPersonKey(authorsById[post.authorId])).filter(Boolean));
    const activePosts = observed.filter((post) => now - Date.parse(post.createdAt) >= 0 && now - Date.parse(post.createdAt) <= DAY);
    const activeMembers = new Set(activePosts.map((post) => rosterPersonKey(authorsById[post.authorId])).filter(Boolean));
    return { ...group, memberCount:members.size, thresholdMet:members.size >= 3, active:activePosts.length > 0,
      activeMembers:activeMembers.size, lastSeen:observed.map((post) => post.createdAt).sort().at(-1) };
  }).sort((a,b) => Number(b.active && b.thresholdMet) - Number(a.active && a.thresholdMet)
    || Number(b.activeMembers >= 3) - Number(a.activeMembers >= 3)
    || String(b.lastSeen).localeCompare(String(a.lastSeen)) || b.memberCount - a.memberCount || a.label.localeCompare(b.label));
}

function caucusKeysOf(author) {
  const keys = new Set();
  for (const tag of author?.caucuses || []) {
    const k = settings.caucus_keys[tag];
    if (k) keys.add(k);
  }
  return [...keys];
}

// Merge a day's assignments: nightly is authoritative, live fills gaps.
export function dayAssignments(date) {
  const nightly = readJSON(topicsPath(date), null);
  const live = readJSON(liveTopicsPath(date), null);
  const combined = combineInterpretations(live, nightly);
  return { ...combined, hasNightly: Boolean(nightly) };
}

function engagementOf(m) {
  if (!m || m.unavailable) return 0;
  return (m.likes || 0) + (m.retweets || 0) + (m.replies || 0) + (m.quotes || 0);
}

// Interpretation completion does not imply that the full original source
// was captured. Derive that separate warning from current source material,
// including legacy records, without editing paid or human interpretations.
export function projectPostForSite(post, { metrics = {}, interpretation = {}, date = null, original = null, pending = null } = {}) {
  const { assignments = {}, provenance = {}, needsContext = {}, pendingIds = [], unclassified = [], corrected = {} } = interpretation;
  const isPending = pending ? pending.has(post.id) : pendingIds.includes(post.id) || unclassified.includes(post.id);
  const m = metrics[post.id];
  const cap = post.metricsAtCapture || {};
  const source = sourceContextStatus(post, original);
  return {
    ...post,
    engN: post.type === 'retweet' ? 0 : (m && !m.unavailable)
      ? engagementOf(m)
      : (cap.likes || 0) + (cap.retweets || 0) + (cap.replies || 0) + (cap.quotes || 0),
    topics: assignments[post.id] || [],
    classificationStatus: Object.hasOwn(assignments, post.id) && (!isPending || corrected[post.id]) ? 'complete' : 'pending',
    provenance: provenance[post.id] || null,
    needsContext: corrected[post.id] && typeof needsContext[post.id] === 'boolean'
      ? needsContext[post.id] : Boolean(needsContext[post.id] || source.incomplete),
    sourceIncomplete: source.incomplete,
    sourceContextReason: source.reason,
    sourceReferenceId: source.referenceId,
    metricsObservedAt: m?.observedAt || m?.fetchedAt || m?.refreshedAt || post.capturedAt || null,
    date
  };
}

// One token-level edit apart? (substitute, insert, or delete one token)
export function oneTokenEdit(a, b) {
  if (a.length === b.length) {
    let d = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
    return d === 1;
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  if (l.length - s.length !== 1) return false;
  let i = 0, j = 0, skipped = false;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; }
    else if (!skipped) { skipped = true; j++; }
    else return false;
  }
  return true;
}

// Group mined n-grams into phrase families: one token edit apart, or one
// contains the other and they share the head noun (last token).
export function clusterFamilies(phraseList) {
  const parent = phraseList.map((_, i) => i);
  const find = (i) => parent[i] === i ? i : (parent[i] = find(parent[i]));
  for (let i = 0; i < phraseList.length; i++) {
    for (let j = i + 1; j < phraseList.length; j++) {
      const ta = phraseList[i].split(' '), tb = phraseList[j].split(' ');
      const sameHead = ta[ta.length - 1] === tb[tb.length - 1];
      const contains = phraseList[i].includes(phraseList[j]) || phraseList[j].includes(phraseList[i]);
      if (oneTokenEdit(ta, tb) || (sameHead && contains)) parent[find(j)] = find(i);
    }
  }
  const groups = new Map();
  phraseList.forEach((ph, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(ph);
  });
  return [...groups.values()];
}

// Legacy key matching helper retained for compatibility; no private context is loaded.
// Which keyed entry
// belongs to an emerging cluster? Entries are keyed by the story candidate's
// key, but the dashboard cluster only carries the placement key (`suggest`)
// and the display label — and a re-run of stories.js can re-key a placement.
// So accept the candidate key, the placement key, or the label, all
// slug-normalised, and return the entry's key (null when nothing matches).
export function contextKeyFor(cluster, entries) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const want = new Set([cluster?.suggest, cluster?.key, cluster?.label].map(norm).filter(Boolean));
  if (!want.size) return null;
  for (const [k, e] of Object.entries(entries || {})) {
    if (want.has(norm(k)) || want.has(norm(e?.key)) || want.has(norm(e?.label))) return k;
  }
  return null;
}

// "Similar, unlabeled": for each emerging cluster and each story subtopic
// row, the posts in the window whose wording sits near the story's posts
// but that carry no label for it — the misses a keyword search cannot find
// (docs/SEMANTIC_MATCHING.md). Measured similarity, not a judgment: the
// dashboard says so, and the list is capped (settings.semantic.related_posts)
// so rollups.json stays small.
//
// Seeds: a cluster the story map knows (its `suggest` key is a tracked
// story) uses the story's centroid over every post tied to it; any other
// cluster uses its own posts (`seeds`: cluster → ids). A story row uses its
// taxonomy story. Excluded everywhere: posts outside the window, retweets
// (the original speaks for itself), and — for story rows — posts that
// already carry the story's label from the live tagger.
//
// Pure: `semantic` is injected (null → nothing attached) and the objects
// are decorated in place. Returns how many lists were non-empty.
export function attachRelated({
  clusters = [], seeds = new Map(), topics = [], tax = {}, posts = [], semantic = null,
  k = settings.semantic?.related_posts ?? 5, minSim = configuredMinSim(),
  handleOf = () => null, warn = console.warn
} = {}) {
  const counts = { clusters: 0, subs: 0 };
  if (!semantic || !(k > 0)) return counts;
  const byId = new Map(posts.map((x) => [x.id, x]));
  const trim = (t) => t.length > 200 ? t.slice(0, 199).replace(/\s+\S*$/, '') + '…' : t;
  const carries = (x, macro, sub) => (x.topics || []).some(([m, s]) => m === macro && s === sub);
  const excludeFor = (macro, sub) => (id) => {
    const x = byId.get(id);
    return !x || x.type === 'retweet' || (macro != null && sub != null && carries(x, macro, sub));
  };
  const decorate = (hits) => hits.map((h) => {
    const x = byId.get(h.id);
    return {
      id: h.id, sim: h.sim, handle: handleOf(x.authorId) || x.authorId, text: trim(x.text), time: x.createdAt,
      topics: [...new Set((x.topics || []).map(([m, s]) => s ? `${m}/${s}` : m))]
    };
  });
  const safe = (fn, what) => {
    try { return fn(); } catch (e) { warn(`[sitedata] similar posts for ${what} skipped: ${e.message}`); return []; }
  };
  for (const c of clusters) {
    const storyKey = c.suggest && semantic.story(c.suggest) ? c.suggest : null;
    const exclude = excludeFor(null, null);
    c.related = decorate(safe(() => storyKey
      ? semantic.relatedPosts(storyKey, { k, minSim, exclude })
      : semantic.nearSeed(seeds.get(c) || [], { k, minSim, exclude }).hits, c.label));
    if (c.related.length) counts.clusters++;
  }
  for (const t of topics) {
    for (const s of t.subs || []) {
      if (!tax[t.key]?.subtopics?.[s.key]?.story) continue;
      const key = semantic.storyKeyFor(t.key, s.key);
      if (!key) continue;
      s.related = decorate(safe(() => semantic.relatedPosts(key, { k, minSim, exclude: excludeFor(t.key, s.key) }), `${t.key}/${s.key}`));
      if (s.related.length) counts.subs++;
    }
  }
  return counts;
}

// Completed interpretation and topic presence are separate measurements:
// an accepted empty assignment is complete; a pending retry can carry old
// topic labels. Legacy callers without status retain the topic fallback.
export function classificationCoverage(allPosts, days, now = Date.now()) {
  const complete = (post) => post.classificationStatus
    ? post.classificationStatus === 'complete' : Boolean(post.topics?.length);
  let through = null;
  for (const d of days) if (allPosts.some((x) => x.date === d && complete(x))) through = d;
  let capturedIn24h = 0;
  let classifiedIn24h = 0;
  let taggedIn24h = 0;
  for (const x of allPosts) {
    const age = now - Date.parse(x.createdAt);
    if (!Number.isFinite(age) || age < 0 || age >= DAY) continue;
    capturedIn24h++;
    if (complete(x)) classifiedIn24h++;
    if (x.topics?.length) taggedIn24h++;
  }
  return { through, capturedIn24h, classifiedIn24h, taggedIn24h,
    pendingIn24h: capturedIn24h - classifiedIn24h,
    momentumPaused: capturedIn24h > 0 && classifiedIn24h === 0 };
}

export function rosterPersonKey(author) {
  if (author?.personId || author?.memberId) return String(author.personId || author.memberId);
  return author?.member ? `member:${String(author.member).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()}` : null;
}

function zeroScope() {
  return { n: 0, eng: 0, members: new Set(), accounts: new Set() };
}
function addScope(s, post, author) {
  s.n++; s.eng += post.engN; s.accounts.add(post.authorId);
  const person = rosterPersonKey(author);
  if (person) s.members.add(person);
}

function finishScope(s) {
  return { n: s.n, eng: s.eng, m: s.members.size, a: s.accounts.size };
}

export function buildSiteData() {
  const state = loadState();
  const authorsById = loadAuthors().byId;
  const tax = loadTaxonomy();
  const days = Array.from({ length: 7 }, (_, i) => daysAgoEt(6 - i)); // oldest → today
  const today = days[6];

  // ── load the window: posts with resolved engagement + topics ──
  // Roster filter: senators, former members and stray non-member accounts
  // on the List stay in the archive but count nowhere below. `excluded`
  // is reported so the dashboard can say how much it is not showing.
  const postsByDay = new Map();
  const allPosts = [];
  const excluded = { posts: 0, t: 0 };
  const quoteCache = loadQuoted(), sourceArchive = archiveLookup();
  const resolveRepost = createRepostResolver({ quoted: quoteCache, archive: sourceArchive });
  const resolveFloorQuote = quotedResolver({ quoted: quoteCache, archive: sourceArchive, authorsById });
  for (const date of days) {
    const metrics = readJSON(metricsPath(date), {});
    const interpretation = dayAssignments(date);
    const pending = new Set([...(interpretation.pendingIds || []), ...(interpretation.unclassified || [])]);
    const posts = loadDay(date).map((post) => projectPostForSite(post, {
      metrics, interpretation, date, original: resolveRepost(post), pending
    }));
    const { house, excluded: out } = splitByRoster(posts, authorsById);
    excluded.posts += out.length;
    if (date === today) excluded.t += out.length;
    postsByDay.set(date, house);
    allPosts.push(...house);
  }
  const classification = classificationCoverage(allPosts, days);
  classification.health = buildInferenceHealth(days.flatMap((date) => [readJSON(topicsPath(date), null), readJSON(liveTopicsPath(date), null)]), classification);
  classification.momentumPaused ||= classification.health.hasCurrentFailure;
  if (classification.momentumPaused) console.warn(`[sitedata] momentum paused: interpretation ${classification.health.status}; ${classification.pendingIn24h}/${classification.capturedIn24h} recent post(s) pending`);

  // ── topics: per-day, per-scope aggregation ──
  // acc[topicKey][scope] = today/week scopes; trends per day.
  // Momentum's "current" window is the rolling last 24 hours (r24), not the
  // calendar day: at 1am ET "today" holds a handful of posts and every topic
  // would read as a 100% collapse against its own baseline. The baseline is
  // the six full days before today, so the current window never dilutes it.
  const topicAcc = new Map(); // key → {t: {All: scope, CPC..}, w: {...}, r24: {...}, trend: number[7], mByDay: Set[7]}
  const subAcc = new Map();   // 'macro/sub' → same-ish + leads
  const nowMs = Date.now();
  const inLast24h = (post) => nowMs - new Date(post.createdAt).getTime() < DAY;
  const ensure = (map, key) => {
    if (!map.has(key)) {
      map.set(key, {
        t: Object.fromEntries(['All', ...KEYS].map((k) => [k, zeroScope()])),
        w: Object.fromEntries(['All', ...KEYS].map((k) => [k, zeroScope()])),
        r24: Object.fromEntries(['All', ...KEYS].map((k) => [k, zeroScope()])),
        trend: days.map(() => 0),
        mByDay: days.map(() => new Set()),
        leadEng: new Map(), // authorId → eng (for sub lead)
        postIds: { t: [], w: [] } // every post on this row, today / 7 days (sorted newest-first below)
      });
    }
    return map.get(key);
  };

  for (const [di, date] of days.entries()) {
    for (const post of postsByDay.get(date)) {
      if (!post.topics.length) continue;
      const scopes = ['All', ...caucusKeysOf(authorsById[post.authorId])];
      const recent = inLast24h(post);
      const seenMacro = new Set();
      const seenSub = new Set();
      for (const [macro, sub] of post.topics) {
        if (!seenMacro.has(macro)) {
          seenMacro.add(macro);
          const acc = ensure(topicAcc, macro);
          acc.trend[di]++;
          if (rosterPersonKey(authorsById[post.authorId])) acc.mByDay[di].add(rosterPersonKey(authorsById[post.authorId]));
          acc.postIds.w.push(post.id);
          if (di === 6) acc.postIds.t.push(post.id);
          for (const s of scopes) {
            const bucket = di === 6 ? acc.t[s] : null;
            if (bucket) addScope(bucket, post, authorsById[post.authorId]);
            if (recent) addScope(acc.r24[s], post, authorsById[post.authorId]);
            addScope(acc.w[s], post, authorsById[post.authorId]);
          }
        }
        if (sub && !seenSub.has(`${macro}/${sub}`)) {
          seenSub.add(`${macro}/${sub}`);
          const acc = ensure(subAcc, `${macro}/${sub}`);
          acc.trend[di]++;
          acc.postIds.w.push(post.id);
          if (di === 6) acc.postIds.t.push(post.id);
          if (post.type !== 'retweet') acc.leadEng.set(post.authorId, (acc.leadEng.get(post.authorId) || 0) + post.engN);
          for (const s of scopes) {
            if (di === 6) addScope(acc.t[s], post, authorsById[post.authorId]);
            addScope(acc.w[s], post, authorsById[post.authorId]);
          }
        }
      }
    }
  }

  const handleOf = (authorId) => authorsById[authorId]?.handle ? `@${authorsById[authorId].handle}` : null;
  // Row post lists are newest-first so the drill-down can render them as-is.
  const createdAtById = new Map(allPosts.map((x) => [x.id, x.createdAt]));
  const newestFirst = (ids) => ids.slice().sort((a, b) => {
    const ca = createdAtById.get(a) || '', cb = createdAtById.get(b) || '';
    return ca === cb ? (a < b ? 1 : -1) : (ca < cb ? 1 : -1);
  });
  const rowPostIds = (acc) => ({ t: newestFirst(acc.postIds.t), w: newestFirst(acc.postIds.w) });
  const topics = [...topicAcc.entries()].map(([key, acc]) => {
    const trend = acc.trend;
    // Baseline = the six full days before today (trend[0..5]); current = last 24h.
    const avg6 = trend.slice(0, 6).reduce((a, b) => a + b, 0) / 6 || 1;
    const rAll = acc.r24.All;
    const d = Math.round(100 * (rAll.n - avg6) / avg6);
    const mAvg = acc.mByDay.slice(0, 6).reduce((a, s) => a + s.size, 0) / 6 || 1;
    const weekAll = acc.w.All;
    const epAvg = weekAll.n ? weekAll.eng / weekAll.n : 1;
    const mo = momentum({
      c: KEYS.map((k) => acc.r24[k].n),
      trend, d,
      m: rAll.members.size, mAvg,
      eng: rAll.eng, epAvg
    });
    const subs = [...subAcc.entries()]
      .filter(([sk]) => sk.startsWith(`${key}/`))
      .map(([sk, sa]) => {
        const lead = [...sa.leadEng.entries()].sort((a, b) => b[1] - a[1])[0];
        return {
          key: sk.split('/')[1],
          t: Object.fromEntries(['All', ...KEYS].map((k) => [k, finishScope(sa.t[k])])),
          w: Object.fromEntries(['All', ...KEYS].map((k) => [k, finishScope(sa.w[k])])),
          lead: lead ? handleOf(lead[0]) : null,
          leadPostId: lead ? allPosts.filter((x) => x.authorId === lead[0] && sa.postIds.w.includes(x.id)).sort((a,b) => b.engN - a.engN)[0]?.id : null,
          postIds: rowPostIds(sa)
        };
      })
      .sort((a, b) => b.t.All.n - a.t.All.n || b.w.All.n - a.w.All.n);
    return {
      key,
      name: tax[key]?.label || labelOf(key),
      t: Object.fromEntries(['All', ...KEYS].map((k) => [k, finishScope(acc.t[k])])),
      w: Object.fromEntries(['All', ...KEYS].map((k) => [k, finishScope(acc.w[k])])),
      trend, d, mAvg: Math.round(mAvg * 10) / 10, epAvg: Math.round(epAvg),
      momentum: { score: mo.score, drivers: mo.drivers.slice(0, 2).map(([n]) => n), volume: mo.volume, accel: mo.accel, adoption: mo.adoption, eff: Math.round(mo.eff * 10) / 10, engLift: mo.engLift },
      subs,
      postIds: rowPostIds(acc)
    };
  }).sort((a, b) => b.t.All.n - a.t.All.n || b.w.All.n - a.w.All.n);

  // ── labels map (needed by phrases below) ──
  const labels = {};
  for (const [k, macro] of Object.entries(tax)) {
    labels[k] = macro.label;
    for (const [sk, sub] of Object.entries(macro.subtopics || {})) labels[`${k}/${sk}`] = sub.label;
  }

  // ── stats per scope × window ──
  const stats = {};
  for (const scope of ['All', ...KEYS]) {
    const inScope = (post) => scope === 'All' || caucusKeysOf(authorsById[post.authorId]).includes(scope);
    const windows = { t: postsByDay.get(today).filter(inScope), w: allPosts.filter(inScope) };
    stats[scope] = {};
    for (const [wk, posts] of Object.entries(windows)) {
      const n = posts.length;
      const orig = posts.filter((x) => x.type === 'tweet' || x.type === 'quote').length;
      const replies = posts.filter((x) => x.type === 'reply').length;
      const reposts = n - orig - replies;
      const eng = posts.reduce((a, x) => a + x.engN, 0);
      const byMember = new Map();
      for (const x of posts) byMember.set(x.authorId, (byMember.get(x.authorId) || 0) + x.engN);
      const top10 = [...byMember.values()].sort((a, b) => b - a).slice(0, 10).reduce((a, b) => a + b, 0);
      // engagement vs the prior-6-day daily average for this scope
      const prior = allPosts.filter((x) => x.date !== today && inScope(x));
      const priorDaily = prior.reduce((a, x) => a + x.engN, 0) / 6 || 1;
      stats[scope][wk] = {
        posts: n,
        mix: n ? [Math.round(100 * orig / n), Math.round(100 * replies / n), Math.max(0, 100 - Math.round(100 * orig / n) - Math.round(100 * replies / n))] : [0, 0, 0],
        accounts: byMember.size,
        members: new Set(posts.map((x) => rosterPersonKey(authorsById[x.authorId])).filter(Boolean)).size,
        unidentifiedAccounts: new Set(posts.filter((x) => !rosterPersonKey(authorsById[x.authorId])).map((x) => x.authorId)).size,
        classified: posts.filter((x) => x.classificationStatus === 'complete').length,
        tagged: posts.filter((x) => x.topics.length).length,
        pending: posts.filter((x) => x.classificationStatus === 'pending').length,
        corePosts: posts.filter((x) => x.topics.some(([macro]) => Object.values(settings.core_messages).some((keys) => keys.includes(macro)))).length,
        coreCounts: Object.fromEntries(Object.entries(settings.core_messages).map(([name, keys]) => [name, posts.filter((x) => x.topics.some(([macro]) => keys.includes(macro))).length])),
        eng,
        perPost: n ? Math.round(eng / n) : 0,
        top10Share: eng ? Math.round(100 * top10 / eng) : 0,
        engDelta: wk === 't' ? Math.round(100 * (eng - priorDaily) / priorDaily) : 0
      };
    }
    // 48h capture curve: 16 × 3h buckets, oldest first
    const now = Date.now();
    const curve = Array.from({ length: 16 }, () => 0);
    for (const x of allPosts) {
      if (!inScope(x)) continue;
      const age = now - new Date(x.createdAt).getTime();
      if (age < 0 || age >= 2 * DAY) continue;
      curve[15 - Math.floor(age / (3 * 3_600_000))]++;
    }
    stats[scope].curve48 = curve;
  }

  // ── phrases over the 7-day window: FAMILIES, not bare n-grams ──
  // A phrase family = a canonical 2-4-gram plus its variants (one token edit,
  // or containment with the same head noun), per the design spec. Reported
  // per family: pillar (which core message it serves), origin (+leadership),
  // cumulative adoption curve, unity inputs (cm per caucus), and discipline
  // (share of uses in the exact canonical wording).
  const ledger = readJSON(p('data', 'phrases.json'), {});
  const nonRt = allPosts.filter((x) => x.type !== 'retweet');
  const mined = minePhrases(nonRt.filter((x) => rosterPersonKey(authorsById[x.authorId])).map((x) => ({ ...x, authorId: rosterPersonKey(authorsById[x.authorId]) })), {
    minMembers: settings.syntax.min_members,
    minNgram: settings.syntax.min_ngram,
    maxNgram: settings.syntax.max_ngram
  }).slice(0, 30);
  const families = clusterFamilies(mined.map((m) => m.phrase));

  const pillarOf = (macro) => Object.entries(settings.core_messages).find(([, keys]) => keys.includes(macro))?.[0] || null;
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const tokenized = nonRt.map((x) => ({ x, padded: ` ${tokenize(x.text).join(' ')} ` }));

  const phrases = families.map((variants) => {
    const hits = tokenized
      .map(({ x, padded }) => ({ x, matched: variants.filter((v) => padded.includes(` ${v} `)) }))
      .filter((h) => h.matched.length);
    if (!hits.length) return null;
    const useCount = new Map(variants.map((v) => [v, hits.filter((h) => h.matched.includes(v)).length]));
    const canonical = variants.slice().sort((a, b) => useCount.get(b) - useCount.get(a))[0];
    const users = new Map(); // authorId → first date in window
    const topicCount = new Map();
    const subCount = new Map();
    for (const { x } of hits) {
      if (!users.has(x.authorId) || users.get(x.authorId) > x.date) users.set(x.authorId, x.date);
      for (const [macro, sub] of x.topics) {
        topicCount.set(macro, (topicCount.get(macro) || 0) + 1);
        if (sub) subCount.set(`${macro}/${sub}`, (subCount.get(`${macro}/${sub}`) || 0) + 1);
      }
    }
    // cumulative distinct adopters by day, honoring earlier first-use from the ledger
    const memberFirst = { ...Object.fromEntries(users) };
    for (const v of variants) {
      for (const [a, d] of Object.entries(ledger[v]?.memberFirst || {})) {
        if (!isHouse(authorsById[a])) continue; // ledger entries predating the roster filter
        if (!memberFirst[a] || memberFirst[a] > d) memberFirst[a] = d;
      }
    }
    const personFirst = new Map();
    for (const [account, date] of Object.entries(memberFirst)) {
      const person = rosterPersonKey(authorsById[account]);
      if (person && (!personFirst.has(person) || date < personFirst.get(person))) personFirst.set(person, date);
    }
    const adopt = days.map(() => 0);
    for (const d of personFirst.values()) {
      const idx = dayIndex.has(d) ? dayIndex.get(d) : (d < days[0] ? 0 : 6);
      adopt[idx]++;
    }
    for (let i = 1; i < adopt.length; i++) adopt[i] += adopt[i - 1];
    const led = variants.map((v) => ledger[v]).filter(Boolean).sort((a, b) => (a.firstSeen < b.firstSeen ? -1 : 1))[0];
    const firstSeen = led?.firstSeen && led.firstSeen < today ? led.firstSeen : [...users.values()].sort()[0] || today;
    const firstAuthorId = led?.firstAuthorId || [...users.entries()].sort((a, b) => (a[1] < b[1] ? -1 : 1))[0]?.[0];
    const topMacro = [...topicCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const topSub = [...subCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    return {
      text: canonical,
      variants: variants.filter((v) => v !== canonical),
      pillar: topMacro ? pillarOf(topMacro) : null,
      topic: topSub ? (labels[topSub] || labelOf(topSub)) : topMacro ? (tax[topMacro]?.label || labelOf(topMacro)) : null,
      first: firstAuthorId ? handleOf(firstAuthorId) : null,
      firstPostId: hits.map((h) => h.x).filter((x) => x.authorId === firstAuthorId).sort((a,b) => a.createdAt.localeCompare(b.createdAt))[0]?.id || null,
      postIds: hits.map((h) => h.x.id),
      firstSeen,
      leadership: Boolean((authorsById[firstAuthorId]?.caucuses || []).includes(settings.leadership_tag)),
      spread: new Set([...users.keys()].map((id) => rosterPersonKey(authorsById[id])).filter(Boolean)).size,
      accounts: users.size,
      cm: KEYS.map((k) => new Set([...users.keys()].filter((a) => caucusKeysOf(authorsById[a]).includes(k)).map((a) => rosterPersonKey(authorsById[a])).filter(Boolean)).size),
      adopt,
      exact: hits.length ? Math.round(100 * hits.filter((h) => h.matched.includes(canonical)).length / hits.length) / 100 : 1,
      total: hits.length,
      eng: hits.reduce((a, h) => a + h.x.engN, 0)
    };
  }).filter((x) => x && x.spread >= settings.syntax.min_members).sort((a, b) => b.spread - a.spread).slice(0, 12);

  // ── emerging: cross-day story candidates (data/stories.json, built by
  // src/stories.js) — falls back to the latest nightly's raw clusters when
  // the story file has not been built yet. Only candidates the placement
  // pass called a story or a taxonomy gap are shown; noise stays out.
  let clusters = [];
  const seeds = new Map(); // cluster → its post ids (for the similar-unlabeled list; not written out)
  const storyFile = readJSON(p('data', 'stories.json'), null);
  const storyCands = (storyFile?.candidates || [])
    .filter((c) => c.placement && c.placement.kind !== 'noise' && !(storyFile.promoted || []).includes(`${c.placement.macro}/${c.placement.key}`))
    .map((c) => ({ label: c.placement.label, ids: c.ids, kind: c.placement.kind, macro: c.placement.macro, key: c.placement.key, days: c.days }));
  const raw = days.flatMap((date) => dayAssignments(date).emerging || []);
  const emergingSources = combineEmergingSources({ placed:storyCands, raw, posts:allPosts, authorsById });
  // Keep every currently active cluster meeting the three-person threshold;
  // use remaining slots for other observed candidates rather than suppressing
  // a live discovery simply because placed stories already exist.
  const visibleEmerging = emergingSources.filter((entry, index) => (entry.active && entry.thresholdMet) || index < 12);
  {
    const byId = new Map(allPosts.map((x) => [x.id, x]));
    clusters = visibleEmerging.map((e) => {
      const posts = e.ids.map((id) => byId.get(id)).filter(Boolean);
      if (!posts.length) return null;
      posts.sort((a, b) => a.createdAt < b.createdAt ? -1 : 1);
      const since = posts[0].createdAt;
      const spanMs = Math.max(1, Date.now() - new Date(since).getTime());
      const shape = Array.from({ length: 8 }, () => 0);
      for (const x of posts) {
        shape[Math.min(7, Math.floor(8 * (new Date(x.createdAt).getTime() - new Date(since).getTime()) / spanMs))]++;
      }
      for (let i = 1; i < 8; i++) shape[i] += shape[i - 1]; // cumulative growth curve
      const gramCount = new Map();
      for (const x of posts) {
        for (const g of new Set(ngrams(tokenize(x.text), 2, 3))) gramCount.set(g, (gramCount.get(g) || 0) + 1);
      }
      const topGram = [...gramCount.entries()].sort((a, b) => b[1] - a[1])[0];
      const members = new Set(posts.map((x) => x.authorId));
      const best = posts.slice().sort((a, b) => b.engN - a.engN)[0];
      const cluster = {
        label: e.label,
        lastSeen: e.lastSeen,
        thresholdMet: e.thresholdMet,
        activeMembers: e.activeMembers,
        provisional: e.provisional,
        discoverySources: e.sources,
        posts: posts.length,
        members: new Set(posts.map((x) => rosterPersonKey(authorsById[x.authorId])).filter(Boolean)).size,
        accounts: members.size,
        postIds: posts.map((x) => x.id),
        sourcePosts: posts.map((x) => ({ id: x.id, handle: handleOf(x.authorId), time: x.createdAt })),
        sampleId: best.id,
        sampleHandle: handleOf(best.authorId),
        who: [...members].map(handleOf).filter(Boolean),
        cm: KEYS.map((k) => new Set([...members].filter((a) => caucusKeysOf(authorsById[a]).includes(k)).map((a) => rosterPersonKey(authorsById[a])).filter(Boolean)).size),
        eng: posts.reduce((a, x) => a + x.engN, 0),
        phrase: topGram?.[0] || null,
        coherence: topGram ? Math.round(100 * topGram[1] / posts.length) : 0,
        since,
        shape,
        sample: best.text.length > 160 ? best.text.slice(0, 159).replace(/\s+\S*$/, '') + '…' : best.text,
        suggest: e.key || e.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
        kind: e.kind || null,      // 'story' | 'gap' | null (raw nightly cluster)
        macro: e.macro || null,    // suggested parent macro id
        days: e.days || null       // distinct days the subject surfaced
      };
      seeds.set(cluster, e.ids);
      return cluster;
    }).filter(Boolean);
  }

  // Only the public reporting store can enter published dashboard context.
  // A retrieved match is a reading lead, separate from sources actually used
  // by an accepted classification; no inbox-derived fields are copied.
  const news = loadNews({ days: 10 });
  const newsCoverage = buildNewsCoverage({ items: loadNews().items, sources: loadSources().sources, status: readStatus() });
  for (const c of clusters) {
    const { evidence } = retrieveEvidence(`${c.label} ${c.sample}`, { items: news.items, asOf: new Date().toISOString(), k: 3, windowAfterDays: 0 });
    c.context = evidence.map(evidenceLine);
  }

  // ── similar, unlabeled: the embedding index against each emerging cluster
  // and each story row (attachRelated above). Skipped, with one line, when
  // there is no index on disk yet.
  const related = attachRelated({
    clusters, seeds, topics, tax, posts: allPosts, handleOf,
    semantic: loadSemanticOrNull({ warn: (m) => console.warn(`[sitedata] ${m}`) })
  });

  // ── feed: window posts, newest first ──
  const feed = allPosts
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 200)
    .map((x) => {
      const a = authorsById[x.authorId] || {};
      return {
        id: x.id,
        handle: a.handle ? `@${a.handle}` : x.authorId,
        member: a.member || a.name || '',
        district: a.stateDistrict || '',
        caucus: caucusKeysOf(a),
        text: x.text,
        topics: [...new Set(x.topics.flatMap(([m, s]) => s ? [`${m}/${s}`, m] : [m]))],
        time: x.createdAt,
        date: x.date,
        engN: x.engN,
        kind: x.type === 'tweet' ? 'original' : x.type === 'retweet' ? 'repost' : x.type,
        quoted: compactQuote(x.quoted),
        classificationStatus: x.classificationStatus,
        needsContext: x.needsContext,
        sourceIncomplete: x.sourceIncomplete,
        sourceContextReason: x.sourceContextReason,
        sourceReferenceId: x.sourceReferenceId,
        provenance: publicProvenance(x.provenance),
        metricsObservedAt: x.metricsObservedAt,
        isNew: Boolean(state.lastPollAt && x.capturedAt === state.lastPollAt)
      };
    });

  // ── feedAll: every captured House post in the window, for the story drill-down ──
  // The 200-post `feed` above stays as the default Feed card; a Topics row
  // opens to its whole post list via `postIds` + this table. Compact rows:
  // authors resolve client-side through `authorHandles` → `members`.
  const feedTopics = (x) => [...new Set(x.topics.flatMap(([m, s]) => s ? [`${m}/${s}`, m] : [m]))];
  const feedAllFull = allPosts
    .slice()
    .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : (a.createdAt < b.createdAt ? 1 : -1)))
    .map((x) => {
      const row = { id: x.id, authorId: x.authorId, createdAt: x.createdAt, date: x.date, type: x.type, text: x.text, engN: x.engN, topics: feedTopics(x), classificationStatus: x.classificationStatus, needsContext: x.needsContext, sourceIncomplete: x.sourceIncomplete, sourceContextReason: x.sourceContextReason, sourceReferenceId: x.sourceReferenceId, provenance: publicProvenance(x.provenance), metricsObservedAt: x.metricsObservedAt };
      if (x.quoted) row.quoted = compactQuote(x.quoted);
      return row;
    });
  const authorHandles = {};
  for (const x of feedAllFull) {
    if (authorHandles[x.authorId] !== undefined) continue;
    const h = handleOf(x.authorId);
    authorHandles[x.authorId] = h || x.authorId;
  }

  // ── members map + per-caucus active counts (posted in the 7-day window) ──
  // House accounts only, so `accounts` is the roster the numbers describe.
  const members = {};
  let nonHouseAccounts = 0;
  for (const a of Object.values(authorsById)) {
    if (!isHouse(a)) { if (a.onList !== false && !a.stale) nonHouseAccounts++; continue; }
    if (a.handle) members[`@${a.handle}`] = [a.member || a.name || a.handle, a.stateDistrict || '', caucusKeysOf(a)];
  }

  // Incidents pass through whole: status (provisional | active | monitoring |
  // resolved), lifecycle, corroboration, per-post evidence spans and flags,
  // intel. `incidentsFiltered` is how many classifier flags the desk's
  // deterministic post-filter dropped this build (src/incidents.js).
  const incidentsFile = readJSON(incidentsPath, { incidents: [], filtered: [] });
  incidentsFile.incidents = incidentsFile.incidents.map((incident) => hydrateIncidentSources(incident, allPosts));

  const core = Object.entries(settings.core_messages).map(([name, keys]) => ({ name, topics: keys }));

  // Active accounts per caucus in the window — the unity threshold's denominator.
  const activeByCaucus = Object.fromEntries(KEYS.map((k) => [k, new Set()]));
  for (const x of allPosts) {
    for (const k of caucusKeysOf(authorsById[x.authorId])) rosterPersonKey(authorsById[x.authorId]) && activeByCaucus[k].add(rosterPersonKey(authorsById[x.authorId]));
  }

  const out = {
    generatedAt: new Date().toISOString(),
    lastPollAt: state.lastPollAt || null,
    lastPollAttemptAt: state.lastPollAttemptAt || null,
    lastPollOutcome: state.lastPollOutcome || null,
    captureInProgress: Boolean(state.pollProgress),
    rosterMembers: new Set(Object.values(authorsById).filter(isHouse).map(rosterPersonKey).filter(Boolean)).size,
    floor: buildFloorDisplay({ agenda: loadFloor({ now: new Date(nowMs).toISOString() }),
      posts: allPosts.map((post) => ({ ...post, reposted: resolveRepost(post), quoting: quotingFor(resolveFloorQuote(post)) })),
      authors: authorsById, personKey: rosterPersonKey, now: nowMs }),
    news: { version: news.version, items: news.items.length, latestPublishedAt: news.items.map((item) => item.publishedAt).filter(Boolean).sort().at(-1) || null, latestFetchedAt: news.items.map((item) => item.fetchedAt).filter(Boolean).sort().at(-1) || null, latest: news.items.slice(0, 8).map((item) => evidenceLine({ ...item, kind: 'lead', passage: item.title })), coverage: newsCoverage },
    timezone: settings.timezone,
    today,
    days,
    accounts: Object.keys(members).length,
    // What the roster filter left out: non-House accounts on the List, and
    // their posts in the window (`posts`) and today (`t`).
    excluded: { accounts: nonHouseAccounts, ...excluded },
    caucusKeys: KEYS,
    caucusNames: Object.fromEntries(Object.entries(settings.caucus_keys).map(([tag, k]) => [k, settings.caucuses[tag]])),
    caucusActive: Object.fromEntries(KEYS.map((k) => [k, activeByCaucus[k].size])),
    // Classifier reach: the latest day with topics, and whether the rolling
    // 24h momentum window has any classified posts at all.
    classification,
    core,
    labels,
    members,
    stats,
    topics,
    phrases,
    clusters,
    emergingCoverage: { total:emergingSources.length, displayed:clusters.length, activeThresholdClusters:emergingSources.filter((entry) => entry.active && entry.thresholdMet).length },
    incidents: incidentsFile.incidents,
    incidentsFiltered: (incidentsFile.filtered || []).length,
    feed,
    authorHandles,
    feedAll: feedAllFull,
    feedAllTruncated: false,
    feedAllTotal: feedAllFull.length,
    feedAllFiles: []
  };
  // Size guard: measure the file exactly as writeJSON serialises it.
  const sizeOf = (list) => Buffer.byteLength(JSON.stringify({ ...out, feedAll: list }, null, 1)) + 1;
  const fit = fitFeedAll(feedAllFull, sizeOf, ROLLUPS_MAX_BYTES - 10_000);
  out.feedAll = fit.feedAll;
  out.feedAllTruncated = fit.truncated;
  // Full-text overflow remains available, including pending classifications.
  // Each shard is published in the same Pages snapshot as its manifest.
  if (fit.truncated) {
    for (let i = 0; i < feedAllFull.length; i += 400) {
      const page = feedAllFull.slice(i, i + 400);
      const hash = createHash('sha256').update(JSON.stringify(page)).digest('hex').slice(0, 16);
      const name = `feed-${Math.floor(i / 400)}-${hash}.json`;
      writeJSON(p('site', 'data', name), page);
      out.feedAllFiles.push(name);
    }
  }
  if (Buffer.byteLength(JSON.stringify(out, null, 1)) + 1 >= ROLLUPS_MAX_BYTES) throw new Error('Dashboard summary exceeds its size limit');
  writeJSON(rollupsJsonPath, out);
  // Old derived shards can be rebuilt from the archive; avoid retaining every
  // metric refresh as another loose file in the latest deployment.
  for (const name of fs.readdirSync(p('site', 'data'))) {
    if (/^feed-\d+(?:-[a-f0-9]{16})?\.json$/.test(name) && !out.feedAllFiles.includes(name)) fs.unlinkSync(p('site', 'data', name));
  }
  const provisional = incidentsFile.incidents.filter((i) => i.status === 'provisional').length;
  console.log(`[sitedata] rollups.json: ${topics.length} topics, ${phrases.length} phrases, ${clusters.length} clusters (${clusters.filter((c) => c.context?.length).length} with outside context), ${incidentsFile.incidents.length} incidents (${provisional} provisional, ${(incidentsFile.filtered || []).length} flags filtered), ${feed.length} feed posts, ${out.feedAll.length}${fit.truncated ? ` of ${feedAllFull.length} (truncated to stay under ${ROLLUPS_MAX_BYTES} bytes)` : ''} drill-down posts; similar-unlabeled lists on ${related.clusters} cluster(s) and ${related.subs} story row(s); ${excluded.posts} post(s) from ${nonHouseAccounts} non-House account(s) excluded`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  buildSiteData();
}
