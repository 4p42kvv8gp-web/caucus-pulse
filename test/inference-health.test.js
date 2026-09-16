import test from 'node:test';
import assert from 'node:assert/strict';
import { inferenceFailureReason, inferenceReceipt, mergeInferenceHealth, buildInferenceHealth } from '../src/inference-health.js';
import { classifySync, chunkRequests, mergeDay, collectResults, planDay } from '../src/classify.js';

const tax = { climate: { label: 'Climate', subtopics: { disasters: { label: 'Disasters' } } } };
const coverage = { capturedIn24h: 777, classifiedIn24h: 48, pendingIn24h: 729 };
const now = Date.parse('2026-09-16T02:00:00Z');
const clock = (start = '2026-09-16T01:00:00Z') => { let time = Date.parse(start); return () => new Date(time++).toISOString(); };
const receipt = (status, at, extra = {}) => ({ attemptedAt: at, observedAt: at, kind: 'sync', status,
  reasonCode: status === 'complete' ? null : 'provider-credits', acceptedCount: status === 'complete' ? 1 : 0,
  retryCount: status === 'complete' ? 0 : 1, ...extra });
const day = (r) => ({ inference: mergeInferenceHealth(null, { request: { inference: r } }) });
const message = (id) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ assignments: [{ id, topics: [] }], emerging: [] }) }] });
const post = (id) => ({ id, type: 'tweet', createdAt: '2026-09-15T20:00:00Z', text: 'A public statement.' });
const requests = () => [1, 2, 3].flatMap((n) => chunkRequests([post(String(n))], tax, 'offline', `r${n}_`, { examples: [] }));

test('known provider failures have bounded public reason codes, not raw messages', () => {
  for (const [error, reason] of [
    [Object.assign(new Error('Your credit balance is too low to access the Anthropic API.'), { status: 400 }), 'provider-credits'],
    [Object.assign(new Error('private diagnostic'), { status: 401 }), 'provider-auth'],
    [{ status: 429 }, 'provider-rate-limit'], [{ status: 529 }, 'provider-unavailable'],
    [new Error('unexpected error containing private text'), 'inference-error']
  ]) assert.equal(inferenceFailureReason(error), reason);
});

test('a rejected first chunk stops subsequent account-wide failures while preserving all pending IDs', async () => {
  let calls = 0; const published = [];
  const out = await classifySync({ messages: { create: async () => { calls++; throw Object.assign(new Error('Your credit balance is too low to access the Anthropic API.'), { status: 400 }); } } }, requests(), tax,
    { refresh: async () => {}, now: clock(), onResult: (r) => published.push(structuredClone(r)) });
  assert.equal(calls, 1); assert.equal(out.failedChunks, 1); assert.equal(published.length, 1);
  assert.deepEqual(Object.values(out.requestStatus).flatMap((r) => r.retryIds), ['1', '2', '3']);
  assert.equal(out.requestStatus['r2_chunk-0'].deferred, true);
  assert.equal(out.requestStatus['r2_chunk-0'].inference, undefined, 'unsent sources have no invented attempt');
  const saved = mergeInferenceHealth(null, out.requestStatus);
  const health = buildInferenceHealth([{ inference: saved }], coverage, { now });
  assert.equal(health.status, 'blocked'); assert.equal(health.reasonCode, 'provider-credits');
  assert.equal(health.lastAttemptAt, '2026-09-16T01:00:00.000Z'); assert.equal(health.lastSuccessAt, null);
  assert.equal(JSON.stringify(health).includes('Anthropic API'), false);
});

test('transient failure permits later chunks, and a later accepted response shows pending coverage', async () => {
  let calls = 0;
  const out = await classifySync({ messages: { create: async () => {
    calls++; if (calls === 1) throw Object.assign(new Error('Overloaded'), { status: 529 });
    return message(String(calls));
  } } }, requests(), tax, { refresh: async () => {}, now: clock() });
  assert.equal(calls, 3); assert.deepEqual(Object.keys(out.assignments), ['2', '3']);
  const health = buildInferenceHealth([{ inference: mergeInferenceHealth(null, out.requestStatus) }], coverage, { now });
  assert.equal(health.status, 'pending'); assert.equal(health.hasCurrentFailure, false);
  assert.equal(health.lastSuccessAt, '2026-09-16T01:00:00.005Z');
});

test('metadata writes preserve the last actual request and successful empty interpretation', async () => {
  const out = await classifySync({ messages: { create: async () => message('1') } }, requests().slice(0, 1), tax,
    { refresh: async () => {}, now: clock() });
  const pl = planDay('2026-09-15', { tweets: [post('1')], tax, prior: {}, resolve: () => null, resolveRepost: () => null });
  const first = mergeDay(pl, out).day;
  const rewritten = mergeDay({ ...pl, previous: first }, { assignments: {}, requestStatus: {} }).day;
  assert.deepEqual(rewritten.inference, first.inference); assert.deepEqual(rewritten.requestStatus, first.requestStatus);
  const health = buildInferenceHealth([{ ...rewritten, classifiedAt: '2026-09-16T01:59:59Z', updatedAt: '2026-09-16T01:59:59Z' }],
    { capturedIn24h: 1, classifiedIn24h: 1, pendingIn24h: 0 }, { now });
  assert.equal(health.status, 'healthy'); assert.equal(health.lastSuccessAt, '2026-09-16T01:00:00.001Z');
});

test('later success clears a failure but preserves incomplete coverage; an old batch cannot clear it', () => {
  const failed = day(receipt('failed', '2026-09-16T01:00:00Z'));
  const oldBatch = day(receipt('complete', '2026-09-15T23:00:00Z', { kind: 'batch-result', observedAt: '2026-09-16T01:30:00Z' }));
  assert.equal(buildInferenceHealth([failed, oldBatch], coverage, { now }).status, 'blocked');
  const recovered = day(receipt('complete', '2026-09-16T01:40:00Z'));
  assert.equal(buildInferenceHealth([failed, oldBatch, recovered], coverage, { now }).status, 'pending');
  assert.equal(buildInferenceHealth([failed, recovered], { ...coverage, pendingIn24h: 0, classifiedIn24h: 777 }, { now }).status, 'healthy');
});

test('partial or malformed accepted responses remain degraded, including with some accepted empty assignments', () => {
  const r = inferenceReceipt({ acceptedIds: ['1'], retryIds: ['2'] }, { attemptedAt: '2026-09-16T01:00:00Z', observedAt: '2026-09-16T01:00:01Z' });
  const health = buildInferenceHealth([day(r)], coverage, { now });
  assert.equal(health.status, 'degraded'); assert.equal(health.reasonCode, 'invalid-response');
  assert.equal(health.lastSuccessAt, '2026-09-16T01:00:01.000Z'); assert.equal(health.hasCurrentFailure, true);
});

test('legacy provider error is visible without invented attempt times; new receipts supersede legacy ambiguity', () => {
  const legacy = { updatedAt: '2026-09-16T01:59:00Z', requestStatus: { old: { retryIds: ['1'], error: '400: Your credit balance is too low to access the Anthropic API.' } } };
  const health = buildInferenceHealth([legacy], coverage, { now });
  assert.equal(health.status, 'blocked'); assert.equal(health.lastAttemptAt, null); assert.equal(health.lastSuccessAt, null);
  assert.equal(buildInferenceHealth([legacy, day(receipt('complete', '2026-09-16T01:30:00Z'))], coverage, { now }).status, 'pending');
  assert.equal(buildInferenceHealth([{ updatedAt: '2026-09-16T01:59:00Z', assignments: { 1: [] } }], { pendingIn24h: 0 }, { now }).status, 'unknown');
  assert.equal(buildInferenceHealth([{ ...legacy, assignments: { 1: [] }, pendingIds: [] }], coverage, { now }).status, 'pending', 'settled legacy failures cannot imply a current outage');
  assert.equal(buildInferenceHealth([{ ...legacy, assignments: { 1: [] }, pendingIds: ['1'], corrected: { 1: true } }], coverage, { now }).status, 'pending', 'a human-settled source is not an unresolved provider failure');
});

test('future or invalid receipts cannot establish health, and source-free metadata cannot rewrite success', () => {
  const valid = day(receipt('complete', '2026-09-16T01:00:00Z'));
  assert.equal(buildInferenceHealth([day(receipt('complete', '2099-01-01T00:00:00Z'))], { pendingIn24h: 0 }, { now }).status, 'unknown');
  assert.deepEqual(mergeInferenceHealth(valid.inference, {}), valid.inference);
  assert.equal(buildInferenceHealth([day(receipt('complete', '2026-09-16T01:00:00Z', { observedAt: '2026-09-15T01:00:00Z' }))], coverage, { now }).lastAttemptAt, null);
});

test('batch receipts retain submission time even when results arrive much later', async () => {
  const manifest = { '2026-09-15_chunk-0': { ids: ['1'] } };
  const client = { messages: { batches: { results: async () => (async function* () {
    yield { custom_id: '2026-09-15_chunk-0', result: { type: 'succeeded', message: message('1') } };
  })() } } };
  const result = (await collectResults(client, 'batch', tax, manifest, { attemptedAt: '2026-09-15T23:00:00Z', now: () => '2026-09-16T01:30:00Z' })).get('2026-09-15_');
  assert.equal(result.requestStatus['2026-09-15_chunk-0'].inference.attemptedAt, '2026-09-15T23:00:00.000Z');
  assert.equal(result.requestStatus['2026-09-15_chunk-0'].inference.kind, 'batch-result');
});

test('mixed batch failures cannot be hidden by the order of successful manifest entries', async () => {
  const rows = [
    { custom_id: '2026-09-15_chunk-0', result: { type: 'errored', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } } },
    { custom_id: '2026-09-15_chunk-1', result: { type: 'succeeded', message: message('2') } }
  ];
  for (const reverse of [false, true]) {
    const entries = [['2026-09-15_chunk-0', { ids: ['1'] }], ['2026-09-15_chunk-1', { ids: ['2'] }]];
    if (reverse) entries.reverse();
    const client = { messages: { batches: { results: async () => (async function* () { yield* rows; })() } } };
    const out = (await collectResults(client, 'batch', tax, Object.fromEntries(entries), {
      attemptedAt: '2026-09-15T23:00:00Z', now: clock('2026-09-16T01:30:00Z')
    })).get('2026-09-15_');
    const health = buildInferenceHealth([{ inference: mergeInferenceHealth(null, out.requestStatus) }], coverage, { now });
    assert.equal(health.status, 'blocked'); assert.equal(health.reasonCode, 'provider-credits');
    assert.equal(health.lastSuccessAt, '2026-09-16T01:30:00.000Z');
  }
});
