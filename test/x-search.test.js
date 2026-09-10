import test from 'node:test';
import assert from 'node:assert/strict';
import { searchRecent } from '../src/x.js';

// Run every case in proxy auth mode so authFetch sends a bare fetch(url) and
// the stub sees exactly the URL the client built. No network: globalThis.fetch
// is replaced for the duration of each test.
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

test('searchRecent builds the recent-search query string without expansions by default', async () => {
  await withStubbedFetch(() => jsonResponse({ data: [], meta: { result_count: 0 } }), async (calls) => {
    const out = await searchRecent('Coxon Anthropic -is:retweet', { maxResults: 500, startTime: '2026-09-08T00:00:00Z' });
    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url.origin + url.pathname, 'https://api.x.com/2/tweets/search/recent');
    assert.equal(url.searchParams.get('query'), 'Coxon Anthropic -is:retweet');
    assert.equal(url.searchParams.get('max_results'), '100');              // clamped to the endpoint ceiling
    assert.equal(url.searchParams.get('start_time'), '2026-09-08T00:00:00Z');
    assert.equal(url.searchParams.get('expansions'), null);                // no user billing unless asked
    assert.equal(url.searchParams.get('user.fields'), null);
    assert.equal(url.searchParams.get('next_token'), null);
    assert.match(url.searchParams.get('tweet.fields'), /(^|,)public_metrics(,|$)/);
    assert.match(url.searchParams.get('tweet.fields'), /(^|,)referenced_tweets(,|$)/);
    assert.equal(init?.headers?.Authorization, undefined);                 // proxy mode: no header from this process
    assert.deepEqual(out, { rateLimited: false, resetAt: null, tweets: [], users: [], includes: { tweets: [], users: [] }, nextToken: null, usage: { posts: 0, users: 0 } });
  });
});

test('searchRecent clamps max_results to the endpoint floor and forwards next_token', async () => {
  await withStubbedFetch(() => jsonResponse({ data: [] }), async (calls) => {
    await searchRecent('Hubinger', { maxResults: 3, nextToken: 'b26v89c19zqg8o3fpe' });
    const { url } = calls[0];
    assert.equal(url.searchParams.get('max_results'), '10');
    assert.equal(url.searchParams.get('next_token'), 'b26v89c19zqg8o3fpe');
  });
});

test('searchRecent bills posts and (only when expanded) users, and passes the page token on', async () => {
  const body = {
    data: [
      { id: '1', text: 'a', author_id: 'u1', created_at: '2026-09-09T12:00:00.000Z', public_metrics: { like_count: 1, retweet_count: 0 } },
      { id: '2', text: 'b', author_id: 'u2', created_at: '2026-09-09T12:01:00.000Z', referenced_tweets: [{ type: 'retweeted', id: '1' }] },
      { id: '3', text: 'c', author_id: 'u1', created_at: '2026-09-09T12:02:00.000Z' }
    ],
    includes: { users: [{ id: 'u1', username: 'one' }, { id: 'u2', username: 'two' }] },
    meta: { result_count: 3, next_token: 'next-page' }
  };
  await withStubbedFetch(() => jsonResponse(body), async (calls) => {
    const out = await searchRecent('Anthropic superintelligence', { expandAuthors: true });
    const { url } = calls[0];
    assert.equal(url.searchParams.get('expansions'), 'author_id');
    assert.equal(url.searchParams.get('user.fields'), 'username,name,verified,public_metrics');
    assert.equal(out.tweets.length, 3);
    assert.equal(out.users.length, 2);
    assert.equal(out.nextToken, 'next-page');
    // 3 post objects ($0.005 each) + 2 user objects ($0.01 each) — users are
    // deduped by the API, so usage.users counts returned objects, not tweets
    assert.deepEqual(out.usage, { posts: 3, users: 2 });
  });
});

test('searchRecent reports a 429 as rateLimited with the reset time and zero usage', async () => {
  const reset = Math.floor(Date.now() / 1000) + 600;
  await withStubbedFetch(
    () => jsonResponse({ title: 'Too Many Requests' }, { status: 429, headers: { 'x-rate-limit-reset': String(reset) } }),
    async () => {
      const out = await searchRecent('Anthropic "pre-crime"');
      assert.equal(out.rateLimited, true);
      assert.equal(out.resetAt, reset * 1000);
      assert.deepEqual(out.tweets, []);
      assert.deepEqual(out.usage, { posts: 0, users: 0 });
    }
  );
});

test('searchRecent throws on other non-2xx statuses with the status attached', async () => {
  await withStubbedFetch(() => jsonResponse({ title: 'Invalid Request', detail: 'bad operator' }, { status: 400 }), async () => {
    await assert.rejects(() => searchRecent('Anthropic ('), (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /^X search recent 400/);
      return true;
    });
  });
});
