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
import { p, settings, readJSON, writeJSON, daysAgoEt } from './util.js';
import { loadDay, topicsPath, metricsPath, loadState } from './store.js';
import { liveTopicsPath } from './classify-live.js';
import { loadAuthors } from './authors.js';
import { loadTaxonomy, labelOf } from './taxonomy.js';
import { momentum } from './momentum.js';
import { minePhrases, tokenize, ngrams } from './syntax.js';
import { incidentsPath } from './incidents.js';

const KEYS = [...new Set(Object.values(settings.caucus_keys))]; // display order: CPC, NewDem, CBC
const DAY = 86_400_000;

export const rollupsJsonPath = p('site', 'data', 'rollups.json');

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
  return {
    assignments: { ...(live?.assignments || {}), ...(nightly?.assignments || {}) },
    emerging: nightly?.emerging || [],
    hasNightly: Boolean(nightly)
  };
}

function engagementOf(m) {
  if (!m || m.unavailable) return 0;
  return (m.likes || 0) + (m.retweets || 0) + (m.replies || 0) + (m.quotes || 0);
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

// Which outside-context entry (data/context.json, see docs/OUTSIDE_CONTEXT.md)
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

function zeroScope() {
  return { n: 0, eng: 0, members: new Set() };
}

function finishScope(s) {
  return { n: s.n, eng: s.eng, m: s.members.size };
}

export function buildSiteData() {
  const state = loadState();
  const authorsById = loadAuthors().byId;
  const tax = loadTaxonomy();
  const days = Array.from({ length: 7 }, (_, i) => daysAgoEt(6 - i)); // oldest → today
  const today = days[6];

  // ── load the window: posts with resolved engagement + topics ──
  const postsByDay = new Map();
  const allPosts = [];
  for (const date of days) {
    const metrics = readJSON(metricsPath(date), {});
    const { assignments } = dayAssignments(date);
    const posts = loadDay(date).map((t) => {
      const m = metrics[t.id];
      const cap = t.metricsAtCapture || {};
      return {
        ...t,
        engN: t.type === 'retweet' ? 0 : (m && !m.unavailable)
          ? engagementOf(m)
          : (cap.likes || 0) + (cap.retweets || 0) + (cap.replies || 0) + (cap.quotes || 0),
        topics: assignments[t.id] || [],
        date
      };
    });
    postsByDay.set(date, posts);
    allPosts.push(...posts);
  }

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
        leadEng: new Map() // authorId → eng (for sub lead)
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
          acc.mByDay[di].add(post.authorId);
          for (const s of scopes) {
            const bucket = di === 6 ? acc.t[s] : null;
            if (bucket) { bucket.n++; bucket.eng += post.engN; bucket.members.add(post.authorId); }
            if (recent) { acc.r24[s].n++; acc.r24[s].eng += post.engN; acc.r24[s].members.add(post.authorId); }
            acc.w[s].n++; acc.w[s].eng += post.engN; acc.w[s].members.add(post.authorId);
          }
        }
        if (sub && !seenSub.has(`${macro}/${sub}`)) {
          seenSub.add(`${macro}/${sub}`);
          const acc = ensure(subAcc, `${macro}/${sub}`);
          acc.trend[di]++;
          if (post.type !== 'retweet') acc.leadEng.set(post.authorId, (acc.leadEng.get(post.authorId) || 0) + post.engN);
          for (const s of scopes) {
            if (di === 6) { acc.t[s].n++; acc.t[s].eng += post.engN; acc.t[s].members.add(post.authorId); }
            acc.w[s].n++; acc.w[s].eng += post.engN; acc.w[s].members.add(post.authorId);
          }
        }
      }
    }
  }

  const handleOf = (authorId) => authorsById[authorId]?.handle ? `@${authorsById[authorId].handle}` : null;
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
          lead: lead ? handleOf(lead[0]) : null
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
      subs
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
        members: byMember.size,
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
  const mined = minePhrases(nonRt, {
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
        if (!memberFirst[a] || memberFirst[a] > d) memberFirst[a] = d;
      }
    }
    const adopt = days.map(() => 0);
    for (const d of Object.values(memberFirst)) {
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
      firstSeen,
      leadership: Boolean((authorsById[firstAuthorId]?.caucuses || []).includes(settings.leadership_tag)),
      spread: users.size,
      cm: KEYS.map((k) => [...users.keys()].filter((a) => caucusKeysOf(authorsById[a]).includes(k)).length),
      adopt,
      exact: hits.length ? Math.round(100 * hits.filter((h) => h.matched.includes(canonical)).length / hits.length) / 100 : 1,
      total: hits.length,
      eng: hits.reduce((a, h) => a + h.x.engN, 0)
    };
  }).filter(Boolean).sort((a, b) => b.spread - a.spread).slice(0, 12);

  // ── emerging: cross-day story candidates (data/stories.json, built by
  // src/stories.js) — falls back to the latest nightly's raw clusters when
  // the story file has not been built yet. Only candidates the placement
  // pass called a story or a taxonomy gap are shown; noise stays out.
  let clusters = [];
  const storyFile = readJSON(p('data', 'stories.json'), null);
  const storyCands = (storyFile?.candidates || [])
    .filter((c) => c.placement && c.placement.kind !== 'noise' && !(storyFile.promoted || []).includes(`${c.placement.macro}/${c.placement.key}`))
    .slice(0, 12)
    .map((c) => ({ label: c.placement.label, ids: c.ids, kind: c.placement.kind, macro: c.placement.macro, key: c.placement.key, days: c.days }));
  const raw = storyCands.length ? [] : (() => {
    for (let d = 0; d < 3; d++) {
      const file = readJSON(topicsPath(daysAgoEt(d)), null);
      if (file?.emerging?.length) return file.emerging;
    }
    return [];
  })();
  {
    const byId = new Map(allPosts.map((x) => [x.id, x]));
    clusters = (storyCands.length ? storyCands : raw).map((e) => {
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
      return {
        label: e.label,
        posts: posts.length,
        members: members.size,
        who: [...members].map(handleOf).filter(Boolean),
        cm: KEYS.map((k) => [...members].filter((a) => caucusKeysOf(authorsById[a]).includes(k)).length),
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
    }).filter(Boolean);
  }

  // ── outside context: newsletter hits per story candidate (data/context.json,
  // hand-searched from the owner's inbox — unreviewed context, not
  // verification). Top 3 per cluster; clusters without an entry get [].
  const context = readJSON(p('data', 'context.json'), null);
  for (const c of clusters) {
    const k = contextKeyFor(c, context?.stories);
    c.context = (k ? context.stories[k].matches : []).slice(0, 3)
      .map(({ sender, subject, date, why }) => ({ sender, subject, date, why: why || null }));
  }

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
        isNew: Boolean(state.lastPollAt && x.capturedAt === state.lastPollAt)
      };
    });

  // ── members map + per-caucus active counts (posted in the 7-day window) ──
  const members = {};
  for (const a of Object.values(authorsById)) {
    if (a.handle) members[`@${a.handle}`] = [a.member || a.name || a.handle, a.stateDistrict || '', caucusKeysOf(a)];
  }

  const incidentsFile = readJSON(incidentsPath, { incidents: [] });

  const core = Object.entries(settings.core_messages).map(([name, keys]) => ({ name, topics: keys }));

  // Active accounts per caucus in the window — the unity threshold's denominator.
  const activeByCaucus = Object.fromEntries(KEYS.map((k) => [k, new Set()]));
  for (const x of allPosts) {
    for (const k of caucusKeysOf(authorsById[x.authorId])) activeByCaucus[k].add(x.authorId);
  }

  writeJSON(rollupsJsonPath, {
    generatedAt: new Date().toISOString(),
    lastPollAt: state.lastPollAt || null,
    timezone: settings.timezone,
    today,
    days,
    accounts: Object.keys(members).length,
    caucusKeys: KEYS,
    caucusNames: Object.fromEntries(Object.entries(settings.caucus_keys).map(([tag, k]) => [k, settings.caucuses[tag]])),
    caucusActive: Object.fromEntries(KEYS.map((k) => [k, activeByCaucus[k].size])),
    core,
    labels,
    members,
    stats,
    topics,
    phrases,
    clusters,
    incidents: incidentsFile.incidents,
    feed
  });
  console.log(`[sitedata] rollups.json: ${topics.length} topics, ${phrases.length} phrases, ${clusters.length} clusters (${clusters.filter((c) => c.context.length).length} with outside context), ${incidentsFile.incidents.length} incidents, ${feed.length} feed posts`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  buildSiteData();
}
