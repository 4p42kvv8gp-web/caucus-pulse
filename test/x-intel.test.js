import test from 'node:test';
import assert from 'node:assert/strict';
import { countsRecent, lookupUsersByIds, usageTweets, quoteTweetsPage, lookupTweets } from '../src/x.js';

// Same harness as test/x-search.test.js: proxy auth mode so authFetch sends a
// bare fetch(url) and the stub sees exactly the URL the client built.
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

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

test('countsRecent: day granularity, no next_token follow, one request billed', async () => {
  const body = {
    data: [
      { start: '2026-09-03T07:00:00.000Z', end: '2026-09-04T00:00:00.000Z', tweet_count: 5 },
      { start: '2026-09-04T00:00:00.000Z', end: '2026-09-05T00:00:00.000Z', tweet_count: 12 }
    ],
    meta: { total_tweet_count: 17, next_token: 'more' }
  };
  await withStubbedFetch(() => jsonResponse(body), async (calls) => {
    const out = await countsRecent('("Epstein files") lang:en', { startTime: '2026-09-03T07:00:00Z' });
    assert.equal(calls.length, 1);                                       // never follows next_token
    const { url } = calls[0];
    assert.equal(url.origin + url.pathname, 'https://api.x.com/2/tweets/counts/recent');
    assert.equal(url.searchParams.get('query'), '("Epstein files") lang:en');
    assert.equal(url.searchParams.get('granularity'), 'day');
    assert.equal(url.searchParams.get('start_time'), '2026-09-03T07:00:00Z');
    assert.equal(url.searchParams.get('expansions'), null);
    assert.deepEqual(out.buckets, [
      { start: '2026-09-03T07:00:00.000Z', end: '2026-09-04T00:00:00.000Z', count: 5 },
      { start: '2026-09-04T00:00:00.000Z', end: '2026-09-05T00:00:00.000Z', count: 12 }
    ]);
    assert.equal(out.total, 17);
    assert.deepEqual(out.usage, { requests: 1 });
    assert.equal(out.rateLimited, false);
  });
});

test('countsRecent refuses minute granularity before any network call, reports 429 with resetAt and zero usage, throws 400 with status', async () => {
  await withStubbedFetch(() => jsonResponse({}), async (calls) => {
    await assert.rejects(() => countsRecent('x', { granularity: 'minute' }), /minute/);
    assert.equal(calls.length, 0);
  });
  const reset = Math.floor(Date.now() / 1000) + 30;
  await withStubbedFetch(() => jsonResponse({ title: 'Too Many Requests' }, { status: 429, headers: { 'x-rate-limit-reset': String(reset) } }), async () => {
    const out = await countsRecent('x', { granularity: 'hour' });
    assert.equal(out.rateLimited, true);
    assert.equal(out.resetAt, reset * 1000);
    assert.deepEqual(out.usage, { requests: 0 });
    assert.deepEqual(out.buckets, []);
  });
  await withStubbedFetch(() => jsonResponse({ title: 'Invalid Request' }, { status: 400 }), async () => {
    await assert.rejects(() => countsRecent('list:123'), (e) => e.status === 400 && /counts recent 400/.test(e.message));
  });
});

test('lookupUsersByIds batches 100 ids per request with the roster user.fields and bills users returned', async () => {
  const ids = Array.from({ length: 150 }, (_, i) => String(1000 + i));
  await withStubbedFetch(({ url }) => {
    const n = url.searchParams.get('ids').split(',').length;
    return jsonResponse({ data: Array.from({ length: n - 1 }, (_, i) => ({ id: String(i), username: `u${i}`, name: 'U', verified_type: i === 0 ? 'government' : 'none', public_metrics: { followers_count: 5 } })) });
  }, async (calls) => {
    const out = await lookupUsersByIds([...ids, 'not-an-id', ids[0]]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url.origin + calls[0].url.pathname, 'https://api.x.com/2/users');
    assert.equal(calls[0].url.searchParams.get('ids').split(',').length, 100);
    assert.equal(calls[1].url.searchParams.get('ids').split(',').length, 50);   // dedupe + invalid dropped
    assert.equal(calls[0].url.searchParams.get('user.fields'), 'username,name,verified,verified_type,public_metrics,created_at');
    assert.equal(calls[0].url.searchParams.get('expansions'), null);
    assert.equal(out.users.length, 99 + 49);                                     // deleted ids do not come back
    assert.deepEqual(out.usage, { users: 148 });
    assert.equal(out.users[0].verified_type, 'government');
  });
});

test('usageTweets parses both the cumulative pay-per-use shape and a daily breakdown', async () => {
  await withStubbedFetch(() => jsonResponse({ data: { cap_reset_day: 28, project_cap: '3000000', project_id: '1', project_usage: '12597' } }), async (calls) => {
    const out = await usageTweets(2);
    assert.equal(calls[0].url.origin + calls[0].url.pathname, 'https://api.x.com/2/usage/tweets');
    assert.equal(calls[0].url.searchParams.get('days'), '2');
    assert.deepEqual(out, { days: [], projectUsage: 12597, projectCap: 3000000, capResetDay: 28 });
  });
  await withStubbedFetch(() => jsonResponse({ data: { project_usage: '99', daily_project_usage: [{ project_id: '1', usage: [{ date: '2026-09-10T00:00:00.000Z', usage: '40' }, { date: '2026-09-09T00:00:00.000Z', usage: '59' }] }] } }), async () => {
    const out = await usageTweets();
    assert.deepEqual(out.days, [{ date: '2026-09-10', posts: 40 }, { date: '2026-09-09', posts: 59 }]);
    assert.equal(out.projectUsage, 99);
  });
});

test('quoteTweetsPage sets max_results explicitly, no expansions, bills posts returned, 429 → resetAt', async () => {
  const body = { data: [{ id: '5', text: 'q', author_id: 'a', created_at: '2026-09-09T12:00:00.000Z' }], meta: { next_token: 'n2' } };
  await withStubbedFetch(() => jsonResponse(body), async (calls) => {
    const out = await quoteTweetsPage('2097685220442923030', { maxResults: 7 });
    const { url } = calls[0];
    assert.equal(url.origin + url.pathname, 'https://api.x.com/2/tweets/2097685220442923030/quote_tweets');
    assert.equal(url.searchParams.get('max_results'), '10');                     // endpoint floor
    assert.equal(url.searchParams.get('expansions'), null);
    assert.match(url.searchParams.get('tweet.fields'), /referenced_tweets/);
    assert.equal(out.tweets.length, 1);
    assert.equal(out.nextToken, 'n2');
    assert.equal(out.usage, 1);
  });
  const reset = Math.floor(Date.now() / 1000) + 10;
  await withStubbedFetch(() => jsonResponse({}, { status: 429, headers: { 'x-rate-limit-reset': String(reset) } }), async () => {
    const out = await quoteTweetsPage('1', { maxResults: 50 });
    assert.deepEqual([out.rateLimited, out.resetAt, out.usage], [true, reset * 1000, 0]);
  });
});

test('lookupTweets default fields are unchanged (public_metrics only) and a fields option widens them', async () => {
  await withStubbedFetch(() => jsonResponse({ data: [{ id: '1', public_metrics: { like_count: 3 } }] }), async (calls) => {
    const out = await lookupTweets(['1']);
    assert.equal(calls[0].url.searchParams.get('tweet.fields'), 'public_metrics');
    assert.equal(out.metricsById.get('1').likes, 3);
    assert.equal(out.usage, 1);
    await lookupTweets(['1'], { fields: 'created_at,public_metrics,text' });
    assert.equal(calls[1].url.searchParams.get('tweet.fields'), 'created_at,public_metrics,text');
  });
});
