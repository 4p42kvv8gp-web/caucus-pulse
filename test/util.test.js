import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, idGt, maxId, etDate } from '../src/util.js';

test('parseCSV handles quotes, commas, and CRLF', () => {
  const rows = parseCSV('handle,member\r\nRepX,"Doe, Jane"\nRepY,"She said ""hi"""\n');
  assert.deepEqual(rows, [['handle', 'member'], ['RepX', 'Doe, Jane'], ['RepY', 'She said "hi"']]);
});

test('snowflake id comparison uses BigInt, not Number', () => {
  const big = '1830000000000000001';
  assert.ok(idGt('1830000000000000002', big)); // differs past float precision
  assert.ok(!idGt(big, big));
  assert.equal(maxId(big, '1830000000000000002'), '1830000000000000002');
  assert.equal(maxId(null, big), big);
});

test('etDate buckets by Eastern calendar day', () => {
  // 03:00 UTC on Sep 2 is still 11pm Sep 1 in New York (EDT)
  assert.equal(etDate('2026-09-02T03:00:00.000Z'), '2026-09-01');
  assert.equal(etDate('2026-09-02T05:00:00.000Z'), '2026-09-02');
});
