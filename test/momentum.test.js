import test from 'node:test';
import assert from 'node:assert/strict';
import { momentum } from '../src/momentum.js';
import { incidentKey, statusOf, groupIncidents } from '../src/incidents.js';
import { oneTokenEdit, clusterFamilies } from '../src/sitedata.js';

const steady = (c) => ({ c, trend: [10, 10, 10, 10, 10, 10, 10], d: 0, m: 5, mAvg: 5, eng: 100, epAvg: 100 / (c.reduce((a, b) => a + b, 0) || 1) });

test('momentum: steady single-caucus topic scores 45 (spread drags below 50)', () => {
  // volume/accel/adoption/engLift all neutral (0.5); spread 0 for one caucus:
  // 100 * (0.4·.5 + 0.2·.5 + 0.2·.5 + 0.1·0 + 0.1·.5) = 45
  assert.equal(momentum(steady([10, 0, 0])).score, 45);
});

test('momentum: steady evenly-spread topic scores 55', () => {
  // eff = every caucus → spread 1 → +10 over the single-caucus case,
  // whether the roster has 3 caucuses or 5 (spread = (eff-1)/(K-1))
  const m3 = momentum(steady([10, 10, 10]));
  assert.equal(m3.score, 55);
  assert.equal(m3.eff, 3);
  const m5 = momentum(steady([10, 10, 10, 10, 10]));
  assert.equal(m5.score, 55);
  assert.equal(Math.round(m5.eff * 1000) / 1000, 5);
  assert.equal(momentum(steady([10, 0, 0, 0, 0])).score, 45);
});

test('phrase families: one-token edits and head-noun containment merge', () => {
  assert.ok(oneTokenEdit(['premium', 'spikes'], ['premium', 'spike']));
  assert.ok(oneTokenEdit(['keep', 'the', 'government', 'open'], ['keep', 'government', 'open']));
  assert.ok(!oneTokenEdit(['big', 'ugly', 'bill'], ['tax', 'scam', 'bill']));
  const fams = clusterFamilies(['premium spikes', 'premium spike', 'affordable care act', 'the affordable care act', 'billionaire giveaway']);
  assert.equal(fams.length, 3);
  const spikes = fams.find((f) => f.includes('premium spikes'));
  assert.ok(spikes.includes('premium spike'));
  const aca = fams.find((f) => f.includes('affordable care act'));
  assert.ok(aca.includes('the affordable care act'), 'containment with same head noun merges');
});

test('momentum: surging topic saturates volume and beats steady', () => {
  const surge = { c: [30, 30, 30], trend: [10, 10, 12, 15, 20, 40, 90], d: 220, m: 15, mAvg: 5, eng: 3000, epAvg: 20 };
  const m = momentum(surge);
  assert.ok(m.score > 80, `expected >80, got ${m.score}`);
  assert.equal(m.drivers[0][0] === 'volume' || m.drivers[1][0] === 'volume', true);
});

test('momentum: collapsing topic scores well under 50', () => {
  const dying = { c: [2, 0, 0], trend: [50, 40, 30, 20, 10, 5, 2], d: -90, m: 1, mAvg: 10, eng: 4, epAvg: 100 };
  assert.ok(momentum(dying).score < 30);
});

test('incidentKey normalizes kind + place variants', () => {
  assert.equal(incidentKey('Flooding', 'Aurora, CO'), incidentKey('flooding', 'aurora co'));
});

test('statusOf lifecycle: active → monitoring → resolved', () => {
  const now = Date.now();
  assert.equal(statusOf(new Date(now - 1 * 3600e3).toISOString(), now), 'active');
  assert.equal(statusOf(new Date(now - 20 * 3600e3).toISOString(), now), 'monitoring');
  assert.equal(statusOf(new Date(now - 40 * 3600e3).toISOString(), now), 'resolved');
});

test('groupIncidents merges same-event flags and builds the timeline', () => {
  const now = Date.now();
  const iso = (hoursAgo) => new Date(now - hoursAgo * 3600e3).toISOString();
  const flags = { a: { kind: 'flooding', place: 'Aurora, CO' }, b: { kind: 'flooding', place: 'aurora co' }, c: { kind: 'wildfire', place: 'Banning, CA' } };
  const posts = new Map([
    ['a', { id: 'a', authorId: 'u1', createdAt: iso(5), text: 'first', engN: 100, capturedAt: 'p1' }],
    ['b', { id: 'b', authorId: 'u2', createdAt: iso(2), text: 'second', engN: 50, capturedAt: 'p2' }],
    ['c', { id: 'c', authorId: 'u1', createdAt: iso(50), text: 'old fire', engN: 10, capturedAt: 'p0' }]
  ]);
  const authors = { u1: { handle: 'RepA', member: 'Rep A', stateDistrict: 'CO-06' }, u2: { handle: 'RepB', member: 'Rep B', stateDistrict: 'CO-07' } };
  const out = groupIncidents(flags, posts, authors, { now, lastPollAt: 'p2' });
  assert.equal(out.length, 2);
  const flood = out.find((i) => i.kind === 'flooding');
  assert.equal(flood.updates, 2);
  assert.equal(flood.handle, '@RepA'); // earliest poster leads
  assert.equal(flood.place, 'Aurora, CO · CO-06');
  assert.deepEqual(flood.others, ['@RepB']);
  assert.equal(flood.status, 'active');
  assert.equal(flood.timeline[1].isNew, true); // captured in the latest poll
  const fire = out.find((i) => i.kind === 'wildfire');
  assert.equal(fire.status, 'resolved');
});
