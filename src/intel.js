// Narrative-intelligence runner (docs/NARRATIVE_INTELLIGENCE.md §3, §16 step 10).
//
//   PHASE 0  budget gate   reconcile the ledger with GET /2/usage/tweets (free),
//                          reserve what capture still needs today, pick a mode
//   PHASE 1  collect (X)   List scans → one-time operator probes → counts pass →
//                          rank → sample the top stories → phrases outside →
//                          incident probes + owner queries. Every call goes
//                          through intel-budget.billedCall: reservation, ledger
//                          (saved before any output), spend log, tool-result cache.
//   PHASE 2  measure       pure, from disk (archive, List day-files, evidence files)
//   PHASE 3  assess        one Claude call per sampled story (web tools on by default)
//   PHASE 4  publish       data/narratives/<key>.json + index.json (tmp-then-rename)
//
// Never runs inside poll.js. Skips cleanly without credentials: no X → mode
// off (measures what is on disk); no Anthropic → --no-llm (MEASURED half only).
//
//   npm run intel -- --dry-run                       # print the plan, spend nothing
//   npm run intel                                     # nightly-shaped run under the caps
//   npm run intel -- --stories=epstein-files --max-reads=120 --no-lists
//   npm run intel -- --replay                         # phases 2–4 from disk, zero X spend
//   npm run intel -- --ask="…" --story=<key>          # v1: bounded probe + one assess call
//   flags: --mode=full|counts|off --story=k --phrase="…" --no-llm --force
//          --rosters=house-gop --incidents --phrases --full-archive --max-results=N --pages=N
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as xClient from './x.js';
import { p, settings, etDate, readJSON, daysAgoEt } from './util.js';
import { loadState, saveState, headroom, loadDay } from './store.js';
import { anthropicConfigured } from './anthropic-auth.js';
import { loadAuthors, isHouse } from './authors.js';
import { caps, captureReserve, planMode, reconcile, Reservation, SpendLog, priorStorySpend } from './intel-budget.js';
import { pruneCache, utcDate } from './intel-cache.js';
import { listEntries, loadCursors, loadRosters, loadCarriers, loadProbes, scanLists, planLists, pullRoster, probeOperators, recentCaucusPostId, writeAtomic, readListDays, PRESS_KEYS } from './intel-lists.js';
import { storyCandidates, countsPass, rankStories, probeStory, evidencePath, recordPath, indexPath, narrativesDir, topPhrases, phraseOutside, probeIncident, runOwnerQueries, questionsDir, incidentSearchPath } from './intel-search.js';
import { loadCorpus, assignStories, aliasTokens, matchesAliases, windowDates } from './intel-corpus.js';
import { readContext, contextFor, loadOwnerQueries } from './intel-context.js';
import { measureStory, statusOf, flagsOf, buildEvidencePack, v } from './intel-measure.js';
import { assessStory } from './intel-assess.js';
import { incidentsPath } from './incidents.js';
import { slug } from './stories.js';

const RUN_CAP_MS = 30 * 60_000;
const ASSESS_CAP_MS = 6 * 60_000;
const DAY = 86_400_000;

export function parseArgs(argv) {
  const has = (n) => argv.includes(`--${n}`);
  const val = (n, d = null) => { const a = argv.find((s) => s.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
  const list = (n) => (val(n, '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const stories = [...list('stories'), ...(val('story') ? [val('story')] : [])];
  return {
    dryRun: has('dry-run'), mode: val('mode'), stories, story: val('story'), phrase: val('phrase'), ask: val('ask'),
    maxReads: val('max-reads') != null ? Number(val('max-reads')) : null, noLists: has('no-lists'), noLlm: has('no-llm'),
    replay: has('replay'), force: has('force'), rosters: list('rosters'), incidents: has('incidents'), phrases: has('phrases'),
    fullArchive: has('full-archive'), maxResults: val('max-results') ? Number(val('max-results')) : null, pages: val('pages') ? Number(val('pages')) : null
  };
}

export function inputsHash(story, context, date) {
  const threads = (context?.matches || []).map((m) => m.threadId).filter(Boolean).sort();
  const aliases = [...new Set((story.aliases || []).map((a) => String(a).toLowerCase()))].sort();
  return createHash('sha1').update(JSON.stringify({ ids: [...(story.ids || [])].sort(), aliases, threads, date })).digest('hex');
}

// Evidence counts array → keyed { organic, originals, hourly, control }.
function keyCounts(evidence, control) {
  const out = { organic: null, originals: null, hourly: null, control: control || evidence?.control || null };
  for (const c of evidence?.counts || []) if (c && c.kind in out && !out[c.kind]) out[c.kind] = c;
  return out;
}

function latestEvidence(key, date) {
  const dir = path.join(narrativesDir, key);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch { return null; }
  const exact = files.find((f) => f === `${date}.json`);
  const pick = exact || files.at(-1);
  return pick ? readJSON(path.join(dir, pick), null) : null;
}

// ── PHASE 2 + record assembly (pure given its inputs) ────────────────────
export function buildRecord(story, {
  evidence = null, control = null, corpus, context, cursors = { lists: {} }, now = new Date(), date = etDate(now), mode = 'full',
  hash = null, authorsById = {}, activeHouseAccounts = null, assess = null, webToolsUnavailable = false, noAssessReason = 'no-llm'
} = {}) {
  const rows = corpus.rows.filter((r) => r.voice !== 'excluded');
  const assigned = assignStories(rows, [story]).get(story.key) || [];
  const gopWindowRows = rows.filter((r) => r.voice === 'gop');
  const gopRowsOfDay = gopWindowRows.filter((r) => etDate(r.createdAt) === date);
  const counts = keyCounts(evidence, control);
  const pressCursors = PRESS_KEYS.map((k) => cursors.lists?.[k]?.complete).filter((x) => x != null);
  const listDates = corpus.rows.flatMap((r) => r.sources.filter((s) => s.kind === 'list').map(() => etDate(r.createdAt))).sort();
  const windows = {
    archive: [corpus.dates[0], corpus.dates.at(-1)],
    lists: listDates.length ? [listDates[0], listDates.at(-1)] : null,
    search: [utcDate(new Date(now.getTime() - 7 * DAY)), utcDate(now)],
    newsletter: context?.available ? context.generatedAt : null
  };
  const measured = measureStory(story, {
    rows: assigned, gopWindowRows, gopComplete: cursors.lists?.['house-gop']?.complete ?? null,
    pressComplete: pressCursors.length ? pressCursors.every(Boolean) : null,
    counts, evidence, context, now: now.getTime(), windows, activeHouseAccounts, authorsById
  });
  if (assess?.fetched?.length) measured.press.articles = { value: assess.fetched.map((f) => ({ url: f.url, title: f.title, outlet: f.title ? null : null, fetched: true })), source: 'web_fetch (assess step)', units: 0 };
  const status = statusOf(measured, { kind: story.kind || 'story' });
  const flags = flagsOf(measured, { context, story, now: now.getTime(), webToolsUnavailable: webToolsUnavailable || Boolean(assess?.webToolsUnavailable) });
  const spendUnits = evidence?.units || 0;
  const record = {
    key: story.key, label: story.label, macro: story.macro || null, kind: story.kind || 'story',
    candidateKey: story.candidateKeys?.[0] || story.candidateKey || null, candidateKeys: story.candidateKeys || [],
    aliases: story.aliases || [], queries: evidence?.queries || story.queries || null,
    generatedAt: now.toISOString(), date, mode, inputsHash: hash,
    status, flags, windows, measured,
    judged: assess?.judged ? { ...assess.judged, model: assess.model, webUses: assess.webToolsUsed ? assess.webUses : null } : null,
    assessmentSkipped: assess ? assess.assessmentSkipped : (noAssessReason || 'no-llm'),
    claims: assess?.claims || { confirmed: [], reported: [], unverified: [], false: [] },
    couldNotVerify: assess?.couldNotVerify || [],
    provenance: {
      ids: assess?.provenance?.ids || [], urls: assess?.provenance?.urls || [],
      evidenceFile: evidence ? `data/narratives/${story.key}/${evidence.date}.json` : null,
      spend: { posts: evidence?.posts?.length || 0, users: evidence?.resolution?.resolved || 0, requests: (evidence?.counts || []).length, units: spendUnits, usd: Math.round(spendUnits * 0.005 * 1000) / 1000 },
      cacheHits: evidence?.cacheHits || 0,
      claude: assess?.usage ? { input: assess.usage.input, cacheRead: assess.usage.cacheRead, cacheWrite: assess.usage.cacheWrite, output: assess.usage.output, calls: assess.usage.calls } : null,
      dropped: assess?.dropped || []
    }
  };
  return { record, rows: assigned, gopRowsOfDay, measured };
}

function indexRow(r) {
  return {
    key: r.key, label: r.label, macro: r.macro, status: r.status, flags: r.flags,
    lift: v(r.measured?.organic?.lift) ?? null, gopPosts: v(r.measured?.gop?.posts) ?? 0, pressPosts: v(r.measured?.press?.posts) ?? 0,
    newsletterHits: (v(r.measured?.press?.newsletterHits) || []).length,
    confirmed: r.claims?.confirmed?.length || 0, reported: r.claims?.reported?.length || 0, unverified: r.claims?.unverified?.length || 0,
    spendUnits: r.provenance?.spend?.units || 0, updatedAt: r.generatedAt, date: r.date, assessmentSkipped: r.assessmentSkipped
  };
}

export function loadAllRecords() {
  let files = [];
  try { files = fs.readdirSync(narrativesDir).filter((f) => f.endsWith('.json') && !['index.json', 'carriers.json', 'probes.json'].includes(f)); } catch { return []; }
  return files.map((f) => readJSON(path.join(narrativesDir, f), null)).filter((r) => r && r.key && r.measured);
}

const fmtUnits = (u) => `${u} units (~$${(u * 0.005).toFixed(2)})`;

// ── the run ──────────────────────────────────────────────────────────────
export async function run(opts, { x = xClient, now = new Date(), log = console.log } = {}) {
  const startedAt = Date.now();
  const withinTime = () => Date.now() - startedAt < RUN_CAP_MS;
  const date = etDate(now);
  const utc = utcDate(now);
  const summary = { date, mode: null, units: 0, usd: 0, cacheHits: 0, records: [], skipped: [], claude: { calls: 0, cacheRead: 0, input: 0, output: 0 }, reconcile: null };

  // ── PHASE 0: budget gate
  const state = loadState();
  const { used: ledgerUsed, budget } = headroom(state);
  const c = caps();
  const xOk = x.isConfigured();
  let xUsage = null;
  if (xOk && !opts.replay && !opts.dryRun) {
    try { xUsage = await x.usageTweets(2); } catch (e) { log(`[intel] usage/tweets failed (${e.status || e.message}) — reconciling from the ledger alone`); }
  } else if (xOk && opts.dryRun) {
    try { xUsage = await x.usageTweets(2); } catch { /* free call; ignore */ }
  }
  const rec = reconcile(ledgerUsed, xUsage || { days: [] }, { todayUtc: utc, ledgerUsage: state.usage });
  const yesterdayOriginals = loadDay(daysAgoEt(1)).filter((t) => t.type !== 'retweet').length;
  const reserve = captureReserve(state, { yesterdayOriginals, now });
  const plan = planMode({ used: rec.used, reserve: reserve.reserve, nightlyCap: c.nightlyCap, budget, override: opts.mode });
  let mode = plan.mode;
  let reason = plan.reason;
  if (opts.replay) { mode = 'replay'; reason = '--replay: phases 2–4 from disk, zero X spend'; }
  else if (!xOk) { mode = 'off'; reason = 'no X credential (set X_BEARER_TOKEN, or X_PROXY_AUTH=1 behind the proxy)'; }
  summary.mode = mode;
  summary.reconcile = rec;
  const askMode = Boolean(opts.ask);
  const nightlyCap = askMode ? Math.min(c.ondemandCap, c.perQuestionCap) : c.nightlyCap;
  const maxReads = opts.maxReads ?? Infinity;
  const u = state.usage?.[date] || {};
  const spentToday = (u.intelPosts || 0) + 2 * (u.intelUsers || 0) + (u.intelRequests || 0);
  const reservation = new Reservation({
    nightlyCap, budget, reserve: reserve.reserve, used: rec.used, maxReads, spentToday,
    storyCeiling: c.storyCeiling, storyWeekCeiling: c.storyWeekCeiling, priorStorySpend: priorStorySpend({ today: date }),
    stageCaps: { lists: c.listsCap, stories: c.storiesCap, phrases: c.phrasesCap, incidents: c.incidentsCap, users: c.usersCap, probes: 20, control: 1, rosters: 2000 }
  });
  const spendLog = opts.dryRun || opts.replay ? null : new SpendLog(date, { mode, reason, reconcile: rec, reserve, cap: nightlyCap, run: { argv: process.argv.slice(2) } });
  const ctx = { reservation, spendLog, state, saveState, date: utc, dryRun: opts.dryRun, cache: !opts.replay, log };

  log(`[intel] ${date} (ET) · ledger ${ledgerUsed}/${budget} · X ${rec.basis === 'utc-day' ? `UTC-day ${rec.xUtcDay}` : rec.basis === 'project-usage-since-reset' ? `project_usage ${rec.xProjectUsage} since ${rec.periodStart} vs ledger ${rec.ledgerPeriod}` : 'usage unavailable'}${rec.deltaPct != null ? ` (${rec.deltaPct > 0 ? '+' : ''}${rec.deltaPct}%${rec.warn ? ' — WARN >10% skew' : ''})` : ''} → used ${rec.used}`);
  log(`[intel] reserve ${reserve.reserve} (${reserve.pollsLeft} polls × ${reserve.perPoll} + ${reserve.yesterdayOriginals} originals to refresh) · cap ${nightlyCap} · ratio ${plan.ratio} → mode ${mode} (${reason})`);
  log(`[intel] spendable now: ${reservation.remaining()} units${Number.isFinite(maxReads) ? ` (--max-reads=${maxReads})` : ''}${spentToday ? ` · ${spentToday} intel units already spent today` : ''}`);

  // ── candidates and the plan
  const owner = loadOwnerQueries();
  for (const pr of owner.problems) log(`[intel] config/intel-queries.json: ${pr}`);
  let only = opts.stories.length ? opts.stories : null;
  let phraseStory = null;
  if (opts.phrase) {
    phraseStory = { key: `phrase-${slug(opts.phrase)}`, label: opts.phrase, macro: null, kind: 'phrase', aliases: [opts.phrase], ids: [], candidateKeys: [], custom: true, pinned: true, explicit: true };
    only = [...(only || []), phraseStory.key];
  }
  const cand = storyCandidates({ owner, today: date, only: only ? only.filter((k) => k !== phraseStory?.key) : null });
  const candidates = [...cand.candidates, ...(phraseStory ? [phraseStory] : [])];
  summary.skipped.push(...cand.skipped);
  const storyRun = Boolean(only);
  const doLists = !opts.noLists && !storyRun && !askMode;
  const doPhrases = opts.phrases || (!storyRun && !askMode);
  const doIncidents = opts.incidents || (!storyRun && !askMode);
  const listPlan = planLists({ mode: doLists ? mode : 'off', now: now.getTime() });
  const probes = loadProbes();
  const probesPlanned = (probes.listOperator == null ? 10 : 0) + (probes.quotesOperator == null ? 10 : 0);
  const sampleN = mode === 'full' ? (storyRun ? candidates.length : Math.min(settings.intel?.sample_stories ?? 5, candidates.length)) : 0;
  const perStory = 1 + 100 + 50 + (settings.intel?.story?.quotes ?? 50) + 2 * (settings.intel?.story?.user_lookups ?? 20);
  const phrases = doPhrases ? topPhrases() : [];
  const incidentsFile = readJSON(incidentsPath, { incidents: [] });
  const liveIncidents = doIncidents ? incidentsFile.incidents.filter((i) => ['active', 'monitoring'].includes(i.status)) : [];
  const planned = {
    lists: listPlan.expected, probes: mode === 'off' ? 0 : probesPlanned, counts: mode === 'off' ? 0 : 1 + 2 * candidates.length,
    samples: sampleN * perStory, phrases: mode === 'off' ? 0 : phrases.length,
    incidents: doIncidents && mode === 'full' ? Math.min(c.incidentsCap, liveIncidents.length * ((settings.intel?.incidents?.search_posts ?? 50) + 20) + owner.queries.reduce((a, q) => a + q.max_results, 0)) : 0
  };
  const plannedTotal = Object.values(planned).reduce((a, b) => a + b, 0);
  log(`[intel] plan: ${candidates.length} candidate(s)${cand.skipped.length ? ` (${cand.skipped.length} skipped)` : ''}, sample top ${sampleN}; worst-case units — lists ${planned.lists} (${listPlan.plan.length} List(s)), probes ${planned.probes}, counts ${planned.counts}, samples ${planned.samples}, phrases ${planned.phrases}, incidents+queries ${planned.incidents} = ${plannedTotal}; actually spendable ${Math.min(plannedTotal, reservation.remaining())}`);
  for (const s of candidates) log(`  ${s.key.padEnd(34)} ${String(s.posts).padStart(3)} caucus posts ${String(s.members).padStart(3)} members  aliases: ${(s.aliases || []).slice(0, 5).join(' | ')}${s.pinned ? '  [pinned]' : ''}${s.excludedByConfig ? '  [excluded by config — explicit ask]' : ''}`);
  for (const s of cand.skipped.slice(0, 20)) log(`  skip ${s.key.padEnd(30)} ${s.reason}`);
  for (const l of listPlan.plan) log(`  list ${l.key.padEnd(22)} ${l.pages} page(s), first ${l.firstPage}, ≤${l.expected} units, cursor ${l.newestId || 'none'}`);
  for (const l of listPlan.skipped) if (doLists) log(`  list ${l.key.padEnd(22)} skip: ${l.reason}`);
  if (opts.dryRun) { log('[intel] --dry-run: nothing spent, nothing written'); return { ...summary, planned, dryRun: true }; }

  const authorsById = loadAuthors().byId;
  const rosters = loadRosters();
  const carriers = loadCarriers();
  const cursors = loadCursors();
  const context = readContext();
  const activeHouseAccounts = (() => { const s = new Set(); for (const d of windowDates(7, date)) for (const t of loadDay(d)) if (isHouse(authorsById[t.authorId])) s.add(t.authorId); return s.size; })();

  // ── PHASE 1: collect (X)
  let counts = { byStory: {}, control: null, units: 0 };
  const sampled = new Map();   // key → { evidence, skipped }
  let phrasesOutside = null;
  const incidentsProbed = [];
  if (mode !== 'off' && mode !== 'replay') {
    pruneCache({ keepDays: 2, now });
    if (doLists) {
      if (mode === 'full') {
        for (const key of new Set(['house-gop', ...opts.rosters])) {
          const r = await pullRoster(key, { ctx, x, force: opts.rosters.includes(key), now });
          log(`[intel] roster ${key}: ${r.skipped || `${r.users} users, ${r.units} units`}`);
        }
      }
      const scan = await scanLists({ ctx, mode, x, now, cursors });
      summary.lists = scan;
    }
    const pr = await probeOperators({ ctx, x, listId: settings.narrative_lists?.['house-gop']?.id, tweetId: recentCaucusPostId(), probes, now });
    for (const r of pr.ran) log(`[intel] probe ${r.name}: ${r.result === null ? `not settled (${r.reason || r.error})` : r.result ? `supported (${r.posts} posts, ${r.units} units${r.cacheHit ? ', cache' : ''})` : 'NOT supported on this tier (400, 0 units) — recorded in probes.json'}`);
    counts = await countsPass(candidates, { ctx, x, now });
    log(`[intel] counts pass: ${candidates.length} story(ies) + control, ${counts.units} units`);
    const ranked = rankStories(candidates, counts, { now: now.getTime() });
    for (const s of ranked) {
      const cs = counts.byStory[s.key];
      log(`  ${s.key.padEnd(34)} originals today ${String(s.countsToday ?? '-').padStart(5)}  lift ${String(s.lift ?? '-').padStart(6)}${s.baselineThin ? ' (thin)' : ''}  score ${s.score}${cs?.error ? `  ERROR ${cs.error}` : ''}${cs?.organic?.cacheHit ? '  [cache]' : ''}`);
    }
    const toSample = mode === 'full' ? (storyRun ? ranked : ranked.slice(0, settings.intel?.sample_stories ?? 5)) : [];
    const corpusForTop = toSample.length ? loadCorpus({ days: 7, today: date, authorsById, rosters, carriers, listKeys: [] }) : null;
    for (const story of toSample) {
      if (!withinTime()) { sampled.set(story.key, { skipped: 'run wall-clock cap (30 min)' }); continue; }
      if (counts.byStory[story.key]?.error) { sampled.set(story.key, { skipped: counts.byStory[story.key].error }); continue; }
      const ctxStory = contextFor(story, context, { now: now.getTime() });
      const hash = inputsHash(story, ctxStory, date);
      const prev = readJSON(recordPath(story.key), null);
      if (prev && prev.date === date && prev.inputsHash === hash && !opts.force) {
        log(`[intel] ${story.key}: inputsHash unchanged since ${prev.generatedAt} — skipping sample + assess (--force to redo)`);
        sampled.set(story.key, { skipped: 'inputsHash unchanged (same ET day)', evidence: latestEvidence(story.key, date), reuseRecord: prev });
        continue;
      }
      const ids = new Set(story.ids || []);
      const top = corpusForTop.rows.filter((r) => ids.has(r.id) && r.type !== 'retweet').sort((a, b) => b.engN - a.engN)[0];
      const res = await probeStory(story, { ctx, x, now, force: opts.force, counts, probes: pr.probes, topPostId: top?.id || null, authorsById, rosters, carriers });
      sampled.set(story.key, { ...res, hash });
      log(`[intel] ${story.key}: ${res.skipped ? `skipped — ${res.skipped}` : `${res.evidence.posts.length} sampled posts, ${res.evidence.pages.length} page(s), quotes ${res.evidence.quotes ? res.evidence.quotes.n : 'none'}, ${res.evidence.units} units, ${res.evidence.cacheHits} cache hit(s)${res.evidence.skipped.length ? `; not done: ${res.evidence.skipped.join('; ')}` : ''}`}`);
    }
    if (doPhrases && phrases.length && withinTime()) {
      phrasesOutside = await phraseOutside(phrases, { ctx, x, now });
      log(`[intel] phrases outside: ${phrases.length} phrase(s), ${phrasesOutside.units} units`);
    }
    if (doIncidents && mode === 'full' && withinTime()) {
      for (const inc of liveIncidents) {
        const r = await probeIncident(inc, { ctx, x, now, authorsById, rosters, carriers });
        if (r.result) incidentsProbed.push(inc.id);
        log(`[intel] incident ${inc.id}: ${r.skipped || `${r.result.rows.length} rows (${r.result.officialSources.length} official), ${r.units} units`}`);
      }
      if (owner.queries.length) {
        const q = await runOwnerQueries(owner.queries, { ctx, x, now, authorsById, rosters, carriers });
        log(`[intel] owner queries: ${q.result.queries.length}, ${q.units} units`);
      }
    }
  } else if (mode === 'replay') {
    for (const story of candidates) sampled.set(story.key, { evidence: latestEvidence(story.key, date), skipped: null, replay: true });
  }

  // ── PHASE 2 + 3 + 4 per story
  const llm = !opts.noLlm && anthropicConfigured();
  if (!llm) log(`[intel] assess: ${opts.noLlm ? '--no-llm' : 'no Anthropic credential'} — MEASURED half only`);
  const evidenceFiles = [...sampled.values()].map((s) => s.evidence).filter(Boolean);
  const listKeys = listEntries().filter((e) => e.scan).map((e) => e.key);
  const corpus = loadCorpus({ days: 7, today: date, authorsById, rosters, carriers, listKeys, evidence: evidenceFiles });
  log(`[intel] corpus: ${corpus.rows.length} rows (${corpus.rows.filter((r) => r.voice === 'caucus').length} caucus, ${corpus.rows.filter((r) => r.voice === 'gop').length} gop, ${corpus.rows.filter((r) => r.voice === 'press').length} press, ${corpus.rows.filter((r) => r.voice === 'organic').length} organic)`);
  const written = [];
  let storyIndex = 0;
  for (const story of candidates) {
    const s = sampled.get(story.key);
    if (s?.reuseRecord) { written.push(s.reuseRecord); summary.skipped.push({ key: story.key, reason: s.skipped }); continue; }
    const evidence = s?.evidence || null;
    if (!evidence && !counts.byStory[story.key] && mode !== 'off') { summary.skipped.push({ key: story.key, reason: s?.skipped || 'not sampled' }); }
    const ctxStory = contextFor(story, context, { now: now.getTime() });
    const hash = s?.hash || inputsHash(story, ctxStory, date);
    const control = counts.control || evidence?.control || null;
    const evidenceWithCounts = evidence || (counts.byStory[story.key] ? { counts: [counts.byStory[story.key].organic, counts.byStory[story.key].originals].filter(Boolean), control, queries: counts.byStory[story.key].queries, posts: [], pages: [], units: (counts.byStory[story.key].organic?.units || 0) + (counts.byStory[story.key].originals?.units || 0), date } : null);
    // Assess whenever today's evidence is on disk — fetched tonight or reused from an
    // earlier run the same ET day — unless the inputsHash rule already reused the record.
    const evidenceToday = Boolean(evidence?.posts && evidence.date === date);
    const noAssessReason = !llm ? (opts.noLlm ? 'no-llm' : 'no-credential') : !(evidenceToday || opts.replay || askMode) ? 'not-sampled' : !withinTime() ? 'timeout' : null;
    let built = buildRecord(story, { evidence: evidenceWithCounts, control, corpus, context: ctxStory, cursors, now, date, mode, hash, authorsById, activeHouseAccounts, noAssessReason });
    let assess = null;
    if (!noAssessReason) {
      const pack = buildEvidencePack(story, built.measured, { rows: built.rows, gopRowsOfDay: built.gopRowsOfDay, context: ctxStory, date });
      storyIndex++;
      try {
        assess = await assessStory(built.record, pack, { webTools: settings.intel?.web_tools !== false, effort: askMode ? 'high' : 'medium', question: opts.ask || null, log, timeoutMs: ASSESS_CAP_MS });
      } catch (e) {
        // never let the model half take the measured half down with it
        assess = { judged: null, claims: { confirmed: [], reported: [], unverified: [], false: [] }, couldNotVerify: [], provenance: { ids: [], urls: [] }, assessmentSkipped: `error: ${String(e.message).slice(0, 160)}`, usage: { calls: 0, cacheRead: 0, input: 0, output: 0 }, webUses: { search: 0, fetch: 0 }, webToolsUsed: false, fetched: [], dropped: [] };
        log(`[intel] assess ${story.key} threw: ${String(e.message).slice(0, 200)}`);
      }
      summary.claude.calls += assess.usage.calls; summary.claude.cacheRead += assess.usage.cacheRead; summary.claude.input += assess.usage.input; summary.claude.output += assess.usage.output;
      log(`[intel] assess ${story.key}: ${assess.assessmentSkipped ? `skipped (${assess.assessmentSkipped})` : `ok`} · ${assess.usage.calls} call(s), input ${assess.usage.input}, cache read ${assess.usage.cacheRead}, output ${assess.usage.output} · web search ${assess.webUses.search}, fetch ${assess.webUses.fetch}${assess.webToolsUnavailable ? ' · WEB TOOLS UNAVAILABLE' : ''} · claims ${assess.claims.confirmed.length} confirmed / ${assess.claims.reported.length} reported / ${assess.claims.unverified.length} unverified${assess.dropped?.length ? ` · dropped ${assess.dropped.length} unknown id(s)` : ''}`);
      if (storyIndex >= 2 && assess.usage.calls && assess.usage.cacheRead === 0) log('[intel] WARNING: cache_read_input_tokens is 0 on a later story — the rubric prefix is not being cached (check for a silent invalidator)');
      built = buildRecord(story, { evidence: evidenceWithCounts, control, corpus, context: ctxStory, cursors, now, date, mode, hash, authorsById, activeHouseAccounts, assess, noAssessReason });
      if (assess.raw) {
        const tDir = p('data', 'narratives', 'transcripts');
        fs.mkdirSync(tDir, { recursive: true });
        fs.writeFileSync(path.join(tDir, `${date}-${story.key}.json`), JSON.stringify({ pack: pack.text, raw: assess.raw, dropped: assess.dropped, fetched: assess.fetched, usage: assess.usage }, null, 1));
      }
    }
    if (askMode) {
      const file = path.join(questionsDir, `${date}-${slug(opts.ask).slice(0, 40)}.json`);
      writeAtomic(file, { question: opts.ask, story: phraseStory ? null : story.key, phrase: phraseStory ? opts.phrase : null, askedAt: now.toISOString(), plannedUnits: planned, calls: spendLog?.data.calls.filter((c) => c.key === story.key).length || 0, answer: assess?.judged?.oneLiner || null, whatsNew: assess?.judged?.whatsNew || [], claims: built.record.claims, citedIds: built.record.provenance.ids, citedUrls: built.record.provenance.urls, confidence: assess?.judged?.confidence || null, couldNotVerify: built.record.couldNotVerify, assessmentSkipped: built.record.assessmentSkipped, spend: reservation.summary(), measured: built.record.measured });
      log(`[intel] question written: ${file.replace(/^.*data\//, 'data/')}`);
    }
    if (!phraseStory || story.key !== phraseStory.key) {
      writeAtomic(recordPath(story.key), built.record);
      written.push(built.record);
      log(`[intel] record ${story.key}: status ${built.record.status}${built.record.flags.length ? ` [${built.record.flags.join(', ')}]` : ''} · caucus ${v(built.measured.caucus.posts)} / gop ${v(built.measured.gop.posts)} of ${v(built.measured.gop.sampleSize)} / press ${v(built.measured.press.posts)} / organic today ${v(built.measured.organic.countsToday) ?? '-'} (lift ${v(built.measured.organic.lift) ?? '-'}, control ${v(built.measured.organic.controlLift) ?? '-'}) · ${built.record.assessmentSkipped ? `no judgment (${built.record.assessmentSkipped})` : `"${built.record.judged.oneLiner}"`}`);
    }
  }

  // ── PHASE 4: index
  const all = loadAllRecords();
  const res = reservation.summary();
  summary.units = res.spent;
  summary.usd = Math.round(res.spent * 0.005 * 1000) / 1000;
  summary.cacheHits = spendLog?.data.cacheHits || 0;
  summary.records = written.map((r) => r.key);
  const index = {
    generatedAt: now.toISOString(), date, mode, reason,
    reconcile: { ledger: rec.ledger, xUtcDay: rec.xUtcDay, xProjectUsage: rec.xProjectUsage, basis: rec.basis, used: rec.used, deltaPct: rec.deltaPct, warn: rec.warn },
    reserve: reserve.reserve, cap: nightlyCap,
    stories: all.map(indexRow).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
    phrasesOutside: phrasesOutside ? Object.fromEntries(Object.entries(phrasesOutside.byPhrase).map(([ph, o]) => [ph, { countsToday: o.countsToday, mean6d: o.mean6d, lift: o.lift, total7d: o.total7d, pressUses: pressUsesOf(ph, corpus) }])) : (readJSON(indexPath, null)?.phrasesOutside || {}),
    incidents: incidentsProbed.length ? incidentsProbed : (readJSON(indexPath, null)?.incidents || []).filter((id) => fs.existsSync(incidentSearchPath(id))),
    skipped: summary.skipped,
    totals: { units: res.spent, usd: summary.usd, byPurpose: res.byPurpose, byList: res.byList, byStory: res.byStory, byStage: res.byStage, cacheHits: summary.cacheHits, refusals: res.refusals, claude: summary.claude }
  };
  writeAtomic(indexPath, index);
  log(`[intel] done in ${Math.round((Date.now() - startedAt) / 1000)}s · ${fmtUnits(res.spent)} spent (${summary.cacheHits} cache hit(s), ${res.refusals} refusal(s)) · by stage ${JSON.stringify(res.byStage)} · Claude ${summary.claude.calls} call(s), cache read ${summary.claude.cacheRead} · ${written.length} record(s) → data/narratives/`);
  return summary;
}

function pressUsesOf(phrase, corpus) {
  const toks = aliasTokens([phrase]);
  return corpus.rows.filter((r) => r.voice === 'press' && r.type !== 'retweet' && matchesAliases(r.text, toks)).slice(0, 10).map((r) => ({ handle: r.author?.handle || null, id: r.id }));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.fullArchive && (!opts.maxResults || !opts.pages)) { console.error('--full-archive needs explicit --max-results=N and --pages=N (one 500-post page is $2.50); it never runs in the nightly'); process.exit(2); }
  if (opts.fullArchive) { console.error('--full-archive is not wired yet (docs/NARRATIVE_INTELLIGENCE.md §11.3: opt-in only) — nothing spent'); process.exit(2); }
  if (opts.ask && !opts.story && !opts.phrase) { console.error('--ask needs --story=<key> or --phrase="…"'); process.exit(2); }
  run(opts).then((s) => { if (!s.dryRun) process.exitCode = 0; }).catch((e) => { console.error(e); process.exitCode = 1; });
}
