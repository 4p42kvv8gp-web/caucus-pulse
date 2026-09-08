import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/db.js';
import { normalizePost } from '../src/normalize.js';
import { importRoster, verifyAccountBinding, promoteCaptured, resolveAttribution, CLERK_SOURCE } from '../src/roster.js';
import { dashboardData } from '../src/dashboard.js';

const now = Date.parse('2026-09-08T00:30:00Z');
const member = { memberId: 'T000001', name: 'Synthetic Test Member', state: 'XY', district: 'XY01', party: 'D', caucus: 'D', swornOn: '2025-01-03' };
function snapshot(overrides = {}) { return { schemaVersion: 1, id: 'a'.repeat(64), sourceUrl: CLERK_SOURCE, congress: '119', publishedOn: '2026-09-07', retrievedAt: '2026-09-08T00:00:00Z', members: [member], ...overrides }; }
function binding(overrides = {}) {
  return { authorId: '123', memberId: member.memberId, handle: 'SyntheticTest', accountType: 'official',
    validFrom: '2026-09-07T00:00:00Z', validUntil: '2026-09-09T00:00:00Z',
    evidence: { officialPage: 'https://synthetic.house.gov', linkedProfile: 'https://x.com/SyntheticTest',
      explanation: 'Synthetic test proof, never a real verification.', xUser: { id: '123', username: 'SyntheticTest', retrievedAt: '2026-09-08T00:00:00Z' } }, ...overrides };
}
function capture(store, { id = '900', authorId = '123', date = '2026-09-07T23:00:00Z' } = {}) {
  const p = normalizePost({ id, author_id: authorId, created_at: date, text: 'A synthetic library opening.' });
  store.db.prepare('INSERT INTO captured_posts(id,author_id,created_at,captured_at,normalized_json) VALUES (?,?,?,?,?)').run(p.id,p.authorId,p.createdAt,p.capturedAt,JSON.stringify(p));
  return p;
}

test('roster import validates provenance, identity, publication freshness and occupied districts', () => {
  const store = openStore();
  try {
    assert.equal(importRoster(store.db, snapshot(), { now }).members, 1);
    assert.equal(importRoster(store.db, snapshot(), { now }).members, 1, 'Exact repeat import is idempotent');
    assert.throws(() => importRoster(store.db, snapshot({ members: [{ ...member, name: 'Rewritten source' }] }), { now }), /cannot be rewritten/);
    assert.throws(() => importRoster(store.db, snapshot({ publishedOn: '2026-02-30' }), { now }), /calendar date/);
    assert.throws(() => importRoster(store.db, snapshot({ sourceUrl: 'https://unrelated.example' }), { now }), /provenance/);
    assert.throws(() => importRoster(store.db, snapshot({ publishedOn: '2026-08-01' }), { now }), /stale/);
    assert.throws(() => importRoster(store.db, snapshot({ members: [member, member] }), { now }), /Duplicate member/);
    assert.throws(() => importRoster(store.db, snapshot({ members: [member, { ...member, memberId: 'T000002' }] }), { now }), /Duplicate occupied district/);
  } finally { store.close(); }
});

test('List capture alone cannot turn an unknown account into a member post', () => {
  const store = openStore();
  try {
    importRoster(store.db, snapshot(), { now }); capture(store);
    assert.deepEqual(promoteCaptured(store, { now }), { promoted: 0, awaitingVerification: 1 });
    assert.equal(store.listPosts().length, 0);
    assert.equal(store.db.prepare('SELECT status FROM captured_posts').get().status, 'awaiting-account-verification');
    const data = dashboardData(store, {}, { mode: 'test', budget: {} });
    assert.equal(data.operations.awaitingRoster, 1);
    assert.equal(data.operations.roster.snapshot.memberCount, 1);
    assert.equal(data.operations.roster.accountBindings, 0);
  } finally { store.close(); }
});

test('binding requires exact profile evidence and refuses overlapping ownership', () => {
  const store = openStore();
  try {
    importRoster(store.db, snapshot(), { now });
    const bad = binding(); bad.evidence.xUser.id = '456';
    assert.throws(() => verifyAccountBinding(store.db, bad, { now }), /matching X profile/);
    const wrongHost = binding(); wrongHost.evidence.officialPage = 'https://house.gov.unrelated.example';
    assert.throws(() => verifyAccountBinding(store.db, wrongHost, { now }), /official House page/);
    verifyAccountBinding(store.db, binding(), { now });
    assert.throws(() => verifyAccountBinding(store.db, binding(), { now }), /Overlapping/);
  } finally { store.close(); }
});

test('verified capture promotes atomically, queues analysis, and preserves post-specific identity', () => {
  const store = openStore();
  try {
    importRoster(store.db, snapshot(), { now }); verifyAccountBinding(store.db, binding(), { now }); capture(store);
    assert.equal(promoteCaptured(store, { now }).promoted, 1);
    assert.equal(store.getPost('900').memberId, 'T000001');
    assert.equal(store.getPost('900').district, 'XY01');
    assert.equal(store.getPost('900').analysis.status, 'pending');
    store.upsertAccount({ authorId: '123', memberId: 'unrelated-later-owner', memberName: 'Changed mapping', handle: 'Changed' });
    assert.equal(store.getPost('900').memberId, 'T000001', 'Historical attribution cannot follow a mutable account row');
    assert.equal(promoteCaptured(store, { now }).promoted, 0);
  } finally { store.close(); }
});

test('old historical posts and expired roster windows remain unresolved', () => {
  const store = openStore();
  try {
    importRoster(store.db, snapshot(), { now });
    verifyAccountBinding(store.db, binding({ validFrom: '2026-01-01T00:00:00Z', validUntil: '2027-01-01T00:00:00Z' }), { now });
    const old = capture(store, { date: '2026-02-01T00:00:00Z' });
    assert.equal(resolveAttribution(store.db, old, { now }).status, 'outside-roster-observation');
    const future = capture(store, { id: '901', date: '2026-09-10T00:00:00Z' });
    assert.equal(resolveAttribution(store.db, future, { now }).status, 'invalid-source-date');
    assert.equal(resolveAttribution(store.db, future, { now: Date.parse('2026-09-10T01:00:00Z') }).status, 'outside-roster-observation');
  } finally { store.close(); }
});

test('new roster snapshots can remove eligibility and cannot be replaced by older publications', () => {
  const store = openStore();
  try {
    importRoster(store.db, snapshot(), { now }); verifyAccountBinding(store.db, binding(), { now });
    const other = { ...member, memberId: 'T000002', name: 'Another Synthetic Member' };
    importRoster(store.db, snapshot({ id: 'b'.repeat(64), retrievedAt: '2026-09-08T00:15:00Z', members: [other] }), { now });
    const p = capture(store, { date: '2026-09-08T00:20:00Z' });
    assert.equal(resolveAttribution(store.db, p, { now }).status, 'outside-verified-membership');
    assert.throws(() => importRoster(store.db, snapshot({ publishedOn: '2026-09-06', retrievedAt: '2026-09-08T00:25:00Z' }), { now }), /older publication/);
  } finally { store.close(); }
});

test('unverified records at the front of the queue do not starve verified captures', () => {
  const store = openStore();
  try {
    importRoster(store.db, snapshot(), { now }); verifyAccountBinding(store.db, binding(), { now });
    capture(store, { id: '1', authorId: '999' }); capture(store, { id: '2' });
    assert.equal(promoteCaptured(store, { limit: 1, now }).awaitingVerification, 1);
    assert.equal(promoteCaptured(store, { limit: 1, now: now + 1 }).promoted, 1);
  } finally { store.close(); }
});

test('promotion storage failure rolls back attribution and analysis jobs without losing capture', () => {
  const store = openStore();
  try {
    importRoster(store.db, snapshot(), { now }); verifyAccountBinding(store.db, binding(), { now }); capture(store);
    store.db.exec("CREATE TRIGGER synthetic_write_failure BEFORE UPDATE OF attribution_json ON posts BEGIN SELECT RAISE(ABORT,'Synthetic storage failure'); END");
    assert.throws(() => promoteCaptured(store, { now }), /Synthetic storage failure/);
    assert.equal(store.getPost('900'), null);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM analysis_jobs').get().n, 0);
    assert.equal(store.db.prepare('SELECT status FROM captured_posts').get().status, 'awaiting-roster');
    store.db.exec('DROP TRIGGER synthetic_write_failure');
    assert.equal(promoteCaptured(store, { now }).promoted, 1);
  } finally { store.close(); }
});
