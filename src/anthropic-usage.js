// Anthropic spend ledger — every Claude call this repo makes, counted.
//
// Until 2026-09-11 nothing here read response.usage. Six call sites (the
// classify batch, live tagging, stories, taxonomy-learn, incident intel, the
// credential check) drew on one credit balance that only the Anthropic
// console could see, and the first sign of trouble was the API refusing with
// "credit balance is too low" halfway through a day. This module makes the
// spend a file in the repo, per ET day, per entry script, per model, and turns
// a daily dollar ceiling into a hard stop.
//
//   data/anthropic-usage.json
//   { "<ET day>": { "<stage>": { "<model>": {
//       "live":  { calls, input, output, cacheRead, cacheWrite },   // messages.create / stream
//       "batch": { calls, input, output, cacheRead, cacheWrite } } } } }   // messages.batches results
//
// Recording happens by wrapping the SDK client in anthropicClient()
// (instrument below: messages.create, messages.stream, messages.batches.
// results), so no call site has to remember. The stage is the entry script —
// poll, classify, stories, taxonomy-learn, incidents. Tokens are what is
// stored; dollars come from anthropic.pricing in config/settings.json at read
// time, so a price change never rewrites history.
//
// Two writers (a poll job and a nightly job, or a Claude Code session) each
// add their own tokens on top of the committed file; src/merge-anthropic-usage.js
// sums the increments on rebase, the way merge-state.js does for X reads.
//
//   node src/anthropic-usage.js          today's spend by stage, and the budget
//   node src/anthropic-usage.js --days=7 the last week
import path from 'node:path';
import { settings, etDate, readJSON, writeJSON, p } from './util.js';

export const LEDGER = p('data', 'anthropic-usage.json');

// Public list-price multipliers (docs.anthropic.com/en/docs/about-claude/pricing).
// Cache writes are the 5-minute kind, which is what cache_control ephemeral
// asks for; the batch discount stacks with caching.
export const CACHE_READ_RATE = 0.1;
export const CACHE_WRITE_RATE = 1.25;
export const BATCH_RATE = 0.5;
// Used when settings.anthropic.pricing has no row for a model, so an unknown
// model is still counted (at the classifier's rate) rather than free.
export const DEFAULT_PRICE = { input: 5, output: 25 };

const emptyRow = () => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

// The entry script's name: `node src/classify.js` → "classify", `npm run poll`
// → "poll". Live tagging runs inside the poll process and is billed to it,
// which is the line a reader wants: what does a poll cost.
export function defaultStage() {
  return path.basename(process.argv[1] || 'unknown', '.js');
}

// Add one response's usage to the ledger. Returns the updated row, or null
// when there was nothing to record (a refusal still carries usage; a thrown
// request does not reach here).
export function recordUsage({ stage, model, usage, batch = false, file = LEDGER, day = etDate() }) {
  if (!usage) return null;
  const ledger = readJSON(file, {});
  const models = ((ledger[day] ||= {})[stage || 'unknown'] ||= {});
  const kinds = (models[model || 'unknown'] ||= {});
  const row = (kinds[batch ? 'batch' : 'live'] ||= emptyRow());
  row.calls += 1;
  row.input += usage.input_tokens || 0;
  row.output += usage.output_tokens || 0;
  row.cacheRead += usage.cache_read_input_tokens || 0;
  row.cacheWrite += usage.cache_creation_input_tokens || 0;
  writeJSON(file, ledger);
  return row;
}

export function priceFor(model, pricing = settings.anthropic?.pricing) {
  const table = pricing || {};
  const row = table[model] || table.default || DEFAULT_PRICE;
  return { input: Number(row.input) || DEFAULT_PRICE.input, output: Number(row.output) || DEFAULT_PRICE.output };
}

// Dollars for one row at list price (per-million rates in `price`).
export function rowCost(row, price, { batch = false } = {}) {
  const i = price.input / 1e6;
  const o = price.output / 1e6;
  const usd = (row.input || 0) * i
    + (row.cacheRead || 0) * i * CACHE_READ_RATE
    + (row.cacheWrite || 0) * i * CACHE_WRITE_RATE
    + (row.output || 0) * o;
  return batch ? usd * BATCH_RATE : usd;
}

// One day's spend: total, per stage, and the call count.
export function dayCost(dayLedger, pricing) {
  let total = 0;
  let calls = 0;
  const byStage = {};
  for (const [stage, models] of Object.entries(dayLedger || {})) {
    for (const [model, kinds] of Object.entries(models || {})) {
      const price = priceFor(model, pricing);
      for (const [kind, row] of Object.entries(kinds || {})) {
        const usd = rowCost(row, price, { batch: kind === 'batch' });
        total += usd;
        calls += row.calls || 0;
        byStage[stage] = (byStage[stage] || 0) + usd;
      }
    }
  }
  return { total, calls, byStage };
}

// The daily ceiling in dollars: ANTHROPIC_DAILY_BUDGET_USD for a one-off run,
// else config/settings.json anthropic.daily_budget_usd. null = no ceiling.
export function dailyBudgetUsd(env = process.env) {
  const raw = env.ANTHROPIC_DAILY_BUDGET_USD ?? settings.anthropic?.daily_budget_usd;
  const v = Number(String(raw ?? '').replace(/[,_]/g, ''));
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function spendOn(day, { file = LEDGER, pricing } = {}) {
  return dayCost(readJSON(file, {})[day], pricing);
}

// Where today stands against the ceiling. `exhausted` is what the auth
// module reads: once true, anthropicConfigured() says no and anthropicClient()
// refuses, so every Claude stage skips or fails loudly until the ET day rolls.
export function budgetStatus({ file = LEDGER, day = etDate(), budget = dailyBudgetUsd(), pricing } = {}) {
  const { total, calls, byStage } = spendOn(day, { file, pricing });
  return { day, budget, spent: total, calls, byStage, exhausted: budget != null && total >= budget };
}

// Wrap an SDK client so its responses land in the ledger. Idempotent per
// client. Recording never throws into the call: a ledger that cannot be
// written warns and the response still returns.
export function instrument(client, { stage = defaultStage(), file = LEDGER } = {}) {
  if (!client?.messages || client.messages.__ledger) return client;
  const record = (usage, model, batch) => {
    try { recordUsage({ stage, model, usage, batch, file }); } catch (e) { console.warn(`[anthropic-usage] not recorded: ${e.message}`); }
  };
  const m = client.messages;
  const create = m.create.bind(m);
  m.create = (params, opts) => {
    const r = create(params, opts);
    if (params?.stream) return r; // raw event stream: usage is in its events, not a Message
    return r.then((res) => { record(res?.usage, res?.model || params?.model, false); return res; });
  };
  if (typeof m.stream === 'function') {
    const stream = m.stream.bind(m);
    m.stream = (params, opts) => {
      const s = stream(params, opts);
      if (typeof s?.on === 'function') s.on('finalMessage', (msg) => record(msg?.usage, msg?.model || params?.model, false));
      return s;
    };
  }
  const b = m.batches;
  if (b && typeof b.results === 'function') {
    const results = b.results.bind(b);
    b.results = async (id, opts) => {
      const page = await results(id, opts);
      return (async function* counted() {
        for await (const r of page) {
          if (r?.result?.type === 'succeeded') record(r.result.message?.usage, r.result.message?.model, true);
          yield r;
        }
      })();
    };
  }
  Object.defineProperty(m, '__ledger', { value: { stage, file }, enumerable: false });
  return client;
}

export function formatStatus(s) {
  const stages = Object.entries(s.byStage).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} $${v.toFixed(2)}`).join(', ');
  const cap = s.budget != null ? ` of $${s.budget} daily budget` : ' (no daily budget set)';
  return `${s.day}: $${s.spent.toFixed(2)}${cap} across ${s.calls} call(s)${stages ? ` — ${stages}` : ''}${s.exhausted ? ' — BUDGET REACHED, Claude stages stopped until tomorrow ET' : ''}`;
}

function main() {
  const daysArg = process.argv.find((a) => a.startsWith('--days='));
  const days = daysArg ? Number(daysArg.split('=')[1]) : 1;
  const ledger = readJSON(LEDGER, {});
  const all = Object.keys(ledger).sort();
  const shown = days > 1 ? all.slice(-days) : [etDate()];
  for (const day of shown) console.log(`[anthropic-usage] ${formatStatus(budgetStatus({ day }))}`);
  if (days > 1) {
    const total = shown.reduce((n, d) => n + spendOn(d).total, 0);
    console.log(`[anthropic-usage] ${shown.length} day(s): $${total.toFixed(2)}`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main();
}
