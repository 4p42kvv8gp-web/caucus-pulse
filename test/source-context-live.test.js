// Synthetic source recovery exercises call selection and interpretation
// precedence. These tests do not measure a model's understanding of events.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyLive, combineInterpretations } from '../src/classify-live.js';
import { sourceContextStatus } from '../src/source-context.js';

const date = '2026-09-12';
const tax = { transportation: { label: 'Transportation', subtopics: { rail: { label: 'Rail' } } } };
const post = { id: '1', type: 'retweet', refId: '900', text: 'RT @governor: New Haven Line service…', createdAt: `${date}T17:00:00Z` };
const original = { id: '900', handle: 'governor', text: 'New Haven Line service is suspended between Norwalk and Bridgeport after a bridge incident.', createdAt: `${date}T16:30:00Z` };
const response = (id) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({
  assignments: [{ id, topics: [['transportation', 'rail']], needs_context: false }], emerging: []
}) }] });

function fixture(t, previous = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-context-live-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const nightly = { assignments: { 1: [] }, provenance: { 1: { contextVersion: 0 } },
    needsContext: { 1: false }, pendingIds: [], complete: true,
    classifiedAt: `${date}T18:00:00Z`, ...previous };
  const files = new Map([[`nightly/${date}`, nightly]]);
  let recovered = null, calls = 0, writes = 0;
  const options = {
    enabled: true, tax, model: 'offline-model', dates: [date], queueFile: path.join(tmp, 'queue.json'),
    load: () => [post], read: (file, fallback) => files.get(file) || fallback,
    write: (file, data) => { writes++; files.set(file, structuredClone(data)); },
    livePath: (d) => `live/${d}`, nightlyPath: (d) => `nightly/${d}`,
    resolve: () => null, resolveRepost: () => recovered,
    hints: async (items) => items, refresh: async () => {}, configured: () => true,
    warn: () => {}, now: () => `${date}T20:00:00Z`, newsStore: { items: [], version: 0 },
    client: { messages: { create: async (params) => {
      calls++;
      const lines = params.messages[0].content.split('\n').map((line) => JSON.parse(line));
      assert.equal(lines.length, 1);
      assert.equal(lines[0].id, post.id);
      assert.equal(lines[0].reposting.text, recovered.text);
      return response(post.id);
    } } }
  };
  return { files, nightly, options, recover: (value = original) => { recovered = value; },
    live: () => files.get(`live/${date}`), calls: () => calls, writes: () => writes };
}

test('legacy missing repost gets an uncertainty observation without another model call or repeated empty-poll writes', async (t) => {
  const f = fixture(t);
  const result = await classifyLive([], f.options);
  assert.equal(result.tagged, 0);
  assert.equal(result.pending, 0);
  assert.deepEqual(f.live().assignments['1'], []);
  assert.equal(f.live().needsContext['1'], true);
  assert.equal(f.live().provenance['1'].sourceContextObserved.incomplete, true);
  assert.equal(f.live().provenance['1'].sourceContext, undefined, 'observation must not claim an earlier model read this source');
  const writes = f.writes();
  assert.equal(await classifyLive([], f.options), null);
  assert.equal(f.writes(), writes);
  assert.equal(f.calls(), 0);
});

test('recovered original is classified once and survives an older nightly decision with the same news version', async (t) => {
  const f = fixture(t);
  await classifyLive([], f.options);
  f.recover();
  const result = await classifyLive([], f.options);
  assert.equal(result.tagged, 1);
  assert.equal(result.pending, 0);
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.live().assignments['1'], [['transportation', 'rail']]);
  assert.equal(f.live().needsContext['1'], false);
  assert.equal(f.live().provenance['1'].sourceContext.incomplete, false);
  assert.equal(f.live().provenance['1'].sourceContext.fingerprint, f.live().provenance['1'].sourceContextObserved.fingerprint);
  const combined = combineInterpretations(f.live(), f.nightly);
  assert.deepEqual(combined.assignments['1'], [['transportation', 'rail']]);
  assert.equal(combined.provenance['1'].sourceContext.fingerprint, f.live().provenance['1'].sourceContext.fingerprint);
  const writes = f.writes();
  assert.equal(await classifyLive([], f.options), null);
  assert.equal(f.calls(), 1);
  assert.equal(f.writes(), writes);
});

test('new unrelated news and refresh metadata do not spend again; changed original wording does', async (t) => {
  const f = fixture(t);
  await classifyLive([], f.options);
  f.recover();
  await classifyLive([], f.options);
  f.recover({ ...original, fetchedAt: `${date}T21:00:00Z`, capturedAt: `${date}T21:00:00Z` });
  const unrelatedNews = { version: 99, items: [{ id: 'unrelated', title: 'Music festival announces headliner', passages: ['A music festival announced a new concert.'], version: 99 }] };
  assert.equal(await classifyLive([], { ...f.options, newsStore: unrelatedNews }), null);
  assert.equal(f.calls(), 1);
  f.recover({ ...original, text: `${original.text} Replacement buses will run during the closure.` });
  assert.equal((await classifyLive([], f.options)).tagged, 1);
  assert.equal(f.calls(), 2);
  assert.equal(await classifyLive([], f.options), null);
  assert.equal(f.calls(), 2);
});

test('human-reviewed repost remains unchanged before and after original recovery', async (t) => {
  const reviewed = { contextVersion: 0, reviewed: true };
  const f = fixture(t, { corrected: { 1: { by: 'reviewer' } }, provenance: { 1: reviewed }, needsContext: { 1: false } });
  assert.equal(await classifyLive([], f.options), null);
  f.recover();
  assert.equal(await classifyLive([], f.options), null);
  assert.equal(f.calls(), 0);
  assert.equal(f.writes(), 0);
  assert.deepEqual(f.nightly.provenance['1'], reviewed);
  assert.equal(f.nightly.needsContext['1'], false);
});

test('pending live source work and mere source observations cannot replace a settled nightly interpretation', () => {
  const observed = sourceContextStatus({ ...post, reposted: original });
  const missing = sourceContextStatus(post);
  const nightly = { assignments: { 1: [] }, provenance: { 1: { contextVersion: 0, sourceContext: missing } }, classifiedAt: `${date}T18:00:00Z` };
  const live = { assignments: { 1: [['transportation', 'rail']] },
    provenance: { 1: { contextVersion: 0, sourceContext: observed, sourceContextObserved: observed } },
    updatedAt: `${date}T20:00:00Z` };
  assert.deepEqual(combineInterpretations({ ...live, pendingIds: ['1'] }, nightly).assignments['1'], []);
  const observedOnly = { ...live, provenance: { 1: { contextVersion: 0, sourceContext: missing, sourceContextObserved: observed } } };
  const merged = combineInterpretations(observedOnly, nightly);
  assert.deepEqual(merged.assignments['1'], []);
  assert.deepEqual(merged.provenance['1'].sourceContext, missing);
  assert.deepEqual(merged.provenance['1'].sourceContextObserved, observed);
});

test('a later nightly interpretation or reviewed correction remains authoritative over earlier source work', () => {
  const observed = sourceContextStatus({ ...post, reposted: original });
  const live = { assignments: { 1: [['transportation', 'rail']] },
    provenance: { 1: { contextVersion: 0, sourceContext: observed, sourceContextObserved: observed } }, updatedAt: `${date}T20:00:00Z` };
  const nightly = { assignments: { 1: [] }, provenance: { 1: { contextVersion: 0 } }, classifiedAt: `${date}T21:00:00Z` };
  assert.deepEqual(combineInterpretations(live, nightly).assignments['1'], []);
  const corrected = { ...nightly, classifiedAt: `${date}T18:00:00Z`, corrected: { 1: { by: 'reviewer' } } };
  const merged = combineInterpretations(live, corrected);
  assert.deepEqual(merged.assignments['1'], []);
  assert.deepEqual(merged.provenance['1'], corrected.provenance['1']);
  assert.deepEqual(merged.corrected['1'], corrected.corrected['1']);
});
