import test from 'node:test';
import assert from 'node:assert/strict';
import {
  incidentKey, statusOf, groupIncidents, shapeIncident, stateOf, rawPlace, evidenceSpan, verifySpan,
  candidatePosts, planBatches, buildJudgePrompt, JUDGE_SYSTEM, judgmentSha, normalizeJudgment, judgeBatch,
  pickTarget, priorDecisions, corroborate, OPEN_STATUSES, DROP_CATEGORIES
} from '../src/incidents.js';
import { etDate } from '../src/util.js';

// ── fixtures ─────────────────────────────────────────────────────────────
const NOW = Date.parse('2026-09-10T16:00:00Z');
const hoursAgo = (n) => new Date(NOW - n * 3_600_000).toISOString();
const authors = {
  a1: { handle: 'RepSanchez', member: 'Linda Sánchez', stateDistrict: 'CA-38', status: 'house' },
  a2: { handle: 'RepPanetta', member: 'Jimmy Panetta', stateDistrict: 'CA-19', status: 'house' },
  a3: { handle: 'RepSoto', member: 'Darren Soto', stateDistrict: 'FL-09', status: 'house' },
  a4: { handle: 'RepMcCollum', member: 'Betty McCollum', stateDistrict: 'MN-04', status: 'house' },
  a5: { handle: 'RepMrvan', member: 'Frank Mrvan', stateDistrict: 'IN-01', status: 'house' },
  a6: { handle: 'RepTran', member: 'Derek Tran', stateDistrict: 'CA-45', status: 'house' }
};
const post = (id, authorId, text, { age = 2, eng = 10, type = 'tweet', refId = null } = {}) =>
  ({ id, authorId, text, createdAt: hoursAgo(age), engN: eng, type, refId, capturedAt: null });

// A world with: a La Habra hazmat split in two cards under kind synonyms (open),
// a Monterey fire (open) with a Big Sur post on a resolved card (candidate),
// a Miami crash card of four condolence posts (open), and an Indiana storm
// recovery post on a resolved card with no open card in its state.
function world() {
  const posts = [
    post('p1', 'a1', 'LA HABRA RESIDENTS: A hazmat situation has been reported near Cypress Street. Officials have ordered evacuations within a 1-mile radius.', { age: 20 }),
    post('p2', 'a1', 'RT @ocregister: Shelter-in-place order lifted following hazmat incident in La Habra', { age: 18 }),
    post('p3', 'a1', 'RT @ABC7: All-clear given after orange smoke seen rising from chemical leak at La Habra factory', { age: 18 }),
    post('p4', 'a2', 'Plaskett is now 61% contained and Timber is at 27%. More than 3,700 personnel are supporting the fight in Monterey County.', { age: 6 }),
    post('p5', 'a2', 'Part of Highway 1 is reopen for Big Sur businesses and residents. Continue to use caution in the affected areas.', { age: 50 }),
    post('p6', 'a3', 'What a tragedy. Praying for the families of those who perished at Miami Airport.', { age: 30 }),
    post('p7', 'a4', 'It is devastating to see the loss of five lives as a result of the Amazon plane that over ran the runway at Miami International Airport.', { age: 8 }),
    post('p8', 'a5', 'As we continue in the storm recovery, I wanted to share information on assistance now available from the City of Gary for the August storm.', { age: 40 })
  ];
  const flags = {
    p1: { kind: 'hazmat release', place: 'La Habra, CA' },
    p2: { kind: 'chemical leak', place: 'La Habra, CA' },
    p3: { kind: 'chemical leak', place: 'La Habra, CA' },
    p4: { kind: 'wildfire', place: 'Monterey County, CA' },
    p5: { kind: 'wildfire', place: 'Big Sur, CA' },
    p6: { kind: 'plane crash', place: 'Miami, FL' },
    p7: { kind: 'plane crash', place: 'Miami, FL' },
    p8: { kind: 'storm damage', place: 'Gary, IN' }
  };
  const postsById = new Map(posts.map((x) => [x.id, x]));
  const incidents = groupIncidents(flags, postsById, authors, { now: NOW });
  return { posts, flags, postsById, incidents };
}

const stubClient = (reply, log = []) => ({
  messages: {
    create: async (req) => {
      log.push(req);
      const text = typeof reply === 'function' ? reply(req) : reply;
      return { stop_reason: text == null ? 'refusal' : 'end_turn', content: text == null ? [] : [{ type: 'text', text }], usage: { input_tokens: 2000, output_tokens: 150 } };
    }
  }
});

// The judge's verdict on the world above: the two La Habra cards are one
// event; the Big Sur post is the Monterey fire; the Miami posts are
// reactions; the Gary post is aftermath.
const VERDICT = JSON.stringify({
  groups: [
    { incidents: ['la-habra-ca--hazmat-release', 'la-habra-ca--chemical-leak'], posts: [], reason: 'Same 8 Sept La Habra hazmat evacuation; "chemical leak" and "hazmat release" name one event', evidence: { post: 'p3', span: 'chemical leak at La Habra factory' } },
    { incidents: ['monterey-county-ca--wildfire'], posts: ['p5'], reason: 'Big Sur is inside Monterey County; the Highway 1 reopening is the Timber/Plaskett fires', evidence: { post: 'p5', span: 'Highway 1 is reopen for Big Sur' } }
  ],
  drops: [
    { post: 'p6', category: 'reaction', reason: 'Condolences from a Central Florida member; no instructions or office engagement', evidence: 'Praying for the families' },
    { post: 'p7', category: 'reaction', reason: 'Reaction from a Minnesota member to a Miami crash', evidence: 'It is devastating to see the loss of five lives' },
    { post: 'p8', category: 'aftermath', reason: 'Recovery assistance for the August storm, weeks later', evidence: 'the August storm' }
  ]
});

// ── grouping (unchanged behaviour) ───────────────────────────────────────
test('groupIncidents keys on the exact kind+place string, so synonyms and neighbouring places split', () => {
  const { incidents } = world();
  assert.equal(incidentKey('Chemical Leak', 'La Habra, CA'), 'la-habra-ca--chemical-leak');
  assert.deepEqual(incidents.map((i) => i.id).sort(), [
    'big-sur-ca--wildfire', 'gary-in--storm-damage', 'la-habra-ca--chemical-leak', 'la-habra-ca--hazmat-release', 'miami-fl--plane-crash', 'monterey-county-ca--wildfire'
  ]);
  const by = Object.fromEntries(incidents.map((i) => [i.id, i]));
  assert.equal(by['la-habra-ca--chemical-leak'].updates, 2);
  assert.equal(by['la-habra-ca--chemical-leak'].status, 'monitoring'); // 18h quiet
  assert.equal(by['monterey-county-ca--wildfire'].status, 'active');
  assert.equal(by['big-sur-ca--wildfire'].status, 'resolved'); // 50h quiet
  assert.equal(by['miami-fl--plane-crash'].place, 'Miami, FL · FL-09');
  assert.deepEqual(by['miami-fl--plane-crash'].others, ['@RepMcCollum']);
  assert.equal(statusOf(hoursAgo(1), NOW), 'active');
  assert.equal(statusOf(hoursAgo(13), NOW), 'monitoring');
  assert.equal(statusOf(hoursAgo(40), NOW), 'resolved');
  // active first, then monitoring, then resolved; newest last-post first within a status
  assert.deepEqual(incidents.map((i) => [i.id, i.status]), [
    ['monterey-county-ca--wildfire', 'active'], ['miami-fl--plane-crash', 'active'], ['la-habra-ca--chemical-leak', 'monitoring'], ['la-habra-ca--hazmat-release', 'monitoring'], ['gary-in--storm-damage', 'resolved'], ['big-sur-ca--wildfire', 'resolved']
  ]);
});

test('shapeIncident marks a merged-in post with its source card on the timeline', () => {
  const { postsById } = world();
  const inc = shapeIncident({ id: 'x', kind: 'wildfire', place: 'Monterey County, CA', posts: [postsById.get('p4'), postsById.get('p5')], from: new Map([['p5', 'big-sur-ca--wildfire']]) }, authors, { now: NOW });
  assert.equal(inc.timeline[0].from, 'big-sur-ca--wildfire'); // p5 is the earlier post
  assert.equal(inc.timeline[1].from, undefined);
  assert.equal(inc.since, postsById.get('p5').createdAt);
});

// ── helpers ──────────────────────────────────────────────────────────────
test('stateOf / rawPlace read the state off the flag place, ignoring the district suffix', () => {
  assert.equal(stateOf('Napa County, CA · CA-04'), 'CA');
  assert.equal(stateOf('Kaʻū, HI'), 'HI');
  assert.equal(stateOf('Orange and LA counties, CA'), 'CA');
  assert.equal(stateOf('district-unspecified'), null);
  assert.equal(rawPlace('Miami, FL · FL-09'), 'Miami, FL');
});

test('evidenceSpan prefers a stored span, else the lead post; verifySpan is verbatim but quote-mark tolerant', () => {
  const { postsById } = world();
  assert.equal(evidenceSpan({ evidence: { span: ' stored  span ' } }, []), 'stored span');
  assert.match(evidenceSpan({}, [postsById.get('p2'), postsById.get('p1')]), /^LA HABRA RESIDENTS/);
  assert.deepEqual(verifySpan('“chemical leak at La Habra”', postsById.get('p3').text), { span: 'chemical leak at La Habra', verified: true });
  assert.deepEqual(verifySpan('a paraphrase', postsById.get('p3').text), { span: 'a paraphrase', verified: false });
});

test('candidatePosts are flagged posts of the last 3 days that sit on no open card, with their origin', () => {
  const { flags, postsById, incidents } = world();
  const work = incidents.map((i) => ({ id: i.id, status: i.status, posts: i.tweetIds.map((id) => postsById.get(id)) }));
  const cands = candidatePosts(flags, postsById, work, { now: NOW, days: 3 });
  assert.deepEqual(cands.map((c) => [c.post.id, c.origin, c.flag.place]), [['p5', 'big-sur-ca--wildfire', 'Big Sur, CA'], ['p8', 'gary-in--storm-damage', 'Gary, IN']]); // oldest first
  // outside the window → not a candidate
  assert.equal(candidatePosts(flags, postsById, work, { now: NOW, days: 1 }).length, 0);
});

test('planBatches keeps a state together, caps cards per call, and lets orphan candidates ride along', () => {
  const card = (id, state, n = 1) => ({ id, kind: 'k', place: `Town, ${state}`, status: 'active', posts: Array.from({ length: n }, (_, i) => post(`${id}-${i}`, 'a1', 't')) });
  const cand = (id, state) => ({ post: post(id, 'a1', 't'), flag: { kind: 'k', place: `Town, ${state}` }, origin: null, neighbor: false });
  const open = [...Array.from({ length: 17 }, (_, i) => card(`ca${i}`, 'CA')), card('fl1', 'FL'), card('hi1', 'HI'), card('nostate', null)];
  open[open.length - 1].place = 'unspecified';
  const cands = [cand('c1', 'CA'), cand('c2', 'IN'), cand('c3', 'FL')];
  const batches = planBatches(open, cands, { batch_incidents: 15, batch_candidates: 40 });
  assert.equal(batches.length, 3);
  assert.ok(batches.every((b) => b.incidents.length <= 15));
  assert.deepEqual(batches.map((b) => [b.states, b.incidents.length]), [[['??'], 1], [['CA'], 15], [['CA', 'FL', 'HI'], 4]]); // a full state chunk is never split across calls; the tail packs with the next states
  const ids = (b) => b.candidates.map((c) => c.post.id);
  assert.ok(ids(batches[1]).includes('c1') && ids(batches[2]).includes('c1')); // a split state offers its candidates to each chunk
  assert.ok(ids(batches[2]).includes('c3'));
  assert.deepEqual(ids(batches[0]), ['c2']); // the Indiana orphan rides in the emptiest call and still gets read
  // an unflagged neighbor travels with its card's state
  const nb = { post: post('n1', 'a2', 'neighbor'), flag: null, origin: null, neighbor: true, incident: 'fl1' };
  const withNb = planBatches([card('fl1', 'FL'), card('ca0', 'CA')], [nb], {});
  assert.deepEqual(withNb[0].candidates.map((c) => c.post.id), ['n1']);
  assert.deepEqual(planBatches([], cands, {}), []);
});

// ── prompt ───────────────────────────────────────────────────────────────
test('buildJudgePrompt shows every card with its evidence span and posts, candidates with their labels, and neighbors marked', () => {
  const { flags, postsById, incidents } = world();
  const open = incidents.filter((i) => OPEN_STATUSES.has(i.status)).map((i) => ({ id: i.id, kind: i.kind, place: rawPlace(i.place), status: i.status, posts: i.tweetIds.map((id) => postsById.get(id)), evidence: null, mergeLog: [] }));
  open[0].status = 'provisional';
  const cands = candidatePosts(flags, postsById, incidents.map((i) => ({ id: i.id, status: i.status, posts: i.tweetIds.map((id) => postsById.get(id)) })), { now: NOW });
  cands.push({ post: { ...post('n1', 'a6', 'Smoke over La Habra this afternoon, avoid Cypress St', { age: 19, type: 'quote', refId: 'q9' }), semanticScore: 0.87 }, flag: null, origin: null, neighbor: true, incident: 'la-habra-ca--hazmat-release' });
  const quotedFor = (x) => (x.refId === 'q9' ? { handle: 'LAHabraPD', text: 'Hazmat incident, evacuations in progress' } : null);
  const prompt = buildJudgePrompt(planBatches(open, cands, {})[0], { authorsById: authors, quotedFor }, { posts_per_incident: 8, candidate_days: 3 });
  assert.match(prompt, /^OPEN CARDS/);
  assert.match(prompt, /\[la-habra-ca--hazmat-release\] hazmat release · La Habra, CA/);
  assert.match(prompt, /provisional \(single post, not yet corroborated\)/);
  assert.match(prompt, /evidence: "LA HABRA RESIDENTS: A hazmat situation/);
  assert.match(prompt, /posts \(2, 1 member\(s\)\):\n {2}- \(p2\) @RepSanchez \(CA-38\) · Sep \d+, \d+:\d\d [AP]M\n {4}"RT @ocregister/);
  assert.match(prompt, /\(p7\) @RepMcCollum \(MN-04\)/);
  assert.match(prompt, /CANDIDATE POSTS — flagged in the last 3 days/);
  assert.match(prompt, /\(p5\) @RepPanetta \(CA-19\) · .* · \[wildfire · Big Sur, CA\] · on resolved card big-sur-ca--wildfire\n {4}"Part of Highway 1/);
  assert.match(prompt, /\(p8\) @RepMrvan \(IN-01\) · .* · \[storm damage · Gary, IN\] · on resolved card gary-in--storm-damage/);
  assert.match(prompt, /\(n1\) @RepTran \(CA-45\) · .* · quote · unflagged neighbor of \[la-habra-ca--hazmat-release\] \(similarity 0\.87\)\n {4}"Smoke over La Habra.*\n {4}↳ quoting @LAHabraPD: "Hazmat incident, evacuations in progress"/);
  assert.match(prompt, /Reply with the JSON object only\.$/);
  assert.match(JUDGE_SYSTEM, /"category": "commemoration\|hypothetical\|national_policy\|aftermath\|reaction"/);
  assert.deepEqual(DROP_CATEGORIES, ['commemoration', 'hypothetical', 'national_policy', 'aftermath', 'reaction']);
  // the cache key is the content asked, and the model
  assert.equal(judgmentSha(prompt, 'm'), judgmentSha(prompt, 'm'));
  assert.notEqual(judgmentSha(prompt, 'm'), judgmentSha(prompt + ' ', 'm'));
  assert.notEqual(judgmentSha(prompt, 'm'), judgmentSha(prompt, 'm2'));
  assert.equal(judgmentSha(prompt, 'm').length, 16);
});

test('buildJudgePrompt shows the first three and latest posts of a long card', () => {
  const posts = Array.from({ length: 12 }, (_, i) => post(`x${i}`, 'a2', `update ${i}`, { age: 24 - i }));
  const prompt = buildJudgePrompt({ incidents: [{ id: 'c', kind: 'wildfire', place: 'Napa County, CA', status: 'active', posts, mergeLog: [] }], candidates: [] }, { authorsById: authors }, { posts_per_incident: 8 });
  assert.match(prompt, /posts \(12, showing 8, 1 member\(s\)\)/);
  assert.match(prompt, /\(x0\)[\s\S]*\(x1\)[\s\S]*\(x2\)[\s\S]*\(x7\)[\s\S]*\(x11\)/);
  assert.doesNotMatch(prompt, /\(x3\)/);
  assert.match(prompt, /CANDIDATE POSTS[^\n]*\n {2}\(none\)/);
});

// ── reply normalisation ──────────────────────────────────────────────────
test('normalizeJudgment keeps only shown ids, resolves conflicts first-wins, lets a drop beat a group, refuses unknown categories, verifies spans', () => {
  const { flags, postsById, incidents } = world();
  const open = incidents.filter((i) => OPEN_STATUSES.has(i.status)).map((i) => ({ id: i.id, kind: i.kind, place: rawPlace(i.place), status: i.status, posts: i.tweetIds.map((id) => postsById.get(id)), mergeLog: [] }));
  const cands = candidatePosts(flags, postsById, incidents.map((i) => ({ id: i.id, status: i.status, posts: i.tweetIds.map((id) => postsById.get(id)) })), { now: NOW });
  const batch = planBatches(open, cands, {})[0];
  const j = normalizeJudgment({
    groups: [
      { incidents: ['la-habra-ca--hazmat-release', 'la-habra-ca--chemical-leak', 'not-a-card'], posts: ['p1', 'nope'], reason: '  same   event ', evidence: { post: 'p3', span: 'chemical leak at La Habra factory' } },
      { incidents: ['la-habra-ca--chemical-leak', 'monterey-county-ca--wildfire'], posts: ['p5'], reason: 'second claim on the same card', evidence: { post: 'p5', span: 'made-up words' } },
      { incidents: ['miami-fl--plane-crash'], posts: ['p8'], reason: 'the drop below wins', evidence: {} },
      { incidents: ['miami-fl--plane-crash'], posts: [], reason: 'one card, no posts: omitted' }
    ],
    drops: [
      { post: 'p8', category: 'Aftermath', reason: 'recovery', evidence: 'the August storm' },
      { post: 'p6', category: 'boring', reason: 'not a vocabulary word' },
      { post: 'p7', category: 'reaction', reason: '' },
      { post: 'zzz', category: 'reaction', reason: 'unknown post' },
      { post: 'p8', category: 'reaction', reason: 'duplicate drop' }
    ]
  }, batch);
  assert.deepEqual(j.drops, [{ post: 'p8', category: 'aftermath', reason: 'recovery', evidence: { post: 'p8', span: 'the August storm', verified: true } }]);
  assert.equal(j.groups.length, 2);
  assert.deepEqual(j.groups[0].incidents, ['la-habra-ca--hazmat-release', 'la-habra-ca--chemical-leak']);
  assert.deepEqual(j.groups[0].posts, []); // p1 is on a card, not a candidate; "nope" is unknown
  assert.equal(j.groups[0].reason, 'same event');
  assert.deepEqual(j.groups[0].evidence, { post: 'p3', span: 'chemical leak at La Habra factory', verified: true });
  assert.deepEqual(j.groups[1].incidents, ['monterey-county-ca--wildfire']); // chemical-leak already used
  assert.deepEqual(j.groups[1].posts, ['p5']);
  assert.equal(j.groups[1].evidence.verified, false); // kept, but says so
  assert.deepEqual(normalizeJudgment(null, batch), { groups: [], drops: [] });
  assert.deepEqual(normalizeJudgment({ groups: 'x', drops: 'y' }, batch), { groups: [], drops: [] });
});

test('judgeBatch sends the system contract and the prompt; a refusal or prose yields no judgment', async () => {
  const { flags, postsById, incidents } = world();
  const open = incidents.filter((i) => OPEN_STATUSES.has(i.status)).map((i) => ({ id: i.id, kind: i.kind, place: rawPlace(i.place), status: i.status, posts: i.tweetIds.map((id) => postsById.get(id)), mergeLog: [] }));
  const batch = planBatches(open, [], {})[0];
  const log = [];
  const r = await judgeBatch(batch, { authorsById: authors }, { client: stubClient('Here you go:\n' + VERDICT, log), model: 'test-model', cfg: { posts_per_incident: 8, candidate_days: 3 } });
  assert.equal(log.length, 1);
  assert.equal(log[0].model, 'test-model');
  assert.equal(log[0].system, JUDGE_SYSTEM);
  assert.match(log[0].messages[0].content, /^OPEN CARDS/);
  assert.deepEqual(r.usage, { input: 2000, output: 150 });
  assert.equal(r.why, null);
  assert.equal(r.judgment.groups.length, 1); // the Big Sur group needs a candidate that this batch did not carry
  assert.equal(r.judgment.drops.length, 2); // p8 was not shown
  assert.equal((await judgeBatch(batch, {}, { client: stubClient(null), model: 'm' })).judgment, null);
  const bad = await judgeBatch(batch, {}, { client: stubClient('I cannot tell.'), model: 'm' });
  assert.equal(bad.judgment, null);
  assert.match(bad.why, /did not parse/);
});

test('pickTarget keeps the fuller card, then the earlier, then the lower id', () => {
  const c = (id, n, age) => ({ id, posts: Array.from({ length: n }, (_, i) => post(`${id}${i}`, 'a1', 't', { age: age + i })) });
  assert.equal(pickTarget([c('b', 1, 1), c('a', 3, 1)]).id, 'a');
  assert.equal(pickTarget([c('b', 2, 5), c('a', 2, 1)]).id, 'b'); // b's earliest post is older
  assert.equal(pickTarget([c('b', 2, 1), c('a', 2, 1)]).id, 'a');
});

// ── the run ──────────────────────────────────────────────────────────────
test('corroborate applies the judge\'s groups and drops: duplicate cards merge, a candidate joins its event, reactions and aftermath are set aside, every step logged with reason and span', async () => {
  const { flags, postsById, incidents } = world();
  const log = [];
  const r = await corroborate(incidents, { flags, postsById, authorsById: authors, client: stubClient(VERDICT, log), model: 'm', now: NOW, cfg: { candidate_days: 3, batch_incidents: 15, batch_candidates: 40, posts_per_incident: 8, neighbors_per_incident: 5, daily_calls: 100, cache_days: 14 } });
  assert.equal(log.length, 1);
  assert.deepEqual({ ...r.stats, skipped: undefined, failed: undefined }, { batches: 1, asked: 1, cached: 0, merges: 2, drops: 3, reapplied: 0, candidates: 2, neighbors: 0, skipped: undefined, failed: undefined });
  const by = Object.fromEntries(r.incidents.map((i) => [i.id, i]));
  assert.deepEqual(Object.keys(by).sort(), ['la-habra-ca--chemical-leak', 'monterey-county-ca--wildfire']);

  // duplicate merge: the two-post card survives, the one-post card folds in
  const lh = by['la-habra-ca--chemical-leak'];
  assert.equal(lh.updates, 3);
  assert.deepEqual(lh.tweetIds, ['p1', 'p2', 'p3']);
  assert.equal(lh.since, postsById.get('p1').createdAt);
  assert.equal(lh.mergeLog.length, 1);
  assert.deepEqual({ ...lh.mergeLog[0], at: undefined }, { merged_from: 'la-habra-ca--hazmat-release', kind: 'hazmat release', place: 'La Habra, CA', posts: ['p1'], reason: 'Same 8 Sept La Habra hazmat evacuation; "chemical leak" and "hazmat release" name one event', evidence: { post: 'p3', span: 'chemical leak at La Habra factory', verified: true }, via: 'card', at: undefined });
  assert.equal(lh.mergeLog[0].at, new Date(NOW).toISOString());
  assert.equal(lh.timeline[0].from, 'la-habra-ca--hazmat-release'); // p1 is earliest and came in through the merge
  assert.equal(lh.timeline[1].from, undefined);
  assert.deepEqual(lh.sources, [{ id: 'la-habra-ca--hazmat-release', kind: 'hazmat release', place: 'La Habra, CA', via: 'card', posts: 1, reason: lh.mergeLog[0].reason, at: lh.mergeLog[0].at }]);
  assert.deepEqual(lh.corroboration, { members: 1, posts: 3, merged: 1, status: 'single-source', reason: lh.mergeLog[0].reason, evidence: lh.mergeLog[0].evidence, judged: true, advanced: null });
  assert.equal(lh.status, 'monitoring'); // the lifecycle is still measured from the last post
  assert.equal(lh.engN, 30); // measured numbers follow the posts

  // candidate joins its event; the resolved card it sat on is emptied and gone
  const mc = by['monterey-county-ca--wildfire'];
  assert.deepEqual(mc.tweetIds, ['p5', 'p4']);
  assert.equal(mc.mergeLog[0].merged_from, 'big-sur-ca--wildfire');
  assert.equal(mc.mergeLog[0].via, 'post');
  assert.deepEqual(mc.mergeLog[0].posts, ['p5']);
  assert.equal(mc.timeline[0].from, 'big-sur-ca--wildfire');
  assert.equal(mc.corroboration.reason, 'Big Sur is inside Monterey County; the Highway 1 reopening is the Timber/Plaskett fires');

  // drops: the Miami card lost both posts and is gone; Gary's post is set aside off its resolved card
  assert.deepEqual(r.dropped.map((d) => [d.tweetId, d.incidentId, d.handle, d.category]), [
    ['p6', 'miami-fl--plane-crash', '@RepSoto', 'reaction'], ['p7', 'miami-fl--plane-crash', '@RepMcCollum', 'reaction'], ['p8', 'gary-in--storm-damage', '@RepMrvan', 'aftermath']
  ]);
  assert.deepEqual(r.dropped[2].evidence, { post: 'p8', span: 'the August storm', verified: true });
  assert.equal(r.dropped[0].reason, 'Condolences from a Central Florida member; no instructions or office engagement');

  // cache + ledger
  const day = etDate(new Date(NOW));
  assert.deepEqual(r.cacheFile.ledger[day], { calls: 1, inputTokens: 2000, outputTokens: 150 });
  const entries = Object.values(r.cacheFile.cache);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].incidents, ['monterey-county-ca--wildfire', 'la-habra-ca--chemical-leak', 'la-habra-ca--hazmat-release', 'miami-fl--plane-crash']);
  assert.deepEqual(entries[0].candidates, ['p5', 'p8']);
  assert.equal(entries[0].judgment.groups.length, 2);

  // the same content again → served from the cache, nothing billed, same result
  const again = await corroborate(incidents, { flags, postsById, authorsById: authors, client: stubClient(VERDICT, log), model: 'm', now: NOW + 60_000, cache: r.cacheFile });
  assert.equal(log.length, 1);
  assert.equal(again.stats.cached, 1);
  assert.equal(again.stats.asked, 0);
  assert.deepEqual(again.incidents.map((i) => [i.id, i.updates]), r.incidents.map((i) => [i.id, i.updates]));
  assert.equal(again.cacheFile.ledger[day].calls, 1);
  // --force asks again
  const forced = await corroborate(incidents, { flags, postsById, authorsById: authors, client: stubClient(VERDICT, log), model: 'm', now: NOW, cache: r.cacheFile, force: true });
  assert.equal(log.length, 2);
  assert.equal(forced.stats.asked, 1);
});

test('corroborate re-applies earlier merges and drops from data/incidents.json before asking, so cards stay stable without a client', async () => {
  const { flags, postsById, incidents } = world();
  const first = await corroborate(incidents, { flags, postsById, authorsById: authors, client: stubClient(VERDICT), model: 'm', now: NOW });
  const prevFile = { incidents: first.incidents, dropped: first.dropped };
  const prior = priorDecisions(prevFile);
  assert.deepEqual(prior.merges.map((m) => [m.target, m.merged_from, m.posts]), [
    ['monterey-county-ca--wildfire', 'big-sur-ca--wildfire', ['p5']], ['la-habra-ca--chemical-leak', 'la-habra-ca--hazmat-release', ['p1']]
  ]);
  assert.equal(prior.drops.length, 3);

  // A fresh string grouping (the split is back) + the previous file, no client: the judge's decisions hold.
  const fresh = groupIncidents(flags, postsById, authors, { now: NOW + 3_600_000 });
  assert.equal(fresh.length, 6);
  const sticky = await corroborate(fresh, { flags, postsById, authorsById: authors, prev: prevFile, client: null, model: 'm', now: NOW + 3_600_000 });
  assert.equal(sticky.stats.reapplied, 5); // 3 drops + 2 merges
  assert.equal(sticky.stats.asked, 0);
  assert.deepEqual(sticky.stats.skipped.map((s) => s.why), ['no Claude client']);
  assert.deepEqual(sticky.incidents.map((i) => [i.id, i.updates]).sort(), [['la-habra-ca--chemical-leak', 3], ['monterey-county-ca--wildfire', 2]]);
  const lh = sticky.incidents.find((i) => i.id === 'la-habra-ca--chemical-leak');
  assert.equal(lh.mergeLog[0].sticky, true);
  assert.equal(lh.mergeLog[0].reason, first.incidents.find((i) => i.id === 'la-habra-ca--chemical-leak').mergeLog[0].reason);
  assert.equal(lh.mergeLog[0].at, new Date(NOW).toISOString()); // the original judgment's time is kept
  assert.equal(lh.corroboration.judged, false); // nobody read the merged card this run
  assert.deepEqual(sticky.dropped.map((d) => [d.tweetId, d.sticky]), [['p6', true], ['p7', true], ['p8', true]]);

  // A card that folded into a target which later folded into a third card: the chain resolves.
  const chained = { incidents: [{ id: 'monterey-county-ca--wildfire', mergeLog: [{ merged_from: 'la-habra-ca--chemical-leak', posts: ['p2', 'p3'], reason: 'r1' }, { merged_from: 'big-sur-ca--wildfire', posts: ['p5'], reason: 'r2' }] }, { id: 'la-habra-ca--chemical-leak', mergeLog: [{ merged_from: 'la-habra-ca--hazmat-release', posts: ['p1'], reason: 'r0' }] }] };
  const chain = await corroborate(groupIncidents(flags, postsById, authors, { now: NOW }), { flags, postsById, authorsById: authors, prev: chained, client: null, now: NOW });
  const mc = chain.incidents.find((i) => i.id === 'monterey-county-ca--wildfire');
  assert.deepEqual(mc.tweetIds, ['p5', 'p1', 'p2', 'p3', 'p4']); // chronological
  assert.ok(!chain.incidents.some((i) => i.id.startsWith('la-habra')));
});

test('a provisional card advances to the live lifecycle when a second member corroborates it, and not when only its own member adds a post', async () => {
  const p1 = post('h1', 'a1', 'LA HABRA RESIDENTS: hazmat situation reported near Cypress Street, evacuations within a 1-mile radius.', { age: 3 });
  const p2 = post('h2', 'a6', 'Orange County neighbors: La Habra hazmat evacuation under way near Cypress St — avoid the area.', { age: 2 });
  const p3 = post('h3', 'a1', 'Update: the La Habra hazmat evacuation zone has been narrowed.', { age: 1 });
  const postsById = new Map([p1, p2, p3].map((x) => [x.id, x]));
  const flags = { h1: { kind: 'hazmat', place: 'La Habra, CA' }, h2: { kind: 'chemical leak', place: 'Orange County, CA' }, h3: { kind: 'hazmat release', place: 'La Habra, CA' } };
  const incidents = groupIncidents(flags, postsById, authors, { now: NOW });
  // The provisional build marks single-post cards; simulate it.
  for (const i of incidents) i.status = 'provisional';
  const reply = (req) => JSON.stringify({
    groups: [{ incidents: ['la-habra-ca--hazmat', 'orange-county-ca--chemical-leak', 'la-habra-ca--hazmat-release'], posts: [], reason: 'One La Habra hazmat evacuation on Cypress Street, reported by two members', evidence: { post: 'h2', span: 'La Habra hazmat evacuation under way' } }],
    drops: []
  });
  const r = await corroborate(incidents, { flags, postsById, authorsById: authors, client: stubClient(reply), model: 'm', now: NOW });
  assert.equal(r.incidents.length, 1);
  const card = r.incidents[0];
  assert.equal(card.id, 'la-habra-ca--hazmat'); // all single-post: the earliest wins
  assert.equal(card.status, 'active');
  assert.deepEqual(card.corroboration, { members: 2, posts: 3, merged: 2, status: 'corroborated', reason: 'One La Habra hazmat evacuation on Cypress Street, reported by two members', evidence: { post: 'h2', span: 'La Habra hazmat evacuation under way', verified: true }, judged: true, advanced: 'provisional→active' });
  assert.deepEqual(card.others, ['@RepTran']);

  // Same member only → stays provisional, but the merge is logged.
  const own = groupIncidents({ h1: flags.h1, h3: flags.h3 }, postsById, authors, { now: NOW });
  for (const i of own) i.status = 'provisional';
  const r2 = await corroborate(own, { flags: { h1: flags.h1, h3: flags.h3 }, postsById, authorsById: authors, client: stubClient(JSON.stringify({ groups: [{ incidents: ['la-habra-ca--hazmat', 'la-habra-ca--hazmat-release'], posts: [], reason: 'same evacuation', evidence: { post: 'h3', span: 'La Habra hazmat evacuation zone' } }], drops: [] })), model: 'm', now: NOW });
  assert.equal(r2.incidents.length, 1);
  assert.equal(r2.incidents[0].status, 'provisional');
  assert.equal(r2.incidents[0].corroboration.status, 'single-source');
  assert.equal(r2.incidents[0].corroboration.advanced, null);
  assert.equal(r2.incidents[0].mergeLog.length, 1);
});

test('an unflagged semantic neighbor is offered to the judge as such and joins the card when judged the same event', async () => {
  const { flags, postsById, incidents } = world();
  const nb = post('n1', 'a6', 'Neighbors near Cypress St in La Habra: the hazmat evacuation order is lifted, thank you to first responders.', { age: 17 });
  const seen = [];
  const neighbors = async (w, { exclude, limit }) => { seen.push([w.id, limit, exclude.has('p1')]); return w.id === 'la-habra-ca--hazmat-release' ? [nb] : []; };
  const log = [];
  const reply = (req) => {
    assert.match(req.messages[0].content, /\(n1\) @RepTran \(CA-45\) · .* · unflagged neighbor of \[la-habra-ca--hazmat-release\]/);
    return JSON.stringify({ groups: [{ incidents: ['la-habra-ca--hazmat-release'], posts: ['n1'], reason: 'Same La Habra hazmat evacuation, from a neighbouring member', evidence: { post: 'n1', span: 'the hazmat evacuation order is lifted' } }], drops: [] });
  };
  const r = await corroborate(incidents, { flags, postsById, authorsById: authors, client: stubClient(reply, log), model: 'm', now: NOW, neighbors, cfg: { candidate_days: 3, batch_incidents: 15, batch_candidates: 40, posts_per_incident: 8, neighbors_per_incident: 3, daily_calls: 100, cache_days: 14 } });
  assert.ok(seen.every(([, limit, excluded]) => limit === 3 && excluded));
  assert.equal(r.stats.neighbors, 1);
  const card = r.incidents.find((i) => i.id === 'la-habra-ca--hazmat-release');
  assert.deepEqual(card.tweetIds, ['p1', 'n1']);
  assert.equal(card.corroboration.members, 2);
  assert.equal(card.corroboration.status, 'corroborated');
  assert.deepEqual({ ...card.mergeLog[0], at: undefined, reason: undefined, evidence: undefined }, { merged_from: null, kind: null, place: null, posts: ['n1'], via: 'neighbor', at: undefined, reason: undefined, evidence: undefined });
  assert.equal(card.timeline[1].from, 'unflagged neighbor');
  assert.deepEqual(card.sources, [{ id: null, kind: null, place: null, via: 'neighbor', posts: 1, reason: 'Same La Habra hazmat evacuation, from a neighbouring member', at: card.mergeLog[0].at }]);
});

test('corroborate honours the daily ceiling and keeps cards untouched when the reply fails; nothing is judged without a client', async () => {
  const { flags, postsById, incidents } = world();
  const day = etDate(new Date(NOW));
  const capped = await corroborate(incidents, { flags, postsById, authorsById: authors, client: stubClient(VERDICT), model: 'm', now: NOW, cache: { cache: {}, ledger: { [day]: { calls: 5, inputTokens: 1, outputTokens: 1 } } }, cfg: { candidate_days: 3, batch_incidents: 15, batch_candidates: 40, posts_per_incident: 8, neighbors_per_incident: 5, daily_calls: 5, cache_days: 14 } });
  assert.equal(capped.stats.asked, 0);
  assert.match(capped.stats.skipped[0].why, /daily ceiling 5 reached/);
  assert.equal(capped.incidents.length, 6);
  assert.ok(capped.incidents.every((i) => i.corroboration.judged === false && i.mergeLog.length === 0));
  assert.equal(capped.cacheFile.ledger[day].calls, 5);

  const failing = await corroborate(incidents, { flags, postsById, authorsById: authors, client: stubClient('nonsense'), model: 'm', now: NOW });
  assert.equal(failing.stats.failed.length, 1);
  assert.equal(failing.incidents.length, 6);
  assert.equal(failing.cacheFile.ledger[day].calls, 1); // a failed call is still billed and ledgered
  assert.equal(Object.keys(failing.cacheFile.cache).length, 0); // and never cached

  const none = await corroborate(incidents, { flags, postsById, authorsById: authors, client: null, now: NOW });
  assert.equal(none.stats.batches, 1);
  assert.deepEqual(none.stats.skipped, [{ batch: 'CA+FL (4 card(s), 2 candidate(s))', why: 'no Claude client' }]);
  assert.equal(none.incidents.length, 6);
  // measured shape is intact and the judgment slot says "not judged"
  const mc = none.incidents.find((i) => i.id === 'monterey-county-ca--wildfire');
  assert.deepEqual(mc.corroboration, { members: 1, posts: 1, merged: 0, status: 'single-source', reason: null, evidence: null, judged: false, advanced: null });
  assert.deepEqual(mc.sources, []);
  // stale cache entries are pruned
  const old = await corroborate(incidents, { flags, postsById, authorsById: authors, client: null, now: NOW, cache: { cache: { stale: { at: hoursAgo(24 * 20), judgment: { groups: [], drops: [] } } }, ledger: {} }, cfg: { candidate_days: 3, batch_incidents: 15, batch_candidates: 40, posts_per_incident: 8, neighbors_per_incident: 5, daily_calls: 5, cache_days: 14 } });
  assert.deepEqual(Object.keys(old.cacheFile.cache), []);
});
