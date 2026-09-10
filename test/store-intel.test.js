import test from 'node:test';
import assert from 'node:assert/strict';
import { addUsage, budgetExhausted, estCost, headroom, usedToday, dailyBudget } from '../src/store.js';
import { mergeState } from '../src/merge-state.js';
import { etDate } from '../src/util.js';

const today = etDate();

test('addUsage keeps every counter flat on the day object and tracks the intel share', () => {
  const state = { usage: {} };
  addUsage(state, { posts: 100 });                                   // a poll
  addUsage(state, { posts: 50, users: 6, requests: 4, purpose: 'intel' });
  addUsage(state, { requests: 1, purpose: 'intel' });
  assert.deepEqual(state.usage[today], {
    posts: 150, users: 6, requests: 5, intelPosts: 50, intelUsers: 6, intelRequests: 5
  });
  // no nested objects: merge-state sums fields numerically
  for (const v of Object.values(state.usage[today])) assert.equal(typeof v, 'number');
});

test('addUsage without intel purpose leaves the intel counters absent (poll ledger shape unchanged)', () => {
  const state = { usage: {} };
  addUsage(state, { posts: 20 });
  assert.deepEqual(state.usage[today], { posts: 20, users: 0 });
});

test('usedToday / budgetExhausted count requests; estCost prices them like a post read', () => {
  const state = { usage: { [today]: { posts: 10, users: 2, requests: 3 } } };
  assert.equal(usedToday(state), 15);
  assert.equal(estCost(state.usage[today]), 10 * 0.005 + 2 * 0.01 + 3 * 0.005);
  const saved = process.env.X_DAILY_READ_BUDGET;
  process.env.X_DAILY_READ_BUDGET = '15';
  try {
    assert.equal(budgetExhausted(state), true);
    assert.deepEqual(headroom(state), { used: 15, budget: 15, remaining: 0 });
    process.env.X_DAILY_READ_BUDGET = '100';
    assert.deepEqual(headroom(state), { used: 15, budget: 100, remaining: 85 });
    assert.equal(dailyBudget(), 100);
  } finally {
    if (saved === undefined) delete process.env.X_DAILY_READ_BUDGET; else process.env.X_DAILY_READ_BUDGET = saved;
  }
});

test('merge-state sums the new flat fields across two writers (a session intel run and an Actions poll)', () => {
  const base = { sinceId: '1', usage: { [today]: { posts: 1000, users: 10 } }, lastPollAt: '2026-09-10T05:00:00Z', recentNewCounts: [] };
  const session = { ...base, usage: { [today]: { posts: 1150, users: 16, requests: 9, intelPosts: 150, intelUsers: 6, intelRequests: 9 } } };
  const actions = { ...base, usage: { [today]: { posts: 1040, users: 10 } }, lastPollAt: '2026-09-10T05:20:00Z' };
  const m = mergeState(base, session, actions);
  assert.deepEqual(m.usage[today], { posts: 1190, users: 16, requests: 9, intelPosts: 150, intelUsers: 6, intelRequests: 9 });
  for (const v of Object.values(m.usage[today])) assert.ok(Number.isFinite(v));
});
