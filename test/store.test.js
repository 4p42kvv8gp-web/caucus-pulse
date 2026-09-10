import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBudget, dailyBudget, budgetExhausted } from '../src/store.js';
import { settings, etDate } from '../src/util.js';

function withEnv(value, fn) {
  const saved = process.env.X_DAILY_READ_BUDGET;
  if (value === undefined) delete process.env.X_DAILY_READ_BUDGET; else process.env.X_DAILY_READ_BUDGET = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.X_DAILY_READ_BUDGET; else process.env.X_DAILY_READ_BUDGET = saved;
  }
}

test('parseBudget accepts plain and separator-formatted numbers, rejects junk', () => {
  assert.equal(parseBudget('15000'), 15000);
  assert.equal(parseBudget('15,000'), 15000);
  assert.equal(parseBudget('50_000'), 50000);
  assert.equal(parseBudget(' 8 000 '), 8000);
  assert.equal(parseBudget(''), null);
  assert.equal(parseBudget(undefined), null);
  assert.equal(parseBudget('lots'), null);
  assert.equal(parseBudget('-5'), null);
  assert.equal(parseBudget('0'), null);
});

test('dailyBudget: env overrides settings; a malformed env never yields NaN', () => {
  withEnv(undefined, () => assert.equal(dailyBudget(), settings.daily_read_budget || 8000));
  withEnv('12,345', () => assert.equal(dailyBudget(), 12345));
  withEnv('NaN-ish', () => assert.equal(dailyBudget(), settings.daily_read_budget || 8000));
  withEnv('15,000', () => {
    // the failure mode seen in the 2026-09-10 06:40 poll log: "12360/NaN"
    const state = { usage: { [etDate()]: { posts: 20000, users: 0 } } };
    assert.equal(budgetExhausted(state), true);
  });
});
