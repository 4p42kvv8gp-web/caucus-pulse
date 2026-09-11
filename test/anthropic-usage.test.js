import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  recordUsage, dayCost, rowCost, priceFor, budgetStatus, instrument, dailyBudgetUsd, formatStatus,
  CACHE_READ_RATE, CACHE_WRITE_RATE, BATCH_RATE
} from '../src/anthropic-usage.js';
import { mergeLedger } from '../src/merge-anthropic-usage.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), 'anthropic-usage.json');
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const usage = (input, output, cacheRead = 0, cacheWrite = 0) =>
  ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite });
const price = { input: 5, output: 25 };

test('recordUsage accumulates per day, stage, model and kind', () => {
  const file = tmp();
  recordUsage({ file, day: '2026-09-11', stage: 'poll', model: 'claude-opus-5', usage: usage(1000, 200, 20000, 0) });
  recordUsage({ file, day: '2026-09-11', stage: 'poll', model: 'claude-opus-5', usage: usage(500, 100, 0, 20000) });
  recordUsage({ file, day: '2026-09-11', stage: 'classify', model: 'claude-opus-5', usage: usage(30000, 3000), batch: true });
  assert.equal(recordUsage({ file, day: '2026-09-11', stage: 'classify', model: 'claude-opus-5', usage: null }), null);
  assert.deepEqual(read(file), {
    '2026-09-11': {
      poll: { 'claude-opus-5': { live: { calls: 2, input: 1500, output: 300, cacheRead: 20000, cacheWrite: 20000 } } },
      classify: { 'claude-opus-5': { batch: { calls: 1, input: 30000, output: 3000, cacheRead: 0, cacheWrite: 0 } } }
    }
  });
});

test('rowCost prices cache reads, cache writes and batch at the published multipliers', () => {
  const row = { input: 1_000_000, output: 100_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 };
  const live = rowCost(row, price);
  assert.equal(live, 5 + 5 * CACHE_READ_RATE + 5 * CACHE_WRITE_RATE + 2.5);
  assert.equal(rowCost(row, price, { batch: true }), live * BATCH_RATE);
  assert.deepEqual(priceFor('claude-opus-5', { 'claude-opus-5': { input: 5, output: 25 } }), price);
  assert.deepEqual(priceFor('unknown-model', { default: { input: 3, output: 15 } }), { input: 3, output: 15 });
});

test('dayCost totals across stages and models; budgetStatus flags the ceiling', () => {
  const file = tmp();
  recordUsage({ file, day: '2026-09-11', stage: 'poll', model: 'claude-opus-5', usage: usage(1_000_000, 0) });          // $5
  recordUsage({ file, day: '2026-09-11', stage: 'classify', model: 'claude-opus-5', usage: usage(2_000_000, 0), batch: true }); // $5
  recordUsage({ file, day: '2026-09-12', stage: 'poll', model: 'claude-opus-5', usage: usage(1_000_000, 0) });          // other day
  const pricing = { default: price };
  const { total, calls, byStage } = dayCost(read(file)['2026-09-11'], pricing);
  assert.equal(total, 10);
  assert.equal(calls, 2);
  assert.deepEqual(byStage, { poll: 5, classify: 5 });
  assert.equal(budgetStatus({ file, day: '2026-09-11', budget: 40, pricing }).exhausted, false);
  assert.equal(budgetStatus({ file, day: '2026-09-11', budget: 10, pricing }).exhausted, true);
  assert.equal(budgetStatus({ file, day: '2026-09-11', budget: null, pricing }).exhausted, false);
  assert.equal(budgetStatus({ file, day: '2026-09-13', budget: 1, pricing }).spent, 0);
  assert.match(formatStatus(budgetStatus({ file, day: '2026-09-11', budget: 10, pricing })), /\$10\.00 of \$10 daily budget.*BUDGET REACHED/);
});

test('dailyBudgetUsd reads the env override, tolerates separators, rejects nonsense', () => {
  assert.equal(dailyBudgetUsd({ ANTHROPIC_DAILY_BUDGET_USD: '1,500' }), 1500);
  assert.equal(dailyBudgetUsd({ ANTHROPIC_DAILY_BUDGET_USD: 'lots' }), null);
  assert.equal(dailyBudgetUsd({ ANTHROPIC_DAILY_BUDGET_USD: '0' }), null);
});

function fakeClient() {
  const calls = [];
  const stream = () => {
    const s = new EventEmitter();
    s.finalMessage = () => new Promise((resolve) => {
      const msg = { model: 'claude-opus-5', usage: usage(700, 70), content: [] };
      setImmediate(() => { s.emit('finalMessage', msg); resolve(msg); });
    });
    return s;
  };
  const messages = {
    create: async (params) => { calls.push(params); return { model: params.model, usage: usage(100, 10, 900, 0), content: [], stop_reason: 'end_turn' }; },
    stream: () => stream(),
    batches: {
      results: async () => (async function* () {
        yield { custom_id: 'a', result: { type: 'succeeded', message: { model: 'claude-opus-5', usage: usage(4000, 400), content: [] } } };
        yield { custom_id: 'b', result: { type: 'errored', error: { type: 'rate_limit' } } };
        yield { custom_id: 'c', result: { type: 'succeeded', message: { model: 'claude-opus-5', usage: usage(4000, 400), content: [] } } };
      })()
    }
  };
  return { messages, calls };
}

test('instrument records create, stream and batch results without changing what callers get', async () => {
  const file = tmp();
  const client = instrument(fakeClient(), { stage: 'test-stage', file });
  assert.equal(instrument(client, { stage: 'other', file }), client); // idempotent

  const res = await client.messages.create({ model: 'claude-opus-5', max_tokens: 5, messages: [] });
  assert.equal(res.stop_reason, 'end_turn');

  const final = await client.messages.stream({ model: 'claude-opus-5', max_tokens: 5, messages: [] }).finalMessage();
  assert.equal(final.usage.input_tokens, 700);

  const seen = [];
  for await (const r of await client.messages.batches.results('msgbatch_1')) seen.push(r.custom_id);
  assert.deepEqual(seen, ['a', 'b', 'c']);

  const day = Object.keys(read(file))[0];
  const rows = read(file)[day]['test-stage']['claude-opus-5'];
  assert.deepEqual(rows.live, { calls: 2, input: 800, output: 80, cacheRead: 900, cacheWrite: 0 });
  assert.deepEqual(rows.batch, { calls: 2, input: 8000, output: 800, cacheRead: 0, cacheWrite: 0 });
});

test('a ledger that cannot be written never breaks the call', async () => {
  const blocker = tmp(); // a regular file where a directory would have to be → ENOTDIR
  fs.writeFileSync(blocker, '{}');
  const client = instrument(fakeClient(), { stage: 's', file: path.join(blocker, 'ledger.json') });
  const res = await client.messages.create({ model: 'm', max_tokens: 5, messages: [] });
  assert.equal(res.stop_reason, 'end_turn');
});

test('mergeLedger adds both sides\' increments at every leaf', () => {
  const base = { '2026-09-11': { poll: { m: { live: { calls: 2, input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } } } } };
  const a = { '2026-09-11': { poll: { m: { live: { calls: 3, input: 150, output: 15, cacheRead: 0, cacheWrite: 0 } } } } };
  const b = {
    '2026-09-11': { poll: { m: { live: { calls: 2, input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } } }, classify: { m: { batch: { calls: 1, input: 5, output: 1, cacheRead: 0, cacheWrite: 0 } } } },
    '2026-09-12': { poll: { m: { live: { calls: 1, input: 7, output: 1, cacheRead: 0, cacheWrite: 0 } } } }
  };
  assert.deepEqual(mergeLedger(base, a, b), {
    '2026-09-11': {
      classify: { m: { batch: { calls: 1, input: 5, output: 1, cacheRead: 0, cacheWrite: 0 } } },
      poll: { m: { live: { calls: 3, input: 150, output: 15, cacheRead: 0, cacheWrite: 0 } } }
    },
    '2026-09-12': { poll: { m: { live: { calls: 1, input: 7, output: 1, cacheRead: 0, cacheWrite: 0 } } } }
  });
  assert.deepEqual(mergeLedger({}, {}, {}), {});
});
