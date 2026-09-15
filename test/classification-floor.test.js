import test from 'node:test';
import assert from 'node:assert/strict';
import { classifierLine, planChunkRequests, emptyOut, mergeParsed } from '../src/classify.js';
import { requestManifest, emptyQueue, saveQueue, readQueue } from '../src/classification-queue.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const source = { id: 'floor_119_20260914_hr9576_fixture', kind: 'floor-agenda', publisher: 'Office of the Clerk',
  billId: '119-hr9576', title: 'National Fraud Enforcement Division Act of 2026',
  text: 'H.R. 9576 may be considered pursuant to a rule during the week of 2026-09-14. This is not a passage record.',
  weekStart: '2026-09-14', weekEnd: '2026-09-20', procedure: 'rule',
  url: 'https://docs.house.gov/floor/', observedAt: '2026-09-14T23:00:00Z', publishedAt: null };
const tax = { democracy: { label: 'Democracy', subtopics: {} } };
const post = (id) => ({ id, text: 'H.R. 9576 is listed for consideration.', officialAgenda: [source] });

test('official agenda survives input bounds, exact manifests and accepted source provenance', (t) => {
  const requests = planChunkRequests([post('1'), post('2')], tax, 'offline', '', { examples: [], evidenceCap: 1 }).requests;
  assert.equal(requests.length, 2);
  const manifest = requestManifest(requests);
  const entry = manifest[requests[0].custom_id];
  assert.deepEqual(JSON.parse(classifierLine(post('1'))).officialAgenda, [source]);
  assert.deepEqual(entry.evidenceByPost['1'], [source]);
  assert.match(requests[0].params.system[0].text, /not evidence of passage/);
  const out = emptyOut();
  mergeParsed({ assignments: [{ id: '1', topics: [['democracy', null]], evidence_used: [source.id] }] }, tax, out, ['1'], entry);
  assert.deepEqual(out.provenance['1'].evidenceSupplied, [source]);
  assert.deepEqual(out.provenance['1'].evidenceUsed, [source.id]);
  assert.equal(out.provenance['1'].inputHash, entry.inputHash);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floor-manifest-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const queue = emptyQueue();
  queue.jobs.push({ key: 'floor-test', dates: ['2026-09-14'], taxonomy: tax, manifest });
  const file = path.join(dir, 'queue.json'); saveQueue(queue, file);
  assert.deepEqual(readQueue(file).jobs[0].manifest, manifest);
});

test('a floor citation cannot cross posts and collisions with news evidence are rejected', () => {
  const requests = planChunkRequests([post('1'), { id: '2', text: 'Other subject' }], tax, 'offline', '', { examples: [] }).requests;
  const entry = requestManifest(requests)[requests[0].custom_id];
  const out = emptyOut();
  mergeParsed({ assignments: [{ id: '2', topics: [], evidence_used: [source.id] }] }, tax, out, ['1', '2'], entry);
  assert.equal(out.assignments['2'], undefined);
  assert.ok(out.validationErrors.some((e) => e.code === 'invalid-evidence-reference'));
  const bad = { ...post('1'), evidence: [{ ...source, kind: 'lead' }] };
  const colliding = planChunkRequests([bad], tax, 'offline', '', { examples: [] }).requests;
  assert.throws(() => requestManifest(colliding), /Invalid source evidence/);
});
