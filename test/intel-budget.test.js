import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  reconcile, periodStart, captureReserve, planMode, Reservation, SpendLog, unitsOf, priorStorySpend, billedCall, usageOf
} from '../src/intel-budget.js';
import { cacheKey, canonical, cacheGet, pruneCache } from '../src/intel-cache.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'intel-budget-'));

test('unitsOf: a post 1, a counts request 1, a user 2', () => {
  assert.equal(unitsOf({ posts: 100, users: 6, requests: 4 }), 116);
  assert.equal(unitsOf({}), 0);
  assert.deepEqual(usageOf({ usage: 7 }), { posts: 7, users: 0, requests: 0 });
  assert.deepEqual(usageOf({ usage: { users: 3 } }), { posts: 0, users: 3, requests: 0 });
});

test('planMode ladder: today\'s 14,144-used state → full; a 40,000 state → off; kill switch; override', () => {
  const budget = 50000;
  assert.equal(planMode({ used: 14144, reserve: 3000, nightlyCap: 2500, budget }).mode, 'full');
  assert.equal(planMode({ used: 40000, reserve: 3000, nightlyCap: 2500, budget }).mode, 'off');
  assert.equal(planMode({ used: 32000, reserve: 3000, nightlyCap: 2500, budget }).mode, 'counts-only');   // 0.75
  assert.equal(planMode({ used: 14144, reserve: 3000, nightlyCap: 0, budget }).mode, 'off');
  assert.match(planMode({ used: 14144, reserve: 3000, nightlyCap: 0, budget }).reason, /kill switch/);
  assert.equal(planMode({ used: 40000, reserve: 3000, nightlyCap: 2500, budget, override: 'counts' }).mode, 'counts-only');
  // an override never gets past an exhausted ceiling
  assert.equal(planMode({ used: 49000, reserve: 3000, nightlyCap: 2500, budget, override: 'full' }).mode, 'off');
});

test('captureReserve pads recent per-poll volume and adds yesterday\'s originals', () => {
  const r = captureReserve({ recentNewCounts: [465, 0, 0, 2, 10, 20, 30] }, { pollsLeft: 10, yesterdayOriginals: 400 });
  // mean of the last six = (0+0+2+10+20+30)/6 = 10.33 → ×1.3 + 5 = 18.4 → floor 20
  assert.equal(r.perPoll, 20);
  assert.equal(r.reserve, 10 * 20 + 400);
  const busy = captureReserve({ recentNewCounts: [100, 100, 100, 100, 100, 100] }, { pollsLeft: 3 });
  assert.equal(busy.reserve, Math.ceil(3 * (130 + 5)));
  assert.ok(captureReserve({}, { now: new Date() }).pollsLeft >= 0);
});

test('reconcile: utc-day basis takes the larger side and warns past 10% skew', () => {
  const r = reconcile(1000, [{ date: '2026-09-10', posts: 1300 }], { todayUtc: '2026-09-10' });
  assert.equal(r.basis, 'utc-day');
  assert.equal(r.used, 1300);
  assert.equal(r.delta, 300);
  assert.equal(r.warn, true);
  const ok = reconcile(1000, { days: [{ date: '2026-09-10', posts: 950 }] }, { todayUtc: '2026-09-10' });
  assert.equal(ok.used, 1000);
  assert.equal(ok.warn, false);
});

test('reconcile: pay-per-use shape compares project_usage since the cap reset day with the ledger and absorbs unseen spend', () => {
  const ledgerUsage = { '2026-09-01': { posts: 100, users: 5 }, '2026-09-10': { posts: 12783, users: 1453, requests: 4 } };
  const r = reconcile(14240, { days: [], projectUsage: 12597, projectCap: 3000000, capResetDay: 28 }, { todayUtc: '2026-09-10', ledgerUsage });
  assert.equal(r.basis, 'project-usage-since-reset');
  assert.equal(r.periodStart, '2026-08-28');
  assert.equal(r.ledgerPeriod, 12887);          // posts + requests since 08-28
  assert.equal(r.delta, 12597 - 12887);
  assert.equal(r.used, 14240);                  // X reports less than the ledger: nothing to absorb
  assert.equal(r.warn, false);
  const skew = reconcile(1000, { days: [], projectUsage: 5000, capResetDay: 28 }, { todayUtc: '2026-09-10', ledgerUsage: { '2026-09-10': { posts: 1000 } } });
  assert.equal(skew.used, 5000);                // the excess is treated as spend the ledger has not merged yet
  assert.equal(skew.warn, true);
  assert.equal(periodStart('2026-09-30', 28), '2026-09-28');
  assert.equal(periodStart('2026-09-10', null), '2026-09-01');
});

test('Reservation enforces nightly cap, ceiling minus reserve, per-story night and week caps, stage caps, --max-reads', () => {
  const r = new Reservation({ nightlyCap: 2500, budget: 50000, reserve: 3000, used: 14144, storyCeiling: 300, storyWeekCeiling: 1000, priorStorySpend: { 'epstein-files': 800 }, stageCaps: { phrases: 12 }, maxReads: 120 });
  assert.equal(r.remaining(), 120);                                          // --max-reads is the tightest
  assert.equal(r.canSpend(100, { story: 'x' }), true);
  assert.equal(r.commit({ posts: 100 }, { purpose: 'intel', story: 'x', stage: 'stories' }), 100);
  assert.equal(r.canSpend(21), false);
  assert.equal(r.canSpend(20), true);
  // per-story week cap: 800 prior + 200 tonight would exceed 1000
  const wk = new Reservation({ nightlyCap: 2500, budget: 50000, storyCeiling: 300, storyWeekCeiling: 1000, priorStorySpend: { 'epstein-files': 800 } });
  assert.equal(wk.remaining({ story: 'epstein-files' }), 200);
  assert.equal(wk.canSpend(201, { story: 'epstein-files' }), false);
  assert.equal(wk.canSpend(200, { story: 'epstein-files' }), true);
  assert.equal(wk.remaining({ story: 'other' }), 300);                        // per-story night ceiling
  wk.commit({ posts: 10 }, { stage: 'phrases' });
  assert.equal(new Reservation({ stageCaps: { phrases: 12 } }).remaining({ stage: 'phrases' }), 12);
  // the nightly cap spans the ET day: 2,400 intel units already in the ledger leave 100
  const day = new Reservation({ nightlyCap: 2500, budget: 50000, spentToday: 2400, storyCeiling: 300, priorStorySpend: { 'epstein-files': { today: 192, week: 192 } } });
  assert.equal(day.remaining(), 100);
  assert.equal(day.remaining({ story: 'epstein-files' }), 100);
  // the per-story night cap counts today's earlier runs: 300 − 192 = 108 left for the same story, 300 for another
  const night = new Reservation({ nightlyCap: 2500, budget: 50000, storyCeiling: 300, storyWeekCeiling: 1000, priorStorySpend: { 'epstein-files': { today: 192, week: 900 } } });
  assert.equal(night.remaining({ story: 'epstein-files' }), 100);                // week cap (1000 − 900) is the tighter one here
  assert.equal(night.remaining({ story: 'other' }), 300);
  const tight = new Reservation({ nightlyCap: 2500, budget: 50000, reserve: 3000, used: 46000 });
  assert.equal(tight.remaining(), 1000);                                     // ceiling minus reserve wins over the nightly cap
  assert.equal(tight.canSpend(1001), false);
  assert.equal(tight.refusals.length, 1);
});

test('SpendLog appends every call, accumulates by purpose/list/story, and survives a rerun on the same date', () => {
  const dir = tmpDir();
  const log = new SpendLog('2026-09-10', { mode: 'full', reason: 'test' }, { dir });
  log.append({ endpoint: 'counts', purpose: 'intel', key: 'epstein-files', units: 1, usd: 0.005 });
  log.append({ endpoint: 'search', purpose: 'intel', key: 'epstein-files', units: 100, usd: 0.5 });
  log.append({ endpoint: 'list', purpose: 'intel', list: 'house-gop', units: 40, usd: 0.2 });
  log.append({ endpoint: 'counts', purpose: 'intel', key: 'epstein-files', units: 0, cacheHit: true });
  const again = new SpendLog('2026-09-10', { mode: 'counts-only' }, { dir });
  assert.equal(again.data.calls.length, 4);
  assert.equal(again.data.total, 141);
  assert.equal(again.data.cacheHits, 1);
  assert.equal(again.data.mode, 'counts-only');
  assert.equal(again.data.runs.length, 2);
  assert.deepEqual(again.data.byStory, { 'epstein-files': 101 });
  assert.deepEqual(again.data.byList, { 'house-gop': 40 });
  // per-story week cap reads prior spend files from the same directory
  const prior = priorStorySpend({ days: 7, dir, today: '2026-09-11' });
  assert.deepEqual(prior, { 'epstein-files': { today: 0, week: 101 } });
  // today's own earlier runs count toward the night cap (a --force rerun gets no fresh allowance)
  assert.deepEqual(priorStorySpend({ days: 7, dir, today: '2026-09-10' }), { 'epstein-files': { today: 101, week: 101 } });
  assert.deepEqual(priorStorySpend({ days: 7, dir, today: '2026-09-20' }), {});
});

test('cache key is stable under argument reordering and changes with the UTC date', () => {
  assert.equal(canonical({ b: 1, a: [{ d: 2, c: 3 }] }), canonical({ a: [{ c: 3, d: 2 }], b: 1 }));
  assert.equal(cacheKey('counts', { query: 'q', granularity: 'day' }, '2026-09-10'), cacheKey('counts', { granularity: 'day', query: 'q' }, '2026-09-10'));
  assert.notEqual(cacheKey('counts', { query: 'q' }, '2026-09-10'), cacheKey('counts', { query: 'q' }, '2026-09-11'));
  assert.notEqual(cacheKey('counts', { query: 'q' }, '2026-09-10'), cacheKey('search', { query: 'q' }, '2026-09-10'));
});

test('billedCall: ledger first, reservation commit, spend log, cache write; the identical call is a 0-unit cacheHit; refusals and 429s bill nothing', async () => {
  const dir = tmpDir();
  const root = path.join(dir, 'cache');
  const saves = [];
  const state = { usage: {} };
  const ctx = {
    reservation: new Reservation({ nightlyCap: 150, budget: 50000 }),
    spendLog: new SpendLog('2026-09-10', {}, { dir }),
    state, saveState: (s) => saves.push(JSON.stringify(s.usage)), cacheRoot: root, date: '2026-09-10', log: () => {}
  };
  let calls = 0;
  const spec = {
    endpoint: 'search', args: { query: 'q', sort: 'relevancy', max_results: 100 }, expected: 100, story: 'epstein-files', stage: 'stories', query: 'q',
    exec: async () => { calls++; return { tweets: Array.from({ length: 96 }, (_, i) => ({ id: String(i) })), usage: { posts: 96, users: 0 } }; }
  };
  const first = await billedCall(ctx, spec);
  assert.equal(first.cacheHit, false);
  assert.equal(first.units, 96);
  assert.equal(calls, 1);
  assert.equal(saves.length, 1);                                          // ledger saved before the spend log entry
  assert.equal(Object.values(state.usage)[0].intelPosts, 96);
  assert.equal(ctx.reservation.spent, 96);
  assert.equal(ctx.spendLog.data.calls.at(-1).cacheHit, false);
  assert.ok(cacheGet('search', { max_results: 100, sort: 'relevancy', query: 'q' }, { date: '2026-09-10', root }));

  const second = await billedCall(ctx, spec);
  assert.equal(second.cacheHit, true);
  assert.equal(second.units, 0);
  assert.equal(calls, 1);                                                 // no network, no ledger change
  assert.equal(saves.length, 1);
  assert.equal(second.result.tweets.length, 96);
  assert.equal(ctx.spendLog.data.calls.at(-1).cacheHit, true);
  assert.equal(ctx.spendLog.data.cacheHits, 1);

  const refused = await billedCall(ctx, { ...spec, args: { query: 'q2' }, expected: 100 });
  assert.equal(refused.refused, true);
  assert.equal(calls, 1);

  const limited = await billedCall(ctx, { ...spec, args: { query: 'q3' }, expected: 10, exec: async () => ({ rateLimited: true, resetAt: Date.now() + 3_600_000, usage: { posts: 0 } }) });
  assert.equal(limited.rateLimited, true);
  assert.equal(ctx.reservation.spent, 96);
  assert.equal(ctx.spendLog.data.calls.at(-1).rateLimited, true);

  const err = new Error('X search recent 400: bad'); err.status = 400;
  const failed = await billedCall(ctx, { ...spec, args: { query: 'q4' }, expected: 10, exec: async () => { throw err; } });
  assert.equal(failed.error, err);
  assert.equal(ctx.spendLog.data.calls.at(-1).error, 400);
  assert.equal(ctx.reservation.spent, 96);

  assert.equal((await billedCall({ ...ctx, dryRun: true }, { ...spec, args: { query: 'q5' } })).dryRun, true);
  fs.mkdirSync(path.join(root, '2026-09-01'), { recursive: true });
  assert.equal(pruneCache({ keepDays: 2, now: new Date('2026-09-10T12:00:00Z'), root }), 1);
  assert.ok(fs.existsSync(path.join(root, '2026-09-10')));
});
