// Read-only API adapter. No provider response, credential, or request header is logged.
export class XReadError extends Error {
  constructor(code) { super('X read request did not complete.'); this.name = 'XReadError'; this.code = code; }
}

export function createXClient({ token = process.env.CAUCUS_X_BEARER_TOKEN, fetchImpl = fetch,
  fieldDialect = 'tweet', timeoutMs = 30_000 } = {}) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('Configure the product bearer token through a private environment.');
  if (!['tweet', 'post'].includes(fieldDialect)) throw new Error('Invalid X field dialect.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('Invalid X request timeout.');
  async function read(path, params = {}) {
    const url = new URL(path, 'https://api.x.com');
    for (const [key, value] of Object.entries(params)) if (value != null) url.searchParams.set(key, String(value));
    let response;
    try {
      response = await fetchImpl(url, { method: 'GET', headers: { Authorization: `Bearer ${token.trim()}` },
        redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch { throw new XReadError('transport-failed'); }
    if (!response.ok) throw new XReadError(`http-${response.status}`);
    try { return await response.json(); } catch { throw new XReadError('invalid-json'); }
  }
  function validateId(id) { if (typeof id !== 'string' || !/^\d{1,25}$/.test(id)) throw new Error('Invalid X resource ID.'); }
  function validatePageSize(n, max) { if (!Number.isInteger(n) || n < 1 || n > max) throw new Error('Invalid X page size.'); }
  function validateCursor(value) { if (value != null && (typeof value !== 'string' || !value || value.length > 4096)) throw new Error('Invalid X pagination token.'); }
  async function listPosts({ listId, maxResults = 100, paginationToken = null }) {
    validateId(listId); validatePageSize(maxResults, 100); validateCursor(paginationToken);
    const fields = fieldDialect === 'tweet'
      ? 'id,text,author_id,created_at,conversation_id,referenced_tweets,note_tweet,entities,attachments,edit_history_tweet_ids,lang'
      : 'id,text,author_id,created_at,conversation_id,referenced_posts,note_post,entities,attachments,edit_history_post_ids,lang';
    // No expansions: reserve only for the requested primary posts. Validate actual accepted fields in the trial.
    const response = await read(`/2/lists/${listId}/tweets`, { max_results: maxResults, pagination_token: paginationToken, [`${fieldDialect}.fields`]: fields });
    if (response.data == null && response.meta?.result_count === 0 && !response.errors?.length) return { ...response, data: [] };
    return response;
  }
  async function creditBalance() {
    const response = await read('/2/usage/credits');
    if (response.errors?.length || typeof response.data?.prepaid_balance !== 'number' || !Number.isFinite(response.data.prepaid_balance)) throw new XReadError('invalid-credit-balance');
    return { prepaidUsd: response.data.prepaid_balance };
  }
  return { listPosts, creditBalance };
}
