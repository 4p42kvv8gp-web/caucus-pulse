import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeState } from '../src/merge-state.js';

const base = {
  sinceId: '100', sinceIdSupported: false, recentNewCounts: [5], pendingBatch: null,
  usage: { '2026-09-10': { posts: 1000, users: 10 } }, lastPollAt: '2026-09-10T05:00:00Z'
};

test('usage adds both sides\' increments on top of the common base', () => {
  const a = { ...base, usage: { '2026-09-10': { posts: 1100, users: 10 } }, lastPollAt: '2026-09-10T05:20:00Z' };
  const b = { ...base, usage: { '2026-09-10': { posts: 1000, users: 460 }, '2026-09-11': { posts: 5, users: 0 } } };
  const m = mergeState(base, a, b);
  assert.deepEqual(m.usage, { '2026-09-10': { posts: 1100, users: 460 }, '2026-09-11': { posts: 5, users: 0 } });
});

test('cursor takes the larger id; recent counts follow the most recent poll; pending batch survives', () => {
  const a = { ...base, sinceId: '250', recentNewCounts: [5, 12], lastPollAt: '2026-09-10T05:40:00Z' };
  const b = { ...base, sinceId: '900', pendingBatch: { id: 'msgbatch_1', date: '2026-09-09' }, lastPollAt: '2026-09-10T05:30:00Z' };
  const m = mergeState(base, a, b);
  assert.equal(m.sinceId, '900');
  assert.deepEqual(m.recentNewCounts, [5, 12]);
  assert.deepEqual(m.pendingBatch, { id: 'msgbatch_1', date: '2026-09-09' });
  assert.equal(m.lastPollAt, '2026-09-10T05:40:00Z');
});

test('merging identical sides is the identity', () => {
  const m = mergeState(base, base, base);
  assert.deepEqual(m, base);
});
