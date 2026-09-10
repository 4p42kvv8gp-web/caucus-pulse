// List scans, rosters and author resolution for the narrative layer
// (docs/NARRATIVE_INTELLIGENCE.md §4, §7.1, §7.6, §11.4 level 3).
//
//   scanLists      nightly capture of every settings.narrative_lists entry with
//                  scan:true — boundary-stop pagination (poll.newerThan), page
//                  cap per List (settings.intel.list_pages), adaptive first page
//                  seeded from the List's own lastNewCount, local dedupe over the
//                  List's last three day-files, rows written as toRecord()+{list}
//                  to data/lists/<key>/<ET date>.jsonl, cursors in
//                  data/lists/cursors.json. Every page is billed through
//                  intel-budget.billedCall (ledger first).
//   rosterFor /    data/lists/<key>.json (949 users already paid for); pullRoster
//   pullRoster     only when the file is missing or --rosters=<key> and >7 days old.
//   resolveAuthors data/authors.json → rosters → data/narratives/carriers.json →
//                  paid lookupUsersByIds (capped) → unresolved. A user object is
//                  never fetched twice.
//   probeOperators one-time `list:` / `quotes_of_tweet_id:` probes (10 units
//                  each) recorded in data/narratives/probes.json.
//
// Nothing here writes to data/archive or data/authors.json (test-guarded).
//
//   npm run intel-lists -- --dry-run          # print the scan plan, spend nothing
//   npm run intel-lists                       # scan (full mode) under the caps
//   npm run intel-lists -- --rosters=house-gop
import fs from 'node:fs';
import path from 'node:path';
import * as xClient from './x.js';
import { p, settings, etDate, readJSON, writeJSON, readJSONL, appendJSONL, idGt, maxId, daysAgoEt } from './util.js';
import { adaptivePageSize, newerThan } from './poll.js';
import { loadAuthors } from './authors.js';
import { loadState, saveState, headroom } from './store.js';
import { billedCall, Reservation, SpendLog, caps, captureReserve, planMode } from './intel-budget.js';
import { listQuery, quotesQuery, assertValid } from './intel-queries.js';
import { loadDay } from './store.js';

export const listsDir = p('data', 'lists');
export const cursorsPath = p('data', 'lists', 'cursors.json');
export const carriersPath = p('data', 'narratives', 'carriers.json');
export const probesPath = p('data', 'narratives', 'probes.json');
export const listDayPath = (key, date) => p('data', 'lists', key, `${date}.jsonl`);
export const rosterPath = (key) => p('data', 'lists', `${key}.json`);

export const PRESS_KEYS = ['cap-hill-reporters', 'congressional-media', 'house-news', 'labor-reporters', 'ny-news', 'international-news', 'national-press'];
export const DELEGATION_KEYS = ['ny-members', 'overlapping-electeds'];
export const GOP_KEYS = ['house-gop', 'gop-leadership'];
export const EXPERT_KEYS = ['economists'];

const DAY = 86_400_000;

// ── config ───────────────────────────────────────────────────────────────
export function listEntries(cfg = settings.narrative_lists, pages = settings.intel?.list_pages || {}) {
  return Object.entries(cfg || {})
    .filter(([k, v]) => k !== '_comment' && v && typeof v === 'object')
    .map(([key, v]) => ({ key, id: String(v.id || ''), name: v.name || key, voice: v.voice || null, scan: Boolean(v.scan), priority: v.priority ?? 9, pages: pages[key] ?? 0 }));
}

// ── files ────────────────────────────────────────────────────────────────
export function loadCursors() { return readJSON(cursorsPath, { lists: {} }); }
export function saveCursors(c) { writeAtomic(cursorsPath, c); }
export function loadCarriers() { return readJSON(carriersPath, { byId: {} }); }
export function saveCarriers(c) { writeAtomic(carriersPath, c); }
export function loadProbes() { return readJSON(probesPath, { listOperator: null, quotesOperator: null, probedAt: null }); }
export function saveProbes(pr) { writeAtomic(probesPath, pr); }

export function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1) + '\n');
  fs.renameSync(tmp, file);
}

// data/lists/<key>.json → { key, fetchedAt, listId, byId: Map<id, {id, handle, name, followers, verifiedType}> }
export function rosterFor(key) {
  const f = readJSON(rosterPath(key), null);
  if (!f?.members) return null;
  const byId = new Map();
  for (const m of f.members) byId.set(String(m.id), { id: String(m.id), handle: m.username || m.handle || null, name: m.name || null, followers: m.followers ?? null, verifiedType: m.verifiedType || m.verified_type || null });
  return { key, fetchedAt: f.fetchedAt || null, listId: f.listId || null, byId };
}

// Every roster on disk, merged: byId → {…, rosters: [keys]}.
export function loadRosters(keys = listEntries().map((e) => e.key)) {
  const byId = new Map();
  const loaded = [];
  for (const key of keys) {
    const r = rosterFor(key);
    if (!r) continue;
    loaded.push({ key, users: r.byId.size, fetchedAt: r.fetchedAt });
    for (const [id, u] of r.byId) {
      const prev = byId.get(id);
      if (prev) { prev.rosters.push(key); if (prev.followers == null) prev.followers = u.followers; }
      else byId.set(id, { ...u, rosters: [key] });
    }
  }
  return { byId, loaded };
}

export function officialSet(cfg = readJSON(p('config', 'official-sources.json'), null)) {
  return {
    handles: new Set((cfg?.handles || []).map((h) => String(h).toLowerCase())),
    verifiedTypes: new Set(cfg?.verified_types || ['government'])
  };
}

// Author lookup without spending: authors.json → rosters → carriers → null.
export function authorInfo(id, { authorsById = {}, rosters = null, carriers = null } = {}) {
  const sid = String(id);
  const a = authorsById[sid];
  const r = rosters?.byId?.get(sid);
  const c = carriers?.byId?.[sid];
  if (!a && !r && !c) return null;
  return {
    id: sid,
    handle: a?.handle || r?.handle || c?.handle || null,
    name: a?.name || r?.name || c?.name || null,
    followers: a?.followers ?? r?.followers ?? c?.followers ?? null,
    verifiedType: a?.verifiedType || r?.verifiedType || c?.verifiedType || null,
    status: a ? (a.status || 'house') : null,
    member: a?.member || null,
    caucuses: a?.caucuses || [],
    onCaucusList: Boolean(a && a.onList !== false && !a.stale),
    rosters: r?.rosters || [],
    source: a ? 'authors' : r ? 'roster' : 'carriers'
  };
}

export function isOfficial(info, official = officialSet()) {
  if (!info) return false;
  if (info.handle && official.handles.has(String(info.handle).toLowerCase())) return true;
  return Boolean(info.verifiedType && official.verifiedTypes.has(String(info.verifiedType).toLowerCase()));
}

// ── day-files ────────────────────────────────────────────────────────────
export function readListDays(key, days = 7, { today = etDate() } = {}) {
  const seen = new Set();
  const out = [];
  for (let d = 0; d < days; d++) {
    const date = etDate(new Date(new Date(`${today}T12:00:00Z`).getTime() - d * DAY));
    for (const t of readJSONL(listDayPath(key, date))) if (!seen.has(t.id) && seen.add(t.id)) out.push(t);
  }
  return out;
}

export function listDedupeSet(key, days = 3, opts) {
  return new Set(readListDays(key, days, opts).map((t) => t.id));
}

function appendListRecords(key, records) {
  const byDate = new Map();
  for (const r of records) {
    const date = etDate(r.createdAt);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(r);
  }
  for (const [date, recs] of byDate) {
    recs.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    appendJSONL(listDayPath(key, date), recs);
  }
  return [...byDate.keys()].sort();
}

// ── plan ─────────────────────────────────────────────────────────────────
export function planLists({ mode = 'full', entries = listEntries(), cursors = loadCursors(), now = Date.now() } = {}) {
  const plan = [];
  const skipped = [];
  for (const e of entries.sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key))) {
    if (!e.id) { skipped.push({ key: e.key, reason: 'no List id — owner: make the List public and paste its id into config/settings.json' }); continue; }
    if (!e.scan) { skipped.push({ key: e.key, reason: 'scan:false' }); continue; }
    if (!e.pages) { skipped.push({ key: e.key, reason: 'intel.list_pages is 0' }); continue; }
    if (mode === 'off') { skipped.push({ key: e.key, reason: 'mode off' }); continue; }
    const cur = cursors.lists?.[e.key] || {};
    if (cur.unavailableUntil && new Date(cur.unavailableUntil).getTime() > now) {
      skipped.push({ key: e.key, reason: `unavailable until ${cur.unavailableUntil} (private, deleted or renamed List — make it public or supply a from: handle set in config/intel-queries.json)` });
      continue;
    }
    const pages = mode === 'counts-only' ? 1 : e.pages;
    const firstPage = cur.lastNewCount != null ? adaptivePageSize([cur.lastNewCount], 100) : 100;
    plan.push({ key: e.key, id: e.id, voice: e.voice, pages, firstPage, expected: firstPage + Math.max(0, pages - 1) * 100, newestId: cur.newestId || null });
  }
  return { plan, skipped, expected: plan.reduce((a, x) => a + x.expected, 0) };
}

// ── scan ─────────────────────────────────────────────────────────────────
// ctx is the billedCall context ({ reservation, spendLog, state, saveState, date, log, dryRun }).
export async function scanLists({ ctx, mode = 'full', x = xClient, now = new Date(), entries = listEntries(), cursors = loadCursors(), maxPagesOverride = null } = {}) {
  const { plan, skipped } = planLists({ mode, entries, cursors, now: now.getTime() });
  const capturedAt = now.toISOString();
  const scanned = [];
  let units = 0;
  for (const item of plan) {
    const cur = (cursors.lists[item.key] ||= { listId: item.id, newestId: null, lastScanAt: null, lastNewCount: null, pagesLast: 0, complete: null, unavailableUntil: null });
    cur.listId = item.id;
    const seen = listDedupeSet(item.key, 3, { today: etDate(now) });
    const pages = maxPagesOverride ?? item.pages;
    const fresh = [];
    let token = null, hitBoundary = false, pagesRead = 0, closed = null, listUnits = 0;
    for (let page = 0; page < pages && !hitBoundary; page++) {
      const size = page === 0 ? item.firstPage : 100;
      const res = await billedCall(ctx, {
        endpoint: 'lists/tweets', purpose: 'intel', list: item.key, stage: 'lists', expected: size,
        args: { listId: item.id, pageSize: size, paginationToken: token, newestId: cur.newestId },
        exec: () => x.listTweetsPage(item.id, { paginationToken: token, pageSize: size })
      });
      if (res.error) {
        const status = res.error.status;
        if ([401, 403, 404].includes(status)) {
          cur.unavailableUntil = new Date(now.getTime() + DAY).toISOString();
          closed = `HTTP ${status}: List unavailable for 24h — make the List public or supply a from: handle set in config/intel-queries.json`;
        } else closed = `error: ${String(res.error.message).slice(0, 120)}`;
        break;
      }
      if (res.refused) { closed = 'reservation refused'; break; }
      if (res.rateLimited) { closed = 'rate limited'; break; }
      if (res.dryRun) { closed = 'dry-run'; break; }
      pagesRead++;
      listUnits += res.units;
      const tweets = res.result.tweets || [];
      const newer = newerThan(tweets, cur.newestId);
      fresh.push(...newer);
      hitBoundary = newer.length < tweets.length;
      token = res.result.nextToken;
      if (!token) { hitBoundary = true; break; }
    }
    const records = [];
    let newest = cur.newestId;
    for (const t of fresh) {
      newest = maxId(newest, t.id);
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      records.push({ ...x.toRecord(t, capturedAt), list: item.key });
    }
    const dates = closed === 'dry-run' ? [] : appendListRecords(item.key, records);
    if (closed !== 'dry-run') {
      cur.newestId = newest;
      cur.lastScanAt = capturedAt;
      cur.lastNewCount = records.length;
      cur.pagesLast = pagesRead;
      cur.complete = hitBoundary;
      saveCursors(cursors);
    }
    units += listUnits;
    scanned.push({ key: item.key, voice: item.voice, pages: pagesRead, posts: fresh.length, newPosts: records.length, complete: hitBoundary, units: listUnits, dates, closed });
    ctx.log?.(`[intel-lists] ${item.key}: ${pagesRead} page(s), ${records.length} new row(s) (${fresh.length} read), complete ${hitBoundary}${closed ? `, ${closed}` : ''}, ${listUnits} units`);
  }
  return { scanned, skipped, units };
}

// ── rosters ──────────────────────────────────────────────────────────────
export async function pullRoster(key, { ctx, x = xClient, force = false, now = new Date(), expectedUsers = 500 } = {}) {
  const entry = listEntries().find((e) => e.key === key);
  if (!entry?.id) return { skipped: `no List id for ${key}` };
  const existing = readJSON(rosterPath(key), null);
  const ageDays = existing?.fetchedAt ? (now.getTime() - new Date(existing.fetchedAt).getTime()) / DAY : Infinity;
  if (existing && !(force && ageDays > 7)) return { skipped: `roster on disk (${existing.members?.length || 0} users, ${Number.isFinite(ageDays) ? ageDays.toFixed(1) : '?'} days old)` };
  const res = await billedCall(ctx, {
    endpoint: 'lists/members', purpose: 'intel', list: key, stage: 'rosters', expected: 2 * expectedUsers, cacheable: false,
    args: { listId: entry.id }, exec: () => x.listMembers(entry.id)
  });
  if (res.refused || res.error || res.rateLimited || res.dryRun) return { skipped: res.refused ? 'reservation refused' : res.error ? `error ${res.error.status || ''}` : res.rateLimited ? 'rate limited' : 'dry-run' };
  const members = (res.result.users || []).map((u) => ({ id: u.id, username: u.username, name: u.name, followers: u.public_metrics?.followers_count ?? null, verifiedType: u.verified_type || null }));
  writeAtomic(rosterPath(key), { fetchedAt: now.toISOString(), listId: entry.id, name: entry.name, members });
  return { users: members.length, units: res.units };
}

// ── author resolution (never twice) ──────────────────────────────────────
export async function resolveAuthors(ids, { ctx, x = xClient, authorsById = loadAuthors().byId, rosters = loadRosters(), carriers = loadCarriers(), cap = settings.intel?.story?.user_lookups ?? 20, story = null, now = new Date(), save = true } = {}) {
  const resolved = new Map();
  const missing = [];
  for (const id of [...new Set(ids.map(String))]) {
    const info = authorInfo(id, { authorsById, rosters, carriers });
    if (info) resolved.set(id, info); else missing.push(id);
  }
  let units = 0;
  let unresolved = missing;
  if (missing.length && cap > 0) {
    const want = missing.slice(0, cap);
    const res = await billedCall(ctx, {
      endpoint: 'users', purpose: 'intel', story, stage: 'users', expected: 2 * want.length,
      args: { ids: want.slice().sort() }, exec: () => x.lookupUsersByIds(want)
    });
    if (res.result) {
      units = res.units;
      for (const u of res.result.users || []) {
        carriers.byId[u.id] = {
          handle: u.username, name: u.name, followers: u.public_metrics?.followers_count ?? null,
          verifiedType: u.verified_type || null, createdAt: u.created_at || null, firstSeenIn: story || null, resolvedAt: now.toISOString()
        };
        resolved.set(String(u.id), authorInfo(u.id, { authorsById, rosters, carriers }));
      }
      if (!res.cacheHit && save) saveCarriers(carriers);
      unresolved = missing.filter((id) => !resolved.has(id));
    }
  }
  return { resolved, unresolved, units };
}

// ── one-time operator probes ─────────────────────────────────────────────
export async function probeOperators({ ctx, x = xClient, listId = settings.narrative_lists?.['house-gop']?.id, tweetId = null, probes = loadProbes(), now = new Date(), save = true } = {}) {
  const ran = [];
  const probe = async (name, query) => {
    const res = await billedCall(ctx, {
      endpoint: 'search/probe', purpose: 'intel', stage: 'probes', expected: 10, query,
      args: { query, maxResults: 10 }, exec: () => x.searchRecent(query, { maxResults: 10 })
    });
    if (res.dryRun) return null;
    if (res.error) {
      if (res.error.status === 400) { probes[name] = false; ran.push({ name, result: false, units: 0 }); }
      else ran.push({ name, result: null, error: String(res.error.message).slice(0, 120) });
      return;
    }
    if (res.refused || res.rateLimited) { ran.push({ name, result: null, reason: res.refused ? 'refused' : 'rate limited' }); return; }
    probes[name] = true;
    ran.push({ name, result: true, units: res.units, posts: res.result.tweets?.length || 0, cacheHit: res.cacheHit });
  };
  if (probes.listOperator == null && listId) await probe('listOperator', assertValid(listQuery(listId), { allowProbe: true }));
  if (probes.quotesOperator == null && tweetId) await probe('quotesOperator', assertValid(quotesQuery(tweetId), { allowProbe: true }));
  if (ran.length && !ctx.dryRun) {
    probes.probedAt = now.toISOString();
    if (save) saveProbes(probes);
  }
  return { probes, ran };
}

// Most recent original caucus post id — the quotes probe target.
export function recentCaucusPostId(days = 2) {
  let best = null;
  for (let d = 0; d < days; d++) {
    for (const t of loadDay(daysAgoEt(d))) if (t.type === 'tweet' && idGt(t.id, best)) best = t.id;
    if (best) return best;
  }
  return best;
}

// ── CLI: npm run intel-lists ─────────────────────────────────────────────
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const rosterArg = process.argv.find((a) => a.startsWith('--rosters='));
  const modeArg = process.argv.find((a) => a.startsWith('--mode='))?.split('=')[1] || null;
  const state = loadState();
  const { used, budget } = headroom(state);
  const c = caps();
  const reserve = captureReserve(state);
  const plan = planMode({ used, reserve: reserve.reserve, nightlyCap: c.nightlyCap, budget, override: modeArg });
  const { plan: lists, skipped, expected } = planLists({ mode: plan.mode });
  console.log(`[intel-lists] mode ${plan.mode} (${plan.reason}); ${used}/${budget} used, reserve ${reserve.reserve}; ${lists.length} List(s) to scan, worst case ${expected} units`);
  for (const l of lists) console.log(`  ${l.key.padEnd(22)} ${l.pages} page(s) (first ${l.firstPage}) ≤ ${l.expected} units · cursor ${l.newestId || 'none'}`);
  for (const s of skipped) console.log(`  skip ${s.key.padEnd(17)} ${s.reason}`);
  if (dryRun || !xClient.isConfigured() || plan.mode === 'off') { console.log(dryRun ? '[intel-lists] dry-run: nothing spent' : '[intel-lists] no X credential or mode off — nothing spent'); return; }
  const date = etDate();
  const ctx = {
    reservation: new Reservation({ nightlyCap: c.nightlyCap, budget, reserve: reserve.reserve, used, stageCaps: { lists: c.listsCap, rosters: 2000 } }),
    spendLog: new SpendLog(date, { mode: plan.mode, reason: plan.reason, reserve: reserve.reserve, cap: c.nightlyCap, run: { cmd: 'intel-lists' } }),
    state, saveState, log: console.log
  };
  if (rosterArg) {
    for (const key of rosterArg.split('=')[1].split(',').filter(Boolean)) console.log(`[intel-lists] roster ${key}:`, JSON.stringify(await pullRoster(key, { ctx, force: true })));
  }
  const out = await scanLists({ ctx, mode: plan.mode });
  console.log(`[intel-lists] ${out.scanned.length} List(s) scanned, ${out.units} units (~$${(out.units * 0.005).toFixed(2)})`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
