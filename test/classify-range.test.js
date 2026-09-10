import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkRequests, mergeParsed } from '../src/classify.js';

const tax = { economy: { label: 'Economy', subtopics: { jobs: { label: 'Jobs' } } } };

test('chunkRequests prefixes custom_ids with the date and keeps them batch-legal', () => {
  const items = Array.from({ length: 85 }, (_, i) => ({ id: String(i), text: `t${i}` }));
  const reqs = chunkRequests(items, tax, 'm', '2026-08-20_');
  assert.equal(reqs.length, 3); // 40 + 40 + 5
  assert.deepEqual(reqs.map((r) => r.custom_id), ['2026-08-20_chunk-0', '2026-08-20_chunk-1', '2026-08-20_chunk-2']);
  for (const r of reqs) assert.match(r.custom_id, /^[a-zA-Z0-9_-]{1,64}$/);
  // the date prefix is what collectResults strips to regroup by day
  assert.equal(reqs[0].custom_id.replace(/chunk-\d+$/, ''), '2026-08-20_');
  assert.equal(chunkRequests(items.slice(0, 3), tax, 'm')[0].custom_id, 'chunk-0');
});

test('mergeParsed keeps only taxonomy-valid assignments and groups emerging labels', () => {
  const out = { assignments: {}, incidents: {}, emergingMap: new Map() };
  mergeParsed({
    assignments: [
      { id: '1', topics: [['economy', 'jobs'], ['nonsense', null]], incident: { kind: 'Flood', place: 'Asheville' } },
      { id: '2', topics: [['economy', null]] }
    ],
    emerging: [{ label: 'Rail strike', ids: ['3'] }, { label: 'rail strike', ids: ['4'] }]
  }, tax, out);
  assert.deepEqual(out.assignments['1'], [['economy', 'jobs']]);
  assert.deepEqual(out.assignments['2'], [['economy', null]]);
  assert.deepEqual(out.incidents['1'], { kind: 'flood', place: 'Asheville' });
  assert.equal(out.emergingMap.size, 1);
  assert.deepEqual([...out.emergingMap.values()][0].ids, ['3', '4']);
});
