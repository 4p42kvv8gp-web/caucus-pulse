import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eventShadowMain, prepareShadowPlans, readShadowState } from '../src/event-shadow.js';

const NOW = '2026-09-14T19:00:00.000Z';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'events', 'shadow.json');
  const pilot = { plans: [1, 2].map((n) => ({ caseId: `fixture-${n}`, ready: true,
    sourceHash: `source-${n}`, correctionHash: 'none', runAsOf: NOW, mode: 'retrospective',
    expectedIds: [`REVIEWER-ANSWER-${n}`], negativeIds: ['REVIEWER-NEGATIVE'], diagnostics: [],
    posts: [{ id: String(n), authorId: String(n), personId: `member-${n}`, text: `Public synthetic statement ${n}.`,
      createdAt: '2026-09-14T18:00:00.000Z', topics: [], evidence: [] }] })), diagnostics: [] };
  const deps = { file, model: 'synthetic-model', log: () => {}, refresh: async () => {}, now: () => NOW,
    load: async ({ runAsOf, mode }) => ({ ...structuredClone(pilot), plans: pilot.plans.map((plan) => ({ ...structuredClone(plan), runAsOf, mode })) }) };
  return { pilot, deps, file };
}
const noEvents = (params) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({
  assignments: params.messages[0].content.split('\n').map((line) => { const p = JSON.parse(line); return { id: p.id, topics: p.topics, evidence_used: [], needs_context: false }; }),
  events: [], unresolved: [] }) }] });

test('CLI awaits asynchronous pilot loading and planning cannot call APIs or create state', async (t) => {
  const { deps, file, pilot } = fixture(t);
  deps.clientFactory = async () => { throw new Error('must not construct client'); };
  const result = await eventShadowMain(['--plan'], deps);
  assert.equal(result.status, 'planned'); assert.equal(result.plans, 2);
  assert.equal(fs.existsSync(file), false);
  const plans = prepareShadowPlans(pilot, { model: 'synthetic-model' });
  assert.ok(!JSON.stringify(plans).includes('REVIEWER-ANSWER'));
  assert.ok(!JSON.stringify(plans).includes('REVIEWER-NEGATIVE'));
  const otherMode = structuredClone(pilot); otherMode.plans[0].mode = 'as-of';
  assert.notEqual(prepareShadowPlans(otherMode, { model: 'synthetic-model' })[0].key, plans[0].key);
});

test('incomplete fixed bundles fail before any state write or provider call', async (t) => {
  const { deps, pilot, file } = fixture(t);
  pilot.plans[0].ready = false; pilot.plans[0].diagnostics = [{ id: '1', reason: 'interpretation-pending' }];
  deps.clientFactory = async () => { throw new Error('must not construct client'); };
  await assert.rejects(eventShadowMain(['--execute'], deps), /refusing reduced evaluation bundles.*interpretation-pending/);
  assert.equal(fs.existsSync(file), false);
});

test('two successful fixed requests are saved and replayed after clock advance without new API calls', async (t) => {
  const { deps, file } = fixture(t);
  let calls = 0;
  deps.client = { messages: { create: async (params) => { calls++; return noEvents(params); } } };
  const first = await eventShadowMain(['--execute'], deps);
  assert.equal(first.accepted, 2); assert.equal(calls, 2);
  assert.equal(readShadowState(file).runAsOf, NOW);
  deps.now = () => '2026-09-17T19:00:00.000Z';
  const next = await eventShadowMain(['--execute'], deps);
  assert.equal(next.accepted, 2); assert.equal(next.calls, 0); assert.equal(calls, 2);
  assert.ok(Object.values(next.state.receipts).every((receipt) => receipt.plan.runAsOf === NOW));
});

test('CLI reports unresolved provider outcomes as incomplete while retaining successful paid work', async (t) => {
  const { deps, file } = fixture(t);
  let calls = 0;
  deps.client = { messages: { create: async (params) => {
    if (++calls === 1) throw Object.assign(new Error('provider overloaded'), { status: 529 });
    return noEvents(params);
  } } };
  await assert.rejects(eventShadowMain(['--execute'], deps), /remains incomplete/);
  const saved = readShadowState(file);
  assert.equal(saved.attempts, 2);
  assert.equal(Object.values(saved.receipts).filter((receipt) => receipt.status === 'accepted').length, 1);
  await assert.rejects(eventShadowMain(['--execute'], deps), /remains incomplete/);
  assert.equal(calls, 2);
});

test('corrupt saved state and unknown arguments cannot reset the evaluation', async (t) => {
  const { deps, file } = fixture(t);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{torn');
  await assert.rejects(eventShadowMain(['--execute'], deps), SyntaxError);
  await assert.rejects(eventShadowMain(['--reset'], deps), /Supported arguments/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{torn');
});
