// Fixed public-source evaluation bundles. Expected memberships are reviewer
// metadata only: callers send plan.posts, never the surrounding case object.
// No network, model calls, publication, or interpretation writes occur here.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { p, readJSONL } from './util.js';
import { archivePath, topicsPath } from './store.js';
import { readClassificationFile } from './classify.js';
import { combineInterpretations, liveTopicsPath } from './classify-live.js';
import { archiveLookup, quotedResolver } from './quoted.js';
import { loadTaxonomy } from './taxonomy.js';
import { evidenceForPosts, evidenceLine, loadNews } from './news-context.js';

export const EVENT_PILOT_CASES = Object.freeze([
  Object.freeze({
    id: 'johnson-ai-oversight', date: '2026-09-14',
    expectedIds: Object.freeze(['2099486798074257742', '2099487281677554158', '2099508362484302050', '2099515039484960898']),
    negativeIds: Object.freeze(['2099528618003366257', '2099512150737719793', '2099493450152382894'])
  }),
  Object.freeze({
    id: 'shared-actors-distinct-events', date: '2026-09-14',
    expectedIds: Object.freeze([]),
    negativeIds: Object.freeze(['2099489632148754661', '2099471129777668544', '2099526917690892520', '2099514645480419802'])
  })
]);

const stable = (value) => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => [k, stable(value[k])])) : value;
const digest = (value) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
const numericId = (value) => typeof value === 'string' && /^\d+$/.test(value);
const readPublicJSON = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
};
const memberKey = (author) => author?.personId || author?.memberId
  ? String(author.personId || author.memberId)
  : author?.member ? `member:${String(author.member).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()}` : null;
const defaultPosts = (date) => readJSONL(archivePath(date), { strict: true });
const defaultInterpretation = (date) => combineInterpretations(
  readClassificationFile(liveTopicsPath(date), null), readClassificationFile(topicsPath(date), null));

function sourceContext(value, id, raw = value, capturedWithPost = null) {
  if (!value || !numericId(id) || typeof value.text !== 'string') return undefined;
  return { id, authorId: value.authorId ?? null, handle: value.handle ?? null,
    text: value.text, createdAt: raw?.createdAt ?? null, capturedAt: raw?.capturedAt ?? raw?.fetchedAt ?? capturedWithPost };
}

function usableContext(context, { asOfMs, mode, field, incomplete }) {
  if (!context) return undefined;
  for (const key of ['createdAt', 'capturedAt']) {
    if (context[key] != null && (!Number.isFinite(Date.parse(context[key])) || Date.parse(context[key]) > asOfMs)) {
      incomplete.push(`${field}-${key}-outside-run`);
      return undefined;
    }
  }
  if (mode === 'as-of' && !Number.isFinite(Date.parse(context.capturedAt))) {
    incomplete.push(`${field}-acquisition-unknown`);
    return undefined;
  }
  return context;
}

function normalizedEvidence(value, runAsOf) {
  if (!value || typeof value.id !== 'string' || !/^https?:\/\//.test(value.url || '')) throw new Error('Invalid public evidence in event pilot');
  const line = typeof value.text === 'string' ? value : evidenceLine(value);
  for (const key of ['publishedAt', 'fetchedAt']) {
    if (!Number.isFinite(Date.parse(line[key])) || Date.parse(line[key]) > runAsOf) return null;
  }
  // Explicit field selection prevents provider/private payloads from flowing
  // through this public pilot; preserve the exact supplied passage text.
  return { id: line.id, publisher: line.publisher ?? null, title: line.title ?? null,
    url: line.url, text: line.text, kind: line.kind ?? 'lead',
    publishedAt: line.publishedAt, fetchedAt: line.fetchedAt, version: line.version ?? null,
    publishedAfterPost: Boolean(line.publishedAfterPost), acquiredAfterPost: Boolean(line.acquiredAfterPost), truncated: Boolean(line.truncated) };
}

// Changing capture metrics, clock-only refresh metadata, or the global news
// version cannot reopen identical evidence. Relevant taxonomy definitions and
// exact source/evidence content remain part of the meaningful input hash.
export function fingerprintEventPosts(posts) {
  const sorted = [...posts].sort((a, b) => a.id.localeCompare(b.id));
  return {
    sourceHash: digest(sorted.map(({ id, authorId, personId, createdAt, capturedAt, type, text, quoting, reposted, sourceIncomplete, sourceIncompleteReasons, topics, evidence, taxonomyContext }) =>
      ({ id, authorId, personId, createdAt, capturedAt, type, text, quoting, reposted, sourceIncomplete, sourceIncompleteReasons, topics,
        evidence: [...(evidence || [])].map(({ bodyAttemptedAt, bodyFetchedAt, lastRefreshAt, ...item }) => item).sort((a, b) => a.id.localeCompare(b.id)), taxonomyContext }))),
    correctionHash: digest(sorted.map(({ id, corrected }) => ({ id, corrected: corrected ?? null })))
  };
}

// Dependency contracts: loadPosts(date) -> source records;
// loadInterpretation(date) -> merged day interpretation;
// loadEvidence(posts, {runAsOf}) -> {byPost: {id: evidence[]}, version}.
// The fixed historical selection is NOT a rolling/current coverage claim.
export async function loadEventPilot({ runAsOf = new Date(), mode = 'retrospective', loadPosts = defaultPosts,
  loadInterpretation = defaultInterpretation, authorsById,
  loadEvidence, taxonomy = loadTaxonomy(), quotedStore } = {}) {
  const asOfMs = new Date(runAsOf).getTime();
  if (!Number.isFinite(asOfMs)) throw new Error('Invalid event pilot runAsOf');
  if (!['retrospective', 'as-of'].includes(mode)) throw new Error('Invalid event pilot interpretation mode');
  const asOf = new Date(asOfMs).toISOString();
  authorsById ??= readPublicJSON(p('data', 'authors.json'), { byId: {} }).byId;
  quotedStore ??= readPublicJSON(p('data', 'quoted.json'), {});
  const days = new Map();
  const day = (date) => {
    if (!days.has(date)) {
      const rows = loadPosts(date);
      if (!Array.isArray(rows)) throw new Error(`Invalid event pilot archive ${date}`);
      const seen = new Set();
      for (const row of rows) {
        if (!numericId(row?.id) || seen.has(row.id) || typeof row.text !== 'string' || !Number.isFinite(Date.parse(row.createdAt))) throw new Error(`Invalid or duplicate event pilot source in ${date}`);
        seen.add(row.id);
      }
      days.set(date, rows);
    }
    return days.get(date);
  };
  const archive = archiveLookup({ loadDay: day });
  const resolve = quotedResolver({ quoted: quotedStore, archive, authorsById, metricsFor: () => ({}) });
  const byDate = new Map(), plans = [];
  for (const fixture of EVENT_PILOT_CASES) {
    if (!byDate.has(fixture.date)) byDate.set(fixture.date, loadInterpretation(fixture.date));
    const interpretation = byDate.get(fixture.date);
    if (interpretation && (!interpretation.assignments || typeof interpretation.assignments !== 'object' || Array.isArray(interpretation.assignments))) throw new Error(`Invalid event pilot interpretation ${fixture.date}`);
    const pending = new Set([...(interpretation?.pendingIds || []), ...(interpretation?.unclassified || [])]);
    const byId = new Map(day(fixture.date).map((post) => [post.id, post]));
    const posts = [], excluded = [];
    const selectedIds = [...fixture.expectedIds, ...fixture.negativeIds];
    if (selectedIds.length > 24 || new Set(selectedIds).size !== selectedIds.length) throw new Error('Invalid event pilot selection');
    for (const id of selectedIds) {
      const post = byId.get(id), author = authorsById?.[post?.authorId];
      const corrected = interpretation?.corrected?.[id];
      const topics = interpretation?.assignments?.[id];
      let reason = !post ? 'source-missing' : corrected ? 'human-corrected'
        : !author || (author.status || 'house') !== 'house' || !memberKey(author) ? 'member-unknown-or-out-of-scope'
          : !Object.hasOwn(interpretation?.assignments || {}, id) || pending.has(id) ? 'interpretation-pending'
            : Date.parse(post.createdAt) > asOfMs || (post.capturedAt && Date.parse(post.capturedAt) > asOfMs) ? 'source-after-run'
              : asOfMs - Date.parse(post.createdAt) >= 86_400_000 ? 'source-outside-24h-window' : null;
      if (reason) { excluded.push({ id, reason, ...(corrected ? { correctionHash: digest(corrected) } : {}) }); continue; }
      if (!Array.isArray(topics) || topics.some((pair) => !Array.isArray(pair) || pair.length !== 2 || !taxonomy[pair[0]] || (pair[1] != null && !taxonomy[pair[0]].subtopics?.[pair[1]]))) {
        excluded.push({ id, reason: 'invalid-or-stale-topics' }); continue;
      }
      const ctx = resolve(post);
      const rawQuote = post.quoted || (post.refId && quotedStore[post.refId]) || (ctx?.id && archive(ctx.id));
      const incomplete = [];
      const quoting = usableContext(sourceContext(ctx, ctx?.id, rawQuote, post.quoted ? post.capturedAt : null),
        { asOfMs, mode, field: 'quoting', incomplete });
      const reposted = usableContext(sourceContext(post.reposted, post.reposted?.id, post.reposted, post.capturedAt),
        { asOfMs, mode, field: 'reposting', incomplete });
      if (post.type === 'retweet' && !reposted?.text?.trim()) incomplete.push('repost-original-unavailable');
      const taxonomyContext = Object.fromEntries([...new Set(topics.map(([macro]) => macro))].sort().map((macro) => [macro, clone(taxonomy[macro])]));
      posts.push({ id, authorId: post.authorId, personId: memberKey(author), createdAt: post.createdAt, capturedAt: post.capturedAt ?? null, type: post.type ?? 'tweet', text: post.text,
        ...(quoting ? { quoting } : {}), ...(reposted ? { reposted } : {}), topics: clone(topics),
        sourceIncomplete: incomplete.length > 0, sourceIncompleteReasons: incomplete,
        evidence: [], contextVersion: 0, taxonomyContext });
    }
    plans.push({ caseId: fixture.id, posts, runAsOf: asOf, mode, expectedIds: [...fixture.expectedIds], negativeIds: [...fixture.negativeIds], diagnostics: excluded, ready: excluded.length === 0 });
  }
  const allPosts = plans.flatMap((plan) => plan.posts);
  const evidenceSnapshot = loadEvidence ? await loadEvidence(allPosts, { runAsOf: asOf }) : (() => {
    const store = loadNews({ days: 21, now: asOfMs });
    return evidenceForPosts(allPosts, { items: store.items, version: store.version, k: 2, perChunkCap: Infinity, knownAt: asOf, mode: 'retrospective' });
  })();
  if (!evidenceSnapshot || !evidenceSnapshot.byPost || typeof evidenceSnapshot.byPost !== 'object') throw new Error('Invalid event pilot evidence snapshot');
  for (const post of allPosts) {
    const evidence = evidenceSnapshot.byPost[post.id] || [];
    if (!Array.isArray(evidence) || new Set(evidence.map((e) => e?.id)).size !== evidence.length) throw new Error(`Invalid or duplicate evidence for event pilot ${post.id}`);
    post.evidence = evidence.map((e) => normalizedEvidence(e, asOfMs)).filter(Boolean);
    post.contextVersion = Number.isInteger(evidenceSnapshot.version) ? evidenceSnapshot.version : 0;
  }
  for (const plan of plans) Object.assign(plan, fingerprintEventPosts(plan.posts));
  return { snapshot: { kind: 'fixed-public-historical-pilot', selectedDates: [...byDate.keys()], runAsOf: asOf,
    interpretationMode: mode, historicalVersionReplay: false,
    notes: 'Latest retained source versions; evidence is limited to publication and acquisition by runAsOf, not each post time. Missing prior versions cannot establish historical knowledge. Expected and negative IDs are reviewer metadata, never model inputs.' },
    plans, diagnostics: plans.flatMap((plan) => plan.diagnostics.map((item) => ({ caseId: plan.caseId, ...item }))) };
}
