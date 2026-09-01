// X API v2 client — list-timeline capture at the billing floor.
//
// X bills pay-per-use: $0.005 per post object returned, $0.01 per user object
// returned. Every function reports its usage so the budget guard in store.js
// can meter spend. Design rules that keep cost at ~1 read per tweet captured:
//   - no expansions anywhere (authors resolve against data/authors.json,
//     refreshed weekly by src/authors.js)
//   - one merged list timeline instead of per-account polling or search
//   - engagement is re-read exactly once, batched, at the 24h mark

const API = 'https://api.twitter.com/2';

// The developer portal displays bearer tokens URL-encoded (%2F, %3D). Which
// form authenticates depends on how it was copied — try as-is first, fall
// back to the decoded form on a 401, then remember what worked.
let resolvedToken = null;

function tokenCandidates() {
  if (resolvedToken) return [resolvedToken];
  const raw = process.env.X_BEARER_TOKEN;
  let decoded = null;
  try { decoded = decodeURIComponent(raw); } catch { /* not %-encoded */ }
  return [...new Set([raw, decoded].filter(Boolean))];
}

async function authFetch(url) {
  const candidates = tokenCandidates();
  let res;
  for (const tok of candidates) {
    res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
    if (res.status === 401 && tok !== candidates[candidates.length - 1]) continue;
    if (res.ok) resolvedToken = tok;
    break;
  }
  return res;
}

export function isConfigured() {
  return Boolean(process.env.X_BEARER_TOKEN);
}

const TWEET_FIELDS = 'created_at,public_metrics,referenced_tweets,author_id,lang,conversation_id';

async function fail(res, label) {
  const text = await res.text();
  const err = new Error(`X ${label} ${res.status}: ${text.slice(0, 300)}`);
  err.status = res.status;
  err.body = text;
  throw err;
}

// One page of the list timeline, newest first. No expansions.
//
// since_id: search and user-timeline endpoints support it; the list-tweets
// endpoint has not consistently documented it. We send it when asked and let
// the caller detect a 400 (err.status === 400) to fall back to boundary-stop
// pagination — the poller records which mode works in state.sinceIdSupported.
export async function listTweetsPage(listId, { sinceId, paginationToken, pageSize = 100 } = {}) {
  const params = new URLSearchParams({
    max_results: String(Math.min(100, Math.max(5, pageSize))),
    'tweet.fields': TWEET_FIELDS
  });
  if (sinceId) params.set('since_id', sinceId);
  if (paginationToken) params.set('pagination_token', paginationToken);
  const res = await authFetch(`${API}/lists/${listId}/tweets?${params}`);
  if (res.status === 429) return { rateLimited: true, tweets: [], nextToken: null, usage: 0 };
  if (!res.ok) await fail(res, 'list tweets');
  const body = await res.json();
  return {
    rateLimited: false,
    tweets: body.data || [],
    nextToken: body.meta?.next_token || null,
    usage: body.data?.length || 0
  };
}

// Batched metrics re-read: up to 100 ids per request; each returned tweet is
// one post read. Deleted/protected tweets simply don't come back.
export async function lookupTweets(ids) {
  if (!ids.length) return { metricsById: new Map(), usage: 0 };
  const params = new URLSearchParams({
    ids: ids.slice(0, 100).join(','),
    'tweet.fields': 'public_metrics'
  });
  const res = await authFetch(`${API}/tweets?${params}`);
  if (res.status === 429) return { rateLimited: true, metricsById: new Map(), usage: 0 };
  if (!res.ok) await fail(res, 'tweets lookup');
  const body = await res.json();
  const metricsById = new Map((body.data || []).map((t) => {
    const m = t.public_metrics || {};
    return [t.id, {
      likes: m.like_count ?? 0, retweets: m.retweet_count ?? 0,
      replies: m.reply_count ?? 0, quotes: m.quote_count ?? 0,
      bookmarks: m.bookmark_count ?? 0, impressions: m.impression_count ?? 0
    }];
  }));
  return { metricsById, usage: body.data?.length || 0 };
}

// Resolve handles → user objects, 100 per request ($0.01 per user returned —
// which is why this runs weekly, not per poll).
export async function lookupUsersByHandles(handles) {
  const valid = handles.filter((h) => /^[A-Za-z0-9_]{1,15}$/.test(h));
  for (const h of handles.filter((h) => !valid.includes(h))) {
    console.warn(`[x] "${h}" is not a valid X username — skipped`);
  }
  const users = [];
  let usage = 0;
  for (let i = 0; i < valid.length; i += 100) {
    const params = new URLSearchParams({
      usernames: valid.slice(i, i + 100).join(','),
      'user.fields': 'username,name,verified,verified_type,public_metrics,created_at'
    });
    const res = await authFetch(`${API}/users/by?${params}`);
    if (!res.ok) await fail(res, 'users/by');
    const body = await res.json();
    users.push(...(body.data || []));
    usage += body.data?.length || 0;
  }
  return { users, usage };
}

// Normalize a raw API tweet into the archive record. Author enrichment
// happens at read time from the local author table, never via expansions.
export function toRecord(t, capturedAt) {
  const refs = t.referenced_tweets || [];
  const rt = refs.find((r) => r.type === 'retweeted');
  const quote = refs.find((r) => r.type === 'quoted');
  const reply = refs.find((r) => r.type === 'replied_to');
  const type = rt ? 'retweet' : quote ? 'quote' : reply ? 'reply' : 'tweet';
  const m = t.public_metrics || {};
  return {
    id: t.id,
    authorId: t.author_id,
    createdAt: t.created_at,
    type,
    refId: rt?.id || quote?.id || reply?.id || null,
    lang: t.lang,
    text: t.text,
    capturedAt,
    // metrics at capture come free in the same object; near-zero this early —
    // the real numbers land in data/metrics/ at the 24h refresh
    metricsAtCapture: {
      likes: m.like_count ?? 0, retweets: m.retweet_count ?? 0,
      replies: m.reply_count ?? 0, quotes: m.quote_count ?? 0
    }
  };
}
