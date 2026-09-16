import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseBudget, dailyBudget, budgetExhausted, loadState } from '../src/store.js';
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

test('completed run markers are optional for legacy state but validated as one pair', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-run-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  const baseline = { sinceId: '100', usage: {}, lastPollAt: '2026-09-16T02:00:00Z' };
  const read = (state) => { fs.writeFileSync(file, JSON.stringify(state)); return loadState(file); };
  assert.equal(Object.hasOwn(read(baseline), 'lastPollRunId'), false);
  const marked = { ...baseline, lastPollRunId: '9007199254740993', lastPollRunAttempt: 2 };
  assert.equal(read(marked).lastPollRunId, '9007199254740993');
  assert.equal(read(marked).lastPollRunAttempt, 2);
  for (const patch of [
    { lastPollRunId: undefined }, { lastPollRunAttempt: undefined },
    { lastPollRunId: null, lastPollRunAttempt: null }, { lastPollRunId: 123 },
    { lastPollRunId: '1e3' }, { lastPollRunId: '0' }, { lastPollRunId: '00123' },
    { lastPollRunAttempt: '2' }, { lastPollRunAttempt: 0 }, { lastPollRunAttempt: -1 },
    { lastPollRunAttempt: 1.5 }, { lastPollRunAttempt: Number.MAX_SAFE_INTEGER + 1 },
    { lastPollAt: undefined }, { lastPollAt: 'not-a-date' }
  ]) assert.throws(() => read({ ...marked, ...patch }), /invalid completed capture run identity/);
});
