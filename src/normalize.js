import { createHash } from 'node:crypto';

export function normalizePost(raw, provenance = {}) {
  if (!raw || typeof raw.id !== 'string' || !/^\d+$/.test(raw.id)) {
    throw new Error('A post must have a numeric string ID; never convert X IDs to Number.');
  }
  if (typeof raw.author_id !== 'string' || !raw.author_id) throw new Error('Missing author ID.');
  if (!raw.created_at || !Number.isFinite(Date.parse(raw.created_at))) throw new Error('Missing valid post date.');
  const extended = raw.note_tweet?.text ?? raw.note_post?.text;
  const text = extended ?? raw.text;
  if (typeof text !== 'string') throw new Error('Missing available post text.');
  const references = raw.referenced_tweets ?? raw.referenced_posts ?? [];
  const type = references.some(r => ['retweeted', 'reposted'].includes(r.type)) ? 'repost'
    : references.some(r => r.type === 'quoted') ? 'quote'
    : references.some(r => r.type === 'replied_to') ? 'reply' : 'original';
  const capturedAt = provenance.retrievedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(capturedAt))) throw new Error('Invalid retrieval date.');
  return {
    id: raw.id, authorId: raw.author_id, createdAt: new Date(raw.created_at).toISOString(),
    capturedAt: new Date(capturedAt).toISOString(), text, type, references,
    conversationId: raw.conversation_id ?? null,
    textCoverage: provenance.fullTextVerified ? 'api-text-verified'
      : extended != null ? 'extended-api-text' : 'standard-api-text-unverified',
    contextCoverage: provenance.contextCoverage ?? 'Referenced posts and media not reviewed',
    provenance, raw, contentHash: createHash('sha256').update(JSON.stringify({ text, references,
      conversationId: raw.conversation_id ?? null, edits: raw.edit_history_tweet_ids ?? raw.edit_history_post_ids ?? [] })).digest('hex'),
    sourceUrl: `https://x.com/i/web/status/${raw.id}`
  };
}

export function exactOccurrences(text, phrase) {
  if (!phrase) return [];
  const spans = [];
  let from = 0;
  while (from <= text.length - phrase.length) {
    const start = text.indexOf(phrase, from);
    if (start === -1) break;
    spans.push({ start, end: start + phrase.length, text: text.slice(start, start + phrase.length) });
    from = start + 1;
  }
  return spans;
}
