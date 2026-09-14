import test from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_PILOT_CASES, fingerprintEventPosts, loadEventPilot } from '../src/event-pilot.js';

const NOW = '2026-09-14T18:00:00.000Z';
const ids = EVENT_PILOT_CASES.flatMap((item) => [...item.expectedIds, ...item.negativeIds]);
// Synthetic dependency data tests contracts; production selection contains
// only the fixed IDs resolved from real public archives by the loader.
function fixture() {
  const rows = ids.map((id, index) => ({ id, authorId: String(index + 1), createdAt: '2026-09-14T14:00:00.000Z',
    capturedAt: '2026-09-14T14:01:00.000Z', type: 'tweet', text: `Synthetic public fixture ${index} with Unicode\u2028line separator.` }));
  const authorsById = Object.fromEntries(rows.map((row, index) => [row.authorId, { member: `Fixture Member ${index}`, status: 'house' }]));
  const interpretation = { assignments: Object.fromEntries(ids.map((id) => [id, [['tech', 'ai-policy']]])) };
  const taxonomy = { tech: { label: 'Technology', subtopics: { 'ai-policy': { label: 'AI policy' } } } };
  const opts = { runAsOf: NOW, loadPosts: (date) => date === '2026-09-14' ? rows : [],
    loadInterpretation: () => interpretation, authorsById, taxonomy, quotedStore: {},
    loadEvidence: async () => ({ byPost: {}, version: 5 }) };
  return { rows, authorsById, interpretation, taxonomy, opts };
}

const evidence = (extra = {}) => ({ id: 'n_fixture', publisher: 'Public Fixture', title: 'Specific public event',
  url: 'https://fixture.example.test/event', text: 'Exact supplied evidence passage.', kind: 'report',
  publishedAt: '2026-09-14T15:00:00.000Z', fetchedAt: '2026-09-14T16:00:00.000Z', version: 5, ...extra });

test('fixed pilot cases are bounded, immutable and keep reviewer answers outside post inputs', async () => {
  assert.equal(EVENT_PILOT_CASES.length, 2);
  assert.equal(EVENT_PILOT_CASES[0].expectedIds.length, 4);
  assert.ok(EVENT_PILOT_CASES.every((item) => item.expectedIds.length + item.negativeIds.length <= 24));
  assert.throws(() => EVENT_PILOT_CASES[0].expectedIds.push('9'), TypeError);
  const { opts } = fixture();
  const result = await loadEventPilot(opts);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.plans.map((plan) => plan.posts.length), [7, 4]);
  assert.ok(result.plans.every((plan) => plan.ready && plan.runAsOf === NOW && plan.mode === 'retrospective'));
  for (const post of result.plans.flatMap((plan) => plan.posts)) {
    assert.ok(!('expectedIds' in post) && !('negativeIds' in post));
    assert.ok(post.text.includes('\u2028'));
    assert.match(post.personId, /^member:/);
  }
});

test('accepted empty classifications remain eligible; missing, pending and corrected rows are excluded explicitly', async () => {
  const { opts, interpretation } = fixture();
  interpretation.assignments[ids[0]] = [];
  delete interpretation.assignments[ids[1]];
  interpretation.pendingIds = [ids[2]];
  interpretation.corrected = { [ids[3]]: { by: 'reviewer', event: 'human decision' } };
  const result = await loadEventPilot(opts);
  assert.deepEqual(result.plans[0].posts.find((post) => post.id === ids[0]).topics, []);
  assert.deepEqual(result.plans[0].diagnostics.map(({ id, reason }) => [id, reason]), [
    [ids[1], 'interpretation-pending'], [ids[2], 'interpretation-pending'], [ids[3], 'human-corrected']
  ]);
  assert.equal(result.plans[0].ready, false);
  assert.ok(!JSON.stringify(result).includes('human decision'), 'correction contents are not public pilot input');
});

test('unknown and non-House members cannot become pilot participants; same member keeps one identity', async () => {
  const { opts, rows, authorsById } = fixture();
  authorsById[rows[1].authorId] = { member: '  Fixture   Member 0  ', status: 'house' };
  delete authorsById[rows[2].authorId];
  authorsById[rows[3].authorId].status = 'senate';
  const { plans } = await loadEventPilot(opts);
  assert.equal(plans[0].posts[0].personId, plans[0].posts[1].personId);
  assert.equal(plans[0].diagnostics.filter((item) => item.reason === 'member-unknown-or-out-of-scope').length, 2);
});

test('quote and repost context preserve exact text, source identity and known timestamps without raw payloads', async () => {
  const { opts, rows } = fixture();
  rows[0].type = 'quote'; rows[0].refId = '900';
  rows[0].quoted = { id: '900', authorId: '901', handle: 'public_source', text: 'Long quoted source. '.repeat(70),
    createdAt: '2026-09-13T15:00:00Z', fetchedAt: '2026-09-14T14:01:00Z', privatePayload: 'must not copy' };
  rows[1].reposted = { id: '902', handle: 'original', text: 'Complete original source.', createdAt: '2026-09-14T13:00:00Z', source: { raw: 'omit' } };
  const { plans } = await loadEventPilot(opts);
  assert.equal(plans[0].posts[0].quoting.text, rows[0].quoted.text);
  assert.equal(plans[0].posts[0].quoting.createdAt, rows[0].quoted.createdAt);
  assert.equal(plans[0].posts[1].reposted.createdAt, rows[1].reposted.createdAt);
  assert.ok(!JSON.stringify(plans[0].posts).includes('must not copy'));
  assert.ok(!('source' in plans[0].posts[1].reposted));
});

test('incomplete reposts stay in the fixed control bundle as explicit coverage gaps', async () => {
  const { opts, rows } = fixture();
  const target = rows.find((row) => row.id === EVENT_PILOT_CASES[1].negativeIds[1]);
  target.type = 'retweet'; target.text = 'RT @source: The event was…'; target.refId = '900';
  const { plans } = await loadEventPilot(opts);
  const retained = plans[1].posts.find((row) => row.id === target.id);
  assert.equal(plans[1].ready, true, 'a known abstention control does not silently shrink or disable the fixture');
  assert.equal(retained.type, 'retweet');
  assert.equal(retained.sourceIncomplete, true);
  assert.deepEqual(retained.sourceIncompleteReasons, ['repost-original-unavailable']);
  assert.equal(retained.text, target.text);
  assert.equal(retained.reposted, undefined);
  assert.notEqual(fingerprintEventPosts([retained]).sourceHash, fingerprintEventPosts([{ ...retained, sourceIncomplete: false }]).sourceHash);
});

test('context acquired after runAsOf cannot leak into retrospective or historical model input', async () => {
  for (const mode of ['retrospective', 'as-of']) {
    const { opts, rows } = fixture();
    opts.mode = mode;
    rows[0].type = 'quote'; rows[0].refId = '900';
    opts.quotedStore = { '900': { text: 'Later context that must not be visible.', fetchedAt: '2026-09-14T18:01:00Z' } };
    rows[1].type = 'retweet';
    rows[1].reposted = { id: '901', text: 'Another future context.', capturedAt: '2026-09-14T18:01:00Z' };
    const { plans } = await loadEventPilot(opts);
    assert.equal(plans[0].posts[0].quoting, undefined);
    assert.equal(plans[0].posts[1].reposted, undefined);
    assert.ok(plans[0].posts.slice(0, 2).every((row) => row.sourceIncomplete));
    assert.ok(!JSON.stringify(plans[0].posts).includes('Later context that'));
    assert.ok(!JSON.stringify(plans[0].posts).includes('Another future context'));
  }
});

test('historical context requires acquisition evidence and inline expansions inherit the containing capture time', async () => {
  const { opts, rows } = fixture();
  opts.mode = 'as-of';
  rows[0].type = 'quote'; rows[0].refId = '900';
  rows[0].quoted = { id: '900', text: 'Captured in the same response.' };
  rows[1].type = 'quote'; rows[1].refId = '901';
  opts.quotedStore = { '901': { text: 'Acquisition time unavailable.' } };
  const { plans } = await loadEventPilot(opts);
  assert.equal(plans[0].posts[0].quoting.capturedAt, rows[0].capturedAt);
  assert.equal(plans[0].posts[0].sourceIncomplete, false);
  assert.equal(plans[0].posts[1].quoting, undefined);
  assert.equal(plans[0].posts[1].sourceIncomplete, true);
  assert.deepEqual(plans[0].posts[1].sourceIncompleteReasons, ['quoting-acquisition-unknown']);
});

test('as-of cutoff is the run time, allowing later-than-post evidence but excluding later-than-run evidence', async () => {
  const { opts } = fixture();
  opts.mode = 'as-of';
  opts.loadEvidence = async (posts, context) => {
    assert.equal(context.runAsOf, NOW);
    return { byPost: { [ids[0]]: [evidence()], [ids[1]]: [evidence({ fetchedAt: '2026-09-14T18:00:01Z' })],
      [ids[2]]: [evidence({ publishedAt: '2026-09-14T18:00:01Z' })] }, version: 6 };
  };
  const { plans } = await loadEventPilot(opts);
  assert.equal(plans[0].posts[0].evidence.length, 1);
  assert.equal(plans[0].posts[1].evidence.length, 0);
  assert.equal(plans[0].posts[2].evidence.length, 0);
  assert.equal(plans[0].mode, 'as-of');
});

test('future capture, future post and posts outside the fixed 24-hour evaluation window are excluded', async () => {
  const { opts, rows } = fixture();
  rows[0].capturedAt = '2026-09-14T18:01:00Z';
  rows[1].createdAt = '2026-09-14T18:01:00Z';
  rows[2].createdAt = '2026-09-13T18:00:00Z';
  const { plans } = await loadEventPilot(opts);
  assert.deepEqual(plans[0].diagnostics.map((item) => item.reason), ['source-after-run', 'source-after-run', 'source-outside-24h-window']);
});

test('fingerprints change for source, relevant taxonomy, evidence and correction content, not global refresh clocks', async () => {
  const { opts } = fixture();
  opts.loadEvidence = async () => ({ byPost: { [ids[0]]: [evidence()] }, version: 5 });
  const { plans } = await loadEventPilot(opts);
  const original = plans[0].posts, before = fingerprintEventPosts(original);
  const mutated = () => structuredClone(original);
  let posts = mutated();
  posts[0].contextVersion = 999; posts[0].metrics = { likes: 9999 }; posts[0].evidence[0].bodyFetchedAt = NOW;
  assert.deepEqual(fingerprintEventPosts(posts), before);
  assert.deepEqual(fingerprintEventPosts([...original].reverse()), before);
  for (const change of [
    (p) => { p[0].text += ' Changed.'; },
    (p) => { p[0].taxonomyContext.tech.subtopics['ai-policy'].story = true; },
    (p) => { p[0].evidence[0].text += ' Corrected passage.'; }
  ]) { posts = mutated(); change(posts); assert.notEqual(fingerprintEventPosts(posts).sourceHash, before.sourceHash); }
  posts = mutated(); posts[0].corrected = { revision: 2 };
  assert.notEqual(fingerprintEventPosts(posts).correctionHash, before.correctionHash);
  assert.equal(fingerprintEventPosts(posts).sourceHash, before.sourceHash);
});

test('malformed source data and duplicated evidence fail closed rather than fabricating a fixture', async () => {
  const { opts, rows } = fixture();
  rows.push({ ...rows[0] });
  await assert.rejects(loadEventPilot(opts), /duplicate event pilot source/);
  rows.pop();
  opts.loadEvidence = async () => ({ byPost: { [ids[0]]: [evidence(), evidence()] }, version: 5 });
  await assert.rejects(loadEventPilot(opts), /duplicate evidence/);
  await assert.rejects(loadEventPilot({ ...opts, runAsOf: 'invalid' }), /Invalid event pilot runAsOf/);
  await assert.rejects(loadEventPilot({ ...opts, mode: 'future' }), /Invalid event pilot interpretation mode/);
});
