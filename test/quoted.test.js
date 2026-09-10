import test from 'node:test';
import assert from 'node:assert/strict';
import { toRecord, quotedFromIncludes, listTweetsPage, userTweetsPage, searchRecent, lookupTweets } from '../src/x.js';
import { quotedContext, quotedResolver, quotingFor, archiveLookup, QUOTING_TEXT_MAX } from '../src/quoted.js';
import { selectRefIds, fetchQuoted } from '../src/quotes-backfill.js';
import { anchorIndex, renderTaxonomy, systemPrompt } from '../src/taxonomy.js';
import { chunkRequests, classifierLine, withQuoting, mergeTopics, anchoredAssignments, planDay, mergeDay } from '../src/classify.js';
import { scoreCandidates, topQuoted, mergeClusters } from '../src/stories.js';

// ── fixtures ─────────────────────────────────────────────────────────────

const COXON = '2097476196791709843';
const capturedAt = '2026-09-10T06:40:00.000Z';
const includes = {
  tweets: [
    { id: COXON, author_id: 'u-coxon', text: 'I resigned from Anthropic today.', public_metrics: { like_count: 708063, retweet_count: 143632, reply_count: 16404, quote_count: 33837, bookmark_count: 253769, impression_count: 139252407 } },
    { id: '500', author_id: 'u-orphan', text: 'author not included' }
  ],
  users: [{ id: 'u-coxon', username: 'hilbertspaess' }]
};
const raw = (id, refs, extra = {}) => ({ id, author_id: 'm1', created_at: '2026-09-09T20:00:00.000Z', lang: 'en', text: `post ${id}`, referenced_tweets: refs, ...extra });

// Proxy auth mode + stubbed global fetch: no network, the stub sees exactly
// the URL the client built (same harness as x-search.test.js).
async function withStubbedFetch(handler, fn) {
  const savedFetch = globalThis.fetch;
  const savedToken = process.env.X_BEARER_TOKEN;
  const savedProxy = process.env.X_PROXY_AUTH;
  delete process.env.X_BEARER_TOKEN;
  process.env.X_PROXY_AUTH = '1';
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: new URL(String(url)), init });
    return handler(calls[calls.length - 1]);
  };
  try { return await fn(calls); } finally {
    globalThis.fetch = savedFetch;
    if (savedToken === undefined) delete process.env.X_BEARER_TOKEN; else process.env.X_BEARER_TOKEN = savedToken;
    if (savedProxy === undefined) delete process.env.X_PROXY_AUTH; else process.env.X_PROXY_AUTH = savedProxy;
  }
}
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ── 1. toRecord with includes ────────────────────────────────────────────

test('toRecord attaches quoted context to quotes and replies from includes, nothing else changes', () => {
  const quote = toRecord(raw('1', [{ type: 'quoted', id: COXON }]), capturedAt, includes);
  assert.equal(quote.type, 'quote');
  assert.equal(quote.refId, COXON);
  assert.deepEqual(quote.quoted, {
    id: COXON, authorId: 'u-coxon', handle: 'hilbertspaess', text: 'I resigned from Anthropic today.',
    metrics: { likes: 708063, retweets: 143632, replies: 16404, quotes: 33837, impressions: 139252407 } // no bookmarks
  });

  const reply = toRecord(raw('2', [{ type: 'replied_to', id: COXON }]), capturedAt, includes);
  assert.equal(reply.type, 'reply');
  assert.equal(reply.quoted.handle, 'hilbertspaess');

  // author object missing from includes → handle null, still attached
  const orphan = toRecord(raw('3', [{ type: 'quoted', id: '500' }]), capturedAt, includes);
  assert.deepEqual(orphan.quoted, { id: '500', authorId: 'u-orphan', handle: null, text: 'author not included', metrics: { likes: 0, retweets: 0, replies: 0, quotes: 0, impressions: 0 } });

  // a retweet of an included post is inherited, not quoted; a plain tweet has nothing
  assert.ok(!('quoted' in toRecord(raw('4', [{ type: 'retweeted', id: COXON }]), capturedAt, includes)));
  assert.ok(!('quoted' in toRecord(raw('5', []), capturedAt, includes)));
  // referenced post not in includes → the record shape is exactly the old one
  const before = toRecord(raw('6', [{ type: 'quoted', id: '999' }]), capturedAt);
  const after = toRecord(raw('6', [{ type: 'quoted', id: '999' }]), capturedAt, includes);
  assert.deepEqual(after, before);
  assert.deepEqual(Object.keys(before), ['id', 'authorId', 'createdAt', 'type', 'refId', 'lang', 'text', 'capturedAt', 'metricsAtCapture']);
  assert.equal(quotedFromIncludes('nope', includes), null);
});

test('timeline pagers ask for referenced expansions only when told, and bill included posts and users', async () => {
  const page = {
    data: [raw('1', [{ type: 'quoted', id: COXON }]), raw('2', [])],
    includes: { tweets: [includes.tweets[0]], users: includes.users },
    meta: { next_token: 'n2' }
  };
  await withStubbedFetch(() => jsonResponse(page), async (calls) => {
    const plain = await listTweetsPage('L', { pageSize: 50 });
    assert.equal(calls[0].url.searchParams.get('expansions'), null);
    assert.equal(calls[0].url.searchParams.get('user.fields'), null);
    assert.equal(plain.usage, 2 + 1); // included posts are billed whether or not the caller asked — it cannot under-bill
    assert.equal(plain.userReads, 1);

    const withRefs = await listTweetsPage('L', { pageSize: 50, includeReferenced: true });
    assert.equal(calls[1].url.searchParams.get('expansions'), 'referenced_tweets.id,referenced_tweets.id.author_id');
    assert.equal(calls[1].url.searchParams.get('user.fields'), 'username');
    assert.match(calls[1].url.searchParams.get('tweet.fields'), /public_metrics/);
    assert.equal(withRefs.tweets.length, 2);
    assert.equal(withRefs.includes.tweets[0].id, COXON);
    assert.equal(withRefs.includes.users[0].username, 'hilbertspaess');
    assert.equal(withRefs.nextToken, 'n2');
    assert.deepEqual([withRefs.usage, withRefs.userReads], [3, 1]);
    assert.equal(toRecord(withRefs.tweets[0], capturedAt, withRefs.includes).quoted.handle, 'hilbertspaess');

    const user = await userTweetsPage('U', { includeReferenced: true, startTime: '2026-08-20T00:00:00Z' });
    assert.equal(calls[2].url.pathname, '/2/users/U/tweets');
    assert.equal(calls[2].url.searchParams.get('expansions'), 'referenced_tweets.id,referenced_tweets.id.author_id');
    assert.deepEqual([user.usage, user.userReads], [3, 1]);

    const search = await searchRecent('Coxon', { includeReferenced: true });
    assert.equal(calls[3].url.searchParams.get('expansions'), 'referenced_tweets.id,referenced_tweets.id.author_id');
    assert.deepEqual(search.usage, { posts: 3, users: 1 });
    const both = await searchRecent('Coxon', { includeReferenced: true, expandAuthors: true });
    assert.equal(calls[4].url.searchParams.get('expansions'), 'author_id,referenced_tweets.id,referenced_tweets.id.author_id');
    assert.equal(both.users.length, 1);
  });
  await withStubbedFetch(() => jsonResponse({ title: 'Too Many Requests' }, 429), async () => {
    const r = await listTweetsPage('L', { includeReferenced: true });
    assert.deepEqual(r, { rateLimited: true, tweets: [], includes: { tweets: [], users: [] }, nextToken: null, usage: 0, userReads: 0 });
  });
});

test('lookupTweets withText returns full posts with handles and bills the author expansion', async () => {
  const body = {
    data: [{ id: COXON, author_id: 'u-coxon', created_at: '2026-09-08T18:00:00.000Z', text: 'I resigned from Anthropic today.', public_metrics: includes.tweets[0].public_metrics }],
    includes: { users: includes.users },
    errors: [{ resource_id: '404404', title: 'Not Found Error' }]
  };
  await withStubbedFetch(() => jsonResponse(body), async (calls) => {
    const plain = await lookupTweets([COXON, '404404']);
    assert.equal(calls[0].url.searchParams.get('tweet.fields'), 'public_metrics');
    assert.equal(calls[0].url.searchParams.get('expansions'), null);
    assert.equal(plain.metricsById.get(COXON).impressions, 139252407);
    assert.equal(plain.tweetsById.size, 0);
    assert.deepEqual([plain.usage, plain.userReads], [1, 1]);

    const full = await lookupTweets([COXON, '404404'], { withText: true });
    assert.equal(calls[1].url.searchParams.get('ids'), `${COXON},404404`);
    assert.equal(calls[1].url.searchParams.get('tweet.fields'), 'public_metrics,author_id,created_at,text');
    assert.equal(calls[1].url.searchParams.get('expansions'), 'author_id');
    assert.equal(calls[1].url.searchParams.get('user.fields'), 'username');
    assert.deepEqual(full.tweetsById.get(COXON), {
      id: COXON, authorId: 'u-coxon', handle: 'hilbertspaess', text: 'I resigned from Anthropic today.', createdAt: '2026-09-08T18:00:00.000Z',
      metrics: { likes: 708063, retweets: 143632, replies: 16404, quotes: 33837, bookmarks: 253769, impressions: 139252407 }
    });
    assert.equal(full.tweetsById.has('404404'), false); // deleted: simply not returned
    assert.deepEqual([full.usage, full.userReads], [1, 1]);
  });
  assert.deepEqual(await lookupTweets([]), { metricsById: new Map(), tweetsById: new Map(), usage: 0, userReads: 0 });
});

// ── 2. backfill selection + fetch loop ───────────────────────────────────

const archive = [
  { id: 'a1', type: 'quote', refId: COXON },
  { id: 'a2', type: 'quote', refId: COXON },
  { id: 'a3', type: 'reply', refId: COXON },
  { id: 'a4', type: 'quote', refId: '200' },
  { id: 'a5', type: 'reply', refId: '300' },
  { id: 'a6', type: 'quote', refId: '100' },      // 100 is a caucus post we hold
  { id: 'a7', type: 'retweet', refId: '900' },    // retweets are inherited, never fetched
  { id: 'a8', type: 'quote', refId: '400' },      // already in the store
  { id: 'a9', type: 'quote', refId: '500' },      // known unavailable: never re-billed
  { id: 'a10', type: 'tweet', refId: null },
  { id: '100', type: 'tweet', refId: null, text: 'a member post that gets quoted' }
];
const store = { 400: { handle: 'x', text: 'known', metrics: {}, fetchedAt: 't' }, 500: { unavailable: true, fetchedAt: 't' } };

test('selectRefIds: distinct quote/reply refIds, most-referenced first, minus the store and the archive', () => {
  const todo = selectRefIds(archive, store, { archivedIds: new Set(archive.map((t) => t.id)) });
  assert.deepEqual(todo, [{ id: COXON, n: 3 }, { id: '200', n: 1 }, { id: '300', n: 1 }]);
  assert.deepEqual(selectRefIds(archive, store, { archivedIds: new Set(archive.map((t) => t.id)), includeReplies: false }).map((t) => t.id), [COXON, '200']);
  // without the archive set the member post is a candidate too
  assert.ok(selectRefIds(archive, store).some((t) => t.id === '100'));
  assert.deepEqual(selectRefIds([], {}), []);
});

test('fetchQuoted: batches of 100, ledger before store, unavailable recorded, resumable, stops at the cap', async () => {
  const todo = Array.from({ length: 230 }, (_, i) => ({ id: String(1000 + i), n: 1 }));
  const asked = [];
  const lookupTweets = async (ids, opts) => {
    asked.push(ids.length);
    assert.equal(opts.withText, true);
    const tweetsById = new Map(ids.filter((id) => id !== '1005').map((id) => [id, { id, authorId: 'u', handle: 'h', text: `t${id}`, createdAt: 'c', metrics: { likes: 1, retweets: 0, replies: 0, quotes: 0, bookmarks: 9, impressions: 5 } }]));
    return { tweetsById, metricsById: new Map(), usage: tweetsById.size, userReads: 1 };
  };
  const state = { usage: {} };
  const quoted = {};
  const events = [];
  const r = await fetchQuoted(todo, {
    lookupTweets, state, quoted,
    save: () => events.push('save'), saveState: () => events.push('state'),
    exhausted: () => false, now: () => 'NOW', log: () => {}
  });
  assert.deepEqual(asked, [100, 100, 30]);
  assert.deepEqual(events, ['state', 'save', 'state', 'save', 'state', 'save']); // ledger first, every batch
  assert.deepEqual({ reads: r.reads, userReads: r.userReads, fetched: r.fetched, unavailable: r.unavailable, batches: r.batches, stopped: r.stopped, remaining: r.remaining },
    { reads: 229, userReads: 3, fetched: 229, unavailable: 1, batches: 3, stopped: null, remaining: 0 });
  assert.deepEqual(quoted['1000'], { authorId: 'u', handle: 'h', text: 't1000', metrics: { likes: 1, retweets: 0, replies: 0, quotes: 0, impressions: 5 }, fetchedAt: 'NOW' });
  assert.deepEqual(quoted['1005'], { unavailable: true, fetchedAt: 'NOW' });
  const day = Object.values(state.usage)[0];
  assert.deepEqual(day, { posts: 229, users: 3 });

  // a second pass selects nothing: everything is known (fetched or unavailable)
  const posts = todo.map((t) => ({ id: `p${t.id}`, type: 'quote', refId: t.id }));
  assert.deepEqual(selectRefIds(posts, quoted), []);

  // --max-reads caps billed reads (a post that does not come back is not a
  // read, so the second batch may ask for one more) and stops; the budget
  // guard stops before a batch; a 429 stops
  asked.length = 0;
  const capped = await fetchQuoted(todo, { maxReads: 150, lookupTweets, state: { usage: {} }, quoted: {}, save: () => {}, saveState: () => {}, exhausted: () => false, log: () => {} });
  assert.deepEqual(asked, [100, 51]);
  assert.equal(capped.reads, 150);
  assert.match(capped.stopped, /--max-reads=150/);
  assert.equal(capped.remaining, 79);
  const budget = await fetchQuoted(todo, { lookupTweets, state: { usage: {} }, quoted: {}, save: () => {}, saveState: () => {}, exhausted: () => true, log: () => {} });
  assert.match(budget.stopped, /budget/);
  assert.equal(budget.reads, 0);
  const limited = await fetchQuoted(todo, { lookupTweets: async () => ({ rateLimited: true, tweetsById: new Map(), usage: 0, userReads: 0 }), state: { usage: {} }, quoted: {}, save: () => {}, saveState: () => {}, exhausted: () => false, log: () => {} });
  assert.equal(limited.stopped, 'rate limited');
});

// ── 3. quotedContext resolution order ────────────────────────────────────

test('quotedContext: the record first, then data/quoted.json, then the archive; retweets and tweets resolve to nothing', () => {
  const quoted = {
    [COXON]: { authorId: 'u-coxon', handle: 'hilbertspaess', text: 'from the store', metrics: { likes: 1, retweets: 2, replies: 3, quotes: 4, impressions: 139252407 }, fetchedAt: 't' },
    500: { unavailable: true, fetchedAt: 't' }
  };
  const archiveRecs = { 100: { id: '100', authorId: 'm2', type: 'tweet', text: 'a member post that gets quoted', metricsAtCapture: { likes: 3, retweets: 1, replies: 0, quotes: 0 } } };
  const deps = {
    quoted,
    archive: (id) => archiveRecs[id] || null,
    authorsById: { m2: { handle: 'RepTwo' } },
    metricsFor: (rec) => (rec.id === '100' ? { likes: 30, retweets: 10, replies: 2, quotes: 1, impressions: 5000, refreshedAt: 'x' } : rec.metricsAtCapture)
  };
  // 1. the record itself wins even when the store knows the id
  const onRecord = quotedContext({ type: 'quote', refId: COXON, quoted: { id: COXON, authorId: 'u-coxon', handle: 'hilbertspaess', text: 'from capture', metrics: { likes: 9, retweets: 0, replies: 0, quotes: 0, impressions: 10 } } }, deps);
  assert.deepEqual(onRecord, { id: COXON, authorId: 'u-coxon', handle: 'hilbertspaess', text: 'from capture', metrics: { likes: 9, retweets: 0, replies: 0, quotes: 0, impressions: 10 } });
  // 2. the store
  const fromStore = quotedContext({ type: 'reply', refId: COXON }, deps);
  assert.equal(fromStore.text, 'from the store');
  assert.equal(fromStore.metrics.impressions, 139252407);
  assert.ok(!('fetchedAt' in fromStore));
  // 3. the archive: handle from authors, metrics from the 24h refresh
  const fromArchive = quotedContext({ type: 'quote', refId: '100' }, deps);
  assert.deepEqual(fromArchive, { id: '100', authorId: 'm2', handle: 'RepTwo', text: 'a member post that gets quoted', metrics: { likes: 30, retweets: 10, replies: 2, quotes: 1, impressions: 5000 } });
  // an unavailable store entry falls through to the archive, and to nothing
  assert.equal(quotedContext({ type: 'quote', refId: '500' }, deps), null);
  assert.equal(quotedContext({ type: 'quote', refId: '999' }, deps), null);
  assert.equal(quotedContext({ type: 'retweet', refId: COXON }, deps), null);
  assert.equal(quotedContext({ type: 'tweet', refId: null }, deps), null);
  assert.equal(quotedContext(null, deps), null);

  // the resolver shares the sources across calls
  const resolve = quotedResolver(deps);
  assert.equal(resolve({ type: 'quote', refId: '100' }).handle, 'RepTwo');
  assert.equal(resolve({ type: 'quote', refId: COXON }).text, 'from the store');
});

test('archiveLookup reads at most the three day files around the snowflake and caches misses', () => {
  const ORIG = '2095338461855191088'; // 2026-09-03T02:29Z → ET 2026-09-02
  const loads = [];
  const loadDay = (d) => { loads.push(d); return d === '2026-09-02' ? [{ id: ORIG, text: 'hit' }] : []; };
  const lookup = archiveLookup({ loadDay });
  assert.equal(lookup(ORIG).text, 'hit');
  assert.equal(lookup(ORIG).text, 'hit');
  assert.equal(lookup('2095338461855191089'), null);
  assert.equal(lookup('2095338461855191089'), null);
  assert.ok(loads.length <= 3, `read ${loads.length} day files`); // the same days serve every id around that timestamp
});

test('quotingFor caps the text and gives impressions only when known', () => {
  const long = quotingFor({ handle: 'h', text: 'x'.repeat(1000), metrics: { impressions: 7 } });
  assert.deepEqual(long, { handle: 'h', text: 'x'.repeat(QUOTING_TEXT_MAX), impressions: 7 });
  assert.equal(QUOTING_TEXT_MAX, 400);
  assert.deepEqual(quotingFor({ handle: null, text: 'short', metrics: { likes: 3 } }), { handle: null, text: 'short' });
  assert.equal(quotingFor(null), null);
});

// ── 4. classifier input + prompt ─────────────────────────────────────────

const tax = {
  tech: { label: 'Technology', subtopics: { 'ai-policy': { label: 'AI policy' }, 'coxon-resignation': { label: 'Jacob Coxon resignation', story: true, since: '2026-09-08', anchors: [COXON] } } },
  economy: { label: 'Economy', subtopics: { jobs: { label: 'Jobs' } } }
};

test('chunk items carry quoting only when context exists; a bare item is exactly {id, text}', () => {
  const ctx = { id: COXON, handle: 'hilbertspaess', text: 'y'.repeat(600), metrics: { impressions: 139252407 } };
  const resolve = (t) => (t.refId === COXON ? ctx : null);
  const items = withQuoting([{ id: '1', type: 'quote', refId: COXON, text: 'wow' }, { id: '2', type: 'tweet', refId: null, text: 'plain' }], resolve);
  assert.equal(classifierLine(items[1]), '{"id":"2","text":"plain"}');
  const line = JSON.parse(classifierLine(items[0]));
  assert.deepEqual(Object.keys(line), ['id', 'text', 'quoting']);
  assert.deepEqual(line.quoting, { handle: 'hilbertspaess', text: 'y'.repeat(400), impressions: 139252407 });
  assert.ok(!('type' in line) && !('refId' in line)); // nothing else leaks into the prompt

  const [req] = chunkRequests(items, tax, 'm');
  const lines = req.params.messages[0].content.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[1], '{"id":"2","text":"plain"}');
  assert.equal(JSON.parse(lines[0]).quoting.impressions, 139252407);
  // the system block is identical whether or not any item has context
  const [bare] = chunkRequests([{ id: '9', text: 't' }], tax, 'm');
  assert.equal(req.params.system[0].text, bare.params.system[0].text);
  assert.deepEqual(req.params.system[0].cache_control, { type: 'ephemeral' });
});

test('systemPrompt is byte-stable, carries the quoting rule once, and shows anchors without ids', () => {
  const a = systemPrompt(tax);
  assert.equal(a, systemPrompt(tax));
  assert.equal(a, systemPrompt(tax, { examples: [] }));
  assert.equal(a.split('Some inputs carry "quoting"').length, 2);
  const rule = 'A quote or reply is about the subject of the post it quotes/answers (assign that subject and its story) in addition to whatever its own text adds; a quoted post with very high reach is a strong signal the story is live.';
  assert.match(a, new RegExp(rule.replace(/[/()."]/g, '\\$&').replace(/ /g, '\\s+'))); // the rule wraps like the others
  assert.equal(a.replace(/\s+/g, ' ').split(rule).length, 2);
  assert.ok(a.indexOf('Some inputs carry "quoting"') < a.indexOf('Reply with ONLY a JSON object'));
  assert.match(renderTaxonomy(tax), /- tech\/coxon-resignation: Jacob Coxon resignation \[developing story since 2026-09-08\] \[anchored\]$/);
  assert.doesNotMatch(a, new RegExp(COXON));
  assert.doesNotMatch(renderTaxonomy({ tech: { label: 'T', subtopics: { x: { label: 'X', anchors: [] } } } }), /anchored/);
});

// ── 5. anchors in planDay / mergeDay / classify-live ─────────────────────

test('anchorIndex and anchoredAssignments: quotes, replies, retweets of an anchor and the anchor itself', () => {
  const anchors = anchorIndex(tax);
  assert.deepEqual([...anchors], [[COXON, [['tech', 'coxon-resignation']]]]);
  assert.equal(anchorIndex({}).size, 0);
  assert.equal(anchorIndex({ t: { label: 't', subtopics: { s: { label: 's', anchors: ['not-an-id'] } } } }).size, 0);
  const tweets = [
    { id: 'q', type: 'quote', refId: COXON }, { id: 'r', type: 'reply', refId: COXON }, { id: 'rt', type: 'retweet', refId: COXON },
    { id: COXON, type: 'tweet', refId: null }, { id: 'o', type: 'quote', refId: 'other' }, { id: 'p', type: 'tweet', refId: null }
  ];
  assert.deepEqual(anchoredAssignments(tweets, anchors), {
    q: [['tech', 'coxon-resignation']], r: [['tech', 'coxon-resignation']], rt: [['tech', 'coxon-resignation']], [COXON]: [['tech', 'coxon-resignation']]
  });
  assert.deepEqual(anchoredAssignments(tweets, new Map()), {});
  assert.deepEqual(mergeTopics([['tech', 'coxon-resignation']], [['tech', 'coxon-resignation'], ['tech', 'ai-policy'], ['economy', null]], null), [['tech', 'coxon-resignation'], ['tech', 'ai-policy'], ['economy', null]]);
});

test('planDay assigns anchored stories before the model and attaches quoted context; mergeDay merges with the model output', () => {
  const tweets = [
    { id: 'q1', type: 'quote', refId: COXON, text: 'Twenty-two politicians replied to this. Zero of them said what they would do.' },
    { id: 'rt1', type: 'retweet', refId: COXON, text: 'RT @hilbertspaess: I resigned' },
    { id: 'rt2', type: 'retweet', refId: 'p1', text: 'RT @Rep: jobs' },
    { id: 'p1', type: 'tweet', refId: null, text: 'jobs report' },
    { id: 'n1', type: 'tweet', refId: null, text: 'nothing fits' },
    { id: 'rt3', type: 'retweet', refId: 'prior-orig', text: 'RT @Rep: earlier' }
  ];
  const ctx = { id: COXON, handle: 'hilbertspaess', text: 'I resigned from Anthropic today.', metrics: { impressions: 139252407 } };
  const resolve = (t) => (t.type !== 'retweet' && t.refId === COXON ? ctx : null);
  const plan = planDay('2026-09-09', { tax, tweets, prior: { 'prior-orig': [['economy', 'jobs']] }, resolve });

  assert.deepEqual(plan.anchored, { q1: [['tech', 'coxon-resignation']], rt1: [['tech', 'coxon-resignation']] });
  assert.deepEqual(plan.inherited, { rt3: [['economy', 'jobs']] });
  // the quote still goes to the model (its own topics), with the quoted post attached
  assert.deepEqual(plan.toClassify.map((t) => t.id), ['q1', 'rt1', 'rt2', 'p1', 'n1']);
  assert.deepEqual(plan.toClassify[0].quoting, { handle: 'hilbertspaess', text: 'I resigned from Anthropic today.', impressions: 139252407 });
  assert.ok(!('quoting' in plan.toClassify[3]));
  assert.ok(!('quoting' in tweets[0])); // the archive records are not mutated
  assert.deepEqual(plan.deferred, []);

  const result = {
    assignments: { q1: [['tech', 'ai-policy']], p1: [['economy', 'jobs']], n1: [] },
    incidents: {},
    emerging: [{ label: 'AI lab departures', ids: ['q1', 'n1'] }, { label: 'only anchored', ids: ['rt1'] }],
    failedChunks: 0
  };
  const { day, stats } = mergeDay(plan, result, { prior: {} });
  assert.deepEqual(day.assignments, {
    q1: [['tech', 'coxon-resignation'], ['tech', 'ai-policy']], // anchor first, model's own topics kept
    p1: [['economy', 'jobs']],
    n1: [],
    rt2: [['economy', 'jobs']],   // inherits from this batch
    rt3: [['economy', 'jobs']],   // inherits from a prior day
    rt1: [['tech', 'coxon-resignation']] // anchored retweet with no model answer
  });
  assert.deepEqual(day.anchored, plan.anchored);
  assert.deepEqual(day.emerging, [{ label: 'AI lab departures', ids: ['n1'] }]); // anchored ids leave the clusters; an emptied cluster is dropped
  assert.deepEqual(day.unclassified, []);
  // rt1 is anchored, not inherited: its original has no assignment to inherit
  assert.deepEqual(stats, { classified: 3, inherited: 2, anchored: 2, incidents: 0, emerging: 1, unclassified: 0, failedChunks: 0 });

  // without anchors nothing changes: a missing model answer is unclassified
  const noAnchors = planDay('2026-09-09', { tax: { economy: tax.economy }, tweets, prior: {}, resolve });
  assert.deepEqual(noAnchors.anchored, {});
  const plain = mergeDay(noAnchors, { assignments: {}, incidents: {}, emerging: [], failedChunks: 1 }, { prior: {} });
  assert.deepEqual(plain.day.unclassified, ['q1', 'rt1', 'rt2', 'p1', 'n1', 'rt3']);
  assert.equal(plain.stats.anchored, 0);
  assert.equal(plain.stats.failedChunks, 1);
});

// ── 6. topQuoted for auto-promotion ──────────────────────────────────────

test('scoreCandidates reports the most-quoted refIds of a candidate as topQuoted', () => {
  const posts = [
    ['1', { id: '1', authorId: 'a', createdAt: '2026-09-08T10:00:00Z', date: '2026-09-08', type: 'quote', refId: COXON, text: 'a', metricsAtCapture: {} }],
    ['2', { id: '2', authorId: 'b', createdAt: '2026-09-08T11:00:00Z', date: '2026-09-08', type: 'reply', refId: COXON, text: 'b', metricsAtCapture: {} }],
    ['3', { id: '3', authorId: 'c', createdAt: '2026-09-09T10:00:00Z', date: '2026-09-09', type: 'quote', refId: '77', text: 'c', metricsAtCapture: {} }],
    ['4', { id: '4', authorId: 'c', createdAt: '2026-09-09T11:00:00Z', date: '2026-09-09', type: 'tweet', refId: null, text: 'd', metricsAtCapture: {} }]
  ];
  const merged = mergeClusters([{ label: 'coxon resignation', ids: ['1', '2', '3', '4'], date: '2026-09-09' }]);
  const [c] = scoreCandidates(merged, new Map(posts), { a: { handle: 'a' }, b: { handle: 'b' }, c: { handle: 'c' } }, []);
  assert.deepEqual(c.topQuoted, [{ id: COXON, n: 2 }, { id: '77', n: 1 }]);
  assert.deepEqual(topQuoted([]), []);
  assert.deepEqual(topQuoted(Array.from({ length: 8 }, (_, i) => ({ refId: String(i) }))).length, 5);
});
