import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mergeState } from '../src/merge-state.js';

const base = {
  sinceId: '100', sinceIdSupported: false, recentNewCounts: [5], pendingBatch: null,
  usage: { '2026-09-10': { posts: 1000, users: 10 } }, lastPollAt: '2026-09-10T05:00:00Z'
};
test('usage combines independent increments while retaining the coherent poll transition', () => {
  const a = { ...base, sinceId: '250', recentNewCounts: [5, 12], usage: { '2026-09-10': { posts: 1100, users: 10 } }, lastPollAt: '2026-09-10T05:20:00Z' };
  const b = { ...base, usage: { '2026-09-10': { posts: 1000, users: 460 }, '2026-09-11': { posts: 5, users: 0 } } };
  const m = mergeState(base, a, b);
  assert.deepEqual(m.usage, { '2026-09-10': { posts: 1100, users: 460 }, '2026-09-11': { posts: 5, users: 0 } });
  assert.equal(m.sinceId, '250');
  assert.deepEqual(m.recentNewCounts, [5, 12]);
  assert.equal(m.lastPollAt, a.lastPollAt);
});
test('two independently advanced cursors fail instead of choosing the larger id', () => {
  const a = { ...base, sinceId: '250', lastPollAt: '2026-09-10T05:40:00Z' };
  const b = { ...base, sinceId: '900', lastPollAt: '2026-09-10T05:30:00Z' };
  assert.throws(() => mergeState(base, a, b), /Concurrent changes to capture state/);
});
test('completed run identity moves with its capture timestamp while unrelated writes merge', () => {
  const common = { ...base, lastPollRunId: '8000', lastPollRunAttempt: 1 };
  const a = { ...common, sinceId: '250', lastPollAt: '2026-09-10T05:20:00Z', lastPollRunId: '9000', lastPollRunAttempt: 2 };
  const b = { ...common, pendingBatch: { id: 'batch-one' } };
  const merged = mergeState(common, a, b);
  assert.equal(merged.lastPollAt, a.lastPollAt);
  assert.equal(merged.lastPollRunId, '9000');
  assert.equal(merged.lastPollRunAttempt, 2);
  assert.deepEqual(merged.pendingBatch, b.pendingBatch);
  const local = { ...a };
  delete local.lastPollRunId;
  delete local.lastPollRunAttempt;
  const localMerged = mergeState(common, local, b);
  assert.equal(localMerged.lastPollAt, local.lastPollAt);
  assert.equal(Object.hasOwn(localMerged, 'lastPollRunId'), false);
  assert.equal(Object.hasOwn(localMerged, 'lastPollRunAttempt'), false);
  assert.deepEqual(mergeState(common, b, local), localMerged);
});
test('concurrent identity-only and capture changes cannot combine into false run attribution', () => {
  const common = { ...base, lastPollRunId: '8000', lastPollRunAttempt: 1 };
  const capture = { ...common, sinceId: '250', lastPollAt: '2026-09-10T05:20:00Z' };
  for (const identity of [
    { ...common, lastPollRunId: '9000' },
    { ...common, lastPollRunAttempt: 2 }
  ]) {
    assert.throws(() => mergeState(common, capture, identity), /Concurrent changes to capture state/);
    assert.throws(() => mergeState(common, identity, capture), /Concurrent changes to capture state/);
  }
});
test('partial capture retains its old cursor and completed time alongside a newer successful API response', () => {
  const a = { ...base, lastPollAttemptAt: '2026-09-10T06:00:00Z', lastPollSuccessAt: '2026-09-10T06:00:01Z', lastPollOutcome: 'page-cap', pollProgress: { listId: 'list', baseSinceId: '100', newestId: '300', pages: 1, nextToken: 'page2' } };
  const b = { ...base, pendingBatch: { id: 'msgbatch_1' } };
  const m = mergeState(base, a, b);
  assert.equal(m.sinceId, '100');
  assert.equal(m.lastPollAt, base.lastPollAt);
  assert.equal(m.lastPollSuccessAt, a.lastPollSuccessAt);
  assert.deepEqual(m.pollProgress, a.pollProgress);
  assert.deepEqual(m.pendingBatch, b.pendingBatch);
});
test('completion clears a checkpoint and a finished batch is not resurrected by an unrelated writer', () => {
  const old = { ...base, pollProgress: { nextToken: 'p2' }, pendingBatch: { id: 'batch' } };
  const a = { ...old, pollProgress: null, sinceId: '300', lastPollAt: '2026-09-10T06:00:00Z' };
  const b = { ...old, pendingBatch: null };
  const m = mergeState(old, a, b);
  assert.equal(m.pollProgress, null);
  assert.equal(m.pendingBatch, null);
  assert.equal(m.sinceId, '300');
});
test('divergent unfinished page tokens cannot be mixed', () => {
  assert.throws(() => mergeState(base, { ...base, pollProgress: { nextToken: 'p2' } }, { ...base, pollProgress: { nextToken: 'p3' } }), /capture state/);
});
test('counter resets and malformed counters fail closed', () => {
  for (const posts of [999, -1, '1100', NaN]) {
    assert.throws(() => mergeState(base, { ...base, usage: { '2026-09-10': { posts, users: 10 } } }, base), /counter/i);
  }
});

const receipt = { day: '2026-09-10', posts: 25, users: 3, responseHash: 'response-one' };
test('identical new acquisition receipts on both branches cannot double-count paid reads', () => {
  const a = { ...base, repostAcquisitionUsage: { lookup1: receipt }, usage: { '2026-09-10': { posts: 1025, users: 13 } } };
  const b = structuredClone(a);
  assert.throws(() => mergeState(base, a, b), /Concurrent application of repost acquisition receipt lookup1.*double-count/);
});

test('one branch acquisition preserves its receipt and combines independent capture usage', () => {
  const a = { ...base, repostAcquisitionUsage: { lookup1: receipt }, usage: { '2026-09-10': { posts: 1025, users: 13 } } };
  const b = { ...base, sinceId: '250', recentNewCounts: [5, 10], lastPollAt: '2026-09-10T05:20:00Z', usage: { '2026-09-10': { posts: 1010, users: 10 } } };
  const merged = mergeState(base, a, b);
  assert.deepEqual(merged.repostAcquisitionUsage, { lookup1: receipt });
  assert.deepEqual(merged.usage, { '2026-09-10': { posts: 1035, users: 13 } });
  assert.equal(merged.sinceId, '250');
  assert.deepEqual(mergeState(base, b, a), merged);
});

test('receipts already present in the common base do not block unrelated capture increments', () => {
  const common = { ...base, repostAcquisitionUsage: { lookup1: receipt } };
  const a = { ...common, usage: { '2026-09-10': { posts: 1005, users: 10 } } };
  const b = { ...common, usage: { '2026-09-10': { posts: 1000, users: 12 } } };
  const merged = mergeState(common, a, b);
  assert.deepEqual(merged.repostAcquisitionUsage, common.repostAcquisitionUsage);
  assert.deepEqual(merged.usage, { '2026-09-10': { posts: 1005, users: 12 } });
});

test('distinct concurrent acquisition maps still require explicit conflict resolution', () => {
  const a = { ...base, repostAcquisitionUsage: { lookup1: receipt }, usage: { '2026-09-10': { posts: 1025, users: 13 } } };
  const b = { ...base, repostAcquisitionUsage: { lookup2: { ...receipt, responseHash: 'response-two' } }, usage: { '2026-09-10': { posts: 1025, users: 13 } } };
  assert.throws(() => mergeState(base, a, b), /Concurrent changes to repostAcquisitionUsage/);
});

test('malformed acquisition ledgers cannot evade overlap checks', () => {
  for (const repostAcquisitionUsage of [[], 3, 'bad']) {
    assert.throws(() => mergeState(base, { ...base, repostAcquisitionUsage }, base), /Invalid repost acquisition usage ledger/);
  }
});
test('merging unchanged sides is the identity', () => assert.deepEqual(mergeState(base, base, base), base));
test('merge driver leaves ours untouched when any JSON input is corrupt', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-merge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = ['base', 'ours', 'theirs'].map((n) => path.join(dir, n));
  fs.writeFileSync(paths[0], '{broken');
  fs.writeFileSync(paths[1], JSON.stringify(base));
  fs.writeFileSync(paths[2], JSON.stringify(base));
  const result = spawnSync(process.execPath, ['src/merge-state.js', ...paths], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(paths[1], 'utf8'), JSON.stringify(base));
});
