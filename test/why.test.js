import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectMovers, pickTop, drivingPosts, baselinePosts, driveSha, renderPost, buildPrompt, SYSTEM,
  verifyQuote, normalizeReply, explainMover, generate
} from '../src/why.js';
import { whyKey, attachWhy } from '../src/sitedata.js';
import { etDate } from '../src/util.js';

// ── fixtures ─────────────────────────────────────────────────────────────
const NOW = Date.parse('2026-09-10T16:00:00Z');
const hoursAgo = (n) => new Date(NOW - n * 3_600_000).toISOString();
const post = (id, authorId, text, { age = 2, eng = 10, type = 'tweet', topics = [['economy', null]], refId = null } = {}) =>
  ({ id, authorId, text, createdAt: hoursAgo(age), engN: eng, type, topics, refId });
const authors = {
  a1: { handle: 'RepOne', member: 'Rep. One', caucuses: ['progressive'] },
  a2: { handle: 'RepTwo', member: 'Rep. Two', caucuses: ['newdem', 'cbc'] },
  a3: { handle: 'RepThree', member: 'Rep. Three', caucuses: [] }
};
const topic = (key, score, extra = {}) => ({
  key, name: key.toUpperCase(), momentum: { score, drivers: ['volume', 'adoption'] }, d: score - 50,
  r24: { n: 10, m: 5 }, w: { All: { n: 50 } }, subs: [], ...extra
});
const sub = (key, score, { story = true, n = 10 } = {}) => ({
  key, name: `Story ${key}`, story, momentum: { score, drivers: ['volume'] }, d: score - 50, r24: { n, m: Math.min(n, 4) }, w: { All: { n: n + 5 } }
});
const cluster = (suggest, kind, n) => ({ suggest, label: `Cluster ${suggest}`, kind, posts: n + 4, r24: { n, m: Math.min(n, 3) }, ids: [], since: hoursAgo(40) });

// ── mover selection ──────────────────────────────────────────────────────
test('selectMovers ranks topics and story subtopics by |momentum-50|, capped at top', () => {
  const topics = [
    topic('economy', 80, { subs: [sub('liam-ramos', 95, { n: 2 }), sub('generic', 99, { story: false, n: 40 })] }),
    topic('labor', 5),
    topic('tech', 52),
    topic('climate', 60)
  ];
  const movers = selectMovers({ topics, clusters: [] }, { top: 3, minStoryPosts: 5 });
  // story 95 (|45|), labor 5 (|45|; ties break by posts → story has 2, labor 10 → labor first), economy 80 (|30|)
  assert.deepEqual(movers.map((m) => m.key), ['topic:labor', 'story:economy/liam-ramos', 'topic:economy']);
  assert.ok(movers.every((m) => m.by === 'momentum'));
  // a generic (non-story) subtopic never competes, however high its score
  assert.ok(!movers.some((m) => m.key.includes('generic')));
  const story = movers.find((m) => m.kind === 'story');
  assert.equal(story.macro, 'economy');
  assert.equal(story.sub, 'liam-ramos');
  assert.equal(story.label, 'Story liam-ramos');
});

test('selectMovers adds every story with enough posts in the last 24h, deduped, and ignores gap clusters', () => {
  const topics = [
    topic('economy', 80, { subs: [sub('busy-story', 51, { n: 7 }), sub('quiet-story', 51, { n: 2 })] }),
    topic('labor', 5)
  ];
  const clusters = [cluster('sept-11-anniversary', 'story', 9), cluster('mental-health', 'gap', 15), cluster('tiny-story', 'story', 1), cluster('raw', null, 20)];
  const movers = selectMovers({ topics, clusters }, { top: 1, minStoryPosts: 5 });
  assert.deepEqual(movers.map((m) => [m.key, m.by]), [
    ['topic:labor', 'momentum'],
    ['story:economy/busy-story', 'story'],
    ['cluster:sept-11-anniversary', 'story']
  ]);
  const c = movers.find((m) => m.kind === 'cluster');
  assert.equal(c.cluster, 'sept-11-anniversary');
  assert.equal(c.score, null); // no momentum for a candidate: only the story rule brings it in
  assert.equal(c.r24, 9);
  // a story that already made the momentum cut is not listed twice
  const twice = selectMovers({ topics: [topic('economy', 50, { subs: [sub('busy-story', 99, { n: 7 })] })], clusters: [] }, { top: 1, minStoryPosts: 5 });
  assert.deepEqual(twice.map((m) => [m.key, m.by]), [['story:economy/busy-story', 'momentum']]);
});

test('selectMovers skips movers with nothing to read and lets the next one in', () => {
  const topics = [topic('a', 90), topic('b', 85), topic('c', 80)];
  const movers = selectMovers({ topics, clusters: [] }, { top: 2, hasPosts: (m) => m.key !== 'topic:a' });
  assert.deepEqual(movers.map((m) => m.key), ['topic:b', 'topic:c']);
});

// ── driving posts ────────────────────────────────────────────────────────
test('drivingPosts: last 24h originals, one post per member first, then by engagement; baseline is older', () => {
  const posts = [
    post('1', 'a1', 'one big', { eng: 100 }),
    post('2', 'a1', 'one small', { eng: 90 }),
    post('3', 'a2', 'two', { eng: 50 }),
    post('4', 'a3', 'three', { eng: 5 }),
    post('5', 'a2', 'a repost', { eng: 0, type: 'retweet' }),
    post('6', 'a1', 'yesterday', { age: 30, eng: 500 }),
    post('7', 'a2', 'two days ago', { age: 50, eng: 1 })
  ];
  assert.deepEqual(drivingPosts(posts, { max: 3, now: NOW }).map((x) => x.id), ['1', '3', '4']); // one per member wins over the second a1 post
  assert.deepEqual(drivingPosts(posts, { max: 4, now: NOW }).map((x) => x.id), ['1', '2', '3', '4']); // then fill by engagement, engagement order kept
  assert.deepEqual(baselinePosts(posts, { max: 6, now: NOW }).map((x) => x.id), ['6', '7']);
  assert.deepEqual(pickTop([], 3), []);
});

test('driveSha is order-independent and changes with the post set', () => {
  assert.equal(driveSha(['b', 'a', 'c']), driveSha(['a', 'b', 'c']));
  assert.equal(driveSha(['a', 'a', 'b']), driveSha(['a', 'b']));
  assert.notEqual(driveSha(['a', 'b']), driveSha(['a', 'b', 'c']));
  assert.equal(driveSha(['a', 'b']).length, 16);
});

// ── prompt shape ─────────────────────────────────────────────────────────
test('buildPrompt carries the measured numbers, the posts with ids and handles, quoted context, and the JSON instruction', () => {
  const quoted = post('9', 'a2', 'the original claim', { age: 5, eng: 300 });
  const driving = [
    post('1', 'a1', 'Costs are up.\n\nWe will fight  for lower prices.', { eng: 120 }),
    post('2', 'a3', 'Agree with this', { eng: 20, type: 'quote', refId: '9' }),
    post('3', 'a2', 'Replying', { eng: 3, type: 'reply', refId: 'missing' })
  ];
  const baseline = [post('8', 'a1', 'last week', { age: 60, eng: 7 })];
  const ctx = { authorsById: authors, byId: new Map([['9', quoted]]) };
  const mover = { key: 'topic:economy', kind: 'topic', label: 'Economy & cost of living', score: 72, d: 131, r24: 31, members24: 22, week: 473, drivers: ['volume', 'adoption'] };
  const prompt = buildPrompt(mover, { driving, baseline, ctx, total: 31 });
  assert.match(prompt, /^MOVER: Economy & cost of living — a macro topic\n/);
  assert.match(prompt, /momentum 72\/100 \(50 = steady/);
  assert.match(prompt, /formula drivers: volume and adoption/);
  assert.match(prompt, /last 24 hours: 31 post\(s\) including reposts, by 22 member\(s\) \(▲131% vs the six-day daily average\)/);
  assert.match(prompt, /DRIVING POSTS — last 24 hours, top by engagement with one post per member first \(3 of 31\):/);
  assert.match(prompt, /\[1\] @RepOne \(Rep\. One · CPC\) · Sep \d+, \d+:\d\d [AP]M · 120 eng\n {2}Costs are up\. We will fight for lower prices\./); // whitespace squashed, text on its own line
  assert.match(prompt, /\[2\] @RepThree \(Rep\. Three\) · .* · 20 eng · quote\n {2}Agree with this\n {2}↳ quoting @RepTwo \(Rep\. Two · NewDem\/CBC\): "the original claim"/);
  assert.match(prompt, /\[3\] @RepTwo .* · reply\n {2}Replying\n {2}↳ replying to a post outside the archive/);
  assert.match(prompt, /BASELINE — the prior six days, top by engagement, for comparison \(1\):\n\[8\] @RepOne/);
  assert.match(prompt, /Reply with the JSON object only\.$/);
  // the driving block comes before the baseline block; the measured block before both
  assert.ok(prompt.indexOf('MEASURED') < prompt.indexOf('DRIVING POSTS') && prompt.indexOf('DRIVING POSTS') < prompt.indexOf('BASELINE'));
  // the system prompt fixes the contract the parser relies on
  assert.match(SYSTEM, /at most 40 words/);
  assert.match(SYSTEM, /EXACT quote copied verbatim .* at most 120 characters/);
  assert.match(SYSTEM, /"confidence": \{"level": "high\|medium\|low"/);
});

test('buildPrompt describes stories and clusters by their kind and copes with an empty window', () => {
  const story = buildPrompt({ kind: 'story', label: 'Liam Ramos detention', macro: 'immigration', macroLabel: 'Immigration', score: 88, d: 200, r24: 6, members24: 5, week: 9, drivers: [] }, {});
  assert.match(story, /^MOVER: Liam Ramos detention — a developing story under Immigration\n/);
  assert.match(story, /\(none — the mover has no original posts in the last 24 hours\)/);
  const c = buildPrompt({ kind: 'cluster', label: 'Sept. 11 anniversary', score: null, d: null, r24: 9, members24: 7, week: 14, since: hoursAgo(40) }, {});
  assert.match(c, /an emerging story candidate \(not yet in the taxonomy\), first seen Sep/);
  assert.doesNotMatch(c, /momentum/);
  assert.match(c, /- last 24 hours: 9 post\(s\) including reposts, by 7 member\(s\)\n- 14 post\(s\) in the candidate so far/);
});

test('renderPost labels an unknown author instead of failing', () => {
  assert.match(renderPost(post('1', 'zz', 'hello'), { authorsById: authors }), /^\[1\] author zz · /);
});

// ── reply normalisation ──────────────────────────────────────────────────
test('verifyQuote accepts verbatim and case/quote-mark tolerant matches, refuses paraphrase', () => {
  const text = 'We will  fight for lower prices — “every day”.';
  assert.deepEqual(verifyQuote('fight for lower prices', text), { quote: 'fight for lower prices', verified: true });
  assert.deepEqual(verifyQuote('FIGHT FOR LOWER PRICES', text), { quote: 'FIGHT FOR LOWER PRICES', verified: true });
  assert.deepEqual(verifyQuote('"every day"', text), { quote: 'every day', verified: true });
  assert.deepEqual(verifyQuote('we fight prices', text), { quote: 'we fight prices', verified: false });
  assert.equal(verifyQuote('', text).verified, false);
});

test('normalizeReply keeps only shown ids, verifies quotes, caps lengths, defaults confidence', () => {
  const driving = [post('1', 'a1', 'Costs are up. We will fight for lower prices.'), post('2', 'a2', 'Second post text')];
  const baseline = [post('8', 'a3', 'Earlier framing', { age: 40 })];
  const parsed = {
    reason: Array.from({ length: 70 }, (_, i) => `w${i}`).join(' '),
    framing: '  lower   prices  ',
    evidence: [
      { id: '1', quote: 'fight for lower prices' },
      { id: '404', quote: 'not shown' },
      { id: '2', quote: 'something the model made up' },
      { id: '8', quote: 'Earlier framing' },
      { id: '1', quote: 'duplicate id' }
    ],
    confidence: { level: 'certain', why: 'x' }
  };
  const e = normalizeReply(parsed, { driving, baseline, authorsById: authors });
  assert.equal(e.reason.split(' ').length, 60);
  assert.ok(e.reason.endsWith('…'));
  assert.equal(e.framing, 'lower prices');
  assert.deepEqual(e.evidence, [
    { id: '1', handle: '@RepOne', quote: 'fight for lower prices', verified: true, window: 'driving' },
    { id: '2', handle: '@RepTwo', quote: 'something the model made up', verified: false, window: 'driving' },
    { id: '8', handle: '@RepThree', quote: 'Earlier framing', verified: true, window: 'baseline' }
  ]);
  assert.deepEqual(e.confidence, { level: 'low', why: 'x' });
  // a 200-char quote is cut at a word boundary under the cap
  const long = normalizeReply({ reason: 'r', evidence: [{ id: '1', quote: 'Costs are up. ' + 'x'.repeat(200) }], confidence: { level: 'high', why: 'y' } }, { driving });
  assert.ok(long.evidence[0].quote.length <= 120);
  assert.equal(long.evidence[0].verified, true); // the cut prefix is still verbatim
  assert.equal(normalizeReply({ evidence: [] }, { driving }), null);
  assert.equal(normalizeReply('nope', { driving }), null);
  assert.equal(normalizeReply({ reason: 'r' }, { driving }).confidence.why, 'confidence not stated');
});

// ── the call ─────────────────────────────────────────────────────────────
const stubClient = (reply, log = []) => ({
  messages: {
    create: async (req) => {
      log.push(req);
      const text = typeof reply === 'function' ? reply(req) : reply;
      return { stop_reason: text == null ? 'refusal' : 'end_turn', content: text == null ? [] : [{ type: 'text', text }], usage: { input_tokens: 1000, output_tokens: 80 } };
    }
  }
});

test('explainMover sends one request per mover with the system contract and parses the reply', async () => {
  const log = [];
  const driving = [post('1', 'a1', 'Costs are up. We will fight for lower prices.', { eng: 50 })];
  const client = stubClient('Sure:\n{"reason": "Members reacted to the CPI print; @RepOne led.", "framing": "lower prices", "evidence": [{"id": "1", "quote": "fight for lower prices"}], "confidence": {"level": "medium", "why": "one post"}}', log);
  const mover = { key: 'topic:economy', kind: 'topic', label: 'Economy', score: 70, d: 40, r24: 1, members24: 1, week: 5, drivers: [] };
  const r = await explainMover(mover, { driving, baseline: [], ctx: { authorsById: authors, byId: new Map() }, total: 1 }, { client, model: 'test-model' });
  assert.equal(log.length, 1);
  assert.equal(log[0].model, 'test-model');
  assert.equal(log[0].system, SYSTEM);
  assert.equal(log[0].messages.length, 1);
  assert.equal(log[0].messages[0].role, 'user');
  assert.match(log[0].messages[0].content, /^MOVER: Economy — a macro topic/);
  assert.match(log[0].messages[0].content, /\[1\] @RepOne/);
  assert.deepEqual(r.usage, { input: 1000, output: 80 });
  assert.equal(r.why, null);
  assert.equal(r.entry.reason, 'Members reacted to the CPI print; @RepOne led.');
  assert.deepEqual(r.entry.evidence, [{ id: '1', handle: '@RepOne', quote: 'fight for lower prices', verified: true, window: 'driving' }]);
  assert.deepEqual(r.entry.confidence, { level: 'medium', why: 'one post' });
  // a refusal or an unparseable reply yields no entry, with a reason
  assert.equal((await explainMover(mover, { driving, baseline: [], ctx: {} }, { client: stubClient(null), model: 'm' })).entry, null);
  const bad = await explainMover(mover, { driving, baseline: [], ctx: {} }, { client: stubClient('I cannot say'), model: 'm' });
  assert.equal(bad.entry, null);
  assert.match(bad.why, /did not parse/);
});

// ── the run: cache keying, ledger, ceiling, pruning ──────────────────────
function fixtureAgg() {
  const allPosts = [
    post('1', 'a1', 'Costs are up. We will fight for lower prices.', { eng: 100 }),
    post('2', 'a2', 'Prices again', { eng: 40 }),
    post('3', 'a3', 'Earlier economy post', { age: 30, eng: 500 }),
    post('4', 'a1', 'Union workers deserve a raise', { eng: 20, topics: [['labor', 'unions']] }),
    post('5', 'a2', 'RT', { type: 'retweet', topics: [['labor', null]] }),
    post('6', 'a1', 'Never forget', { eng: 30, topics: [] }),
    post('7', 'a2', 'We remember', { eng: 25, topics: [] }),
    post('8', 'a3', 'Old tech post', { age: 100, eng: 1, topics: [['tech', null]] })
  ];
  return {
    authorsById: authors,
    allPosts,
    topics: [topic('economy', 80), topic('labor', 20, { r24: { n: 2, m: 2 } }), topic('tech', 51, { r24: { n: 0, m: 0 } })],
    clusters: [{ ...cluster('sept-11', 'story', 2), ids: ['6', '7'] }, { ...cluster('gap-thing', 'gap', 9), ids: ['1'] }]
  };
}
const CFG = { top: 2, min_story_posts_24h: 2, max_posts: 25, baseline_posts: 6, min_posts: 1, daily_calls: 150 };
// A stub that quotes the first shown post verbatim so evidence verifies.
const echoReply = (agg) => (req) => {
  const id = req.messages[0].content.match(/^\[(\d+)\]/m)?.[1];
  const x = agg.allPosts.find((p) => p.id === id);
  return JSON.stringify({ reason: `about ${id}`, framing: 'f', evidence: [{ id, quote: x.text.slice(0, 12) }], confidence: { level: 'high', why: 'clear' } });
};

test('generate asks once per mover, keys the cache by the posts read, and re-asks only what changed', async () => {
  const agg = fixtureAgg();
  const log = [];
  const first = await generate(agg, { prev: { entries: { 'topic:old': { sha: 'x', reason: 'stale' } } }, client: stubClient(echoReply(agg), log), model: 'm', now: NOW, cfg: CFG });
  assert.deepEqual(first.movers.map((m) => m.key), ['topic:economy', 'topic:labor', 'cluster:sept-11']); // tech: no readable posts is not the issue here — it is out by rank; gap cluster never in
  assert.equal(first.asked, 3);
  assert.equal(first.cached, 0);
  assert.equal(log.length, 3);
  assert.equal(first.changed, true);
  const f = first.file;
  assert.deepEqual(Object.keys(f.entries).sort(), ['cluster:sept-11', 'topic:economy', 'topic:labor']); // the stale key is pruned
  const eco = f.entries['topic:economy'];
  assert.deepEqual(eco.postIds, ['1', '2']);
  assert.deepEqual(eco.baselineIds, ['3']);
  assert.equal(eco.sha, driveSha(['1', '2', '3']));
  assert.equal(eco.reason, 'about 1');
  assert.deepEqual(eco.evidence, [{ id: '1', handle: '@RepOne', quote: 'Costs are up', verified: true, window: 'driving' }]);
  assert.equal(eco.model, 'm');
  assert.equal(eco.generatedAt, new Date(NOW).toISOString());
  assert.deepEqual(eco.measured, { score: 80, d: 30, r24: 10, members24: 5, week: 50, by: 'momentum' });
  assert.equal(f.entries['topic:labor'].postIds.length, 1); // the retweet is not read
  assert.equal(f.entries['cluster:sept-11'].kind, 'cluster');
  assert.deepEqual(f.movers.map((m) => [m.key, m.by, m.sha]), [
    ['topic:economy', 'momentum', eco.sha], ['topic:labor', 'momentum', f.entries['topic:labor'].sha], ['cluster:sept-11', 'story', f.entries['cluster:sept-11'].sha]
  ]);
  const day = etDate(new Date(NOW));
  assert.deepEqual(f.ledger[day], { calls: 3, inputTokens: 3000, outputTokens: 240 });

  // Same posts → nothing asked, everything cached, ledger untouched.
  const second = await generate(agg, { prev: f, client: stubClient(echoReply(agg), log), model: 'm', now: NOW + 60_000, cfg: CFG });
  assert.equal(second.asked, 0);
  assert.equal(second.cached, 3);
  assert.equal(second.changed, false);
  assert.equal(log.length, 3);
  assert.equal(second.file.ledger[day].calls, 3);
  assert.equal(second.file.entries['topic:economy'].generatedAt, eco.generatedAt);

  // A new economy post → only economy is re-asked.
  agg.allPosts.push(post('9', 'a3', 'New economy post', { eng: 1 }));
  const third = await generate(agg, { prev: f, client: stubClient(echoReply(agg), log), model: 'm', now: NOW + 120_000, cfg: CFG });
  assert.equal(third.asked, 1);
  assert.equal(third.cached, 2);
  assert.equal(log.length, 4);
  assert.deepEqual(third.file.entries['topic:economy'].postIds, ['1', '2', '9']);
  assert.equal(third.file.ledger[day].calls, 4);
  // --force re-asks everything
  const forced = await generate(agg, { prev: third.file, client: stubClient(echoReply(agg), log), model: 'm', now: NOW, cfg: CFG, force: true });
  assert.equal(forced.asked, 3);
});

test('generate honours the daily ceiling, keeps a dated old entry when a reply fails, and never writes in a dry run', async () => {
  const agg = fixtureAgg();
  const log = [];
  const prev = { entries: { 'topic:labor': { sha: 'old', reason: 'stale labor reason', generatedAt: '2026-09-09T00:00:00Z' } }, ledger: { [etDate(new Date(NOW))]: { calls: 1, inputTokens: 10, outputTokens: 5 } } };
  const capped = await generate(agg, { prev, client: stubClient(echoReply(agg), log), model: 'm', now: NOW, cfg: { ...CFG, daily_calls: 2 } });
  assert.equal(capped.asked, 1); // one call left under the ceiling
  assert.equal(log.length, 1);
  assert.deepEqual(capped.skipped.map((s) => s.key), ['topic:labor', 'cluster:sept-11']);
  assert.match(capped.skipped[0].why, /daily ceiling 2 reached/);
  assert.equal(capped.file.entries['topic:labor'].reason, 'stale labor reason'); // kept, still dated 09-09
  assert.equal(capped.file.entries['cluster:sept-11'], undefined);
  assert.equal(capped.file.ledger[etDate(new Date(NOW))].calls, 2);

  const failing = await generate(agg, { prev, client: stubClient('nonsense', log), model: 'm', now: NOW, cfg: CFG });
  assert.equal(failing.asked, 0);
  assert.equal(failing.failed.length, 3);
  assert.equal(failing.file.entries['topic:labor'].reason, 'stale labor reason');
  assert.equal(failing.file.entries['topic:economy'], undefined);
  assert.equal(failing.file.ledger[etDate(new Date(NOW))].calls, 4); // failed calls are still billed and ledgered

  const dry = await generate(agg, { prev, client: stubClient(echoReply(agg), log), model: 'm', now: NOW, cfg: CFG, dryRun: true });
  assert.equal(dry.asked, 0);
  assert.equal(dry.skipped.length, 3);
  assert.equal(log.length, 4); // no new calls
});

// ── attachment ───────────────────────────────────────────────────────────
test('whyKey and attachWhy put the judgment beside the numbers, null where nothing was judged', () => {
  assert.equal(whyKey('topic', 'economy'), 'topic:economy');
  assert.equal(whyKey('story', 'immigration', 'liam-ramos'), 'story:immigration/liam-ramos');
  assert.equal(whyKey('cluster', 'sept-11-anniversary'), 'cluster:sept-11-anniversary');
  const topics = [
    { key: 'economy', momentum: { score: 80 }, subs: [{ key: 'liam-ramos' }, { key: 'prices' }] },
    { key: 'labor', momentum: { score: 20 }, subs: [] }
  ];
  const clusters = [{ suggest: 'sept-11-anniversary' }, { suggest: 'mental-health' }];
  const whyFile = {
    generatedAt: '2026-09-10T12:00:00Z', model: 'm',
    entries: {
      'topic:economy': { reason: 'CPI reaction', framing: 'lower prices', evidence: [{ id: '1', handle: '@RepOne', quote: 'q', verified: true, window: 'driving' }], confidence: { level: 'high', why: 'clear' }, postIds: ['1', '2'], generatedAt: '2026-09-10T11:00:00Z', model: 'm2' },
      'story:economy/liam-ramos': { reason: 'story reason', evidence: [], confidence: { level: 'low', why: 'few posts' }, postIds: ['3'] },
      'cluster:sept-11-anniversary': { reason: 'remembrance posts', evidence: [], confidence: { level: 'medium', why: '' }, postIds: [] },
      'topic:labor': { sha: 'x' } // no reason: never attached
    }
  };
  assert.equal(attachWhy({ topics, clusters }, whyFile), 3);
  assert.deepEqual(topics[0].why, { reason: 'CPI reaction', framing: 'lower prices', evidence: whyFile.entries['topic:economy'].evidence, confidence: { level: 'high', why: 'clear' }, generatedAt: '2026-09-10T11:00:00Z', posts: 2, model: 'm2' });
  assert.equal(topics[0].momentum.score, 80); // the measured number is untouched
  assert.deepEqual(topics[0].subs[0].why, { reason: 'story reason', framing: null, evidence: [], confidence: { level: 'low', why: 'few posts' }, generatedAt: '2026-09-10T12:00:00Z', posts: 1, model: 'm' });
  assert.equal(topics[0].subs[1].why, null);
  assert.equal(topics[1].why, null);
  assert.equal(clusters[0].why.reason, 'remembrance posts');
  assert.equal(clusters[0].why.posts, 0);
  assert.equal(clusters[1].why, null);
  // no file at all → every row says "not judged"
  assert.equal(attachWhy({ topics, clusters }, null), 0);
  assert.equal(topics[0].why, null);
});
