// Budget policy for the narrative-intelligence layer (docs/NARRATIVE_INTELLIGENCE.md §11).
//
// Pure helpers (reconcile, captureReserve, planMode, unitsOf) plus the three
// objects every billed X call goes through, in this order:
//   1. Reservation.canSpend(expected)            — nightly cap, ceiling minus the
//                                                  capture reserve, stage caps,
//                                                  per-story night and 7-day caps
//   2. addUsage + saveState                       — the shared ledger, BEFORE any
//                                                  output is written (billedCall)
//   3. SpendLog.append(...)                       — data/narratives/spend/<date>.json
// Units are $0.005 post-read equivalents: a post 1, a counts request 1, a user
// 2. The ledger in data/state.json keeps counting objects (a user is one
// object there, as today); the dollar view lives in estCost and here.
//
// One async mutex serialises X calls so no two are ever in flight; a 429 is
// slept through only when the reset is under 60 s, otherwise the stage closes.
import fs from 'node:fs';
import path from 'node:path';
import { p, settings, etDate, readJSON } from './util.js';
import { dailyBudget, estCost, addUsage, saveState } from './store.js';
import { cacheGet, cachePut, utcDate } from './intel-cache.js';

export const spendDir = p('data', 'narratives', 'spend');
export const spendPath = (date, dir = spendDir) => path.join(dir, `${date}.json`);

export function unitsOf({ posts = 0, users = 0, requests = 0 } = {}) {
  return (posts || 0) + 2 * (users || 0) + (requests || 0);
}
export const usdOf = (u) => estCost(u || {});

// Env-overridable caps. `X_INTEL_NIGHTLY_CAP=0` is the kill switch.
function envNumber(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  const n = Number(String(v).replace(/[,_\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
export function caps(intel = settings.intel || {}) {
  return {
    nightlyCap: envNumber('X_INTEL_NIGHTLY_CAP', intel.nightly_cap ?? 2500),
    ondemandCap: envNumber('X_INTEL_ONDEMAND_CAP', intel.ondemand_cap ?? 1000),
    perQuestionCap: intel.per_question_cap ?? 300,
    listsCap: intel.lists_cap ?? 1400,
    storiesCap: 1000,
    phrasesCap: intel.phrases_outside ?? 12,
    incidentsCap: intel.incidents?.cap ?? 200,
    usersCap: 2 * (intel.user_lookups_per_night ?? 50),
    storyCeiling: intel.story?.ceiling ?? 300,
    storyWeekCeiling: intel.story?.week_ceiling ?? 1000
  };
}

// ── §11.2 reconcile ──────────────────────────────────────────────────────
// Compare the ET-day ledger with X's own usage view. With a daily breakdown,
// the UTC-day figure is compared directly (used = the larger). Pay-per-use
// projects currently expose only a cumulative counter since the cap reset
// day, so the fallback compares that with the ledger summed over the same
// period and treats any excess X reports as spend the ledger has not seen
// (a cloud session and the Actions poller writing un-merged state.json copies).
export function reconcile(ledgerToday, xUsage, { todayUtc = utcDate(), ledgerUsage = null } = {}) {
  const days = Array.isArray(xUsage) ? xUsage : xUsage?.days || [];
  const row = days.find((d) => d.date === todayUtc);
  const out = { ledger: ledgerToday, xUtcDay: null, xProjectUsage: null, basis: 'none', used: ledgerToday, delta: null, deltaPct: null, warn: false };
  if (row) {
    out.basis = 'utc-day';
    out.xUtcDay = row.posts;
    out.used = Math.max(ledgerToday, row.posts);
    out.delta = row.posts - ledgerToday;
  } else if (!Array.isArray(xUsage) && xUsage?.projectUsage != null) {
    out.basis = 'project-usage-since-reset';
    out.xProjectUsage = xUsage.projectUsage;
    const since = periodStart(todayUtc, xUsage.capResetDay);
    let ledgerPeriod = 0;
    for (const [day, u] of Object.entries(ledgerUsage || {})) {
      if (day >= since) ledgerPeriod += (u.posts || 0) + (u.requests || 0);   // X counts post reads only
    }
    out.ledgerPeriod = ledgerPeriod;
    out.periodStart = since;
    out.delta = xUsage.projectUsage - ledgerPeriod;
    out.used = ledgerToday + Math.max(0, out.delta);
  }
  if (out.delta != null) {
    const base = Math.max(1, out.basis === 'utc-day' ? Math.max(ledgerToday, out.xUtcDay) : Math.max(out.ledgerPeriod, out.xProjectUsage));
    out.deltaPct = Math.round(1000 * out.delta / base) / 10;
    out.warn = Math.abs(out.delta) / base > 0.10;
  }
  return out;
}

// First day (YYYY-MM-DD, UTC) of the X usage period that contains todayUtc.
export function periodStart(todayUtc, capResetDay) {
  const [y, m, d] = todayUtc.split('-').map(Number);
  if (!capResetDay) return `${y}-${String(m).padStart(2, '0')}-01`;
  const reset = Math.min(28, Math.max(1, capResetDay));
  const dt = d >= reset ? new Date(Date.UTC(y, m - 1, reset)) : new Date(Date.UTC(y, m - 2, reset));
  return dt.toISOString().slice(0, 10);
}

// ── §11.2 reserve ────────────────────────────────────────────────────────
// What the capture path still needs today: the 20-minute polls left in the
// ET day, each at its recent per-poll volume (padded), plus tomorrow's
// nightly refresh of yesterday's originals when that has not run yet.
export function pollsLeftToday(now = new Date(), tz = settings.timezone || 'America/New_York') {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const h = Number(parts.find((x) => x.type === 'hour')?.value) % 24;
  const m = Number(parts.find((x) => x.type === 'minute')?.value);
  return Math.max(0, Math.ceil((1440 - (h * 60 + m)) / 20));
}

export function captureReserve(state, { pollsLeft, yesterdayOriginals = 0, now = new Date() } = {}) {
  const left = pollsLeft ?? pollsLeftToday(now);
  const recent = (state?.recentNewCounts || []).slice(-6);
  const mean = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
  const perPoll = Math.max(20, mean * 1.3 + 5);
  const reserve = Math.ceil(left * perPoll + (yesterdayOriginals || 0));
  return { reserve, pollsLeft: left, perPoll: Math.round(perPoll * 10) / 10, yesterdayOriginals: yesterdayOriginals || 0 };
}

// ── §11.2 ladder ─────────────────────────────────────────────────────────
export const MODES = ['full', 'counts-only', 'off'];
export function planMode({ used, reserve, nightlyCap, budget = dailyBudget(), override = null, ladder = settings.intel?.ladder } = {}) {
  const l = { full: 0.70, counts_only: 0.85, off: 0.95, ...(ladder || {}) };
  const ratio = budget > 0 ? (used + reserve + nightlyCap) / budget : Infinity;
  const r3 = Math.round(ratio * 1000) / 1000;
  if (nightlyCap === 0) return { mode: 'off', ratio: r3, reason: 'X_INTEL_NIGHTLY_CAP=0 (kill switch)' };
  if (used + reserve >= budget) return { mode: 'off', ratio: r3, reason: `no headroom: used ${used} + reserve ${reserve} ≥ budget ${budget}` };
  const normalized = override === 'counts' ? 'counts-only' : override;
  if (normalized && MODES.includes(normalized)) return { mode: normalized, ratio: r3, reason: `--mode=${override}` };
  if (ratio < l.full) return { mode: 'full', ratio: r3, reason: `(${used} used + ${reserve} reserve + ${nightlyCap} cap) / ${budget} = ${r3} < ${l.full}` };
  if (ratio < l.counts_only) return { mode: 'counts-only', ratio: r3, reason: `ratio ${r3} in [${l.full}, ${l.counts_only})` };
  return { mode: 'off', ratio: r3, reason: `ratio ${r3} ≥ ${l.counts_only}` };
}

// ── story spend already on disk: today's earlier runs (per-story night cap)
// plus the prior 7 days (per-story week cap, today included). A --force
// rerun or a session run followed by the Actions nightly must not get a
// fresh allowance. → { <story>: { today, week } }
export function priorStorySpend({ days = 7, dir = spendDir, today = etDate() } = {}) {
  const out = {};
  for (let d = 0; d <= days; d++) {
    const date = etDate(new Date(new Date(`${today}T12:00:00Z`).getTime() - d * 86_400_000));
    const f = readJSON(spendPath(date, dir), null);
    for (const [k, v] of Object.entries(f?.byStory || {})) {
      const units = typeof v === 'number' ? v : v?.units || 0;
      out[k] ||= { today: 0, week: 0 };
      out[k].week += units;
      if (d === 0) out[k].today += units;
    }
  }
  return out;
}

// ── Reservation ──────────────────────────────────────────────────────────
export class Reservation {
  // spentToday: intel units the ledger already holds for this ET day (earlier
  // runs), so the nightly cap is a per-day cap; the caller reads it from
  // state.usage[day].intel* (flat fields). `used` already contains it for the
  // ceiling-minus-reserve arithmetic.
  constructor({
    nightlyCap = Infinity, budget = dailyBudget(), reserve = 0, used = 0, maxReads = Infinity, spentToday = 0,
    storyCeiling = Infinity, storyWeekCeiling = Infinity, priorStorySpend: prior = {}, stageCaps = {}
  } = {}) {
    Object.assign(this, { nightlyCap, budget, reserve, used, maxReads, spentToday, storyCeiling, storyWeekCeiling, prior, stageCaps });
    this.spent = 0;
    this.byPurpose = {}; this.byStory = {}; this.byList = {}; this.byStage = {};
    this.refusals = [];
  }
  // Units still spendable overall (and for a story / stage when given).
  remaining({ story, stage } = {}) {
    let r = Math.min(this.nightlyCap - this.spentToday - this.spent, this.budget - this.reserve - this.used - this.spent, this.maxReads - this.spent);
    if (story) {
      // prior[story] = { today, week } from spend files (a bare number is read as prior-week spend)
      const pr = this.prior[story];
      const priorToday = typeof pr === 'number' ? 0 : pr?.today || 0;
      const priorWeek = typeof pr === 'number' ? pr : pr?.week || 0;
      const mine = this.byStory[story] || 0;
      r = Math.min(r, this.storyCeiling - priorToday - mine, this.storyWeekCeiling - priorWeek - mine);
    }
    if (stage && this.stageCaps[stage] != null) r = Math.min(r, this.stageCaps[stage] - (this.byStage[stage] || 0));
    return Math.max(0, Math.floor(r));
  }
  canSpend(expected, { story, stage } = {}) {
    const ok = expected <= this.remaining({ story, stage });
    if (!ok) this.refusals.push({ expected, story: story || null, stage: stage || null, remaining: this.remaining({ story, stage }) });
    return ok;
  }
  commit(usage, { purpose = 'intel', story, list, stage } = {}) {
    const units = unitsOf(usage);
    this.spent += units;
    this.byPurpose[purpose] = (this.byPurpose[purpose] || 0) + units;
    if (story) this.byStory[story] = (this.byStory[story] || 0) + units;
    if (list) this.byList[list] = (this.byList[list] || 0) + units;
    if (stage) this.byStage[stage] = (this.byStage[stage] || 0) + units;
    return units;
  }
  summary() {
    return { spent: this.spent, byPurpose: { ...this.byPurpose }, byStory: { ...this.byStory }, byList: { ...this.byList }, byStage: { ...this.byStage }, refusals: this.refusals.length };
  }
}

// ── SpendLog: data/narratives/spend/<date>.json, rewritten after every call ──
export class SpendLog {
  constructor(date = etDate(), meta = {}, { dir = spendDir } = {}) {
    this.file = spendPath(date, dir);
    const prev = readJSON(this.file, null);
    this.data = {
      date, mode: null, reason: null, reconcile: null, reserve: null, cap: null,
      ...(prev || {}),
      ...meta,
      runs: [...(prev?.runs || []), { startedAt: new Date().toISOString(), ...(meta.run || {}) }],
      calls: prev?.calls || [],
      byPurpose: prev?.byPurpose || {}, byList: prev?.byList || {}, byStory: prev?.byStory || {},
      total: prev?.total || 0, usd: prev?.usd || 0, cacheHits: prev?.cacheHits || 0
    };
    delete this.data.run;
  }
  append(entry) {
    const e = { t: new Date().toISOString(), cacheHit: false, rateLimited: false, ...entry };
    e.units = e.units || 0;
    e.usd = Math.round((e.usd || 0) * 10000) / 10000;
    this.data.calls.push(e);
    if (e.cacheHit) this.data.cacheHits++;
    const add = (map, k) => { if (k) map[k] = (map[k] || 0) + e.units; };
    add(this.data.byPurpose, e.purpose);
    add(this.data.byList, e.list);
    add(this.data.byStory, e.key);
    this.data.total += e.units;
    this.data.usd = Math.round((this.data.usd + e.usd) * 10000) / 10000;
    this.write();
    return e;
  }
  write() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1) + '\n');
    fs.renameSync(tmp, this.file);
  }
}

// ── one async mutex for every X call in the runner ───────────────────────
let chain = Promise.resolve();
export function withLock(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Normalise the different `usage` shapes the X client returns.
export function usageOf(result) {
  const u = result?.usage;
  if (u == null) return { posts: 0, users: 0, requests: 0 };
  if (typeof u === 'number') return { posts: u, users: 0, requests: 0 };
  return { posts: u.posts || 0, users: u.users || 0, requests: u.requests || 0 };
}

// ── §11.1 the one path every billed call takes ───────────────────────────
// ctx: { reservation, spendLog, state, cache (bool, default true), date (UTC), dryRun, log }
// spec: { endpoint, args, expected, purpose, story, list, stage, query, exec: async () => xResult }
// Returns { result, cacheHit, units } on success; { refused: true } when the
// reservation says no; { rateLimited: true } when a 429 closed the stage;
// { error } when X rejected the request (nothing billed).
export async function billedCall(ctx, spec) {
  const { endpoint, args = {}, expected = 0, purpose = 'intel', story, list, stage, query, exec, cacheable = true } = spec;
  const date = ctx.date || utcDate();
  const base = { endpoint, purpose, key: story || null, list: list || null, stage: stage || null, query: query || null };
  if (cacheable && ctx.cache !== false) {
    const hit = cacheGet(endpoint, args, { date, root: ctx.cacheRoot });
    if (hit) {
      ctx.spendLog?.append({ ...base, units: 0, usd: 0, cacheHit: true });
      return { result: hit.result, cacheHit: true, units: 0, at: hit.at || null };
    }
  }
  if (ctx.dryRun) return { dryRun: true, units: expected };
  if (ctx.reservation && !ctx.reservation.canSpend(expected, { story, stage })) {
    ctx.log?.(`[intel] refused ${endpoint} (${expected} units) — ${ctx.reservation.remaining({ story, stage })} left${story ? ` for ${story}` : ''}${stage ? ` in stage ${stage}` : ''}`);
    return { refused: true, units: 0 };
  }
  let result;
  try {
    result = await withLock(async () => {
      let r = await exec();
      if (r?.rateLimited) {
        const wait = (r.resetAt || 0) - Date.now();
        if (wait > 0 && wait < 60_000) {
          ctx.log?.(`[intel] 429 on ${endpoint}; reset in ${Math.ceil(wait / 1000)}s — waiting once`);
          await sleep(wait + 500);
          r = await exec();
        }
      }
      return r;
    });
  } catch (e) {
    ctx.spendLog?.append({ ...base, units: 0, usd: 0, error: e.status || String(e.message).slice(0, 120) });
    return { error: e, units: 0 };
  }
  if (result?.rateLimited) {
    ctx.spendLog?.append({ ...base, units: 0, usd: 0, rateLimited: true });
    return { rateLimited: true, resetAt: result.resetAt, units: 0 };
  }
  const usage = usageOf(result);
  // ledger first — before any output, before the spend log, before the cache
  if (ctx.state) {
    addUsage(ctx.state, { ...usage, purpose: 'intel' });
    (ctx.saveState || saveState)(ctx.state);
  }
  const units = ctx.reservation ? ctx.reservation.commit(usage, { purpose, story, list, stage }) : unitsOf(usage);
  const at = new Date().toISOString();
  ctx.spendLog?.append({ ...base, t: at, units, usd: usdOf(usage), posts: usage.posts, users: usage.users, requests: usage.requests });
  if (cacheable && ctx.cache !== false) cachePut(endpoint, args, { result, units }, { date, root: ctx.cacheRoot });
  return { result, cacheHit: false, units, at };
}
