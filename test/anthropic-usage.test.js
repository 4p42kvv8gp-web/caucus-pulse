import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  recordUsage, dayCost, rowCost, priceFor, budgetStatus, instrument, dailyBudgetUsd, formatStatus,
  CACHE_READ_RATE, CACHE_WRITE_RATE, BATCH_RATE, REQUESTS_KEY, estimateRequestUsd
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
  assert.throws(() => dailyBudgetUsd({ ANTHROPIC_DAILY_BUDGET_USD: 'lots' }), /Invalid.*budget/);
  assert.equal(dailyBudgetUsd({ ANTHROPIC_DAILY_BUDGET_USD: '0' }), 0);
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
  const rows = Object.values(read(file)[day][REQUESTS_KEY]);
  const sum = (batch) => rows.filter((r) => r.batch === batch && r.usage).reduce((out, r) => {
    for (const [k, v] of Object.entries(r.usage)) out[k] = (out[k] || 0) + v;
    return out;
  }, {});
  assert.deepEqual(sum(false), { calls: 2, input: 800, output: 80, cacheRead: 900, cacheWrite: 0 });
  assert.deepEqual(sum(true), { calls: 2, input: 8000, output: 800, cacheRead: 0, cacheWrite: 0 });
});

test('an unwritable ledger prevents the paid call', async () => {
  const blocker = tmp(); // a regular file where a directory would have to be → ENOTDIR
  fs.writeFileSync(blocker, '{}');
  const client = instrument(fakeClient(), { stage: 's', file: path.join(blocker, 'ledger.json') });
  await assert.rejects(() => client.messages.create({ model: 'm', max_tokens: 5, messages: [] }));
  assert.equal(client.calls.length, 0);
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

test('failed calls are counted per stage, auth failures separately, and never priced', async () => {
  const file = tmp();
  const exchangeRefused = Object.assign(new Error('Token exchange failed with status 401 (request-id req_x): {"error":{"type":"authentication_error"}}'), { statusCode: 401 });
  const client = instrument({
    messages: {
      create: async () => { throw exchangeRefused; },
      stream: () => { const s = new EventEmitter(); s.finalMessage = () => new Promise((_, reject) => setImmediate(() => { s.emit('error', new Error('rate limited')); reject(new Error('rate limited')); })); return s; }
    }
  }, { stage: 'stories', file });
  await assert.rejects(() => client.messages.create({ model: 'claude-opus-5', max_tokens: 5, messages: [] }), /Token exchange failed/);
  await assert.rejects(() => client.messages.stream({ model: 'claude-opus-5', max_tokens: 5, messages: [] }).finalMessage(), /rate limited/);
  const day = Object.keys(read(file))[0];
  assert.deepEqual(read(file)[day].stories._errors, { auth: 1, other: 1 });
  const s = budgetStatus({ file, day, budget: 40, pricing: { default: price } });
  assert.equal(s.spent, 0);
  assert.equal(s.calls, 0);
  assert.equal(s.authFailures, 1);
  assert.equal(s.otherFailures, 1);
  assert.deepEqual(s.failedStages, ['stories']);
  assert.match(formatStatus(s), /2 call\(s\) FAILED \(1 auth\) in stories/);
});

test('a reused client rechecks budget before every paid call', async () => {
  const file = tmp();
  let calls = 0;
  const client = instrument({ messages: { create: async () => {
    calls++;
    return { model: 'claude-opus-5', usage: usage(1000, 800) };
  } } }, { file, budget: 0.045 });
  const params = { model: 'claude-opus-5', max_tokens: 1000, messages: [] };
  await client.messages.create(params);
  await assert.rejects(() => client.messages.create(params), /would exceed budget/);
  assert.equal(calls, 1);
  assert.equal(budgetStatus({ file, budget: 0.045 }).spent, 0.025);
  assert.equal(budgetStatus({ file, budget: 0.045 }).reserved, 0);
});

test('an in-flight call reserves allowance against a second client', async () => {
  const file = tmp();
  const params = { model: 'claude-opus-5', max_tokens: 1000, messages: [] };
  const estimate = estimateRequestUsd(params);
  let complete;
  const first = instrument({ messages: { create: () => new Promise((resolve) => { complete = resolve; }) } }, { file, budget: estimate * 1.5 });
  const second = instrument(fakeClient(), { file, budget: estimate * 1.5 });
  const pending = first.messages.create(params);
  await new Promise(setImmediate);
  await assert.rejects(() => second.messages.create(params), /would exceed budget/);
  assert.equal(second.calls.length, 0);
  complete({ model: params.model, usage: usage(100, 10) });
  await pending;
  assert.equal(budgetStatus({ file }).reserved, 0);
});

test('corrupt ledgers block paid calls without overwriting evidence', async () => {
  for (const corrupt of ['{', '[]', '{"2026-09-13":{"poll":{"m":{"live":{"input":-1}}}}}']) {
    const file = tmp();
    fs.writeFileSync(file, corrupt);
    const client = instrument(fakeClient(), { file });
    await assert.rejects(() => client.messages.create({ model: 'claude-opus-5', max_tokens: 10, messages: [] }));
    assert.equal(client.calls.length, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
    assert.equal(fs.existsSync(`${file}.lock`), false);
  }
});

test('batch reservations survive midnight and settle each custom_id once across rereads', async () => {
  const file = tmp();
  let day = '2026-09-13';
  const fake = fakeClient();
  fake.messages.batches.create = async () => ({ id: 'batch-one' });
  const client = instrument(fake, { file, today: () => day, budget: 1 });
  const params = { model: 'claude-opus-5', max_tokens: 1000, messages: [] };
  await client.messages.batches.create({ requests: ['a', 'b', 'c'].map((custom_id) => ({ custom_id, params })) });
  const initiallyReserved = budgetStatus({ file, day, budget: 1 }).reserved;
  assert.ok(initiallyReserved > 0);
  assert.equal(budgetStatus({ file, day, budget: 1 }).spent, 0);
  day = '2026-09-14';
  assert.equal(budgetStatus({ file, day, budget: 1 }).reserved, initiallyReserved);
  // Breaking a results read retains the other requests' outstanding liability.
  for await (const row of await client.messages.batches.results('batch-one')) break;
  assert.ok(budgetStatus({ file, day, budget: 1 }).reserved > 0);
  for await (const row of await client.messages.batches.results('batch-one')) { /* complete */ }
  assert.equal(budgetStatus({ file, day, budget: 1 }).reserved, 0);
  const charged = budgetStatus({ file, day: '2026-09-13', budget: 1 }).spent;
  assert.equal(charged, 0.03);
  for await (const row of await client.messages.batches.results('batch-one')) { /* identical reread */ }
  assert.equal(budgetStatus({ file, day: '2026-09-13', budget: 1 }).spent, charged);
});

test('existing batch results remain readable when new-call allowance is zero', async () => {
  const file = tmp();
  const client = instrument(fakeClient(), { file, budget: 0 });
  await assert.rejects(() => client.messages.create({ model: 'claude-opus-5', max_tokens: 1, messages: [] }), /budget/);
  for await (const row of await client.messages.batches.results('existing-batch')) { /* allowed */ }
  assert.equal(budgetStatus({ file, budget: 0 }).calls, 2);
});

test('an uncertain transport failure retains its allowance until reconciled', async () => {
  const file = tmp();
  const client = instrument({ messages: { create: async () => { throw new Error('connection lost after submission'); } } }, { file, budget: 1 });
  await assert.rejects(() => client.messages.create({ model: 'claude-opus-5', max_tokens: 10, messages: [] }), /connection lost/);
  assert.ok(budgetStatus({ file }).reserved > 0);
});

test('preflight failures identify definitely-unsent requests to durable queues', async () => {
  const params = { model: 'claude-opus-5', max_tokens: 5, messages: [] };
  for (const options of [{ budget: 0 }, { budget: NaN }, { pricing: { default: { input: -1, output: 25 } } }]) {
    const fake = fakeClient();
    const client = instrument(fake, { file: tmp(), ...options });
    await assert.rejects(() => client.messages.create(params), (error) => {
      assert.equal(error.requestSent, false);
      assert.equal(error.code, options.budget === 0 ? 'ANTHROPIC_BUDGET_EXCEEDED' : 'ANTHROPIC_PREFLIGHT_REJECTED');
      return true;
    });
    assert.equal(fake.calls.length, 0);
  }
  const client = instrument({ messages: { create: async () => { throw new Error('provider outcome unknown'); } } }, { file: tmp(), budget: 1 });
  await assert.rejects(() => client.messages.create(params), (error) => {
    assert.notEqual(error.requestSent, false);
    return true;
  });
});

test('merge keeps one terminal settlement when both writers reread the same batch', () => {
  const reserved = { id: 'batch:1:a', stage: 'classify', model: 'm', batch: true, status: 'reserved', reservedUsd: 1 };
  const settled = { ...reserved, status: 'settled', usage: { calls: 1, input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } };
  const wrap = (r) => ({ '2026-09-13': { [REQUESTS_KEY]: { [r.id]: r } } });
  assert.deepEqual(mergeLedger(wrap(reserved), wrap(settled), wrap(settled)), wrap(settled));
  assert.deepEqual(mergeLedger(wrap(reserved), wrap(reserved), wrap(settled)), wrap(settled));
  assert.throws(() => mergeLedger(wrap(reserved), wrap(settled), wrap({ ...settled, usage: { ...settled.usage, input: 999 } })), /Conflicting.*settlement/);
});
