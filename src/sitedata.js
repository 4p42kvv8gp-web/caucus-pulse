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
  const topicAcc = new Map(); // key → {t: {All: scope, CPC..}, w: {...}, trend: number[7], mByDay: Set[7], engByDay: number[7], nByDay}
  const subAcc = new Map();   // 'macro/sub' → same-ish + leads
  const ensure = (map, key) => {
    if (!map.has(key)) {
      map.set(key, {
        t: Object.fromEntries(['All', ...KEYS].map((k) => [k, zeroScope()])),
        w: Object.fromEntries(['All', ...KEYS].map((k) => [k, zeroScope()])),
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
    const avg7 = trend.reduce((a, b) => a + b, 0) / trend.length || 1;
    const d = Math.round(100 * (trend[6] - avg7) / avg7);
    const mAvg = acc.mByDay.reduce((a, s) => a + s.size, 0) / 7 || 1;
    const weekAll = acc.w.All;
    const epAvg = weekAll.n ? weekAll.eng / weekAll.n : 1;
    const tAll = acc.t.All;
    const mo = momentum({
      c: KEYS.map((k) => acc.t[k].n),
      trend, d,
      m: tAll.members.size, mAvg,
      eng: tAll.eng, epAvg
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

  // ── phrases over the 7-day window ──
  const ledger = readJSON(p('data', 'phrases.json'), {});
  const nonRt = allPosts.filter((x) => x.type !== 'retweet');
  const mined = minePhrases(nonRt, {
    minMembers: settings.syntax.min_members,
    minNgram: settings.syntax.min_ngram,
    maxNgram: settings.syntax.max_ngram
  }).slice(0, 12);
  const phrases = mined.map(({ phrase }) => {
    const users = new Map(); // authorId → first date in window
    const topicCount = new Map();
    let total = 0, eng = 0;
    for (const x of nonRt) {
      if (!(` ${tokenize(x.text).join(' ')} `).includes(` ${phrase} `)) continue;
      total++; eng += x.engN;
      if (!users.has(x.authorId) || users.get(x.authorId) > x.date) users.set(x.authorId, x.date);
      for (const [macro] of x.topics) topicCount.set(macro, (topicCount.get(macro) || 0) + 1);
    }
    const led = ledger[phrase];
    const memberFirst = { ...Object.fromEntries(users), ...(led?.memberFirst || {}) };
    const cm = KEYS.map((k) => [...users.keys()].filter((a) => caucusKeysOf(authorsById[a]).includes(k)).length);
    const firstSeen = led?.firstSeen && led.firstSeen < today ? led.firstSeen : [...users.values()].sort()[0] || today;
    const topTopic = [...topicCount.entries()].sort((a, b) => b[1] - a[1])[0];
    const cutoff48 = daysAgoEt(1);
    return {
      text: phrase,
      cm,
      first: led?.firstAuthor ? `@${led.firstAuthor}` : handleOf([...users.entries()].sort((a, b) => a[1] < b[1] ? -1 : 1)[0]?.[0]),
      firstSeen,
      spread: users.size,
      total,
      eng,
      emerging: firstSeen >= daysAgoEt(6),
      topic: topTopic ? (tax[topTopic[0]]?.label || labelOf(topTopic[0])) : null,
      delta: [...users.keys()].filter((a) => (memberFirst[a] || today) >= cutoff48).length
    };
  }).sort((a, b) => b.spread - a.spread);

  // ── emerging clusters (latest nightly that produced any) ──
  let clusters = [];
  for (let d = 0; d < 3 && !clusters.length; d++) {
    const file = readJSON(topicsPath(daysAgoEt(d)), null);
    if (!file?.emerging?.length) continue;
    const byId = new Map(allPosts.map((x) => [x.id, x]));
    clusters = file.emerging.map((e) => {
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
        suggest: e.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
      };
    }).filter(Boolean);
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

  // ── labels + members maps ──
  const labels = {};
  for (const [k, macro] of Object.entries(tax)) {
    labels[k] = macro.label;
    for (const [sk, sub] of Object.entries(macro.subtopics || {})) labels[`${k}/${sk}`] = sub.label;
  }
  const members = {};
  for (const a of Object.values(authorsById)) {
    if (a.handle) members[`@${a.handle}`] = [a.member || a.name || a.handle, a.stateDistrict || '', caucusKeysOf(a)];
  }

  const incidentsFile = readJSON(incidentsPath, { incidents: [] });

  const core = Object.entries(settings.core_messages).map(([name, keys]) => ({ name, topics: keys }));

  writeJSON(rollupsJsonPath, {
    generatedAt: new Date().toISOString(),
    lastPollAt: state.lastPollAt || null,
    timezone: settings.timezone,
    today,
    days,
    caucusKeys: KEYS,
    caucusNames: Object.fromEntries(Object.entries(settings.caucus_keys).map(([tag, k]) => [k, settings.caucuses[tag]])),
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
  console.log(`[sitedata] rollups.json: ${topics.length} topics, ${phrases.length} phrases, ${clusters.length} clusters, ${incidentsFile.incidents.length} incidents, ${feed.length} feed posts`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  buildSiteData();
}
