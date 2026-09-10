// Incident desk backend. The classifier (nightly batch + poll-time live
// pass) flags posts that respond to breaking district emergencies with
// {kind, place}; this module groups those flags into incidents with the
// lifecycle the desk shows: active (posts within 12h) → monitoring (12-36h
// quiet) → resolved (36h with no member posts), dropped after 7 quiet days.
//
// Corroboration (corroborate()) is the judging step beside the string
// grouping. Grouping keys on the exact kind+place string, so one event splits
// across cards when members use different words ("hazmat release" / "chemical
// leak") or neighbouring places ("Big Sur" / "Monterey County"), and a second
// member's post about the same event never reaches the first member's card
// (docs/INCIDENT_AUDIT.md: 16 of 29 cards were fragments of six events).
// After grouping, Claude reads the open cards (provisional / active /
// monitoring) plus every incident-flagged post of the last few days that is
// not on one of them, in batches of at most `batch_incidents` cards, and says
// which candidates describe the SAME event as a card, which cards are
// duplicates of each other, and which flagged posts are not an incident at all
// (commemoration, hypothetical, national policy, aftermath, reaction) — each
// with a one-line reason and an exact span from a post. The merges are applied
// deterministically from the returned groups; every merge is logged on the
// card ({merged_from, reason}); dropped posts are listed with their reason;
// a provisional card that gains a second member advances to the live
// lifecycle. Judgments are cached by the content they were asked about
// (data/incident-judgments.json) so a re-run never re-bills, spend is
// ledgered per ET day, and earlier decisions are re-applied before asking
// again, so cards stay stable between runs. Measured numbers (posts, members,
// engagement) are never overwritten by a judgment; they sit beside it.
//
// Intel panels (confirmed / circulating-unverified / what's new) are an
// optional Claude extraction over the incident's member posts — everything
// there is attributed to the member post it came from; the pipeline only
// captures list members, so official-source rows arrive when X search is
// connected, not before. Runs with withIntel:false at poll time (grouping +
// cached corroboration) and withIntel:true in the nightly chain.
//
//   node --use-env-proxy src/incidents.js                  # group, corroborate, extract intel
//   node --use-env-proxy src/incidents.js --no-corroborate # string grouping only (prior merges still re-applied)
//   node --use-env-proxy src/incidents.js --force          # ignore the judgment cache
import crypto from 'node:crypto';
import { p, readJSON, writeJSON, daysAgoEt, settings, etDate } from './util.js';
import { anthropicConfigured } from './anthropic-auth.js';
import { loadDay, topicsPath, loadState } from './store.js';
import { liveTopicsPath } from './classify-live.js';
import { loadAuthors } from './authors.js';
import { parseJsonLoose } from './taxonomy.js';

export const incidentsPath = p('data', 'incidents.json');
export const judgmentsPath = p('data', 'incident-judgments.json');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Statuses the judge reads. `provisional` is the single-post card of the
// provisional-incidents build (branch claude/night-provisional-incidents);
// until that lands no card carries it, and the lifecycle below is the only
// source of status.
export const OPEN_STATUSES = new Set(['provisional', 'active', 'monitoring']);
export const DROP_CATEGORIES = ['commemoration', 'hypothetical', 'national_policy', 'aftermath', 'reaction'];

const DEFAULTS = { corroborate: true, candidate_days: 3, batch_incidents: 15, batch_candidates: 40, posts_per_incident: 8, neighbors_per_incident: 5, daily_calls: 100, cache_days: 14 };
export const incidentSettings = () => ({ ...DEFAULTS, ...(settings.incidents || {}) });
export const MODEL = () => process.env.CLASSIFY_MODEL || settings.incidents?.model || settings.classify.model;

export function incidentKey(kind, place) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().replace(/\s+/g, '-');
  return `${norm(place)}--${norm(kind)}`;
}

export function statusOf(lastPostAt, now = Date.now()) {
  const quiet = now - new Date(lastPostAt).getTime();
  if (quiet <= 12 * HOUR) return 'active';
  if (quiet <= 36 * HOUR) return 'monitoring';
  return 'resolved';
}

// Collect {tweetId: {kind, place}} across nightly + live files for a window
// of days. Nightly wins on conflict (it re-reads the whole day).
export function collectFlags(days = 8) {
  const flags = {};
  for (let d = days - 1; d >= 0; d--) {
    const date = daysAgoEt(d);
    for (const file of [readJSON(liveTopicsPath(date), null), readJSON(topicsPath(date), null)]) {
      if (file?.incidents) Object.assign(flags, file.incidents);
    }
  }
  return flags;
}

const STATUS_RANK = { active: 0, provisional: 1, monitoring: 2, resolved: 3 };
export function sortIncidents(incidents) {
  return incidents.sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || (a.last < b.last ? 1 : -1));
}

// One card from a group {id, kind, place, posts[, from]}. `from` maps a post
// id to the card it was merged in from, so the timeline can show the source.
export function shapeIncident(g, authorsById, { now = Date.now(), lastPollAt = null } = {}) {
  const posts = g.posts.slice().sort((a, b) => a.createdAt < b.createdAt ? -1 : 1);
  const lead = posts[0];
  const leadAuthor = authorsById[lead.authorId] || {};
  const last = posts[posts.length - 1];
  const memberHandles = [...new Set(posts.map((t) => authorsById[t.authorId]?.handle).filter(Boolean))];
  const from = g.from || new Map();
  return {
    id: g.id,
    kind: g.kind,
    status: statusOf(last.createdAt, now),
    place: g.place + (leadAuthor.stateDistrict ? ` · ${leadAuthor.stateDistrict}` : ''),
    handle: leadAuthor.handle ? `@${leadAuthor.handle}` : lead.authorId,
    member: leadAuthor.member || leadAuthor.name || '',
    since: lead.createdAt,
    last: last.createdAt,
    updates: posts.length,
    engN: posts.reduce((a, t) => a + (t.engN || 0), 0),
    amplifiers: posts.reduce((a, t) => a + (t.amplifiers || 0), 0),
    others: memberHandles.slice(1).map((h) => `@${h}`),
    title: `${g.kind.charAt(0).toUpperCase()}${g.kind.slice(1)} · ${g.place}`,
    timeline: posts.map((t) => ({
      time: t.createdAt,
      who: authorsById[t.authorId]?.handle ? `@${authorsById[t.authorId].handle}` : t.authorId,
      tag: 'member',
      text: t.text,
      engN: t.engN || 0,
      isNew: Boolean(lastPollAt && t.capturedAt === lastPollAt),
      ...(from.has(t.id) ? { from: from.get(t.id) } : {})
    })),
    tweetIds: posts.map((t) => t.id)
  };
}

export function groupIncidents(flags, postsById, authorsById, { now = Date.now(), lastPollAt = null } = {}) {
  const groups = new Map();
  for (const [tweetId, flag] of Object.entries(flags)) {
    const post = postsById.get(tweetId);
    if (!post) continue;
    const key = incidentKey(flag.kind, flag.place);
    const g = groups.get(key) || { id: key, kind: flag.kind, place: flag.place, posts: [] };
    g.posts.push(post);
    groups.set(key, g);
  }

  const incidents = [];
  for (const g of groups.values()) {
    const incident = shapeIncident(g, authorsById, { now, lastPollAt });
    if (incident.status === 'resolved' && now - new Date(incident.last).getTime() > 7 * DAY) continue;
    incidents.push(incident);
  }
  return sortIncidents(incidents);
}

// ── corroboration: helpers ───────────────────────────────────────────────
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s);

// "Napa County, CA · CA-04" → "CA"; "Michigan, MI" → "MI"; no state → null.
export function stateOf(place) {
  const m = rawPlace(place).match(/,\s*([A-Z]{2})\s*$/);
  return m ? m[1] : null;
}
// The flag's place without the lead member's district suffix.
export const rawPlace = (place) => String(place || '').split(' · ')[0];

function whenEt(iso) {
  return new Intl.DateTimeFormat('en-US', { timeZone: settings.timezone || 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

function describe(authorId, authorsById) {
  const a = authorsById?.[authorId];
  if (!a) return `author ${authorId}`;
  return `@${a.handle}${a.stateDistrict ? ` (${a.stateDistrict})` : ''}`;
}

// The span the judge sees as the card's own evidence: the provisional build
// stores one (`evidence.span`); otherwise the lead post's opening words.
export function evidenceSpan(incident, posts) {
  const stored = incident?.evidence?.span || incident?.evidence?.quote;
  if (stored) return squash(stored);
  const lead = posts.slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0];
  return lead ? clip(squash(lead.text), 200) : '';
}

// Exact-span check: the judge's evidence must be copied from a post.
export function verifySpan(span, text) {
  const q = squash(span), t = squash(text);
  if (!q) return { span: q, verified: false };
  if (t.toLowerCase().includes(q.toLowerCase())) return { span: q, verified: true };
  const bare = q.replace(/^[“"'‘]+|[”"'’…]+$/g, '').trim();
  if (bare && t.toLowerCase().includes(bare.toLowerCase())) return { span: bare, verified: true };
  return { span: q, verified: false };
}

// A mutable working copy of a card: hydrated posts plus the merge log built
// up during this run. `place` is the flag's place (no district suffix).
function toWork(incident, postsById) {
  return {
    id: incident.id,
    kind: incident.kind,
    place: rawPlace(incident.place),
    status: incident.status,
    posts: (incident.tweetIds || []).map((id) => postsById.get(id)).filter(Boolean),
    evidence: incident.evidence || null,
    mergeLog: [],
    judged: false
  };
}

const distinctMembers = (posts) => new Set(posts.map((t) => t.authorId)).size;

// Flagged posts of the last `days` days that sit on no open card: posts on a
// resolved card, or loose flags. Each carries the card it currently sits on
// (`origin`), if any, so a merge can log where it came from.
export function candidatePosts(flags, postsById, work, { now = Date.now(), days = 3 } = {}) {
  const onOpen = new Set();
  const originOf = new Map();
  for (const w of work) {
    for (const t of w.posts) {
      originOf.set(t.id, w.id);
      if (OPEN_STATUSES.has(w.status)) onOpen.add(t.id);
    }
  }
  const out = [];
  for (const [id, flag] of Object.entries(flags)) {
    if (onOpen.has(id)) continue;
    const post = postsById.get(id);
    if (!post) continue;
    const age = now - new Date(post.createdAt).getTime();
    if (age < 0 || age > days * DAY) continue;
    out.push({ post, flag: { kind: flag.kind, place: flag.place }, origin: originOf.get(id) || null, neighbor: false });
  }
  return out.sort((a, b) => (a.post.createdAt < b.post.createdAt ? -1 : 1));
}

// HOOK(semantic): when src/semantic.js lands (branch
// claude/night-semantic-integration — src/embeddings.js, src/embedding-index.js,
// src/semantic.js, data/embeddings/), ask the index for the posts that sit
// near a card's centroid but were never flagged. Expected contract:
//   relatedPosts({ ids: <post ids on the card>, limit, exclude: <ids already
//   in play> }) → [{ id, score, post? }]
// Anything returned that is not already flagged goes to the judge marked
// "unflagged neighbor"; the judge decides, never the distance. Until the
// module exists this returns nothing, and tests inject `neighbors` directly.
export async function unflaggedNeighbors(work, { exclude = new Set(), limit = 5, lookup = () => null } = {}) {
  let semantic;
  try { semantic = await import('./semantic.js'); } catch { return []; }
  if (typeof semantic.relatedPosts !== 'function') return [];
  try {
    const hits = await semantic.relatedPosts({ ids: work.posts.map((t) => t.id), limit, exclude: [...exclude] });
    const out = [];
    for (const h of Array.isArray(hits) ? hits : []) {
      const id = String(h?.id ?? h);
      if (exclude.has(id)) continue;
      const post = h?.post || lookup(id);
      if (post?.text) out.push({ ...post, id, semanticScore: typeof h?.score === 'number' ? h.score : null });
      if (out.length >= limit) break;
    }
    return out;
  } catch (e) {
    console.warn(`[incidents] semantic neighbors unavailable for ${work.id}: ${e.message}`);
    return [];
  }
}

// Pack open cards into calls of at most `batch_incidents` cards, keeping a
// state's cards together (a split event is almost always in one state) and
// handing each call the candidates from its states. Cards and candidates
// with no parseable state travel together as their own group.
export function planBatches(open, candidates, { batch_incidents = 15, batch_candidates = 40 } = {}) {
  const byState = new Map();
  const groupOf = (place) => stateOf(place) || '??';
  for (const w of open) {
    const k = groupOf(w.place);
    if (!byState.has(k)) byState.set(k, { incidents: [], candidates: [] });
    byState.get(k).incidents.push(w);
  }
  for (const c of candidates) {
    const k = c.neighbor ? groupOf(open.find((w) => w.id === c.incident)?.place) : groupOf(c.flag?.place);
    if (!byState.has(k)) byState.set(k, { incidents: [], candidates: [] });
    byState.get(k).candidates.push(c);
  }
  const batches = [];
  let cur = null;
  const flush = () => { if (cur?.incidents.length) batches.push(cur); cur = null; };
  const orphans = [];
  for (const state of [...byState.keys()].sort()) {
    const g = byState.get(state);
    if (!g.incidents.length) { orphans.push(...g.candidates); continue; } // no card to join in this state; still judged for a drop, below
    const chunks = [];
    for (let i = 0; i < g.incidents.length; i += batch_incidents) chunks.push(g.incidents.slice(i, i + batch_incidents));
    for (const chunk of chunks) {
      const cands = g.candidates.slice(0, batch_candidates);
      if (cur && (cur.incidents.length + chunk.length > batch_incidents || cur.candidates.length + cands.length > batch_candidates)) flush();
      cur ||= { states: [], incidents: [], candidates: [] };
      cur.states.push(state);
      cur.incidents.push(...chunk);
      cur.candidates.push(...cands);
    }
  }
  flush();
  // Candidates from a state with no open card ride along in the batch with
  // the most room, up to the cap; with no batch at all nothing is asked.
  for (const c of orphans) {
    const room = batches.slice().sort((a, b) => a.candidates.length - b.candidates.length)[0];
    if (!room || room.candidates.length >= batch_candidates) break;
    room.candidates.push(c);
  }
  return batches;
}

// ── corroboration: the prompt ────────────────────────────────────────────
export const JUDGE_SYSTEM = `You are the corroboration judge for the incident desk of the House Democratic Leader's communications office. The desk collects House members' X posts that a classifier flagged as a breaking district emergency ({kind, place}) into cards, one per exact kind+place string. That splits one event across cards when members use different words or neighbouring places, and it never lets a second member's post reach the first member's card. You read the posts and decide three things, each with a one-line reason and an exact span copied from a post:

1. SAME EVENT — which candidate posts describe the same real-world event as an open card (same fire, storm, shooting, outage, crash; different words, a kind synonym, a town inside the county, a region containing the city are still the same event).
2. DUPLICATES — which open cards are the same event as each other.
3. DROP — which flagged posts are not a breaking district emergency the member is handling:
   - commemoration: anniversaries, memorials, "we remember", a past event honoured;
   - hypothetical: a scenario, a drill, what a bill would do, a warning about a future event that has not happened;
   - national_policy: a national policy or political argument that only mentions an emergency;
   - aftermath: recovery weeks later — FEMA/SBA/USDA assistance, application deadlines, disaster-declaration requests or approvals, intake-centre schedules, thank-you messages, site visits, "the August storm", "is gone", "left behind";
   - reaction: thoughts-and-prayers or "heartbroken" from a member who is not handling the event (a distant district), with no instructions, resources or office engagement.

Rules:
- Judge from the post text (and quoted context when shown), never from the kind/place label alone. Two cards with the same kind but different events (two different fires, two different storms) are NOT duplicates.
- Same event needs the same place (or one inside the other) AND the same days AND the same emergency or its direct consequence (a storm and its outages are one event; a heat warning in another county is not).
- When in doubt, do not merge and do not drop. A wrong merge is worse than a split; a wrong drop hides a live emergency.
- Evidence: an EXACT span of at most 120 characters copied verbatim from one post shown here, with that post's id. Never paraphrase.
- Reason: one line, at most 30 words, that a staffer can read on the card.

Reply with ONLY a JSON object:
{"groups": [{"incidents": ["<card id>", ...], "posts": ["<candidate post id>", ...], "reason": "...", "evidence": {"post": "<post id>", "span": "<exact text>"}}],
 "drops": [{"post": "<post id>", "category": "commemoration|hypothetical|national_policy|aftermath|reaction", "reason": "...", "evidence": "<exact text>"}]}
A group is one real-world event: list every open card that is that event (two or more = duplicates to merge) and every candidate post that is that event. Omit a group that would contain one card and no posts. Use empty lists when nothing applies.`;

function renderPost(post, { authorsById = {}, quotedFor = null } = {}, { label = null } = {}) {
  const body = clip(squash(post.text), 600);
  const kind = post.type === 'quote' ? ' · quote' : post.type === 'reply' ? ' · reply' : '';
  let context = '';
  if ((post.type === 'quote' || post.type === 'reply') && post.refId) {
    const ref = quotedFor ? quotedFor(post) : null;
    const verb = post.type === 'quote' ? 'quoting' : 'replying to';
    context = ref?.text
      ? `\n    ↳ ${verb} ${ref.handle ? `@${ref.handle}` : 'a post'}: "${clip(squash(ref.text), 240)}"`
      : `\n    ↳ ${verb} a post outside the archive (context not available)`;
  }
  return `  - (${post.id}) ${describe(post.authorId, authorsById)} · ${whenEt(post.createdAt)}${kind}${label ? ` · ${label}` : ''}\n    "${body}"${context}`;
}

// The posts a card shows the judge: all of them up to the cap, else the first
// three (how it started) and the latest (where it is).
function shownPosts(posts, cap) {
  const sorted = posts.slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  if (sorted.length <= cap) return sorted;
  return [...sorted.slice(0, 3), ...sorted.slice(-(cap - 3))];
}

export function buildJudgePrompt(batch, ctx = {}, { posts_per_incident = 8, candidate_days = 3 } = {}) {
  const lines = ['OPEN CARDS — id, kind · place, the card\'s evidence span, then the member posts on it:'];
  for (const w of batch.incidents) {
    const shown = shownPosts(w.posts, posts_per_incident);
    lines.push(`[${w.id}] ${w.kind} · ${w.place}${w.status === 'provisional' ? ' · provisional (single post, not yet corroborated)' : ''}`);
    lines.push(`  evidence: "${evidenceSpan(w, w.posts)}"`);
    lines.push(`  posts (${w.posts.length}${shown.length < w.posts.length ? `, showing ${shown.length}` : ''}, ${distinctMembers(w.posts)} member(s)):`);
    for (const t of shown) lines.push(renderPost(t, ctx));
  }
  lines.push('');
  lines.push(`CANDIDATE POSTS — flagged in the last ${candidate_days} days and on no open card (their classifier label and, where they sit on a resolved card, its id), or "unflagged neighbor": never flagged, placed near a card by the semantic index:`);
  if (!batch.candidates.length) lines.push('  (none)');
  for (const c of batch.candidates) {
    const label = c.neighbor
      ? `unflagged neighbor of [${c.incident}]${typeof c.post.semanticScore === 'number' ? ` (similarity ${c.post.semanticScore.toFixed(2)})` : ''}`
      : `[${c.flag.kind} · ${c.flag.place}]${c.origin ? ` · on resolved card ${c.origin}` : ''}`;
    lines.push(renderPost(c.post, ctx, { label }));
  }
  lines.push('');
  lines.push('Reply with the JSON object only.');
  return lines.join('\n');
}

// Cache key: exactly what the model was asked, and which model.
export function judgmentSha(prompt, model) {
  return crypto.createHash('sha256').update(`${model}\n${JUDGE_SYSTEM}\n${prompt}`).digest('hex').slice(0, 16);
}

// ── corroboration: the reply ─────────────────────────────────────────────
const REASON_CAP = 200;
const SPAN_CAP = 120;

// Validate the reply against what was shown: only shown ids survive, a card
// or a post sits in at most one group (first wins), drops win over groups,
// categories outside the vocabulary are refused, spans are checked verbatim
// (an unverified span stays and says so).
export function normalizeJudgment(parsed, batch) {
  const out = { groups: [], drops: [] };
  if (!parsed || typeof parsed !== 'object') return out;
  const cards = new Map(batch.incidents.map((w) => [w.id, w]));
  const shownPost = new Map();
  for (const w of batch.incidents) for (const t of w.posts) shownPost.set(t.id, t);
  const cands = new Map();
  for (const c of batch.candidates) { cands.set(c.post.id, c); shownPost.set(c.post.id, c.post); }

  const evidenceOf = (raw, fallbackIds) => {
    const postId = String(raw?.post ?? raw?.id ?? fallbackIds[0] ?? '');
    const spanText = typeof raw === 'string' ? raw : raw?.span ?? raw?.quote ?? '';
    const post = shownPost.get(postId);
    let span = squash(spanText);
    if (span.length > SPAN_CAP) span = span.slice(0, SPAN_CAP - 1).replace(/\s+\S*$/, '');
    if (!post || !span) return span ? { post: post ? postId : null, span, verified: false } : null;
    return { post: postId, ...verifySpan(span, post.text) };
  };

  const droppedIds = new Set();
  for (const d of Array.isArray(parsed.drops) ? parsed.drops : []) {
    const id = String(d?.post ?? '');
    if (!shownPost.has(id) || droppedIds.has(id)) continue;
    const category = String(d?.category ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!DROP_CATEGORIES.includes(category)) continue;
    const reason = clip(squash(d?.reason), REASON_CAP);
    if (!reason) continue;
    droppedIds.add(id);
    out.drops.push({ post: id, category, reason, evidence: evidenceOf(d?.evidence, [id]) });
  }

  const usedCards = new Set();
  const usedPosts = new Set();
  for (const g of Array.isArray(parsed.groups) ? parsed.groups : []) {
    const incidents = [...new Set((Array.isArray(g?.incidents) ? g.incidents : []).map(String))].filter((id) => cards.has(id) && !usedCards.has(id));
    const posts = [...new Set((Array.isArray(g?.posts) ? g.posts : []).map(String))].filter((id) => cands.has(id) && !usedPosts.has(id) && !droppedIds.has(id));
    if (!incidents.length || (incidents.length < 2 && !posts.length)) continue;
    const reason = clip(squash(g?.reason), REASON_CAP) || 'judged the same event (no reason given)';
    for (const id of incidents) usedCards.add(id);
    for (const id of posts) usedPosts.add(id);
    out.groups.push({ incidents, posts, reason, evidence: evidenceOf(g?.evidence, [...posts, ...incidents.flatMap((id) => cards.get(id).posts.map((t) => t.id))]) });
  }
  return out;
}

// One call for one batch. `client` is injectable (tests feed a canned reply).
export async function judgeBatch(batch, ctx, { client, model, cfg = incidentSettings() }) {
  const prompt = buildJudgePrompt(batch, ctx, cfg);
  const res = await client.messages.create({
    model,
    max_tokens: 4000,
    system: JUDGE_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    output_config: { effort: 'medium' }
  });
  const usage = { input: res.usage?.input_tokens ?? 0, output: res.usage?.output_tokens ?? 0 };
  if (res.stop_reason === 'refusal') return { judgment: null, usage, why: 'refusal' };
  const text = res.content?.find((b) => b.type === 'text')?.text || '';
  const parsed = parseJsonLoose(text);
  if (!parsed || (!Array.isArray(parsed.groups) && !Array.isArray(parsed.drops))) {
    return { judgment: null, usage, why: `reply did not parse (stop_reason=${res.stop_reason}, ${text.length} chars): ${text.slice(0, 160).replace(/\s+/g, ' ')}` };
  }
  return { judgment: normalizeJudgment(parsed, batch), usage, why: null };
}

// ── corroboration: applying decisions ────────────────────────────────────
// Which card holds a post right now.
function holderOf(work, tweetId) {
  return work.find((w) => w.posts.some((t) => t.id === tweetId)) || null;
}

function removePost(work, tweetId) {
  const holder = holderOf(work, tweetId);
  if (!holder) return null;
  holder.posts = holder.posts.filter((t) => t.id !== tweetId);
  return holder;
}

// Deterministic choice of the card that survives a merge: the one with the
// most posts, then the earliest, then the id — so the fuller card keeps its
// id and the dashboard's selection and links stay stable.
export function pickTarget(cards) {
  return cards.slice().sort((a, b) =>
    b.posts.length - a.posts.length ||
    (earliest(a) < earliest(b) ? -1 : earliest(a) > earliest(b) ? 1 : 0) ||
    a.id.localeCompare(b.id)
  )[0];
}
const earliest = (w) => w.posts.reduce((m, t) => (m == null || t.createdAt < m ? t.createdAt : m), null) || '';

// Move a whole card, or listed posts, into `target`; returns the ids that
// actually moved (so a re-applied entry records only what still exists). A
// folded card's own merge log travels with it, so provenance survives a
// chain of merges; `absorbed` remembers where each folded card went.
function mergeInto(target, { merged_from = null, posts = [] }, { work, byId, lookup = () => null, absorbed = new Map() }) {
  const moved = [];
  const source = merged_from ? byId.get(merged_from) : null;
  if (source && source !== target) {
    for (const t of source.posts) { target.posts.push(t); moved.push(t.id); }
    source.posts = [];
    if (source.mergeLog.length) { target.mergeLog.push(...source.mergeLog); source.mergeLog = []; }
    absorbed.set(source.id, target.id);
  }
  for (const id of posts) {
    if (target.posts.some((t) => t.id === id)) continue;
    const holder = holderOf(work, id);
    const t = holder?.posts.find((x) => x.id === id) || lookup(id);
    if (!t) continue;
    if (holder) holder.posts = holder.posts.filter((x) => x.id !== id);
    target.posts.push(t);
    moved.push(id);
  }
  return moved;
}

// A card that was folded away earlier in the run stands for its absorber.
function resolveCard(id, byId, absorbed) {
  let cur = byId.get(id);
  const seen = new Set();
  while (cur && !cur.posts.length && absorbed.has(cur.id) && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = byId.get(absorbed.get(cur.id));
  }
  return cur && cur.posts.length ? cur : null;
}

// Earlier runs' merges and drops, read back from data/incidents.json.
export function priorDecisions(prev) {
  const merges = [];
  for (const inc of prev?.incidents || []) {
    for (const e of inc.mergeLog || []) merges.push({ target: inc.id, ...e });
  }
  return { merges, drops: (prev?.dropped || []).filter((d) => d?.tweetId) };
}

// Apply a batch's judgment to the working set. Drops first (a post the judge
// set aside never joins a card), then each group: the surviving card is
// chosen deterministically, the other cards and the candidate posts fold into
// it, and every fold is logged with the judge's reason and span.
export function applyJudgment(judgment, { work, byId, candidates, postsById, dropped, at, authorsById = {}, absorbed = new Map() }) {
  const stats = { merges: 0, drops: 0, absorbed: [] };
  const candById = new Map(candidates.map((c) => [c.post.id, c]));
  const ctx = { work, byId, absorbed, lookup: (id) => postsById.get(id) || candById.get(id)?.post || null };
  const handleOf = (post) => { const a = post && authorsById[post.authorId]; return a?.handle ? `@${a.handle}` : post?.authorId || null; };
  for (const d of judgment.drops) {
    const holder = removePost(work, d.post);
    const cand = candById.get(d.post);
    if (!holder && !cand) continue;
    if (cand) candidates.splice(candidates.indexOf(cand), 1);
    const post = postsById.get(d.post) || cand?.post;
    dropped.push({
      tweetId: d.post,
      incidentId: holder?.id || cand?.origin || null,
      handle: handleOf(post),
      category: d.category, reason: d.reason, evidence: d.evidence, at
    });
    stats.drops++;
  }
  for (const g of judgment.groups) {
    const cards = [...new Set(g.incidents.map((id) => resolveCard(id, byId, absorbed)).filter(Boolean))];
    if (!cards.length) continue;
    const target = pickTarget(cards);
    for (const w of cards) {
      if (w === target) continue;
      const moved = mergeInto(target, { merged_from: w.id }, ctx);
      if (!moved.length) continue;
      target.mergeLog.push({ merged_from: w.id, kind: w.kind, place: w.place, posts: moved, reason: g.reason, evidence: g.evidence, at, via: 'card' });
      stats.absorbed.push(w.id);
      stats.merges++;
    }
    const byOrigin = new Map();
    for (const id of g.posts) {
      const c = candById.get(id);
      if (!c || !candidates.includes(c)) continue;
      const key = c.neighbor ? 'neighbor' : c.origin || 'loose';
      if (!byOrigin.has(key)) byOrigin.set(key, []);
      byOrigin.get(key).push(c);
    }
    for (const [key, cs] of byOrigin) {
      const origin = key === 'neighbor' || key === 'loose' ? null : byId.get(key);
      const moved = mergeInto(target, { posts: cs.map((c) => c.post.id) }, ctx);
      if (!moved.length) continue;
      for (const c of cs) candidates.splice(candidates.indexOf(c), 1);
      target.mergeLog.push({ merged_from: origin?.id || null, kind: origin?.kind || cs[0].flag?.kind || null, place: origin?.place || cs[0].flag?.place || null, posts: moved, reason: g.reason, evidence: g.evidence, at, via: key === 'neighbor' ? 'neighbor' : 'post' });
      stats.merges++;
    }
  }
  return stats;
}

// The card as data/incidents.json stores it: the measured shape plus the
// judgment beside it (corroboration, merge log, merged sources) and the
// lifecycle advance for a provisional card that gained a second member.
function finalize(w, authorsById, { now, lastPollAt }) {
  const from = new Map();
  for (const e of w.mergeLog) for (const id of e.posts) from.set(id, e.merged_from || (e.via === 'neighbor' ? 'unflagged neighbor' : 'loose post'));
  const incident = shapeIncident({ id: w.id, kind: w.kind, place: w.place, posts: w.posts, from }, authorsById, { now, lastPollAt });
  const members = distinctMembers(w.posts);
  const wasProvisional = w.status === 'provisional';
  if (wasProvisional && members < 2) incident.status = 'provisional';
  const latest = w.mergeLog[w.mergeLog.length - 1] || null;
  incident.mergeLog = w.mergeLog;
  const sources = new Map();
  for (const e of w.mergeLog) {
    const key = e.merged_from || e.via;
    const s = sources.get(key) || { id: e.merged_from, kind: e.kind, place: e.place, via: e.via, posts: 0, reason: e.reason, at: e.at };
    s.posts += e.posts.length;
    sources.set(key, s);
  }
  incident.sources = [...sources.values()];
  if (w.evidence) incident.evidence = w.evidence;
  incident.corroboration = {
    members,                       // measured: distinct member accounts on the card
    posts: w.posts.length,         // measured
    merged: w.mergeLog.length,     // measured: folds applied by the judge (this run or re-applied)
    status: members >= 2 ? 'corroborated' : 'single-source',
    reason: latest?.reason || null,           // judgment: why the latest fold is the same event
    evidence: latest?.evidence || null,
    judged: w.judged,                          // whether the judge read this card (fresh or cached)
    advanced: wasProvisional && incident.status !== 'provisional' ? 'provisional→' + incident.status : null
  };
  return incident;
}

// ── corroboration: the run ───────────────────────────────────────────────
// Everything except file I/O and client construction, so tests drive it with
// synthetic cards, a stub client and (optionally) injected neighbors.
export async function corroborate(incidents, {
  flags = {}, postsById = new Map(), authorsById = {}, prev = null, cache = null, client = null, model = MODEL(),
  now = Date.now(), lastPollAt = null, cfg = incidentSettings(), force = false, quotedFor = null, neighbors = null, log = () => {}
} = {}) {
  const at = new Date(now).toISOString();
  const work = incidents.map((i) => toWork(i, postsById)).filter((w) => w.posts.length);
  const byId = new Map(work.map((w) => [w.id, w]));
  const absorbed = new Map();
  const dropped = [];
  const stats = { batches: 0, asked: 0, cached: 0, skipped: [], failed: [], merges: 0, drops: 0, reapplied: 0, candidates: 0, neighbors: 0 };

  // 1. Earlier decisions first, so the judge is only asked about what is new.
  const prior = priorDecisions(prev);
  for (const d of prior.drops) {
    const holder = removePost(work, d.tweetId);
    if (!holder) continue;
    dropped.push({ ...d, incidentId: holder.id, sticky: true });
    stats.reapplied++;
  }
  const priorCtx = { work, byId, absorbed, lookup: (id) => postsById.get(id) || null };
  for (const m of prior.merges) {
    const target = resolveCard(m.target, byId, absorbed);
    if (!target) continue;
    const moved = mergeInto(target, m, priorCtx);
    if (!moved.length) continue;
    target.mergeLog.push({ merged_from: m.merged_from || null, kind: m.kind || null, place: m.place || null, posts: moved, reason: m.reason, evidence: m.evidence || null, at: m.at || at, via: m.via || 'card', sticky: true });
    stats.reapplied++;
  }

  // 2. What the judge reads: open cards, loose flagged posts, semantic neighbors.
  const open = work.filter((w) => OPEN_STATUSES.has(w.status) && w.posts.length);
  const candidates = candidatePosts(flags, postsById, work, { now, days: cfg.candidate_days });
  stats.candidates = candidates.length;
  if (open.length) {
    const inPlay = new Set([...Object.keys(flags), ...candidates.map((c) => c.post.id)]);
    for (const w of open) {
      const found = neighbors ? await neighbors(w, { exclude: inPlay, limit: cfg.neighbors_per_incident }) : await unflaggedNeighbors(w, { exclude: inPlay, limit: cfg.neighbors_per_incident });
      for (const post of found || []) {
        if (!post?.id || inPlay.has(post.id)) continue;
        inPlay.add(post.id);
        candidates.push({ post, flag: null, origin: null, neighbor: true, incident: w.id });
        stats.neighbors++;
      }
    }
  }

  // 3. Judge, batch by batch, from the cache where the content is unchanged.
  const cacheFile = { cache: {}, ledger: {}, ...(cache || {}) };
  for (const [sha, e] of Object.entries(cacheFile.cache)) {
    if (now - new Date(e.at || 0).getTime() > cfg.cache_days * DAY) delete cacheFile.cache[sha];
  }
  const today = etDate(new Date(now));
  const day = (cacheFile.ledger[today] = { calls: 0, inputTokens: 0, outputTokens: 0, ...(cacheFile.ledger[today] || {}) });
  for (const k of Object.keys(cacheFile.ledger).sort().slice(0, -30)) delete cacheFile.ledger[k];

  const ctx = { authorsById, quotedFor };
  const batches = planBatches(open, candidates, cfg);
  stats.batches = batches.length;
  const judgments = [];
  for (const batch of batches) {
    const prompt = buildJudgePrompt(batch, ctx, cfg);
    const sha = judgmentSha(prompt, model);
    const label = `${batch.states.join('+')} (${batch.incidents.length} card(s), ${batch.candidates.length} candidate(s))`;
    let judgment = !force && cacheFile.cache[sha]?.judgment ? cacheFile.cache[sha].judgment : null;
    if (judgment) {
      stats.cached++;
      log(`  = ${label}  cached ${sha}`);
    } else if (!client) {
      stats.skipped.push({ batch: label, why: 'no Claude client' });
      continue;
    } else if (day.calls >= cfg.daily_calls) {
      stats.skipped.push({ batch: label, why: `daily ceiling ${cfg.daily_calls} reached` });
      continue;
    } else {
      day.calls++;
      let r;
      try {
        r = await judgeBatch(batch, ctx, { client, model, cfg });
      } catch (e) {
        r = { judgment: null, usage: { input: 0, output: 0 }, why: e.message };
      }
      day.inputTokens += r.usage.input;
      day.outputTokens += r.usage.output;
      if (!r.judgment) {
        stats.failed.push({ batch: label, why: r.why });
        log(`  ! ${label}  ${r.why}`);
        continue;
      }
      judgment = r.judgment;
      stats.asked++;
      cacheFile.cache[sha] = { at, model, usage: r.usage, incidents: batch.incidents.map((w) => w.id), candidates: batch.candidates.map((c) => c.post.id), judgment };
      log(`  + ${label}  ${judgment.groups.length} group(s), ${judgment.drops.length} drop(s) [${sha}]`);
    }
    for (const w of batch.incidents) w.judged = true;
    judgments.push(judgment);
  }

  // 4. Apply, in batch order — deterministic for a given set of replies.
  for (const j of judgments) {
    const s = applyJudgment(j, { work, byId, candidates, postsById, dropped, at, authorsById, absorbed });
    stats.merges += s.merges;
    stats.drops += s.drops;
    for (const g of j.groups) log(`    ∪ ${g.incidents.join(' + ')}${g.posts.length ? ` + ${g.posts.length} post(s)` : ''} — ${g.reason}`);
    for (const d of j.drops) log(`    − ${d.post} ${d.category}: ${d.reason}`);
  }

  const out = sortIncidents(work.filter((w) => w.posts.length).map((w) => finalize(w, authorsById, { now, lastPollAt })));
  cacheFile.generatedAt = at;
  cacheFile.model = model;
  return { incidents: out, dropped, cacheFile, stats };
}

// ── intel ────────────────────────────────────────────────────────────────
async function extractIntel(incident, model) {
  const { anthropicClient } = await import('./anthropic-auth.js');
  const client = await anthropicClient();
  const posts = incident.timeline.map((e) => `[${e.time}] ${e.who}: ${e.text}`).join('\n');
  const res = await client.messages.create({
    model,
    max_tokens: 2000,
    system: 'You summarize a breaking district incident from a House member\'s X posts for a communications team. Only state what the posts themselves say; attribute every item to the post ("per @handle, <time>"). Facts the member states from officials (police, OEM, fire) go in "confirmed"; things the member frames as reports/claims/unconfirmed go in "unverified"; "whatsNew" is 2-4 short bullets on the latest developments, newest first. Reply with ONLY JSON: {"confirmed":[{"text":"...","src":"..."}],"unverified":[{"text":"...","src":"..."}],"whatsNew":["..."]}',
    messages: [{ role: 'user', content: `Incident: ${incident.kind} — ${incident.place}\nPosts:\n${posts}` }]
  });
  if (res.stop_reason === 'refusal') return null;
  const textBlock = res.content.find((b) => b.type === 'text');
  const parsed = textBlock && parseJsonLoose(textBlock.text);
  if (!parsed) return null;
  return {
    confirmed: (parsed.confirmed || []).slice(0, 5),
    unverified: (parsed.unverified || []).slice(0, 5),
    whatsNew: (parsed.whatsNew || []).slice(0, 5),
    extractedAt: new Date().toISOString(),
    posts: incident.updates
  };
}

// ── the build ────────────────────────────────────────────────────────────
export async function buildIncidents({ withIntel = false, withCorroboration = incidentSettings().corroborate !== false, client = null, force = false, now = Date.now(), log = () => {} } = {}) {
  const authorsById = loadAuthors().byId;
  const state = loadState();
  const flags = collectFlags();
  const prev = readJSON(incidentsPath, { incidents: [] });

  // Hydrate flagged posts (plus amplifier counts) from the archive window —
  // and the posts earlier merges brought in, which may never have been flagged.
  const wanted = new Set(Object.keys(flags));
  for (const inc of prev.incidents || []) for (const e of inc.mergeLog || []) for (const id of e.posts || []) wanted.add(id);
  const postsById = new Map();
  const retweetsOf = new Map();
  for (let d = 7; d >= 0; d--) {
    for (const t of loadDay(daysAgoEt(d))) {
      if (wanted.has(t.id)) {
        const m = t.metricsAtCapture || {};
        postsById.set(t.id, { ...t, engN: (m.likes || 0) + (m.retweets || 0) + (m.replies || 0) + (m.quotes || 0) });
      }
      if (t.type === 'retweet' && t.refId) retweetsOf.set(t.refId, (retweetsOf.get(t.refId) || 0) + 1);
    }
  }
  // Prefer refreshed 24h metrics where they exist.
  for (let d = 7; d >= 1; d--) {
    const metrics = readJSON(p('data', 'metrics', `${daysAgoEt(d)}.json`), {});
    for (const [id, m] of Object.entries(metrics)) {
      const post = postsById.get(id);
      if (post && !m.unavailable) post.engN = (m.likes || 0) + (m.retweets || 0) + (m.replies || 0) + (m.quotes || 0);
    }
  }
  for (const post of postsById.values()) post.amplifiers = retweetsOf.get(post.id) || 0;

  const prevById = new Map(prev.incidents.map((i) => [i.id, i]));
  let incidents = groupIncidents(flags, postsById, authorsById, { now, lastPollAt: state.lastPollAt });

  // Corroboration: prior merges/drops are always re-applied (free); the judge
  // is asked only with a client, and only about batches the cache has not seen.
  let dropped = prev.dropped || [];
  let judge = prev.judge || null;
  const model = MODEL();
  try {
    if (withCorroboration && !client && anthropicConfigured()) {
      const { anthropicClient } = await import('./anthropic-auth.js');
      client = await anthropicClient();
    }
    let quotedFor = null;
    try { const { quotedResolver } = await import('./quoted.js'); quotedFor = quotedResolver(); } catch { /* context is optional */ }
    const r = await corroborate(incidents, {
      flags, postsById, authorsById, prev, cache: readJSON(judgmentsPath, null), client: withCorroboration ? client : null, model,
      now, lastPollAt: state.lastPollAt, force, quotedFor, log
    });
    incidents = r.incidents;
    dropped = r.dropped;
    judge = { at: new Date(now).toISOString(), model, ...r.stats };
    writeJSON(judgmentsPath, r.cacheFile);
  } catch (e) {
    console.warn(`[incidents] corroboration failed — cards are string-grouped only: ${e.message}`);
  }

  for (const incident of incidents) {
    const old = prevById.get(incident.id);
    incident.intel = old?.intel || null;
    const stale = !incident.intel || incident.intel.posts < incident.updates;
    if (withIntel && stale && anthropicConfigured()) {
      try {
        incident.intel = await extractIntel(incident, model) || incident.intel;
      } catch (e) {
        console.warn(`[incidents] intel extraction failed for ${incident.id}: ${e.message}`);
      }
    }
  }

  writeJSON(incidentsPath, { generatedAt: new Date().toISOString(), incidents, dropped, judge });
  return incidents;
}

async function main() {
  const withCorroboration = !process.argv.includes('--no-corroborate');
  const force = process.argv.includes('--force');
  const incidents = await buildIncidents({ withIntel: true, withCorroboration, force, log: console.log });
  const counts = { provisional: 0, active: 0, monitoring: 0, resolved: 0 };
  for (const i of incidents) counts[i.status] = (counts[i.status] || 0) + 1;
  const file = readJSON(incidentsPath, {});
  const j = file.judge;
  console.log(`[incidents] ${incidents.length} incident(s): ${counts.active} active, ${counts.monitoring} monitoring, ${counts.resolved} resolved${counts.provisional ? `, ${counts.provisional} provisional` : ''}`);
  if (j) console.log(`[incidents] corroboration: ${j.batches} batch(es), ${j.asked} asked, ${j.cached} cached, ${j.merges} merge(s), ${j.drops} drop(s), ${j.reapplied} earlier decision(s) re-applied, ${(file.dropped || []).length} post(s) set aside${j.failed?.length ? `, ${j.failed.length} failed` : ''}${j.skipped?.length ? `, ${j.skipped.length} skipped` : ''}`);
  for (const f of j?.failed || []) console.warn(`[incidents]   failed ${f.batch}: ${f.why}`);
  for (const s of j?.skipped || []) console.warn(`[incidents]   skipped ${s.batch}: ${s.why}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
