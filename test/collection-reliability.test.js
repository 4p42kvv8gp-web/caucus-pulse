import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pollOnce } from '../src/poll.js';
import { backfill } from '../src/backfill.js';
import { backfillMembers, loadBackfillProgress } from '../src/backfill-members.js';
import { appendToArchive, loadState, boundedPageSize, dailyBudget } from '../src/store.js';
import { appendJSONL, readJSONL, writeJSON, etDate } from '../src/util.js';
import { checkCapture } from '../src/health.js';

const now = '2026-09-13T12:00:00.000Z';
const raw = (id) => ({ id, author_id: '1', text: `synthetic ${id}`, created_at: '2026-09-13T11:00:00.000Z', public_metrics: {} });
const page = (ids, nextToken = null) => ({ tweets: ids.map(raw), nextToken, usage: ids.length, userReads: 0, includes: { tweets: [], users: [] } });
function rig() {
  const state = { sinceId: '100', sinceIdSupported: false, recentNewCounts: [], lastPollAt: '2026-09-13T11:00:00.000Z', usage: {} };
  const rows = new Map(), writes = [], requests = [];
  const deps = {
    state, id: 'test-list', now: () => now, configured: true, includeReferences: false,
    afterCapture: false,
    unseen: (records) => records.filter((r) => !rows.has(r.id)),
    archive: (records) => { for (const r of records) rows.set(r.id, r); return records.length ? ['2026-09-13'] : []; },
    persist: (s) => writes.push({ state: structuredClone(s), archived: [...rows.keys()] })
  };
  return { state, rows, writes, requests, deps };
}

for (const failure of ['500', '429']) {
  test(`poll resumes a page-${failure} interruption without skipping older records`, async () => {
    const r = rig(); let calls = 0;
    const first = await pollOnce({ ...r.deps, fetchPage: async (_id, opts) => {
      r.requests.push(opts); calls++;
      if (calls === 1) return page(['500', '400'], 'p2');
      if (failure === '429') return { rateLimited: true };
      throw Object.assign(new Error('synthetic'), { status: 500 });
    } });
    assert.equal(first.complete, false);
    assert.equal(r.state.sinceId, '100');
    assert.equal(r.state.pollProgress.nextToken, 'p2');
    assert.deepEqual([...r.rows.keys()], ['500', '400']);
    assert.equal(r.state.lastPollAt, '2026-09-13T11:00:00.000Z');
    const second = await pollOnce({ ...r.deps, fetchPage: async (_id, opts) => {
      assert.equal(opts.paginationToken, 'p2'); return page(['300', '200', '100']);
    } });
    assert.equal(second.complete, true);
    assert.equal(r.state.sinceId, '500');
    assert.equal(r.state.pollProgress, null);
    assert.deepEqual([...r.rows.keys()], ['500', '400', '300', '200']);
    for (const w of r.writes.filter((x) => x.state.sinceId === '500')) {
      assert.deepEqual(w.archived, ['500', '400', '300', '200']);
    }
  });
}

test('a one-page cap resumes the token rather than re-reading the newest page forever', async () => {
  const r = rig();
  const first = await pollOnce({ ...r.deps, maxPages: 1, fetchPage: async () => page(['500', '400'], 'p2') });
  assert.equal(first.reason, 'page-cap');
  assert.equal(r.state.pollProgress.nextToken, 'p2');
  const second = await pollOnce({ ...r.deps, maxPages: 1, fetchPage: async (_id, opts) => {
    assert.equal(opts.paginationToken, 'p2'); return page(['300', '200', '100']);
  } });
  assert.equal(second.complete, true);
  assert.equal(r.state.sinceId, '500');
});

test('replayed pages do not duplicate storage and still advance the completed cursor', async () => {
  const r = rig();
  r.rows.set('500', raw('500')); r.rows.set('400', raw('400'));
  const out = await pollOnce({ ...r.deps, fetchPage: async () => page(['500', '400', '100']) });
  assert.equal(out.captured, 0);
  assert.equal(out.complete, true);
  assert.equal(r.state.sinceId, '500');
  assert.equal(r.rows.size, 2);
});

test('a first-page 429 records an attempt but no successful or completed poll', async () => {
  const r = rig();
  const out = await pollOnce({ ...r.deps, fetchPage: async () => ({ rateLimited: true }) });
  assert.equal(out.reason, 'rate-limited');
  assert.equal(r.state.lastPollAttemptAt, now);
  assert.equal(r.state.lastPollSuccessAt, undefined);
  assert.equal(r.state.lastPollAt, '2026-09-13T11:00:00.000Z');
  assert.equal(checkCapture(r.state, Date.parse(now)).status, 'warn');
});

test('budget headroom is checked before every page, including referenced-object allowance', async () => {
  const r = rig(); const budget = dailyBudget();
  r.state.usage[etDate()] = { posts: budget - 5, users: 0 };
  let calls = 0;
  const out = await pollOnce({ ...r.deps, fetchPage: async (_id, opts) => {
    calls++; assert.equal(opts.pageSize, 5); return page(['500', '400', '300', '200', '150'], 'p2');
  } });
  assert.equal(calls, 1);
  assert.equal(out.reason, 'budget');
  assert.equal(r.state.usage[etDate()].posts, budget);
  assert.equal(r.state.sinceId, '100');
  assert.equal(r.state.pollProgress.nextToken, 'p2');
  const oneLeft = { usage: { [etDate()]: { posts: budget - 1, users: 0 } } };
  assert.equal(boundedPageSize(oneLeft), 0);
  const expanded = { usage: { [etDate()]: { posts: budget - 35, users: 0 } } };
  assert.equal(boundedPageSize(expanded, { includeReferenced: true }), 5);
});

test('an expired continuation is surfaced and can be explicitly restarted without discarding the boundary', async () => {
  const r = rig();
  await pollOnce({ ...r.deps, maxPages: 1, fetchPage: async () => page(['500'], 'expired') });
  const failed = await pollOnce({ ...r.deps, fetchPage: async () => { throw Object.assign(new Error('invalid token'), { status: 400 }); } });
  assert.equal(failed.reason, 'pagination-token-rejected');
  assert.equal(r.state.sinceId, '100');
  assert.equal(checkCapture(r.state, Date.parse(now)).status, 'fail');
  let calls = 0;
  await pollOnce({ ...r.deps, fetchPage: async () => { calls++; throw new Error('must not issue requests'); } });
  assert.equal(calls, 0);
  const recovered = await pollOnce({ ...r.deps, restartPagination: true, fetchPage: async (_id, opts) => {
    assert.equal(opts.paginationToken, null); return page(['500', '400', '100']);
  } });
  assert.equal(recovered.complete, true);
  assert.equal(recovered.captured, 1);
  assert.equal(r.state.sinceId, '500');
});

test('provider exhaustion without the established boundary is an explicit recovery condition', async () => {
  const r = rig();
  const out = await pollOnce({ ...r.deps, fetchPage: async () => page(['500', '400']) });
  assert.equal(out.complete, false);
  assert.equal(out.reason, 'boundary-not-reached');
  assert.equal(r.state.sinceId, '100');
  assert.equal(r.rows.size, 2);
});

test('archive failure retains the old cursor and continuation and marks recovery required', async () => {
  const r = rig();
  await assert.rejects(pollOnce({ ...r.deps, fetchPage: async () => page(['500'], 'p2'), archive: () => { throw new Error('disk failed'); } }), /disk failed/);
  assert.equal(r.state.sinceId, '100');
  assert.equal(r.state.pollProgress.nextToken, null);
  assert.equal(r.state.pollProgress.recoveryRequired.reason, 'archive-write-failed');
  assert.equal(r.state.usage[etDate()].posts, 1);
});

test('manual List backfill checkpoints each page without moving the poll cursor', async () => {
  const r = rig(); let calls = 0;
  const first = await backfill({ ...r.deps, fetchPage: async () => {
    if (++calls === 1) return page(['500', '400'], 'p2');
    throw Object.assign(new Error('synthetic'), { status: 500 });
  } });
  assert.equal(first.complete, false);
  assert.equal(r.state.sinceId, '100');
  assert.deepEqual([...r.rows.keys()], ['500', '400']);
  assert.equal(r.state.listBackfillProgress.nextToken, 'p2');
  const second = await backfill({ ...r.deps, fetchPage: async (_id, opts) => {
    assert.equal(opts.paginationToken, 'p2'); return page(['300', '200']);
  } });
  assert.equal(second.complete, true);
  assert.equal(r.state.sinceId, '100');
});

test('member backfill persists empty and duplicate completions and resumes a failed account page', async () => {
  const r = rig(); const progress = { startISO: null, users: {} }, saved = [];
  const deps = { ...r.deps, authors: { '1': { handle: 'sample', onList: true }, '2': { handle: 'stale', onList: true, stale: true } },
    progress, saveProgress: (p) => saved.push(structuredClone(p)), seedMetrics: () => {}, stopAtLimit: true };
  const empty = await backfillMembers({ ...deps, fetchPage: async () => page([]) });
  assert.equal(empty.complete, true);
  assert.equal(saved.at(-1).users['1'].done, true);
  assert.equal(saved.at(-1).users['2'], undefined);
  progress.users = {}; let calls = 0;
  await backfillMembers({ ...deps, fetchPage: async () => {
    if (++calls === 1) return page(['500'], 'p2');
    throw Object.assign(new Error('synthetic'), { status: 500 });
  } });
  assert.equal(saved.at(-1).users['1'].next, 'p2');
  assert.equal(r.rows.size, 1);
  const final = await backfillMembers({ ...deps, fetchPage: async (_id, opts) => {
    assert.equal(opts.paginationToken, 'p2'); return page(['400']);
  } });
  assert.equal(final.complete, true);
  assert.equal(r.rows.size, 2);
});

test('atomic state publication preserves the previous file when serialization fails; invalid state fails closed', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-state-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  writeJSON(file, { sinceId: '100', usage: {} });
  const before = fs.readFileSync(file, 'utf8'); const circular = {}; circular.self = circular;
  assert.throws(() => writeJSON(file, circular));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.throws(() => writeJSON(file, undefined), /undefined JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
  fs.writeFileSync(file, '{"sinceId":');
  assert.throws(() => loadState(file), /refusing to reset/);
  assert.throws(() => loadBackfillProgress(file), /refusing to restart/);
  writeJSON(file, { sinceId: '100', usage: { today: { posts: -1, users: 0 } } });
  assert.throws(() => loadState(file), /invalid read counters/);
});

test('torn JSONL tails cannot swallow the next capture; valid records without a final newline append safely', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-archive-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'day.jsonl');
  fs.writeFileSync(file, '{"id":"1","text":"unfinished');
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => appendJSONL(file, [{ id: '2' }]), /Invalid archive JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  fs.writeFileSync(file, '{"id":"1","text":"legal\u2028separator"}');
  appendJSONL(file, [{ id: '2' }]);
  assert.deepEqual(readJSONL(file, { strict: true }).map((r) => r.id), ['1', '2']);
});

test('archive append deduplicates replays older than the recent three-day cache', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-dedupe-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pathFor = (date) => path.join(dir, `${date}.jsonl`);
  const record = { id: '123', createdAt: '2025-01-01T12:00:00.000Z', text: 'synthetic' };
  appendToArchive([record], { pathFor }); appendToArchive([record], { pathFor });
  assert.equal(readJSONL(pathFor('2025-01-01'), { strict: true }).length, 1);
});

test('missing state next to an existing archive cannot silently reset the ledger', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-missing-state-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'archive'));
  fs.writeFileSync(path.join(dir, 'archive', '2026-09-13.jsonl'), '{"id":"1"}\n');
  assert.throws(() => loadState(path.join(dir, 'state.json')), /missing beside an existing archive/);
});

test('a non-advancing token stops instead of exhausting the budget on the same page', async () => {
  const r = rig();
  await pollOnce({ ...r.deps, maxPages: 1, fetchPage: async () => page(['500'], 'p2') });
  const out = await pollOnce({ ...r.deps, fetchPage: async () => page(['400'], 'p2') });
  assert.equal(out.reason, 'pagination-not-advancing');
  assert.equal(r.state.sinceId, '100');
  assert.equal(r.state.pollProgress.recoveryRequired.reason, 'pagination-not-advancing');
});

test('known rate-limit reset prevents another request until the window is due', async () => {
  const r = rig();
  const retryAt = Date.parse(now) + 60_000;
  await pollOnce({ ...r.deps, fetchPage: async () => ({ rateLimited: true, resetAt: retryAt }) });
  let called = false;
  const out = await pollOnce({ ...r.deps, fetchPage: async () => { called = true; return page(['100']); } });
  assert.equal(called, false);
  assert.equal(out.reason, 'rate-limited');
});

test('member-backfill resume honors a saved rate-limit reset before issuing a request', async () => {
  const r = rig(); let calls = 0;
  const progress = { startISO: now, users: { '1': { handle: 'sample', done: false, next: 'p2', retryAt: '2026-09-13T12:01:00.000Z' } } };
  const out = await backfillMembers({ ...r.deps, authors: { '1': { handle: 'sample', onList: true } },
    progress, saveProgress: () => {}, seedMetrics: () => {}, stopAtLimit: true,
    fetchPage: async () => { calls++; return page([]); } });
  assert.equal(calls, 0);
  assert.equal(out.complete, false);
  assert.equal(progress.users['1'].next, 'p2');
  assert.match(out.stopped, /until 2026-09-13T12:01/);
});
