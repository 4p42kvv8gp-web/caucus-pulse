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
