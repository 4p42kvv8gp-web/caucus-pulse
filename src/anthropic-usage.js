// Anthropic spend ledger — every Claude call this repo makes, counted.
//
// Until 2026-09-11 nothing here read response.usage. Six call sites (the
// classify batch, live tagging, stories, taxonomy-learn, incident intel, the
// credential check) drew on one credit balance that only the Anthropic
// console could see, and the first sign of trouble was the API refusing with
// "credit balance is too low" halfway through a day. This module makes the
// spend a file in the repo, per ET day, per entry script, per model. Every
// new request reserves a conservative allowance under the configured rates.
//
//   data/anthropic-usage.json
//   { "<ET day>": { "<stage>": { "<model>": {
//       "live":  { calls, input, output, cacheRead, cacheWrite },   // messages.create / stream
//       "batch": { calls, input, output, cacheRead, cacheWrite } },  // messages.batches results
//     "_errors": { auth, other } } } }                                 // calls that threw, per stage
//
// _errors is the line the health check reads: a stage that catches its own
// errors and "continues with cached results" leaves no other trace, and on
// 2026-09-12/13 that hid two nights of federation 401s behind a green run.
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
// sums legacy increments and deduplicates request settlements on rebase.
// Git merges do not provide a shared real-time cap across separate checkouts.
//
//   node src/anthropic-usage.js          today's spend by stage, and the budget
//   node src/anthropic-usage.js --days=7 the last week
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { settings, etDate, p } from './util.js';

export const LEDGER = p('data', 'anthropic-usage.json');
export const REQUESTS_KEY = '_requests';

// New calls are journaled individually, beside the legacy aggregate counters.
// A reservation survives interrupted calls and is replaced by actual usage only
// once. This coordinates processes sharing one disk; independent checkouts need
// a single writer/provider limit, not an eventual git merge, to share a cap.
export function readLedger(file = LEDGER) {
  let ledger;
  try { ledger = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`Anthropic usage ledger unreadable; paid requests blocked: ${file}`, { cause: e });
  }
  const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!object(ledger)) throw new Error('Anthropic usage ledger must be an object; paid requests blocked');
  for (const [day, stages] of Object.entries(ledger)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !object(stages)) throw new Error('Invalid Anthropic usage ledger day');
    for (const [stage, models] of Object.entries(stages)) {
      if (!object(models)) throw new Error('Invalid Anthropic usage ledger stage');
      if (stage === REQUESTS_KEY) {
        for (const request of Object.values(models)) {
          if (!object(request) || !['reserved', 'uncertain', 'settled', 'rejected'].includes(request.status)
            || !Number.isFinite(request.reservedUsd) || request.reservedUsd < 0) throw new Error('Invalid Anthropic request reservation');
          if (request.usage && (!object(request.usage) || Object.values(request.usage).some((v) => !Number.isFinite(v) || v < 0))) throw new Error('Invalid Anthropic request usage');
        }
        continue;
      }
      for (const [model, kinds] of Object.entries(models)) {
        if (!object(kinds)) throw new Error('Invalid Anthropic usage model');
        const rows = model === '_errors' ? [kinds] : Object.values(kinds || {});
        for (const row of rows) if (!object(row) || Object.values(row).some((v) => !Number.isFinite(v) || v < 0)) throw new Error('Invalid Anthropic usage counters');
      }
    }
  }
  return ledger;
}

function updateLedger(file, update) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch (e) { throw new Error('Anthropic ledger locked/unwritable; paid request blocked', { cause: e }); }
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const ledger = readLedger(file);
    const result = update(ledger);
    fs.writeFileSync(temporary, JSON.stringify(ledger, null, 1) + '\n', { mode: 0o600 });
    const out = fs.openSync(temporary, 'r');
    try { fs.fsyncSync(out); } finally { fs.closeSync(out); }
    fs.renameSync(temporary, file);
    return result;
  } finally {
    fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
    fs.rmSync(lock, { force: true });
  }
}

const normalizedUsage = (usage) => ({
  calls: 1, input: usage.input_tokens || 0, output: usage.output_tokens || 0,
  cacheRead: usage.cache_read_input_tokens || 0, cacheWrite: usage.cache_creation_input_tokens || 0
});

// Conservative bound for this application's text-only calls: UTF-8 bytes,
// protocol headroom, maximum output, and the highest cache-write multiplier.
// Server tools/media can add unbounded charges; they require a separate adapter.
export function estimateRequestUsd(params, { batch = false, pricing } = {}) {
  if (!Number.isInteger(params?.max_tokens) || params.max_tokens < 1) throw new Error('A positive max_tokens is required for a paid request reservation');
  const blocks = [...(Array.isArray(params.system) ? params.system : []), ...(params.messages || []).flatMap((m) => Array.isArray(m.content) ? m.content : [])];
  if (params.tools?.length || blocks.some((b) => b.type !== 'text')) throw new Error('Budget reservation currently supports text-only requests without tools');
  const inputBound = Buffer.byteLength(JSON.stringify(params), 'utf8') + 1024 + 256 * (params.messages?.length || 0);
  const price = priceFor(params.model, pricing);
  return (inputBound * price.input * 2 + params.max_tokens * price.output) / 1e6 * (batch ? BATCH_RATE : 1);
}

function findRequest(ledger, id) {
  for (const [day, value] of Object.entries(ledger)) if (value[REQUESTS_KEY]?.[id]) return { day, request: value[REQUESTS_KEY][id] };
  return null;
}

function reserveRequests(entries, { file, day, budget, pricing }) {
  if (budget != null && (!Number.isFinite(budget) || budget < 0)) throw new Error('Invalid Anthropic request budget');
  return updateLedger(file, (ledger) => {
    const status = statusFromLedger(ledger, { day, budget, pricing });
    const reserved = entries.reduce((sum, entry) => sum + entry.reservedUsd, 0);
    if (budget != null && status.committed + reserved > budget + 1e-9) {
      throw Object.assign(new Error(`Anthropic request would exceed budget: $${status.committed.toFixed(2)} committed + $${reserved.toFixed(2)} reserved exceeds $${budget}`), { code: 'ANTHROPIC_BUDGET_EXCEEDED' });
    }
    const requests = ((ledger[day] ||= {})[REQUESTS_KEY] ||= {});
    for (const entry of entries) requests[entry.id] = { ...entry, status: 'reserved', createdAt: new Date().toISOString() };
  });
}

function finishRequest(id, { file, usage, model, status = 'settled', day = etDate(), stage = 'unknown', batch = false }) {
  return updateLedger(file, (ledger) => {
    const found = findRequest(ledger, id);
    if (found && ['settled', 'rejected'].includes(found.request.status)) return found.request;
    const request = found?.request || { id, stage, model, batch, reservedUsd: 0, createdAt: new Date().toISOString() };
    if (usage) { request.usage = normalizedUsage(usage); request.model = model || request.model; }
    // No usage after a successful call is unresolved liability, not a free call.
    request.status = status === 'settled' && !usage ? 'uncertain' : status;
    request.completedAt = new Date().toISOString();
    ((ledger[found?.day || day] ||= {})[REQUESTS_KEY] ||= {})[id] = request;
    return request;
  });
}

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
  return updateLedger(file, (ledger) => {
    const models = ((ledger[day] ||= {})[stage || 'unknown'] ||= {});
    const kinds = (models[model || 'unknown'] ||= {});
    const row = (kinds[batch ? 'batch' : 'live'] ||= emptyRow());
    for (const [key, value] of Object.entries(normalizedUsage(usage))) row[key] += value;
    return row;
  });
}

// A failed call: auth (the federation exchange or the key was refused) or
// anything else. Counted per stage, not per model — a refused exchange never
// reaches a model.
export const ERRORS_KEY = '_errors';
export function isAuthError(e) {
  const code = e?.statusCode ?? e?.status;
  return code === 401 || code === 403 || /token exchange failed|authentication_error/i.test(String(e?.message || ''));
}
export function recordError({ stage, error, file = LEDGER, day = etDate() }) {
  return updateLedger(file, (ledger) => {
    const row = (((ledger[day] ||= {})[stage || 'unknown'] ||= {})[ERRORS_KEY] ||= { auth: 0, other: 0 });
    row[isAuthError(error) ? 'auth' : 'other'] += 1;
    return row;
  });
}

export function priceFor(model, pricing = settings.anthropic?.pricing) {
  const table = pricing || {};
  const row = table[model] || table.default || DEFAULT_PRICE;
  const price = { input: Number(row.input), output: Number(row.output) };
  if (Object.values(price).some((value) => !Number.isFinite(value) || value <= 0)) throw new Error('Invalid Anthropic model pricing; paid requests blocked');
  return price;
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
  let authFailures = 0;
  let otherFailures = 0;
  const byStage = {};
  const failedStages = [];
  for (const [stage, models] of Object.entries(dayLedger || {})) {
    if (stage === REQUESTS_KEY) {
      for (const request of Object.values(models)) {
        if (!request.usage) continue;
        const usd = rowCost(request.usage, priceFor(request.model, pricing), { batch: request.batch });
        total += usd;
        calls += request.usage.calls || 0;
        byStage[request.stage] = (byStage[request.stage] || 0) + usd;
      }
      continue;
    }
    for (const [model, kinds] of Object.entries(models || {})) {
      if (model === ERRORS_KEY) {
        authFailures += kinds.auth || 0;
        otherFailures += kinds.other || 0;
        if ((kinds.auth || 0) + (kinds.other || 0) > 0) failedStages.push(stage);
        continue;
      }
      const price = priceFor(model, pricing);
      for (const [kind, row] of Object.entries(kinds || {})) {
        const usd = rowCost(row, price, { batch: kind === 'batch' });
        total += usd;
        calls += row.calls || 0;
        byStage[stage] = (byStage[stage] || 0) + usd;
      }
    }
  }
  return { total, calls, byStage, authFailures, otherFailures, failedStages };
}

// The daily ceiling in dollars: ANTHROPIC_DAILY_BUDGET_USD for a one-off run,
// else config/settings.json anthropic.daily_budget_usd. null = no ceiling.
export function dailyBudgetUsd(env = process.env) {
  const raw = env.ANTHROPIC_DAILY_BUDGET_USD ?? settings.anthropic?.daily_budget_usd;
  if (raw == null) return null;
  const v = Number(String(raw ?? '').replace(/[,_]/g, ''));
  if (!Number.isFinite(v) || v < 0 || String(raw).trim() === '') throw new Error('Invalid Anthropic daily budget; paid requests blocked');
  return v;
}

export function spendOn(day, { file = LEDGER, pricing } = {}) {
  return dayCost(readLedger(file)[day], pricing);
}

// Where today stands against the ceiling. `exhausted` is what the auth
// module reads: optional stages may skip when exhausted. Constructing a client
// remains possible for existing batch retrieval; new calls enforce reservations.
export function budgetStatus({ file = LEDGER, day = etDate(), budget = dailyBudgetUsd(), pricing } = {}) {
  return statusFromLedger(readLedger(file), { day, budget, pricing });
}

function statusFromLedger(ledger, { day, budget, pricing }) {
  const { total, calls, byStage, authFailures, otherFailures, failedStages } = dayCost(ledger[day], pricing);
  let reserved = 0;
  for (const stages of Object.values(ledger)) for (const request of Object.values(stages[REQUESTS_KEY] || {})) {
    if (['reserved', 'uncertain'].includes(request.status)) reserved += request.reservedUsd;
  }
  const committed = total + reserved;
  return { day, budget, spent: total, reserved, committed, calls, byStage, authFailures, otherFailures, failedStages, exhausted: budget != null && committed >= budget };
}

// Wrap an SDK client with a durable reservation before every paid request.
// Any failure before dispatch has a distinct code so a durable queue can
// distinguish a request never sent from an uncertain provider outcome.
const preflight = (fn) => {
  try { return fn(); }
  catch (error) {
    error.code ||= 'ANTHROPIC_PREFLIGHT_REJECTED';
    error.requestSent = false;
    throw error;
  }
};
export function instrument(client, { stage = defaultStage(), file = LEDGER, budget, pricing, today = etDate } = {}) {
  if (!client?.messages || client.messages.__ledger) return client;
  const reserve = (params, id = `live:${randomUUID()}`, batch = false) => preflight(() => {
    const entry = { id, stage, model: params.model, batch, reservedUsd: estimateRequestUsd(params, { batch, pricing }) };
    reserveRequests([entry], { file, day: today(), budget: budget === undefined ? dailyBudgetUsd() : budget, pricing });
    return id;
  });
  const record = (id, message, model, batch = false) => finishRequest(id, { file, day: today(), stage, usage: message?.usage, model: message?.model || model, batch });
  const failed = (error, ids) => {
    const code = error?.statusCode ?? error?.status;
    // Explicit pre-inference rejections release their reservation. Transport,
    // server, and interrupted-stream failures remain uncertain liabilities.
    const status = [400, 401, 403, 404, 413, 422, 429].includes(code) ? 'rejected' : 'uncertain';
    for (const id of ids) finishRequest(id, { file, status, day: today(), stage });
    recordError({ stage, error, file, day: today() });
  };
  const m = client.messages;
  const create = m.create.bind(m);
  m.create = async (params, opts) => {
    if (params?.stream) throw new Error('Use messages.stream() so streamed usage is accounted for');
    const id = reserve(params);
    return Promise.resolve().then(() => create(params, { ...opts, maxRetries: 0 })).then(
      (res) => { record(id, res, params.model); return res; },
      (err) => { failed(err, [id]); throw err; }
    );
  };
  if (typeof m.stream === 'function') {
    const stream = m.stream.bind(m);
    m.stream = (params, opts) => {
      const id = reserve(params);
      let s;
      try { s = stream(params, { ...opts, maxRetries: 0 }); }
      catch (err) { failed(err, [id]); throw err; }
      if (typeof s?.finalMessage !== 'function') throw new Error('Unsupported stream: finalMessage is required for accounting');
      const final = s.finalMessage.bind(s);
      let completion;
      s.finalMessage = () => {
        completion ||= Promise.resolve().then(final).then(
          (message) => { record(id, message, params.model); return message; },
          (err) => { failed(err, [id]); throw err; }
        );
        return completion;
      };
      // Attach a listener so the SDK does not emit an unhandled error; the
      // finalMessage promise performs settlement exactly once.
      if (typeof s.on === 'function') {
        s.on('error', () => {});
      }
      return s;
    };
  }
  const b = m.batches;
  if (b && typeof b.create === 'function') {
    const createBatch = b.create.bind(b);
    b.create = async (params, opts) => {
      const { entries, day } = preflight(() => {
      const submission = randomUUID();
      if (!params?.requests?.length) throw new Error('Cannot reserve an empty batch');
      const seen = new Set();
      const entries = params.requests.map((request) => {
        if (typeof request.custom_id !== 'string' || !request.custom_id || seen.has(request.custom_id)) throw new Error('Batch custom_ids must be nonempty and unique');
        seen.add(request.custom_id);
        return { id: `submission:${submission}:${request.custom_id}`, stage, model: request.params.model, batch: true, customId: request.custom_id, reservedUsd: estimateRequestUsd(request.params, { batch: true, pricing }) };
      });
      const day = today();
      reserveRequests(entries, { file, day, budget: budget === undefined ? dailyBudgetUsd() : budget, pricing });
      return { entries, day };
      });
      let response;
      try { response = await createBatch(params, { ...opts, maxRetries: 0 }); }
      catch (err) { failed(err, entries.map((entry) => entry.id)); throw err; }
      if (!response?.id) throw new Error('Batch submission returned no id; reservation retained for reconciliation');
      updateLedger(file, (ledger) => {
        const requests = ledger[day][REQUESTS_KEY];
        for (const entry of entries) {
          const id = `batch:${response.id}:${entry.customId}`;
          requests[id] = { ...requests[entry.id], id, batchId: response.id };
          delete requests[entry.id];
        }
      });
      return response;
    };
  }
  if (b && typeof b.results === 'function') {
    const results = b.results.bind(b);
    b.results = async (id, opts) => {
      const page = await results(id, opts);
      return (async function* counted() {
        for await (const r of page) {
          if (typeof r?.custom_id !== 'string' || !r.custom_id) throw new Error('Batch result has no custom_id; cannot account safely');
          const key = `batch:${id}:${r.custom_id}`;
          if (r.result?.type === 'succeeded') record(key, r.result.message, r.result.message?.model, true);
          else if (['errored', 'expired', 'canceled'].includes(r.result?.type)) finishRequest(key, { file, day: today(), stage, batch: true, status: 'rejected' });
          else throw new Error('Unknown batch result state; reservation retained');
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
  const failed = (s.authFailures || 0) + (s.otherFailures || 0);
  const failures = failed ? `; ${failed} call(s) FAILED (${s.authFailures || 0} auth) in ${(s.failedStages || []).join(', ')}` : '';
  return `${s.day}: $${s.spent.toFixed(2)}${cap} across ${s.calls} call(s)${s.reserved ? `; $${s.reserved.toFixed(2)} reserved/uncertain` : ''}${stages ? ` — ${stages}` : ''}${failures}${s.exhausted ? ' — BUDGET REACHED, new Claude requests stopped until allowance is available' : ''}`;
}

function main() {
  const daysArg = process.argv.find((a) => a.startsWith('--days='));
  const days = daysArg ? Number(daysArg.split('=')[1]) : 1;
  const ledger = readLedger(LEDGER);
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
