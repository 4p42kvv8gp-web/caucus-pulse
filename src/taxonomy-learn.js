// The taxonomy learns from the data.
//
// Owner (2026-09-10): "the topics I saw were rather basic, e.g. the midterms
// means nothing to me. Tweets about affordability mean a ton; subtopics in
// there could be utilities, groceries, gas — or you could determine that gas
// is its own bucket because it's getting as much attention as affordability
// as a whole, and then you can run it in both categories or just one, you
// decide! Learn."
//
// So, nightly after classify + stories, for every macro (and for the pool of
// posts the classifier left with no topic at all):
//   1. DISCOVER — read the last window_days of original posts filed under the
//      macro and cluster them by meaning. With a semantic index present
//      (data/embeddings/, src/embedding-index.js) that is agglomerative
//      clustering on the embeddings at settings.taxonomy_learn.cluster_sim;
//      without one, Claude reads the posts in batches (a first sample to
//      find the subjects, then batches assigned against the subjects found so
//      far, adding new ones as they appear). Assignments are cached per post
//      in data/taxonomy-learn.json, so a later night only reads new posts.
//      Then ONE call per macro names each cluster (label, key, aliases, kind:
//      subtopic | story | noise), says whether it duplicates an existing
//      subtopic, and judges the existing subtopics: dead, too coarse,
//      duplicate, misnamed. Every verdict carries a reason.
//   2. MEASURE SHAPE — per macro, each subtopic's (existing and proposed)
//      share of the macro over share_days, members, days. A subtopic that
//      draws elevate_share of its macro (or elevate_factor × the macro's
//      median live-subtopic count) is flagged ELEVATE: it becomes a macro of
//      its own, dual-listed — the subtopic row stays under the parent with
//      `dual: true, of: <new macro>` so history reads both ways and posts may
//      carry both. Near-duplicates are flagged MERGE; subtopics with zero
//      assignments over retire_days are flagged RETIRE.
//   3. PROPOSE — data/taxonomy-proposals.json, one entry per change with the
//      evidence it rests on (posts, members, days, share, sample ids) and the
//      reason. `auto: true` marks adds and retirements that clear the
//      thresholds (at most max_per_night); elevations and merges are never
//      auto unless settings.taxonomy_learn.auto_elevate is true. `--apply`
//      writes the auto ones into config/taxonomy.yaml as text edits (comments
//      survive; every learned row carries `provisional: true` and
//      `learned: <date>`), `--apply --elevate=key` / `--merge=key` applies a
//      named elevation or merge, and the daily report's "Taxonomy learned
//      tonight" section lists every proposal and which were applied.
//   Measured numbers are never overwritten by a judgment: counts come from
//   the archive and data/topics, the model's reasons sit next to them.
//
//   node --use-env-proxy src/taxonomy-learn.js                # discover + measure + propose (no YAML edit)
//   node --use-env-proxy src/taxonomy-learn.js --apply        # …and write the auto proposals into the YAML
//   node --use-env-proxy src/taxonomy-learn.js --apply --elevate=gas-prices --merge=grocery-prices
//   node --use-env-proxy src/taxonomy-learn.js --dry-run      # print the plan, write nothing (calls still run)
//   node --use-env-proxy src/taxonomy-learn.js --no-llm       # cached clusters + measured rules only
//   node --use-env-proxy src/taxonomy-learn.js --macro=economy,unassigned --scan=all --days=14 --calls=40
import fs from 'node:fs';
import yaml from 'js-yaml';
import { anthropicClient, anthropicConfigured } from './anthropic-auth.js';
import { p, settings, readJSON, writeJSON, etDate, addDays } from './util.js';
import { loadDay, topicsPath } from './store.js';
import { loadTaxonomy, renderTaxonomy, parseJsonLoose, ymd } from './taxonomy.js';
import { slug, markRetired, existingSubtopic, assignmentCounts } from './stories.js';
import { loadAuthors, splitByRoster } from './authors.js';
import { quotedResolver } from './quoted.js';

export const proposalsPath = p('data', 'taxonomy-proposals.json');
export const learnStatePath = p('data', 'taxonomy-learn.json');
export const POOL = 'unassigned';            // the empty-assignment pool
export const TYPES = ['add', 'elevate', 'merge', 'retire', 'rename'];
export const KINDS = ['subtopic', 'story', 'noise'];

export const LEARN_DEFAULTS = {
  model: null, window_days: 14, share_days: 7, sample_posts: 60, batch_posts: 100, scan_posts: 360,
  cluster_sim: 0.82, merge_sim: 0.9, min_posts: 8, min_members: 3, elevate_share: 0.6, elevate_factor: 3, elevate_min_share: 0.25,
  retire_days: 21, auto_apply: true, auto_elevate: false, max_per_night: 6, max_calls: 40
};
export const learnSettings = (s = settings.taxonomy_learn) => ({ ...LEARN_DEFAULTS, ...(s || {}) });

const arg = (name, dflt) => {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : dflt;
};

// ── Window ───────────────────────────────────────────────────────────────

// The `days` ET dates before `today`, oldest first (today itself is still
// being captured and never classified yet).
export function windowDates(days, today) {
  return Array.from({ length: days }, (_, i) => addDays(today, -(days - i)));
}

// Every classified ORIGINAL post in the window (retweets inherit an
// assignment and add no text of their own): Map id → {…post, date, topics}.
// Days without a topics file are skipped and not counted as classified.
export function loadWindow(dates, { loadDay: loadDayFn = loadDay, topicsFor = (d) => readJSON(topicsPath(d), null), authorsById = null } = {}) {
  const posts = new Map();
  const classifiedDays = [];
  for (const date of dates) {
    const file = topicsFor(date);
    if (!file?.assignments) continue;
    classifiedDays.push(date);
    const day = authorsById ? splitByRoster(loadDayFn(date), authorsById).house : loadDayFn(date);
    for (const t of day) {
      if (t.type === 'retweet') continue;
      const topics = file.assignments[t.id];
      if (!topics) continue;
      posts.set(t.id, { ...t, date, topics: Array.isArray(topics) ? topics : [] });
    }
  }
  return { posts, classifiedDays };
}

// Posts per pool: each macro's posts (a post under two macros is in both
// pools — that is the point of multi-label) and the unassigned pool.
export function poolsOf(posts, tax) {
  const pools = new Map([[POOL, []]]);
  for (const m of Object.keys(tax || {})) pools.set(m, []);
  for (const t of posts.values()) {
    if (!t.topics.length) { pools.get(POOL).push(t); continue; }
    const seen = new Set();
    for (const [m] of t.topics) {
      if (seen.has(m) || !pools.has(m)) continue;
      seen.add(m);
      pools.get(m).push(t);
    }
  }
  return pools;
}

// What the classifier assigned, per macro: totals over the window and over
// the share window, and each existing subtopic's posts, members, days.
export function existingShape(posts, tax, { shareFrom }) {
  const out = {};
  for (const [m, macro] of Object.entries(tax || {})) {
    out[m] = { total: 0, total7: 0, subs: {} };
    for (const k of Object.keys(macro.subtopics || {})) out[m].subs[k] = { posts: 0, posts7: 0, members7: new Set(), days7: new Set(), lastSeen: null };
  }
  for (const t of posts.values()) {
    const recent = t.date >= shareFrom;
    const macros = new Set();
    for (const [m, s] of t.topics) {
      if (!out[m]) continue;
      if (!macros.has(m)) { macros.add(m); out[m].total++; if (recent) out[m].total7++; }
      if (!s || !out[m].subs[s]) continue;
      const e = out[m].subs[s];
      e.posts++;
      if (!e.lastSeen || t.date > e.lastSeen) e.lastSeen = t.date;
      if (recent) { e.posts7++; e.members7.add(t.authorId); e.days7.add(t.date); }
    }
  }
  for (const m of Object.values(out)) {
    for (const e of Object.values(m.subs)) { e.members7 = e.members7.size; e.days7 = e.days7.size; }
  }
  return out;
}

// Deterministic pseudo-random order by id hash: the posts read first when a
// pool is capped are a fair sample of it (so counts extrapolate), and the
// same posts on every run (so the cache accumulates instead of churning).
function fnv(s) {
  let h = 2166136261;
  for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}
export function stableOrder(items, key = (t) => t.id) {
  return items.map((t) => [fnv(key(t)), t]).sort((a, b) => a[0] - b[0] || (key(a[1]) < key(b[1]) ? -1 : 1)).map((x) => x[1]);
}

// ── Semantic path: agglomerative clustering on embeddings ────────────────

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function centroid(vectors) {
  if (!vectors.length) return null;
  const out = new Array(vectors[0].length).fill(0);
  for (const v of vectors) for (let i = 0; i < out.length; i++) out[i] += v[i];
  for (let i = 0; i < out.length; i++) out[i] /= vectors.length;
  return out;
}

// Centroid-linkage agglomerative clustering: merge the two closest clusters
// while their centroids' cosine is at least `threshold`. Deterministic (ties
// broken by lower index). Returns clusters as arrays of item indices, largest
// first. O(n²) memory; fine for the ~1-2k posts a macro holds in two weeks.
export function agglomerate(vectors, threshold) {
  const n = vectors.length;
  if (!n) return [];
  const members = vectors.map((_, i) => [i]);
  const sums = vectors.map((v) => v.slice());
  const alive = new Array(n).fill(true);
  const sim = new Map(); // "i j" (i<j) → cosine of centroids
  const key = (i, j) => (i < j ? `${i} ${j}` : `${j} ${i}`);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) sim.set(key(i, j), cosine(vectors[i], vectors[j]));
  while (true) {
    let best = null, bi = -1, bj = -1;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (!alive[j]) continue;
        const s = sim.get(key(i, j));
        if (s >= threshold && (best === null || s > best)) { best = s; bi = i; bj = j; }
      }
    }
    if (best === null) break;
    members[bi].push(...members[bj]);
    members[bj] = [];
    for (let d = 0; d < sums[bi].length; d++) sums[bi][d] += sums[bj][d];
    alive[bj] = false;
    const c = sums[bi].map((x) => x / members[bi].length);
    for (let k = 0; k < n; k++) {
      if (!alive[k] || k === bi) continue;
      sim.set(key(bi, k), cosine(c, sums[k].map((x) => x / members[k].length)));
    }
  }
  return members.filter((m, i) => alive[i] && m.length).map((m) => m.slice().sort((a, b) => a - b)).sort((a, b) => b.length - a.length || a[0] - b[0]);
}

// Vectors for post ids when a semantic index exists; null otherwise. The
// contract with the semantic layer (src/embedding-index.js on its own branch)
// is minimal on purpose: a module exporting loadEmbeddingIndex() / loadIndex()
// / openIndex() whose result answers get(id) → number[] | null (or carries a
// byId / vectors map), or a plain data/embeddings/index.json {ids, vectors}.
export async function semanticIndex({ modulePath = './embedding-index.js', jsonPath = p('data', 'embeddings', 'index.json') } = {}) {
  let store = null;
  try {
    const mod = await import(modulePath);
    const open = mod.loadEmbeddingIndex || mod.loadIndex || mod.openIndex;
    if (open) store = await open();
  } catch { /* no semantic layer on this branch */ }
  if (!store && fs.existsSync(jsonPath)) {
    const raw = readJSON(jsonPath, null);
    if (raw?.byId) store = raw.byId;
    else if (Array.isArray(raw?.ids) && Array.isArray(raw?.vectors)) store = Object.fromEntries(raw.ids.map((id, i) => [id, raw.vectors[i]]));
  }
  if (!store) return null;
  const get = typeof store.get === 'function' ? (id) => store.get(id) : (id) => (store.byId || store.vectors || store)[id];
  return { get: (id) => { const v = get(id); return Array.isArray(v) || ArrayBuffer.isView(v) ? Array.from(v) : null; } };
}

// Cluster a pool's posts on their embeddings → {clusters: [{key, label, ids}],
// missing: n}. Posts without a vector are left out (they are read next time
// the index catches up). Cluster keys are content-hashed so the naming cache
// can find them again while the membership is unchanged.
export function semanticClusters(posts, index, { threshold }) {
  const withVec = [], vectors = [];
  let missing = 0;
  for (const t of posts) {
    const v = index.get(t.id);
    if (!v) { missing++; continue; }
    withVec.push(t);
    vectors.push(v);
  }
  const clusters = agglomerate(vectors, threshold).map((idx) => {
    const ids = idx.map((i) => withVec[i].id);
    return { key: `c-${fnv(ids.join(',')).toString(36)}`, label: null, ids, centroid: centroid(idx.map((i) => vectors[i])) };
  });
  return { clusters, missing, scanned: withVec.map((t) => t.id) };
}

// ── Claude path: read the posts in batches ───────────────────────────────

// One completion. A large max_tokens makes the SDK insist on streaming
// ("operations that may take longer than 10 minutes"), so stream when the
// client can and collect the final message; a test stub only has create().
async function complete(client, params) {
  if (typeof client.messages?.stream === 'function') return client.messages.stream(params).finalMessage();
  return client.messages.create(params);
}

const POST_TEXT_MAX = 280;
const QUOTE_TEXT_MAX = 160;
export function postLine(t, i, quoting = null) {
  const q = quoting?.text ? ` [quoting ${quoting.handle ? `@${quoting.handle}` : 'a post'}: ${String(quoting.text).replace(/\s+/g, ' ').slice(0, QUOTE_TEXT_MAX)}]` : '';
  return `${i + 1}. ${String(t.text || '').replace(/\s+/g, ' ').slice(0, POST_TEXT_MAX)}${q}`;
}

export function assignPrompt({ pool, label, posts, subjects, quoting = () => null }) {
  const where = pool === POOL
    ? 'These posts fit none of the taxonomy\'s topics — the classifier gave them no topic at all.'
    : `All of these were filed under the topic "${label}" (${pool}) by the classifier.`;
  const known = Object.entries(subjects || {}).map(([k, s]) => `- ${k}: ${s.label} — ${s.desc || ''}`).join('\n');
  const list = posts.map((t, i) => postLine(t, i, quoting(t))).join('\n');
  return `You read tweets by US House Democrats. ${where}

Group them by the SPECIFIC subject each post is about, at the granularity the posts support — not policy-area headings. "utility bills" not "energy", "gas prices" not "prices", "grocery prices", "rent", "child care costs", "tariffs on Canada"; a named event, person or place the caucus is reacting to is its own subject ("Coxon resignation", "Dilley detention center"). A subject is a thread several posts recognisably share. A post that is generic (the topic in general, a slogan, a greeting, a schedule note) gets "none". Read the post text and any quoted post it reacts to; ignore incidental word matches.

Known subjects (reuse a key when a post fits it; add a new subject only when no known one fits):
${known || '(none yet)'}

Posts:
${list}

Reply with ONLY a JSON object:
{"subjects": [{"key": "<lowercase slug, <= 32 chars>", "label": "<display label, <= 40 chars>", "desc": "<one line: what these posts are about>"}, ...],
 "assignments": [[<post number>, "<subject key or none>"], ...]}
List only NEW subjects in "subjects". Give every post number exactly once.`;
}

// One batch: posts → {subjects (new), assignments {id → key|null}}. The
// reply is checked line by line: unknown keys that are not declared as new
// subjects are dropped (the post stays unread and is retried next night).
export async function assignBatch({ pool, label, posts, subjects, client, model, quoting }) {
  const prompt = assignPrompt({ pool, label, posts, subjects, quoting });
  // The model reasons before it answers and that reasoning counts against
  // max_tokens: 120 posts at 8000 came back truncated (stop_reason
  // max_tokens after ~3k chars of JSON), so the budget is generous.
  const res = await complete(client, { model, max_tokens: 32000, messages: [{ role: 'user', content: prompt }] });
  const text = res.content.find((b) => b.type === 'text')?.text || '';
  const parsed = parseJsonLoose(text);
  if (!parsed?.assignments) {
    console.warn(`[taxonomy-learn] ${pool}: batch reply did not parse (stop_reason=${res.stop_reason}, ${text.length} chars): ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
    return { subjects: {}, assignments: {} };
  }
  const fresh = {};
  for (const s of Array.isArray(parsed.subjects) ? parsed.subjects : []) {
    const key = slug(s?.key || s?.label || '');
    if (!key || key === 'none') continue;
    if (subjects?.[key] || fresh[key]) continue;
    fresh[key] = { label: String(s.label || s.key).slice(0, 40), desc: String(s.desc || '').replace(/\s+/g, ' ').slice(0, 160) };
  }
  const assignments = {};
  for (const a of Array.isArray(parsed.assignments) ? parsed.assignments : []) {
    const [n, k] = Array.isArray(a) ? a : [a?.n ?? a?.post, a?.key ?? a?.subject];
    const t = posts[Number(n) - 1];
    if (!t || t.id in assignments) continue;
    const key = k == null || String(k).toLowerCase() === 'none' ? null : slug(k);
    if (key && !subjects?.[key] && !fresh[key]) continue;
    assignments[t.id] = key;
  }
  return { subjects: fresh, assignments };
}

// Read a pool's unread posts: the first call (no subjects yet) sees
// sample_posts and discovers the subjects; later calls see batch_posts and
// assign against everything found so far. `scan` caps the posts read tonight
// (Infinity = all). Mutates `st` (the pool's cache) and returns the calls made.
export async function readPool({ pool, label, posts, st, cfg, scan, client, model, quoting, log = () => {} }) {
  const unread = stableOrder(posts.filter((t) => !(t.id in st.posts))).slice(0, scan);
  let calls = 0, i = 0, read = 0;
  while (i < unread.length) {
    const size = Object.keys(st.subjects).length ? cfg.batch_posts : cfg.sample_posts;
    const batch = unread.slice(i, i + size);
    i += size;
    calls++;
    // A failed call degrades to "the rest waits for tomorrow" rather than
    // aborting: this runs inside the nightly chain.
    let r;
    try { r = await assignBatch({ pool, label, posts: batch, subjects: st.subjects, client, model, quoting }); }
    catch (e) { console.warn(`[taxonomy-learn] ${pool}: batch call failed (${e.message}); ${unread.length - i + batch.length} post(s) wait for the next run`); break; }
    for (const [k, s] of Object.entries(r.subjects)) st.subjects[k] = { ...s, firstSeen: batch[0].date };
    Object.assign(st.posts, r.assignments);
    read += Object.keys(r.assignments).length;
    log(`  ${pool}: read ${batch.length} posts (${Object.keys(r.assignments).length} placed, ${Object.keys(r.subjects).length} new subject(s): ${Object.values(r.subjects).map((s) => s.label).join(', ') || '-'})`);
  }
  return { calls, read };
}

// Estimated calls for a pool tonight (the budget check before reading).
export function callsNeeded(unread, hasSubjects, cfg) {
  if (!unread) return 1; // naming only
  const first = hasSubjects ? 0 : Math.min(unread, cfg.sample_posts);
  return (first ? 1 : 0) + Math.ceil((unread - first) / cfg.batch_posts) + 1;
}

// Clusters from the cache: posts in the window grouped by subject, largest
// first. `none` (generic) posts are not a cluster.
export function cachedClusters(posts, st) {
  const by = new Map();
  for (const t of posts) {
    const k = st.posts[t.id];
    if (!k) continue;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(t.id);
  }
  return [...by].map(([key, ids]) => ({ key, label: st.subjects[key]?.label || key, desc: st.subjects[key]?.desc || '', ids }))
    .sort((a, b) => b.ids.length - a.ids.length || (a.key < b.key ? -1 : 1));
}

// ── Measure ──────────────────────────────────────────────────────────────

const engagement = (t) => (t.metricsAtCapture?.likes || 0) + (t.metricsAtCapture?.retweets || 0) + (t.metricsAtCapture?.replies || 0) + (t.metricsAtCapture?.quotes || 0);

// A cluster's evidence. `scanned7` / `total7` are the pool's read and total
// posts in the share window: share is measured over what was read; `posts7`
// extrapolates to the pool when the read was capped (`estimated: true`).
export function clusterEvidence(ids, postsById, { shareFrom, scanned7, total7 }) {
  const posts = ids.map((id) => postsById.get(id)).filter(Boolean);
  const recent = posts.filter((t) => t.date >= shareFrom);
  const hits7 = recent.length;
  const share = scanned7 ? hits7 / scanned7 : 0;
  const estimated = scanned7 < total7;
  const byEng = posts.slice().sort((a, b) => engagement(b) - engagement(a) || (a.id < b.id ? -1 : 1));
  return {
    posts: posts.length,
    hits7,
    posts7: estimated ? Math.round(share * total7) : hits7,
    estimated,
    members: new Set(posts.map((t) => t.authorId)).size,
    days: new Set(posts.map((t) => t.date)).size,
    firstSeen: posts.map((t) => t.date).sort()[0] || null,
    lastSeen: posts.map((t) => t.date).sort().at(-1) || null,
    share: Number(share.toFixed(3)),
    sample_ids: byEng.slice(0, 5).map((t) => t.id)
  };
}

// The elevate rule. `share` is the subtopic's share of its macro over
// share_days; `posts7` its posts there; `siblings` the OTHER subtopics'
// 7-day counts measured on the same basis (other discovered clusters for a
// cluster, other existing rows for an existing row; zeros dropped — a dead
// row says nothing about the shape). Two ways in: the share rule (the
// subject draws elevate_share of its parent) or the median rule (it draws
// elevate_factor × the median live sibling AND at least elevate_min_share
// of the parent — without that floor, sparse sibling counts would elevate
// every modest subtopic).
export function elevateDecision(share, posts7, siblings, cfg) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  if (share >= cfg.elevate_share) return { elevate: true, rule: 'share', why: `${pct(share)} of the macro over ${cfg.share_days} days (≥ ${pct(cfg.elevate_share)})` };
  const live = (siblings || []).filter((n) => n > 0).sort((a, b) => a - b);
  const floor = cfg.elevate_min_share ?? 0;
  if (live.length >= 3) {
    const median = live.length % 2 ? live[(live.length - 1) / 2] : (live[live.length / 2 - 1] + live[live.length / 2]) / 2;
    const bar = median * cfg.elevate_factor;
    if (posts7 >= bar && posts7 >= cfg.min_posts && share >= floor) return { elevate: true, rule: 'median', why: `${posts7} posts over ${cfg.share_days} days ≥ ${cfg.elevate_factor} × the macro's median live subtopic (${median}), ${pct(share)} of the macro` };
    if (posts7 >= bar && posts7 >= cfg.min_posts) return { elevate: false, why: `${posts7} posts clear ${cfg.elevate_factor} × the median sibling (${median}) but ${pct(share)} of the macro is under the ${pct(floor)} floor` };
    return { elevate: false, why: `${pct(share)} of the macro, ${posts7} posts vs a bar of ${bar} (${cfg.elevate_factor} × median ${median})` };
  }
  return { elevate: false, why: `${pct(share)} of the macro over ${cfg.share_days} days (< ${pct(cfg.elevate_share)}; fewer than 3 live siblings, so no median bar)` };
}

// ── Name (one Claude call per pool) ──────────────────────────────────────

export function namePrompt({ pool, label, tax, clusters, existing, postsById }) {
  const isPool = pool === POOL;
  const subs = Object.entries(existing?.subs || {}).map(([k, e]) => {
    const sub = tax[pool]?.subtopics?.[k] || {};
    return `- ${k}: ${sub.label}${sub.story ? ' [story]' : ''}${sub.retired ? ' [retired]' : ''} — ${e.posts} posts over the window (${e.posts7} in the last week)`;
  }).join('\n');
  const list = clusters.map((c, i) => {
    const samples = c.evidence.sample_ids.slice(0, 3).map((id) => JSON.stringify(String(postsById.get(id)?.text || '').replace(/\s+/g, ' ').slice(0, 220)));
    return `${i + 1}. "${c.label || 'unnamed'}"${c.desc ? ` — ${c.desc}` : ''} (${c.evidence.posts} posts, ${c.evidence.members} members, ${c.evidence.days} day(s))\n   samples: ${samples.join(' | ')}`;
  }).join('\n');
  return `You maintain a two-level topic taxonomy for tweets by US House Democrats. Rows must be what the caucus is actually talking about, at the granularity the posts support; a macro is a shelf, the rows under it are the subjects and named stories. Existing taxonomy:

${renderTaxonomy(tax)}

${isPool
    ? 'Under review: the posts the classifier could not file under any topic.'
    : `Under review: macro "${label}" (${pool}). Its existing subtopics, with what the classifier assigned to each:\n${subs || '(none)'}`}

Clusters found by reading the posts${isPool ? '' : ' filed under this macro'} (counts are measured over the window):
${list || '(no cluster reached the thresholds)'}

For EACH cluster:
- label: a crisp display label (<= 40 chars); a story names the specific event/person/place
- key: a stable slug (lowercase, hyphens, <= 32 chars)
- aliases: 2-5 short strings the classifier should recognise (names, hashtags, nicknames, phrasings)
- kind: "subtopic" (a durable subject), "story" (a specific, time-bound named event/person/place the caucus is reacting to), or "noise" (not a coherent subject: greetings, mixed tributes, schedule notes)
- duplicate_of: the key of an EXISTING subtopic${isPool ? ' anywhere in the taxonomy (as "macro/key")' : ' under this macro'} that is the same subject (not merely related), else null
- same_as: if this cluster is the same subject as an earlier-numbered cluster (the reader split one subject in two), that cluster's number; else null
${isPool ? '- macro: the existing macro id this cluster belongs under, or "none" if no macro fits (it would be a new bucket)\n' : ''}- reason: one line citing what the samples say
${isPool ? '' : `
For EACH existing subtopic (verdicts must follow from the counts and the clusters, not from the label alone):
- verdict: "ok" | "dead" (nothing in the posts is about it) | "coarse" (it lumps distinct subjects the clusters split out — name them in "splits") | "duplicate" (the same subject as another existing subtopic — give "of") | "rename" (the label misleads — give "label")
- reason: one line
`}
Reply with ONLY a JSON object:
{"clusters": [{"n": 1, "label": "...", "key": "...", "aliases": [...], "kind": "subtopic|story|noise", "duplicate_of": null, "same_as": null${isPool ? ', "macro": "..."' : ''}, "reason": "..."}, ...]${isPool ? '' : ',\n "existing": [{"key": "...", "verdict": "ok|dead|coarse|duplicate|rename", "of": null, "label": null, "splits": [], "reason": "..."}, ...]'}}`;
}

// Fold clusters the naming call said are one subject (same_as → the
// earlier cluster's key): ids are unioned into the survivor, evidence is
// remeasured with `evidenceFor(ids)`, and the folded cluster is dropped.
export function foldSameAs(named, evidenceFor) {
  const byCluster = new Map(named.map((n) => [n.cluster, n]));
  const target = (n) => {
    let t = n, seen = new Set();
    while (t.sameAs && byCluster.has(t.sameAs) && !seen.has(t.sameAs)) { seen.add(t.sameAs); t = byCluster.get(t.sameAs); }
    return t === n ? null : t;
  };
  const folded = new Set();
  for (const n of named) {
    const t = target(n);
    if (!t) continue;
    t.ids = [...new Set([...t.ids, ...n.ids])];
    t.foldedFrom = [...(t.foldedFrom || []), { cluster: n.cluster, label: n.label, posts: n.ids.length }];
    folded.add(n.cluster);
  }
  const out = named.filter((n) => !folded.has(n.cluster));
  for (const n of out) if (n.foldedFrom) n.evidence = evidenceFor(n.ids);
  return out;
}

export function parseNaming(parsed, { pool, tax, clusters }) {
  const named = [];
  const isPool = pool === POOL;
  for (const c of Array.isArray(parsed?.clusters) ? parsed.clusters : []) {
    const src = clusters[Number(c.n) - 1];
    if (!src) continue;
    let dup = c.duplicate_of ? String(c.duplicate_of).trim() : null;
    let macro = isPool ? (tax[c.macro] ? c.macro : null) : pool;
    if (dup) {
      const [dm, dk] = dup.includes('/') ? dup.split('/') : [macro, dup];
      dup = dm && tax[dm]?.subtopics?.[dk] ? { macro: dm, key: dk } : null;
    }
    named.push({
      ...src,
      cluster: src.key,
      macro,
      key: slug(c.key || src.label || src.key),
      label: String(c.label || src.label || src.key).slice(0, 40),
      aliases: Array.isArray(c.aliases) ? c.aliases.map((a) => String(a).trim()).filter(Boolean).slice(0, 5) : [],
      kind: KINDS.includes(c.kind) ? c.kind : 'subtopic',
      duplicateOf: dup,
      sameAs: c.same_as && clusters[Number(c.same_as) - 1] && Number(c.same_as) !== Number(c.n) ? clusters[Number(c.same_as) - 1].key : null,
      reason: String(c.reason || '').replace(/\s+/g, ' ').trim().slice(0, 240)
    });
  }
  const existing = [];
  for (const e of Array.isArray(parsed?.existing) ? parsed.existing : []) {
    const key = String(e.key || '').trim();
    if (!tax[pool]?.subtopics?.[key]) continue;
    const verdict = ['ok', 'dead', 'coarse', 'duplicate', 'rename'].includes(e.verdict) ? e.verdict : 'ok';
    existing.push({
      key, verdict,
      of: verdict === 'duplicate' && tax[pool].subtopics[e.of] && e.of !== key ? String(e.of) : null,
      label: verdict === 'rename' && e.label ? String(e.label).slice(0, 40) : null,
      splits: Array.isArray(e.splits) ? e.splits.map(String).slice(0, 6) : [],
      reason: String(e.reason || '').replace(/\s+/g, ' ').trim().slice(0, 240)
    });
  }
  return { named, existing };
}

// The naming call's answers are cached in the pool's state (keyed by the
// cluster's subject key), so a night without the model — --no-llm, a
// failed call, a pool past the call budget — still carries last night's
// names, kinds and duplicate judgments instead of working labels.
export function rememberNaming(st, named, verdicts, at) {
  st.named ||= {};
  for (const n of named) {
    if (!n.cluster) continue;
    st.named[n.cluster] = { macro: n.macro, key: n.key, label: n.label, aliases: n.aliases, kind: n.kind, duplicateOf: n.duplicateOf, sameAs: n.sameAs || null, reason: n.reason, at };
  }
  st.verdicts = verdicts;
  st.namedAt = at;
}

export function namedFromCache(clusters, st, pool) {
  const named = clusters.map((c) => {
    const cached = st?.named?.[c.key];
    return cached
      ? { ...c, cluster: c.key, ...cached, reason: cached.reason ? `${cached.reason} (named ${cached.at})` : '' }
      : { ...c, cluster: c.key, macro: pool === POOL ? null : pool, key: slug(c.key), label: c.label || c.key, aliases: [], kind: 'subtopic', duplicateOf: null, reason: '' };
  });
  return { named, existing: st?.verdicts || [] };
}

export async function nameClusters({ pool, label, tax, clusters, existing, postsById, client, model }) {
  if (!clusters.length && pool === POOL) return { named: [], existing: [] };
  const prompt = namePrompt({ pool, label, tax, clusters, existing, postsById });
  const res = await complete(client, { model, max_tokens: 16000, messages: [{ role: 'user', content: prompt }] });
  const text = res.content.find((b) => b.type === 'text')?.text || '';
  const parsed = parseJsonLoose(text);
  if (!parsed) console.warn(`[taxonomy-learn] ${pool}: naming reply did not parse (stop_reason=${res.stop_reason}, ${text.length} chars): ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
  return parseNaming(parsed, { pool, tax, clusters });
}

// ── Propose ──────────────────────────────────────────────────────────────

const pct = (x) => `${Math.round(x * 100)}%`;
const evidenceLine = (ev, cfg) => `${ev.posts} posts${ev.estimated ? ` read (≈${ev.posts7} in the last ${cfg.share_days} days, extrapolated)` : ''}, ${ev.members} members, ${ev.days} day(s)`;

// Named clusters + measured shape + the model's verdicts → proposals for one
// pool. Pure: everything it needs is passed in.
//   clusters   [{key, label, aliases, kind, macro, duplicateOf, reason, evidence}]
//   existing   existingShape(...)[pool] (null for the unassigned pool)
//   verdicts   [{key, verdict, of, label, splits, reason}] on existing subtopics
export function proposeForPool({ pool, tax, clusters, existing, verdicts = [], cfg, stories = null }) {
  const out = [];
  const isPool = pool === POOL;
  const splitsOf = (key) => verdicts.filter((v) => v.verdict === 'coarse' && v.splits.some((s) => slug(s) === key || s.toLowerCase() === key)).map((v) => v.key);
  const overlaps = (ids) => {
    if (!stories?.candidates?.length) return null;
    const set = new Set(ids);
    let best = null;
    for (const c of stories.candidates) {
      const shared = (c.ids || []).filter((id) => set.has(id)).length;
      if (shared && shared >= Math.min(ids.length, (c.ids || []).length) / 2 && (!best || shared > best.shared)) best = { key: c.placement?.key || c.key, shared };
    }
    return best;
  };

  for (const c of clusters) {
    if (c.kind === 'noise') continue;
    const ev = c.evidence;
    const eligible = ev.posts >= cfg.min_posts && ev.members >= cfg.min_members;
    const short = [];
    if (ev.posts < cfg.min_posts) short.push(`${ev.posts}/${cfg.min_posts} posts`);
    if (ev.members < cfg.min_members) short.push(`${ev.members}/${cfg.min_members} members`);
    const base = { pool, label: c.label, aliases: c.aliases, kind: c.kind, evidence: ev };

    if (c.duplicateOf) {
      out.push({
        type: 'merge', macro: c.duplicateOf.macro, key: c.duplicateOf.key, from: c.key, ...base,
        label: tax[c.duplicateOf.macro]?.subtopics?.[c.duplicateOf.key]?.label || c.label,
        reason: `"${c.label}" reads as the same subject as ${c.duplicateOf.macro}/${c.duplicateOf.key}: ${c.reason || 'model judgment'} — ${evidenceLine(ev, cfg)}; adds its aliases to that row`,
        auto: Boolean(cfg.auto_elevate && eligible), eligible
      });
      continue;
    }

    if (!c.macro) {
      // Unassigned pool, no macro fits: a new bucket — always a human call.
      out.push({
        type: 'elevate', macro: null, key: c.key, ...base, dual: false,
        reason: `no existing macro fits (${c.reason || 'model judgment'}) — ${evidenceLine(ev, cfg)}${short.length ? `; below threshold: ${short.join(', ')}` : ''}`,
        auto: false, eligible
      });
      continue;
    }

    const already = existingSubtopic(tax, c.macro, { key: c.key, label: c.label, aliases: c.aliases });
    if (already) {
      out.push({
        type: 'merge', macro: c.macro, key: already, from: c.key, ...base, label: tax[c.macro].subtopics[already].label,
        reason: `"${c.label}" already exists as ${c.macro}/${already} (matched by key, label or alias) — ${evidenceLine(ev, cfg)}; adds its aliases to that row`,
        auto: false, eligible
      });
    } else {
      const splits = splitsOf(c.key);
      const story = c.kind === 'story';
      const twin = overlaps(c.ids);
      out.push({
        type: 'add', macro: c.macro, key: c.key, ...base, story, since: story ? ev.firstSeen : null,
        reason: `${c.reason || 'read from the posts'} — ${evidenceLine(ev, cfg)}${isPool ? ', all of them unfiled today' : `, ${pct(ev.share)} of ${c.macro} this week`}${splits.length ? `; splits ${splits.map((k) => `${c.macro}/${k}`).join(', ')} (too coarse)` : ''}${short.length ? `; below threshold: ${short.join(', ')}` : ''}${twin ? `; overlaps story candidate ${twin.key} (${twin.shared} shared posts)` : ''}`,
        auto: Boolean(cfg.auto_apply && eligible), eligible
      });
    }

    if (!isPool && eligible) {
      const others = clusters.filter((o) => o !== c && o.kind !== 'noise' && o.evidence.members >= cfg.min_members).map((o) => o.evidence.hits7);
      const d = elevateDecision(ev.share, ev.hits7, others, cfg);
      c.elevation = d;
      if (d.elevate) {
        out.push({
          type: 'elevate', macro: c.macro, key: c.key, ...base, dual: true, rule: d.rule,
          reason: `${d.why}: "${c.label}" draws as much attention as its parent — proposed as its own macro, dual-listed under ${c.macro}`,
          auto: Boolean(cfg.auto_elevate), eligible
        });
      }
    }
  }

  // Existing subtopics: elevation by measured share (against the OTHER
  // siblings' median); the model's verdicts.
  for (const [key, e] of Object.entries(existing?.subs || {})) {
    const sub = tax[pool]?.subtopics?.[key];
    if (!sub || sub.retired || sub.dual) continue;
    const share = existing.total7 ? e.posts7 / existing.total7 : 0;
    const others = Object.entries(existing.subs).filter(([k]) => k !== key).map(([, o]) => o.posts7);
    const d = elevateDecision(share, e.posts7, others, cfg);
    if (d.elevate && e.posts7 >= cfg.min_posts) {
      out.push({
        type: 'elevate', macro: pool, key, label: sub.label, aliases: sub.aliases || [], kind: sub.story ? 'story' : 'subtopic', pool, dual: true, rule: d.rule,
        evidence: { posts: e.posts, hits7: e.posts7, posts7: e.posts7, estimated: false, members: e.members7, days: e.days7, share: Number(share.toFixed(3)), sample_ids: [] },
        reason: `${d.why} — an existing subtopic that draws as much attention as its parent; proposed as its own macro, dual-listed under ${pool}`,
        auto: Boolean(cfg.auto_elevate), eligible: true
      });
    }
  }
  for (const v of verdicts) {
    const sub = tax[pool]?.subtopics?.[v.key];
    if (!sub || sub.retired) continue;
    const e = existing?.subs?.[v.key] || { posts: 0, posts7: 0, members7: 0, days7: 0 };
    const evidence = { posts: e.posts, hits7: e.posts7, posts7: e.posts7, estimated: false, members: e.members7, days: e.days7, share: existing?.total7 ? Number((e.posts7 / existing.total7).toFixed(3)) : 0, sample_ids: [] };
    if (v.verdict === 'duplicate' && v.of) {
      out.push({ type: 'merge', macro: pool, key: v.of, from: v.key, pool, label: tax[pool].subtopics[v.of]?.label || v.of, aliases: sub.aliases || [], kind: 'subtopic', evidence, reason: `${pool}/${v.key} reads as the same subject as ${pool}/${v.of}: ${v.reason} — ${e.posts} posts assigned to it over the window; its aliases move to the survivor and it retires`, auto: false, eligible: true });
    } else if (v.verdict === 'rename' && v.label) {
      out.push({ type: 'rename', macro: pool, key: v.key, pool, label: v.label, aliases: sub.aliases || [], kind: sub.story ? 'story' : 'subtopic', evidence, reason: `"${sub.label}" → "${v.label}": ${v.reason}`, auto: false, eligible: true });
    }
  }
  return out;
}

// Subtopics with zero assignments over the retire window. `counts` is
// assignmentCounts() over the retire window ("macro/key" → {posts}). A row
// that entered the taxonomy inside the window (learned / promoted / since)
// is too new to judge; dual rows and anchored stories are never retired
// here; and fewer than retire_days classified days is not enough history.
export function retireProposals(tax, counts, { cfg, today, classifiedDays, verdicts = {} }) {
  if ((classifiedDays || []).length < cfg.retire_days) return [];
  const cutoff = addDays(today, -cfg.retire_days);
  const out = [];
  for (const [macro, m] of Object.entries(tax || {})) {
    for (const [key, sub] of Object.entries(m.subtopics || {})) {
      if (sub.retired || sub.dual || sub.anchors?.length) continue;
      const entered = ymd(sub.learned || sub.promoted || sub.since);
      if (entered && entered > cutoff) continue;
      if (counts.get(`${macro}/${key}`)?.posts) continue;
      const v = (verdicts[macro] || []).find((x) => x.key === key);
      out.push({
        type: 'retire', macro, key, pool: macro, label: sub.label, aliases: sub.aliases || [], kind: sub.story ? 'story' : 'subtopic',
        evidence: { posts: 0, hits7: 0, posts7: 0, estimated: false, members: 0, days: cfg.retire_days, share: 0, sample_ids: [] },
        reason: `no assignments over the last ${cfg.retire_days} classified days${v?.verdict === 'dead' ? ` — model agrees: ${v.reason}` : v ? ` (model: ${v.verdict}${v.reason ? `, ${v.reason}` : ''})` : ''}; the key stays for history`,
        auto: Boolean(cfg.auto_apply), eligible: true
      });
    }
  }
  return out;
}

// The night's cap: adds and retirements that cleared the thresholds stay
// auto in order of posts (retirements last — they cost nothing to wait), the
// rest wait; elevations and merges are auto only with auto_elevate.
export function capAuto(proposals, cfg) {
  const rank = (x) => (x.type === 'retire' ? -1 : x.evidence?.posts || 0);
  let left = cfg.max_per_night;
  const order = proposals.map((x, i) => [x, i]).sort((a, b) => rank(b[0]) - rank(a[0]) || a[1] - b[1]);
  for (const [x] of order) {
    if (!x.auto) continue;
    if (x.type === 'elevate' || x.type === 'merge') { x.auto = Boolean(cfg.auto_elevate && x.eligible); if (!x.auto) continue; }
    if (x.type === 'rename') { x.auto = false; continue; }
    if (left <= 0) { x.auto = false; x.reason += ` (waits: max_per_night ${cfg.max_per_night})`; continue; }
    left--;
  }
  return proposals;
}

// ── YAML text edits (comments preserved; see stories.js promoteToTaxonomy) ──

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const macroBlockRe = (macro) => new RegExp(`^${escapeRe(macro)}:\\n((?:  .*\\n)*)`, 'm');
const subBlockRe = (key) => new RegExp(`^    ${escapeRe(key)}:\\n((?:      .*\\n)*)`, 'm');
const yamlStr = (s) => JSON.stringify(String(s));

// The text of one learned subtopic entry.
export function subtopicEntry(it) {
  const lines = [`    ${it.key}:`, `      label: ${yamlStr(it.label)}`];
  if (it.aliases?.length) lines.push(`      aliases: [${it.aliases.map(yamlStr).join(', ')}]`);
  if (it.story) lines.push('      story: true');
  if (it.story && it.since) lines.push(`      since: ${ymd(it.since)}`);
  if (it.provisional !== false) lines.push('      provisional: true');
  if (it.learned) lines.push(`      learned: ${ymd(it.learned)}`);
  if (it.dual) lines.push('      dual: true', `      of: ${it.of}`);
  return lines.join('\n') + '\n';
}

// Insert learned subtopics under their macros (first in the block). A key
// already present is left alone, so replaying is harmless.
export function addSubtopics(yamlText, items) {
  let text = yamlText;
  for (const it of items) {
    const macroRe = macroBlockRe(it.macro);
    const m = text.match(macroRe);
    if (!m) throw new Error(`macro "${it.macro}" not found in taxonomy.yaml`);
    let block = m[1];
    if (subBlockRe(it.key).test(block)) continue;
    const entry = subtopicEntry(it);
    if (/^  subtopics: \{\}\n/m.test(block)) block = block.replace(/^  subtopics: \{\}\n/m, () => `  subtopics:\n${entry}`);
    else if (/^  subtopics:\n/m.test(block)) block = block.replace(/^  subtopics:\n/m, () => `  subtopics:\n${entry}`);
    else block = block + `  subtopics:\n${entry}`;
    text = text.replace(macroRe, () => `${it.macro}:\n${block}`);
  }
  return text;
}

// Append `flags` ({name: value}) to an existing subtopic's block, skipping
// any already present. Values are written raw (true, a date, a slug).
export function setSubtopicFlags(yamlText, macro, key, flags) {
  const macroRe = macroBlockRe(macro);
  const m = yamlText.match(macroRe);
  if (!m) throw new Error(`macro "${macro}" not found in taxonomy.yaml`);
  const subRe = subBlockRe(key);
  const s = m[1].match(subRe);
  if (!s) throw new Error(`subtopic "${macro}/${key}" not found in taxonomy.yaml`);
  let body = s[1];
  for (const [k, v] of Object.entries(flags)) {
    if (new RegExp(`^      ${escapeRe(k)}:`, 'm').test(body)) continue;
    body += `      ${k}: ${v}\n`;
  }
  const block = m[1].replace(subRe, () => `    ${key}:\n${body}`);
  return yamlText.replace(macroRe, () => `${macro}:\n${block}`);
}

// Union `aliases` into a subtopic's aliases line (created after label if
// absent). Case-insensitive dedupe; order kept.
export function addAliases(yamlText, macro, key, aliases) {
  if (!aliases?.length) return yamlText;
  const macroRe = macroBlockRe(macro);
  const m = yamlText.match(macroRe);
  if (!m) throw new Error(`macro "${macro}" not found in taxonomy.yaml`);
  const subRe = subBlockRe(key);
  const s = m[1].match(subRe);
  if (!s) throw new Error(`subtopic "${macro}/${key}" not found in taxonomy.yaml`);
  let body = s[1];
  const line = body.match(/^      aliases: \[(.*)\]\n/m);
  const current = line ? (parseJsonLoose(`{"a":[${line[1]}]}`)?.a || []) : [];
  const seen = new Set(current.map((a) => String(a).toLowerCase()));
  const merged = current.slice();
  for (const a of aliases) { const k = String(a).trim().toLowerCase(); if (k && !seen.has(k)) { seen.add(k); merged.push(String(a).trim()); } }
  if (merged.length === current.length) return yamlText;
  const rendered = `      aliases: [${merged.map(yamlStr).join(', ')}]\n`;
  body = line ? body.replace(/^      aliases: \[.*\]\n/m, () => rendered) : body.replace(/^(      label: .*\n)/m, (x) => x + rendered);
  const block = m[1].replace(subRe, () => `    ${key}:\n${body}`);
  return yamlText.replace(macroRe, () => `${macro}:\n${block}`);
}

// Elevate a subtopic to a macro of its own: a new top-level block appended
// to the file (provisional, learned, `from: parent/key`), and — when `dual`
// — the row under the parent kept (created if it was only a proposal) with
// `dual: true, of: <new macro>` so history reads both ways. A macro key
// already present is left alone. `macro` null = no parent (a new bucket
// from the unassigned pool).
export function elevateMacro(yamlText, it) {
  let text = yamlText;
  if (!macroBlockRe(it.key).test(text)) {
    const lines = [`${it.key}:`, `  label: ${yamlStr(it.label)}`];
    if (it.aliases?.length) lines.push(`  aliases: [${it.aliases.map(yamlStr).join(', ')}]`);
    lines.push('  provisional: true');
    if (it.learned) lines.push(`  learned: ${ymd(it.learned)}`);
    if (it.macro) lines.push(`  from: ${it.macro}/${it.key}`);
    lines.push('  subtopics: {}');
    text = text.replace(/\n*$/, '\n\n') + lines.join('\n') + '\n';
  }
  if (it.macro && it.dual !== false) {
    const m = text.match(macroBlockRe(it.macro));
    if (!m) throw new Error(`macro "${it.macro}" not found in taxonomy.yaml`);
    if (subBlockRe(it.key).test(m[1])) text = setSubtopicFlags(text, it.macro, it.key, { dual: 'true', of: it.key });
    else text = addSubtopics(text, [{ ...it, dual: true, of: it.key }]);
  }
  return text;
}

// Apply proposals to YAML text. Returns {text, applied: [proposal ids]}.
export const proposalId = (x) => `${x.type} ${x.macro || '-'}/${x.key}${x.from ? ` ← ${x.from}` : ''}`;
export function applyProposals(yamlText, proposals, { night }) {
  let text = yamlText;
  const applied = [];
  const tax = () => { try { return yaml.load(text) || {}; } catch { return {}; } };
  for (const x of proposals) {
    if (x.type === 'add') {
      // A key, label or alias already under the macro (the owner's hand, or
      // stories.js the same night) wins; the add is simply not needed.
      if (existingSubtopic(tax(), x.macro, { key: x.key, label: x.label, aliases: x.aliases })) continue;
      text = addSubtopics(text, [{ macro: x.macro, key: x.key, label: x.label, aliases: x.aliases, story: x.story, since: x.since, learned: night }]);
    } else if (x.type === 'retire') {
      text = markRetired(text, [{ macro: x.macro, key: x.key }]);
    } else if (x.type === 'elevate') {
      text = elevateMacro(text, { macro: x.macro, key: x.key, label: x.label, aliases: x.aliases, learned: night, dual: x.dual !== false });
    } else if (x.type === 'merge') {
      // The survivor takes the aliases; an absorbed existing row retires
      // with a pointer, so history still resolves its key.
      text = addAliases(text, x.macro, x.key, x.aliases || []);
      if (x.from && tax()[x.macro]?.subtopics?.[x.from]) {
        text = setSubtopicFlags(text, x.macro, x.from, { merged_into: x.key, retired: 'true' });
      }
    } else if (x.type === 'rename') {
      text = renameSubtopic(text, x.macro, x.key, x.label);
    } else continue;
    applied.push(proposalId(x));
  }
  return { text, applied };
}

export function renameSubtopic(yamlText, macro, key, label) {
  const macroRe = macroBlockRe(macro);
  const m = yamlText.match(macroRe);
  if (!m) throw new Error(`macro "${macro}" not found in taxonomy.yaml`);
  const subRe = subBlockRe(key);
  const s = m[1].match(subRe);
  if (!s) throw new Error(`subtopic "${macro}/${key}" not found in taxonomy.yaml`);
  const body = s[1].replace(/^      label: .*\n/m, () => `      label: ${yamlStr(label)}\n`);
  const block = m[1].replace(subRe, () => `    ${key}:\n${body}`);
  return yamlText.replace(macroRe, () => `${macro}:\n${block}`);
}

// ── Report section ───────────────────────────────────────────────────────

// "Taxonomy learned tonight": every proposal with its evidence and whether
// it was applied. The nightly for `date` runs early the next ET day, so the
// file's `night` may be either stamp. Returns [] when there is nothing.
export function learnedSection(file, date, cfg = learnSettings()) {
  if (!file?.proposals || !(file.night === date || file.night === addDays(date, 1))) return [];
  const applied = new Set(file.applied || []);
  const lines = ['', '## Taxonomy learned tonight', ''];
  const cov = file.coverage || {};
  const pools = Object.keys(cov);
  const read = pools.reduce((a, k) => a + (cov[k].read || 0), 0);
  const calls = pools.reduce((a, k) => a + (cov[k].calls || 0), 0);
  lines.push(`_Discovery read ${read.toLocaleString('en-US')} posts across ${pools.length} pool(s) in ${calls} Claude call(s), window ${file.window?.from} → ${file.window?.to}; share is each subject's part of its macro over the last ${file.window?.shareDays ?? cfg.share_days} days. Counts are measured; the reasons are the model's judgments. ${file.applied?.length ? 'Applied rows carry `provisional: true` and `learned: <date>` in config/taxonomy.yaml — prune there.' : 'Nothing was written to config/taxonomy.yaml.'} Elevations and merges wait for \`npm run taxonomy-learn -- --apply --elevate=key\` / \`--merge=key\`._`, '');
  if (!file.proposals.length) lines.push('_No proposals: the posts support the taxonomy as it stands._');
  const order = { elevate: 0, add: 1, merge: 2, rename: 3, retire: 4 };
  const sorted = file.proposals.slice().sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9) || (b.evidence?.posts || 0) - (a.evidence?.posts || 0));
  for (const x of sorted) {
    const ev = x.evidence || {};
    const id = proposalId(x);
    const where = x.type === 'elevate'
      ? (x.macro ? `${x.macro}/${x.key} → new macro \`${x.key}\`${x.dual === false ? '' : ' (dual-listed)'}` : `new macro \`${x.key}\``)
      : x.type === 'merge' ? `${x.macro}/${x.key} ← ${x.from}` : `${x.macro}/${x.key}`;
    const counts = x.type === 'retire'
      ? `0 assignments in ${ev.days} days`
      : `${ev.posts} posts${ev.estimated ? ` read (≈${ev.posts7}/wk)` : ''}, ${ev.members} members, ${ev.days} day(s)${ev.share ? `, ${pct(ev.share)} share` : ''}`;
    const status = applied.has(id) ? '**applied**' : x.auto ? 'auto — applies with `--apply`' : 'proposed';
    lines.push(`- **${x.type.toUpperCase()}** ${where} "${x.label}"${x.kind === 'story' ? ' [story]' : ''} — ${counts} — ${x.reason} — ${status}`);
  }
  if (file.deferred?.length) lines.push('', `_Deferred to the next night (max_calls ${file.settings?.max_calls ?? cfg.max_calls}): ${file.deferred.map((d) => `${d.pool} (${d.posts} posts)`).join(', ')}._`);
  return lines;
}

// ── Runner ───────────────────────────────────────────────────────────────

function labelOfPool(pool, tax) {
  return pool === POOL ? 'Unassigned posts' : tax[pool]?.label || pool;
}

async function main() {
  const cfg = learnSettings();
  const days = Number(arg('days', cfg.window_days));
  const only = arg('macro', '').split(',').map((s) => s.trim()).filter(Boolean);
  const scanArg = arg('scan', String(cfg.scan_posts));
  const scan = scanArg === 'all' ? Infinity : Number(scanArg);
  const maxCalls = Number(arg('calls', cfg.max_calls));
  const dryRun = process.argv.includes('--dry-run');
  const apply = process.argv.includes('--apply');
  const noLlm = process.argv.includes('--no-llm');
  const elevateKeys = new Set(arg('elevate', '').split(',').map((s) => s.trim()).filter(Boolean));
  const mergeKeys = new Set(arg('merge', '').split(',').map((s) => s.trim()).filter(Boolean));
  const today = etDate();
  const tax = loadTaxonomy();
  const authorsById = loadAuthors().byId;
  const model = cfg.model || process.env.CLASSIFY_MODEL || settings.classify.model;

  // One read of the longer window; the learning window is its tail.
  const retireDates = windowDates(Math.max(days, cfg.retire_days), today);
  const dates = retireDates.slice(-days);
  const shareFrom = addDays(today, -cfg.share_days);
  const { posts: allPosts, classifiedDays } = loadWindow(retireDates, { authorsById });
  const posts = new Map([...allPosts].filter(([, t]) => t.date >= dates[0]));
  const pools = poolsOf(posts, tax);
  const shape = existingShape(posts, tax, { shareFrom });
  const retireCounts = assignmentCounts(retireDates, (d) => readJSON(topicsPath(d), null));
  const stories = readJSON(p('data', 'stories.json'), null);
  const state = readJSON(learnStatePath, { version: 1, pools: {} });
  const prev = readJSON(proposalsPath, null);
  const llm = !noLlm && anthropicConfigured();
  if (!noLlm && !llm) console.warn('[taxonomy-learn] no Anthropic credential: cached clusters and measured rules only');
  const index = await semanticIndex();
  const client = llm ? await anthropicClient() : null;
  const quoting = quotedResolver({ authorsById });
  const quoteOf = (t) => { const c = quoting(t); return c ? { handle: c.handle, text: c.text } : null; };
  console.log(`[taxonomy-learn] window ${dates[0]} → ${dates.at(-1)} (${classifiedDays.filter((d) => d >= dates[0]).length} classified days, ${posts.size} original posts); ${index ? 'semantic index present (agglomerative, sim ≥ ' + cfg.cluster_sim + ')' : 'no semantic index — Claude reads the posts'}; model ${model}; scan ${scanArg} per pool; budget ${maxCalls} calls`);

  const order = (only.length ? only : [...pools.keys()].filter((k) => k !== POOL).sort((a, b) => pools.get(b).length - pools.get(a).length).concat(POOL))
    .filter((k) => pools.has(k) && pools.get(k).length);
  let calls = 0;
  const proposals = [];
  const coverage = {};
  const deferred = [];
  const verdictsByPool = {};

  for (const pool of order) {
    const poolPosts = pools.get(pool);
    const label = labelOfPool(pool, tax);
    const st = (state.pools[pool] ||= { subjects: {}, posts: {} });
    const inWindow = new Set(poolPosts.map((t) => t.id));
    for (const id of Object.keys(st.posts)) if (!inWindow.has(id)) delete st.posts[id];
    // Subjects (and their cached names) that no post in the window carries
    // any more are forgotten, so the cache tracks the window.
    const live = new Set(Object.values(st.posts).filter(Boolean));
    for (const k of Object.keys(st.subjects)) if (!live.has(k)) { delete st.subjects[k]; if (st.named) delete st.named[k]; }
    const total7 = poolPosts.filter((t) => t.date >= shareFrom).length;
    let clusters, scannedIds, poolCalls = 0, read = 0;

    if (index) {
      const r = semanticClusters(poolPosts, index, { threshold: cfg.cluster_sim });
      clusters = r.clusters;
      scannedIds = r.scanned;
      if (r.missing) console.log(`  ${pool}: ${r.missing} post(s) have no embedding yet`);
    } else {
      const unread = poolPosts.filter((t) => !(t.id in st.posts)).length;
      const need = llm ? callsNeeded(Math.min(unread, scan), Object.keys(st.subjects).length > 0, cfg) : 0;
      if (llm && calls + need > maxCalls) {
        deferred.push({ pool, posts: poolPosts.length, unread, calls: need });
        console.log(`  ${pool}: deferred (${need} calls needed, ${maxCalls - calls} left)`);
        continue;
      }
      if (llm) {
        const r = await readPool({ pool, label, posts: poolPosts, st, cfg, scan, client, model, quoting: quoteOf, log: console.log });
        poolCalls += r.calls;
        read = r.read;
      }
      clusters = cachedClusters(poolPosts, st);
      scannedIds = poolPosts.filter((t) => t.id in st.posts).map((t) => t.id);
    }

    const scanned7 = scannedIds.filter((id) => posts.get(id)?.date >= shareFrom).length;
    for (const c of clusters) c.evidence = clusterEvidence(c.ids, posts, { shareFrom, scanned7, total7 });
    const big = clusters.filter((c) => c.evidence.posts >= cfg.min_posts && c.evidence.members >= cfg.min_members).slice(0, 12);
    let named = [], verdicts = [], fresh = false;
    if (llm && (big.length || (pool !== POOL && Object.keys(shape[pool]?.subs || {}).length))) {
      if (calls + poolCalls + 1 > maxCalls && !index) {
        deferred.push({ pool, posts: poolPosts.length, unread: 0, calls: 1 });
        console.log(`  ${pool}: naming deferred (budget)`);
      } else {
        poolCalls++;
        try {
          ({ named, existing: verdicts } = await nameClusters({ pool, label, tax, clusters: big, existing: shape[pool] || null, postsById: posts, client, model }));
          fresh = named.length > 0 || verdicts.length > 0;
          if (fresh) rememberNaming(st, named, verdicts, today);
        } catch (e) {
          console.warn(`[taxonomy-learn] ${pool}: naming call failed (${e.message}); using cached names where they exist`);
        }
      }
    }
    if (!fresh) ({ named, existing: verdicts } = namedFromCache(big, st, pool));
    named = foldSameAs(named, (ids) => clusterEvidence(ids, posts, { shareFrom, scanned7, total7 }));
    if (index) {
      // Semantic merges: a cluster whose centroid sits on an existing subtopic's.
      const subCentroids = {};
      for (const k of Object.keys(tax[pool]?.subtopics || {})) {
        const vs = poolPosts.filter((t) => t.topics.some(([m, s]) => m === pool && s === k)).map((t) => index.get(t.id)).filter(Boolean);
        if (vs.length >= cfg.min_members) subCentroids[k] = centroid(vs);
      }
      for (const c of named) {
        if (c.duplicateOf || !c.centroid) continue;
        const hit = Object.entries(subCentroids).map(([k, v]) => [k, cosine(c.centroid, v)]).filter(([, s]) => s >= cfg.merge_sim).sort((a, b) => b[1] - a[1])[0];
        if (hit) { c.duplicateOf = { macro: pool, key: hit[0] }; c.reason = `${c.reason ? c.reason + '; ' : ''}semantic similarity ${hit[1].toFixed(2)} ≥ ${cfg.merge_sim}`; }
      }
    }
    calls += poolCalls;
    verdictsByPool[pool] = verdicts;
    const mine = proposeForPool({ pool, tax, clusters: named.map(({ centroid: _c, ...c }) => c), existing: shape[pool] || null, verdicts, cfg, stories });
    proposals.push(...mine);
    coverage[pool] = {
      label, posts: poolPosts.length, posts7: total7, scanned: scannedIds.length, scanned7, read, calls: poolCalls,
      clusters: clusters.length, named: big.length, generic: scannedIds.filter((id) => !clusters.some((c) => c.ids.includes(id))).length,
      subjects: clusters.slice(0, 40).map((c) => ({ key: c.key, label: named.find((n) => n.ids === c.ids)?.label || c.label, posts: c.evidence.posts, posts7: c.evidence.posts7, members: c.evidence.members, days: c.evidence.days, share: c.evidence.share })),
      existing: Object.fromEntries(Object.entries(shape[pool]?.subs || {}).map(([k, e]) => [k, { posts: e.posts, posts7: e.posts7, members7: e.members7, days7: e.days7, share: shape[pool].total7 ? Number((e.posts7 / shape[pool].total7).toFixed(3)) : 0, verdict: verdicts.find((v) => v.key === k) || null }])),
      proposals: mine.length
    };
    console.log(`  ${pool}: ${poolPosts.length} posts, ${scannedIds.length} read → ${clusters.length} cluster(s), ${big.length} named, ${mine.length} proposal(s) (${poolCalls} call(s))`);
  }

  proposals.push(...retireProposals(tax, retireCounts, { cfg, today, classifiedDays, verdicts: verdictsByPool }));

  // Same-night re-runs accumulate: pools not processed now keep the
  // proposals and coverage an earlier run tonight produced (retirements
  // are global and recomputed every run). The per-night cap is then
  // applied over everything, so auto flags mean the same in every run.
  const carried = prev?.night === today ? prev : null;
  if (carried) {
    for (const x of carried.proposals || []) {
      if (coverage[x.pool] || x.type === 'retire') continue;
      x.reason = String(x.reason || '').replace(/ \(waits: max_per_night \d+\)$/, '');
      x.auto = Boolean(cfg.auto_apply && x.eligible && (x.type === 'add' || (cfg.auto_elevate && (x.type === 'elevate' || x.type === 'merge'))));
      proposals.push(x);
    }
    for (const [k, v] of Object.entries(carried.coverage || {})) if (!coverage[k]) coverage[k] = v;
  }
  capAuto(proposals, cfg);
  const file = {
    generatedAt: new Date().toISOString(),
    night: today,
    window: { from: dates[0], to: dates.at(-1), days, shareDays: cfg.share_days, retireDays: cfg.retire_days, classifiedDays: classifiedDays.length },
    settings: { model, min_posts: cfg.min_posts, min_members: cfg.min_members, elevate_share: cfg.elevate_share, elevate_factor: cfg.elevate_factor, merge_sim: cfg.merge_sim, retire_days: cfg.retire_days, auto_apply: cfg.auto_apply, auto_elevate: cfg.auto_elevate, max_per_night: cfg.max_per_night, max_calls: maxCalls, semantic: Boolean(index) },
    calls: calls + (carried?.calls || 0),
    coverage,
    deferred: deferred.filter((d) => !coverage[d.pool]),
    proposals,
    applied: carried?.applied || []
  };

  // The plan.
  console.log(`\n[taxonomy-learn] ${proposals.length} proposal(s), ${proposals.filter((x) => x.auto).length} auto; ${calls} Claude call(s) this run`);
  for (const x of proposals) {
    const ev = x.evidence;
    console.log(`  ${x.auto ? 'AUTO ' : '     '}${x.type.padEnd(7)} ${proposalId(x).replace(/^\w+ /, '').padEnd(44)} "${x.label}" — ${x.type === 'retire' ? `0 in ${ev.days}d` : `${ev.posts} posts${ev.estimated ? ` (≈${ev.posts7}/wk)` : ''}, ${ev.members} members, ${ev.days}d, share ${pct(ev.share)}`}`);
    console.log(`        ${x.reason}`);
  }
  if (deferred.length) console.log(`  deferred: ${deferred.map((d) => `${d.pool} (${d.posts} posts, ${d.calls} calls)`).join(', ')}`);
  if (dryRun) { console.log('[taxonomy-learn] --dry-run: nothing written'); return; }

  writeJSON(learnStatePath, state);
  if (apply) {
    const chosen = proposals.filter((x) => x.auto || (x.type === 'elevate' && elevateKeys.has(x.key)) || (x.type === 'merge' && (mergeKeys.has(x.key) || mergeKeys.has(x.from))));
    if (chosen.length) {
      const yamlFile = p('config', 'taxonomy.yaml');
      const { text, applied } = applyProposals(fs.readFileSync(yamlFile, 'utf8'), chosen, { night: today });
      fs.writeFileSync(yamlFile, text);
      file.applied = [...new Set([...file.applied, ...applied])];
      file.appliedAt = new Date().toISOString();
      console.log(`[taxonomy-learn] applied ${applied.length} change(s) to config/taxonomy.yaml (seen by the next classification run): ${applied.join('; ')}`);
    } else console.log('[taxonomy-learn] --apply: nothing to apply');
  }
  writeJSON(proposalsPath, file);
  console.log(`[taxonomy-learn] wrote data/taxonomy-proposals.json (${proposals.length} proposals) and data/taxonomy-learn.json (${Object.keys(state.pools).length} pools cached)`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
