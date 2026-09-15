import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFloorDisplay } from '../src/floor-display.js';
import { publicProvenance } from '../src/sitedata.js';
import { parseFloorXML } from '../src/floor-context.js';
import { withEvidence } from '../src/classify.js';
import fs from 'node:fs';

const observedAt = '2026-09-14T22:00:00Z', now = Date.parse('2026-09-14T23:00:00Z');
const snapshot = parseFloorXML(fs.readFileSync(new URL('../tests/fixtures/house-floor-20260914.xml', import.meta.url), 'utf8'), { observedAt });
const agenda = { ...snapshot, available: true, current: true, stale: false, status: { ok: true } };

test('numeric build clocks supply actual bill context and deduplicate accounts to real members', () => {
  const original = { id: '900', text: 'H.R. 9576 may be considered this week.', createdAt: '2026-09-14T18:00:00Z' };
  const posts = [
    { id: '1', type: 'tweet', authorId: 'a', text: 'H.R. 9576 deserves scrutiny.', createdAt: '2026-09-14T19:00:00Z' },
    { id: '2', type: 'quote', authorId: 'b', text: 'Read this.', createdAt: '2026-09-14T20:00:00Z', refId: '900', quoting: original }
  ];
  const duplicateRow = agenda.items.find((item) => item.billId === '119-hr9576');
  const duplicated = { ...agenda, items: [...agenda.items, { ...duplicateRow, id: 'another-official-row' }] };
  const enriched = withEvidence(posts, { agenda, now, store: { items: [], version: 0 } });
  assert.deepEqual(enriched.items.map((item) => item.officialAgenda[0].billId), ['119-hr9576', '119-hr9576']);
  const display = buildFloorDisplay({ agenda: duplicated, posts: [...posts, posts[0]],
    authors: { a: { member: 'Same Member' }, b: { member: 'Same Member' } }, personKey: (author) => author?.member, now });
  const row = display.items.find((item) => item.billId === '119-hr9576');
  assert.equal(display.referencesAvailable, true);
  assert.equal(row.membersReferencing, 1);
  assert.equal(row.accountsReferencing, 2);
  assert.equal(row.references.length, 2);
  assert.equal(row.references.find((post) => post.id === '2').referencedSources[0].text, original.text);
  assert.equal(row.references.find((post) => post.id === '2').referencedSources[0].id, original.id);
});

test('public official-source citations keep the week and acquisition time, without private extras', () => {
  const source = { id: 'floor-fixture', publisher: 'Clerk', kind: 'floor-agenda',
    url: 'https://docs.house.gov/floor/', text: 'May be considered', weekStart: '2026-09-14', weekEnd: '2026-09-20',
    observedAt: '2026-09-14T23:00:00Z', billId: '119-hr9576', procedure: 'rule', inboxSubject: 'private' };
  const out = publicProvenance({ evidenceSupplied: [source], evidenceUsed: [source.id] });
  assert.equal(out.evidenceSupplied[0].fetchedAt, source.observedAt);
  assert.equal(out.evidenceSupplied[0].weekStart, source.weekStart);
  assert.equal(out.evidenceSupplied[0].weekEnd, source.weekEnd);
  assert.equal(out.evidenceSupplied[0].billId, source.billId);
  assert.ok(!JSON.stringify(out).includes('inboxSubject'));
});

test('an unavailable agenda cannot be presented as zero observed member references', () => {
  const out = buildFloorDisplay({ agenda: { items: [], current: false, stale: true, status: { ok: false } } });
  assert.equal(out.referencesAvailable, false);
});
