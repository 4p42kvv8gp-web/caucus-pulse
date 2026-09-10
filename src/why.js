// "Why it moved" — the judgment beside the momentum number.
//
// Momentum (src/momentum.js) says HOW HARD a topic or story is moving against
// its own 7-day baseline; it cannot say why. For the top movers this stage
// reads the posts that drive the movement and asks Claude, once per mover,
// to write the reason (what happened, who drove it), quote 2-3 posts as the
// evidence, name the framing members use, and say how confident it is and
// why. The measured numbers are handed to the model as context and never
// restated as findings; the dashboard shows the two side by side, labelled.
//
// Movers come from the SAME aggregation the dashboard reads (sitedata.js →
// aggregate()), never a second copy of the math:
//   - the top `settings.why.top` topics and story subtopics by |momentum − 50|
//   - plus every story (a `story: true` subtopic, or an emerging story
//     candidate) with >= `min_story_posts_24h` posts in the last 24 hours.
// Driving posts: the mover's last-24h posts, top by engagement with one post
// per member first, at most `max_posts`; plus a few top posts from the prior
// six days as the baseline to compare against.
//
// Bounded and cached: one call per mover, at most `daily_calls` per ET day
// (ledgered in data/why.json), and an entry is re-asked only when the hash of
// the post ids it would read changes. Best-effort everywhere: no credential
// → skip silently; a reply that does not parse → keep the previous entry.
//
//   node --use-env-proxy src/why.js              # explain the current movers, then rebuild rollups.json
//   node --use-env-proxy src/why.js --dry-run    # list movers and what would be asked; no calls
//   node --use-env-proxy src/why.js --force      # ignore the cache
//   node --use-env-proxy src/why.js --no-rebuild # leave site/data/rollups.json alone
import crypto from 'node:crypto';
import { anthropicClient, anthropicConfigured } from './anthropic-auth.js';
import { p, settings, readJSON, writeJSON, etDate, idGt } from './util.js';
import { parseJsonLoose } from './taxonomy.js';
import { aggregate, whyKey, buildSiteData } from './sitedata.js';

export const whyPath = p('data', 'why.json');
const DAY = 86_400_000;
const DEFAULTS = { top: 8, min_story_posts_24h: 5, max_posts: 25, baseline_posts: 6, min_posts: 3, daily_calls: 150 };
export const whySettings = () => ({ ...DEFAULTS, ...(settings.why || {}) });
export const MODEL = () => process.env.CLASSIFY_MODEL || settings.why?.model || settings.classify.model;

// ── mover selection ──────────────────────────────────────────────────────
// Rows in (topic rows with momentum + story subs, clusters with r24) →
// movers out. `hasPosts(mover)` lets the caller drop a mover that has
// nothing readable (a story that only ever had retweets) so the next one
// by momentum takes its place; the momentum ranking never exceeds `top`.
export function selectMovers({ topics = [], clusters = [] }, { top = 8, minStoryPosts = 5, hasPosts = () => true } = {}) {
  const rows = [];
  for (const t of topics) {
    rows.push({ key: whyKey('topic', t.key), kind: 'topic', label: t.name, macro: t.key, sub: null, score: t.momentum?.score ?? 50, d: t.d ?? 0, r24: t.r24?.n ?? 0, members24: t.r24?.m ?? 0, week: t.w?.All?.n ?? 0, drivers: t.momentum?.drivers || [] });
    for (const s of t.subs || []) {
      if (!s.story) continue;
      rows.push({ key: whyKey('story', t.key, s.key), kind: 'story', label: s.name || s.key, macro: t.key, sub: s.key, macroLabel: t.name, score: s.momentum?.score ?? 50, d: s.d ?? 0, r24: s.r24?.n ?? 0, members24: s.r24?.m ?? 0, week: s.w?.All?.n ?? 0, drivers: s.momentum?.drivers || [] });
    }
  }
  const out = new Map();
  const ranked = rows.slice().sort((a, b) => Math.abs(b.score - 50) - Math.abs(a.score - 50) || b.r24 - a.r24 || a.key.localeCompare(b.key));
  for (const r of ranked) {
    if (out.size >= top) break;
    if (!hasPosts(r)) continue;
    out.set(r.key, { ...r, by: 'momentum' });
  }
  const stories = [
    ...rows.filter((r) => r.kind === 'story'),
    ...clusters.filter((c) => c.kind === 'story').map((c) => ({
      key: whyKey('cluster', c.suggest), kind: 'cluster', label: c.label, cluster: c.suggest, macro: c.macro || null, sub: null,
      score: null, d: null, r24: c.r24?.n ?? 0, members24: c.r24?.m ?? 0, week: c.posts, since: c.since, drivers: []
    }))
  ];
  for (const s of stories) {
    if (s.r24 < minStoryPosts || out.has(s.key) || !hasPosts(s)) continue;
    out.set(s.key, { ...s, by: 'story' });
  }
  return [...out.values()];
}

// ── driving posts ────────────────────────────────────────────────────────
export function postsFor(mover, { allPosts = [], clusters = [] }) {
  if (mover.kind === 'topic') return allPosts.filter((x) => x.topics?.some(([m]) => m === mover.macro));
  if (mover.kind === 'story') return allPosts.filter((x) => x.topics?.some(([m, s]) => m === mover.macro && s === mover.sub));
  const ids = new Set(clusters.find((c) => c.suggest === mover.cluster)?.ids || []);
  return allPosts.filter((x) => ids.has(x.id));
}

const byEngagement = (a, b) => (b.engN || 0) - (a.engN || 0) || (idGt(a.id, b.id) ? -1 : 1);

// Top `max` by engagement, one post per member first so a single loud
// account cannot crowd out the rest; the remainder fills by engagement.
export function pickTop(posts, max) {
  const sorted = posts.slice().sort(byEngagement);
  const picked = new Set();
  const members = new Set();
  for (const x of sorted) {
    if (picked.size >= max) break;
    if (members.has(x.authorId)) continue;
    members.add(x.authorId);
    picked.add(x);
  }
  for (const x of sorted) {
    if (picked.size >= max) break;
    picked.add(x);
  }
  return sorted.filter((x) => picked.has(x));
}

const ageOf = (post, now) => now - new Date(post.createdAt).getTime();
const original = (post) => post.type !== 'retweet' && typeof post.text === 'string' && post.text.trim();

export function drivingPosts(posts, { max = 25, now = Date.now() } = {}) {
  return pickTop(posts.filter((x) => original(x) && ageOf(x, now) >= 0 && ageOf(x, now) < DAY), max);
}

export function baselinePosts(posts, { max = 6, now = Date.now() } = {}) {
  return pickTop(posts.filter((x) => original(x) && ageOf(x, now) >= DAY), max);
}

// HOOK(semantic): when src/semantic.js lands (branch
// claude/night-semantic-integration — src/embeddings.js, src/embedding-index.js,
// src/semantic.js, data/embeddings/), return the unlabeled posts the index
// places next to this mover's driving posts. They go into the prompt as a
// third, labelled block ("SIMILAR, UNLABELED") so the reason can say when the
// movement is bigger than the classifier saw. Until then: nothing.
export async function semanticNeighbors(_mover, _ctx) {
  return [];
}

// Cache key: the posts the model would read. Order-independent.
export function driveSha(ids) {
  return crypto.createHash('sha256').update([...new Set(ids)].sort().join('\n')).digest('hex').slice(0, 16);
}

// ── prompt ───────────────────────────────────────────────────────────────
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const fmtN = (n) => Math.round(n).toLocaleString('en-US');

function whenEt(iso) {
  return new Intl.DateTimeFormat('en-US', { timeZone: settings.timezone || 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

export function describeAuthor(authorId, authorsById) {
  const a = authorsById?.[authorId];
  if (!a) return `author ${authorId}`;
  const caucuses = (a.caucuses || []).map((tag) => settings.caucus_keys?.[tag]).filter(Boolean);
  const who = [a.member || a.name, caucuses.length ? caucuses.join('/') : null].filter(Boolean).join(' · ');
  return `@${a.handle}${who ? ` (${who})` : ''}`;
}

// One post for the prompt. Quoted / replied-to context is included when the
// referenced post is itself in the window (the archive stores member posts
// only); otherwise the line says the context is missing rather than guessing.
export function renderPost(post, { authorsById = {}, byId = new Map() } = {}) {
  const text = squash(post.text);
  const body = text.length > 600 ? text.slice(0, 599).replace(/\s+\S*$/, '') + '…' : text;
  const kind = post.type === 'quote' ? ' · quote' : post.type === 'reply' ? ' · reply' : '';
  let context = '';
  if ((post.type === 'quote' || post.type === 'reply') && post.refId) {
    const ref = byId.get(post.refId);
    const verb = post.type === 'quote' ? 'quoting' : 'replying to';
    context = ref
      ? `\n  ↳ ${verb} ${describeAuthor(ref.authorId, authorsById)}: "${squash(ref.text).slice(0, 240)}"`
      : `\n  ↳ ${verb} a post outside the archive (context not available)`;
  }
  return `[${post.id}] ${describeAuthor(post.authorId, authorsById)} · ${whenEt(post.createdAt)} · ${fmtN(post.engN || 0)} eng${kind}\n  ${body}${context}`;
}

export const SYSTEM = `You explain to the House Democratic Leader's communications office why a topic or story in the caucus's X activity is moving. You are given measured numbers (they are the finding of a formula — explain them, never restate them as your own conclusion), the posts from the last 24 hours that drive the movement, and a few posts from the prior days for comparison.

Read the posts and judge:
- reason: what happened and who drove it, in at most 40 words. Name members by @handle. Say whether it is one event, a coordinated message, a reaction to news, or scattered unrelated posts. If the movement is a drop, say what the earlier activity was and that it has faded.
- evidence: 2-3 posts that show it, each with its id and an EXACT quote copied verbatim from that post's text, at most 120 characters. Prefer posts from the last 24 hours; a baseline post is allowed only to show what faded.
- framing: one short phrase for how members frame it (the line they are pushing), or "no shared framing" if there is none.
- confidence: high when the posts clearly explain the movement, medium when they mostly do, low when they do not — and say why in one line.

Only claim what the posts support. Do not invent events, names or numbers. Reply with ONLY a JSON object:
{"reason": "...", "framing": "...", "evidence": [{"id": "<post id>", "quote": "<exact text>"}], "confidence": {"level": "high|medium|low", "why": "..."}}`;

export function buildPrompt(mover, { driving = [], baseline = [], ctx = {}, total = null } = {}) {
  const head = [];
  if (mover.kind === 'topic') head.push(`MOVER: ${mover.label} — a macro topic`);
  else if (mover.kind === 'story') head.push(`MOVER: ${mover.label} — a developing story under ${mover.macroLabel || mover.macro}`);
  else head.push(`MOVER: ${mover.label} — an emerging story candidate (not yet in the taxonomy)${mover.since ? `, first seen ${whenEt(mover.since)}` : ''}`);

  const measured = [];
  if (mover.score != null) {
    measured.push(`- momentum ${mover.score}/100 (50 = steady; formula weights volume lift, acceleration, member adoption, caucus spread, engagement lift against the topic's own 7-day baseline)${mover.drivers?.length ? `; formula drivers: ${mover.drivers.join(' and ')}` : ''}`);
  }
  const dir = mover.d == null ? '' : mover.d >= 0 ? ` (▲${mover.d}% vs the six-day daily average)` : ` (▼${Math.abs(mover.d)}% vs the six-day daily average)`;
  measured.push(`- last 24 hours: ${mover.r24} post(s) including reposts, by ${mover.members24} member(s)${dir}`);
  if (mover.kind === 'cluster') measured.push(`- ${mover.week} post(s) in the candidate so far`);
  else measured.push(`- ${mover.week} post(s) in the 7-day window`);

  const lines = [
    ...head,
    'MEASURED (context, not your finding):',
    ...measured,
    '',
    `DRIVING POSTS — last 24 hours, top by engagement with one post per member first${total != null ? ` (${driving.length} of ${total})` : ''}:`,
    driving.length ? driving.map((x) => renderPost(x, ctx)).join('\n') : '(none — the mover has no original posts in the last 24 hours)',
    '',
    `BASELINE — the prior six days, top by engagement, for comparison (${baseline.length}):`,
    baseline.length ? baseline.map((x) => renderPost(x, ctx)).join('\n') : '(none)',
    '',
    'Reply with the JSON object only.'
  ];
  return lines.join('\n');
}

// ── reply → entry ────────────────────────────────────────────────────────
const WORD_CAP = 60;
const QUOTE_CAP = 120;

export function verifyQuote(quote, text) {
  const q = squash(quote), t = squash(text);
  if (!q) return { quote: q, verified: false };
  if (t.includes(q)) return { quote: q, verified: true };
  if (t.toLowerCase().includes(q.toLowerCase())) return { quote: q, verified: true };
  const bare = q.replace(/^[“"'‘]+|[”"'’…]+$/g, '').trim();
  if (bare && t.toLowerCase().includes(bare.toLowerCase())) return { quote: bare, verified: true };
  return { quote: q, verified: false };
}

// Normalize the model's reply against the posts it was shown: unknown ids
// are dropped, quotes are checked verbatim (an unverified quote stays but
// says so), lengths are capped. Returns null when there is no reason.
export function normalizeReply(parsed, { driving = [], baseline = [], authorsById = {} } = {}) {
  if (!parsed || typeof parsed !== 'object') return null;
  const reason = squash(parsed.reason);
  if (!reason) return null;
  const words = reason.split(' ');
  const shown = new Map([...driving.map((x) => [x.id, { x, window: 'driving' }]), ...baseline.map((x) => [x.id, { x, window: 'baseline' }])]);
  const evidence = [];
  const seen = new Set();
  for (const e of Array.isArray(parsed.evidence) ? parsed.evidence : []) {
    const id = String(e?.id ?? '');
    const hit = shown.get(id);
    if (!hit || seen.has(id)) continue;
    let quote = squash(e?.quote);
    if (quote.length > QUOTE_CAP) quote = quote.slice(0, QUOTE_CAP - 1).replace(/\s+\S*$/, '');
    const v = verifyQuote(quote, hit.x.text);
    if (!v.quote) continue;
    seen.add(id);
    const a = authorsById[hit.x.authorId];
    evidence.push({ id, handle: a?.handle ? `@${a.handle}` : hit.x.authorId, quote: v.quote, verified: v.verified, window: hit.window });
    if (evidence.length === 3) break;
  }
  const level = ['high', 'medium', 'low'].includes(parsed.confidence?.level) ? parsed.confidence.level : 'low';
  return {
    reason: words.length > WORD_CAP ? words.slice(0, WORD_CAP).join(' ') + '…' : reason,
    framing: squash(parsed.framing).slice(0, 80) || null,
    evidence,
    confidence: { level, why: squash(parsed.confidence?.why).slice(0, 200) || (parsed.confidence?.level ? '' : 'confidence not stated') }
  };
}

// One call for one mover. `client` is injectable (tests feed a canned reply).
export async function explainMover(mover, { driving, baseline, ctx, total }, { client, model }) {
  const res = await client.messages.create({
    model,
    max_tokens: 3000,
    system: SYSTEM,
    messages: [{ role: 'user', content: buildPrompt(mover, { driving, baseline, ctx, total }) }],
    output_config: { effort: 'medium' }
  });
  const usage = { input: res.usage?.input_tokens ?? 0, output: res.usage?.output_tokens ?? 0 };
  if (res.stop_reason === 'refusal') return { entry: null, usage, why: 'refusal' };
  const text = res.content?.find((b) => b.type === 'text')?.text || '';
  const entry = normalizeReply(parseJsonLoose(text), { driving, baseline, authorsById: ctx?.authorsById });
  if (!entry) return { entry: null, usage, why: `reply did not parse (stop_reason=${res.stop_reason}, ${text.length} chars): ${text.slice(0, 160).replace(/\s+/g, ' ')}` };
  return { entry, usage, why: null };
}

// ── the run ──────────────────────────────────────────────────────────────
// Everything except file I/O and client construction, so tests can drive it
// with a synthetic aggregation and a stub client.
export async function generate(agg, { prev = {}, client, model = MODEL(), now = Date.now(), cfg = whySettings(), force = false, dryRun = false, log = () => {} } = {}) {
  const ctx = { authorsById: agg.authorsById || {}, byId: new Map((agg.allPosts || []).map((x) => [x.id, x])) };
  const gathered = new Map();
  const gather = (mover) => {
    if (!gathered.has(mover.key)) {
      const posts = postsFor(mover, agg);
      const driving = drivingPosts(posts, { max: cfg.max_posts, now });
      const baseline = baselinePosts(posts, { max: cfg.baseline_posts, now });
      const total = posts.filter((x) => original(x) && ageOf(x, now) >= 0 && ageOf(x, now) < DAY).length;
      gathered.set(mover.key, { driving, baseline, total, sha: driveSha([...driving, ...baseline].map((x) => x.id)) });
    }
    return gathered.get(mover.key);
  };
  const movers = selectMovers(agg, {
    top: cfg.top,
    minStoryPosts: cfg.min_story_posts_24h,
    hasPosts: (m) => { const g = gather(m); return g.driving.length + g.baseline.length >= cfg.min_posts; }
  });

  const today = etDate(new Date(now));
  const ledger = { ...(prev.ledger || {}) };
  const day = (ledger[today] = { calls: 0, inputTokens: 0, outputTokens: 0, ...(ledger[today] || {}) });
  for (const k of Object.keys(ledger).sort().slice(0, -30)) delete ledger[k]; // keep a month

  const entries = {};
  const stats = { asked: 0, cached: 0, skipped: [], failed: [] };
  for (const mover of movers) {
    const g = gather(mover);
    const old = prev.entries?.[mover.key];
    const measured = { score: mover.score, d: mover.d, r24: mover.r24, members24: mover.members24, week: mover.week, by: mover.by };
    if (!force && old?.sha === g.sha) {
      entries[mover.key] = { ...old, measured, by: mover.by };
      stats.cached++;
      log(`  = ${mover.key}  cached (${g.driving.length} driving, ${g.baseline.length} baseline)`);
      continue;
    }
    if (dryRun) {
      stats.skipped.push({ key: mover.key, why: 'dry run' });
      log(`  ? ${mover.key}  would ask (${g.driving.length} driving, ${g.baseline.length} baseline; sha ${g.sha}${old ? `, was ${old.sha}` : ''})`);
      if (old) entries[mover.key] = old;
      continue;
    }
    if (day.calls >= cfg.daily_calls) {
      stats.skipped.push({ key: mover.key, why: `daily ceiling ${cfg.daily_calls} reached` });
      if (old) entries[mover.key] = old;
      continue;
    }
    day.calls++;
    let r;
    try {
      r = await explainMover(mover, { ...g, ctx }, { client, model });
    } catch (e) {
      r = { entry: null, usage: { input: 0, output: 0 }, why: e.message };
    }
    day.inputTokens += r.usage.input;
    day.outputTokens += r.usage.output;
    if (!r.entry) {
      stats.failed.push({ key: mover.key, why: r.why });
      log(`  ! ${mover.key}  ${r.why}`);
      if (old) entries[mover.key] = old; // stale but dated; better than nothing
      continue;
    }
    stats.asked++;
    entries[mover.key] = {
      key: mover.key, kind: mover.kind, label: mover.label, macro: mover.macro || null, sub: mover.sub || null, cluster: mover.cluster || null,
      by: mover.by, measured,
      sha: g.sha, postIds: g.driving.map((x) => x.id), baselineIds: g.baseline.map((x) => x.id),
      ...r.entry,
      generatedAt: new Date(now).toISOString(), model, usage: r.usage
    };
    log(`  + ${mover.key}  [${r.entry.confidence.level}] ${r.entry.reason}`);
  }

  const file = {
    generatedAt: new Date(now).toISOString(),
    model,
    settings: { top: cfg.top, min_story_posts_24h: cfg.min_story_posts_24h, max_posts: cfg.max_posts, baseline_posts: cfg.baseline_posts, daily_calls: cfg.daily_calls },
    movers: movers.map((m) => ({ key: m.key, kind: m.kind, label: m.label, by: m.by, score: m.score, d: m.d, r24: m.r24, sha: gather(m).sha })),
    entries,
    ledger
  };
  const before = Object.keys(prev.entries || {}).sort().join(' ');
  const after = Object.keys(entries).sort().join(' ');
  return { file, movers, ...stats, changed: stats.asked > 0 || before !== after };
}

export async function runWhy({ client = null, model = null, now = Date.now(), force = false, dryRun = false, rebuild = true, log = () => {} } = {}) {
  if (!client && !anthropicConfigured()) return null;
  const agg = aggregate({ now });
  const prev = readJSON(whyPath, { entries: {}, ledger: {} });
  if (!dryRun) client ||= await anthropicClient();
  const result = await generate(agg, { prev, client, model: model || MODEL(), now, force, dryRun, log });
  if (dryRun) return result;
  writeJSON(whyPath, result.file);
  if (rebuild && result.changed) buildSiteData();
  return result;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const force = process.argv.includes('--force');
  const rebuild = !process.argv.includes('--no-rebuild');
  if (!dryRun && !anthropicConfigured()) {
    console.log('[why] no Anthropic credential — nothing asked (set CLASSIFIER_ANTHROPIC_API_KEY, or run with --dry-run to see the movers)');
    return;
  }
  const r = await runWhy({ force, dryRun, rebuild, log: console.log });
  const day = r.file.ledger[etDate()] || { calls: 0, inputTokens: 0, outputTokens: 0 };
  console.log(`[why] ${r.movers.length} mover(s): ${r.asked} explained, ${r.cached} unchanged, ${r.failed.length} failed, ${r.skipped.length} skipped${dryRun ? ' (dry run)' : ''}; today ${day.calls} call(s), ${day.inputTokens} in / ${day.outputTokens} out tokens`);
  for (const f of r.failed) console.warn(`[why]   failed ${f.key}: ${f.why}`);
  for (const s of r.skipped.filter((x) => x.why !== 'dry run')) console.warn(`[why]   skipped ${s.key}: ${s.why}`);
}

// Best-effort stage: it runs last in the nightly chain and after every
// poll's site-data rebuild, so a failure here (auth, network) must not fail
// the job and lose the outputs already produced. Loud, but exit 0.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(`[why] failed — best-effort stage, not failing the chain: ${e.stack || e}`); process.exit(0); });
}
