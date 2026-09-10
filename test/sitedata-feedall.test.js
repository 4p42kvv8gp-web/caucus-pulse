// Story drill-down data: rollups.json size guard, feedAll truncation, and the
// row ↔ post-list contract of the committed site/data/rollups.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fitFeedAll, ROLLUPS_MAX_BYTES, rollupsJsonPath } from '../src/sitedata.js';

test('fitFeedAll keeps the whole list when it fits', () => {
  const list = [1, 2, 3, 4];
  const out = fitFeedAll(list, (l) => l.length * 10, 100);
  assert.equal(out.truncated, false);
  assert.equal(out.feedAll, list);
});

test('fitFeedAll trims to the largest newest-first prefix under the cap', () => {
  const list = Array.from({ length: 100 }, (_, i) => `p${i}`); // newest first
  const out = fitFeedAll(list, (l) => 1000 + l.length * 10, 1055); // 1000 base + 10/post → 5 fit (1050), 6 do not (1060)
  assert.equal(out.truncated, true);
  assert.deepEqual(out.feedAll, ['p0', 'p1', 'p2', 'p3', 'p4']);
  // the guard never keeps a prefix that is itself over the cap
  const none = fitFeedAll(list, (l) => 2000 + l.length, 1000);
  assert.equal(none.truncated, true);
  assert.deepEqual(none.feedAll, []);
});

test('ROLLUPS_MAX_BYTES is the 2.5 MB budget', () => {
  assert.equal(ROLLUPS_MAX_BYTES, 2_500_000);
});

const rollups = fs.existsSync(rollupsJsonPath) ? JSON.parse(fs.readFileSync(rollupsJsonPath, 'utf8')) : null;

test('site/data/rollups.json stays under the size guard', { skip: !rollups && 'no rollups.json built' }, () => {
  const bytes = fs.statSync(rollupsJsonPath).size;
  assert.ok(bytes < ROLLUPS_MAX_BYTES, `rollups.json is ${bytes} bytes; cap is ${ROLLUPS_MAX_BYTES}`);
  assert.equal(typeof rollups.feedAllTruncated, 'boolean');
  assert.ok(Array.isArray(rollups.feedAll));
  assert.equal(rollups.feed.length <= 200, true, 'the default feed stays capped at 200');
});

test('every Topics row lists its posts (postIds) and feedAll resolves them', { skip: !rollups && 'no rollups.json built' }, () => {
  const byId = new Map(rollups.feedAll.map((x) => [x.id, x]));
  const rows = rollups.topics.flatMap((t) => [[t.key, t], ...t.subs.map((s) => [`${t.key}/${s.key}`, s])]);
  assert.ok(rows.length > 0);
  for (const [key, row] of rows) {
    for (const win of ['t', 'w']) {
      const ids = row.postIds?.[win];
      assert.ok(Array.isArray(ids), `${key}.postIds.${win} missing`);
      assert.equal(ids.length, row[win].All.n, `${key}: postIds.${win} (${ids.length}) ≠ ${win}.All.n (${row[win].All.n})`);
      assert.equal(new Set(ids).size, ids.length, `${key}: duplicate ids in postIds.${win}`);
      if (!rollups.feedAllTruncated) for (const id of ids) assert.ok(byId.has(id), `${key}: ${id} not in feedAll`);
      // newest first
      const known = ids.map((id) => byId.get(id)).filter(Boolean);
      for (let i = 1; i < known.length; i++) assert.ok(known[i - 1].createdAt >= known[i].createdAt, `${key}: postIds.${win} not newest-first`);
    }
    assert.ok(row.postIds.t.every((id) => row.postIds.w.includes(id)), `${key}: today's posts must be in the 7-day list`);
  }
  for (const x of rollups.feedAll) {
    assert.ok(x.topics.length > 0, `${x.id} carries no topic`);
    for (const k of ['id', 'authorId', 'createdAt', 'type', 'text', 'engN']) assert.ok(k in x, `${x.id} lacks ${k}`);
    assert.ok(rollups.authorHandles[x.authorId], `${x.id}: author ${x.authorId} has no handle`);
    if (x.quoted) assert.ok(x.quoted.text.length <= 200, `${x.id}: quoted text over 200 chars`);
  }
});
