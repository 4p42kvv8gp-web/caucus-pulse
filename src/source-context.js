// Source completeness is a deterministic observation, separate from a model's
// topic decision. No API, storage writes, clock reads, or text truncation here.
import { createHash } from 'node:crypto';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const numericId = (value) => typeof value === 'string' && /^\d+$/.test(value);
const textPresent = (value) => typeof value === 'string' && value.trim().length > 0;
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validOriginal = (original, referenceId) => object(original) && original.unavailable !== true
  && numericId(original.id) && original.id === referenceId && textPresent(original.text);

// An explicitly provided original must carry its own matching ID. The
// resolver below can establish that ID from an authoritative cache key.
export function sourceContextStatus(post, original = null) {
  if (post?.type !== 'retweet') {
    return { incomplete: false, reason: null, referenceId: null,
      fingerprint: digest({ policy: 'repost-context-v1', type: 'not-a-repost' }) };
  }
  const referenceId = numericId(post.refId) ? post.refId : null;
  const candidates = [post.reposted, original].filter(object);
  const source = referenceId ? candidates.find((candidate) => validOriginal(candidate, referenceId)) : null;
  let reason = null;
  if (!referenceId) reason = 'repost-reference-invalid';
  else if (!source) {
    if (candidates.some((candidate) => candidate.id !== referenceId && candidate.unavailable !== true)) reason = 'repost-original-mismatch';
    else if (candidates.some((candidate) => candidate.id === referenceId && candidate.unavailable !== true && !textPresent(candidate.text))) reason = 'repost-original-empty';
    else reason = 'repost-original-unavailable';
  }
  const incomplete = reason !== null;
  // Keep the original input wording and attribution in the revision key.
  // Engagement, refresh/capture times and provider envelopes cannot reopen it.
  // Diagnostic reasons do not alter the usable source: a serializer may omit
  // an empty/unavailable/mismatched original while keeping the same gap.
  const fingerprint = digest({ policy: 'repost-context-v1', referenceId,
    wrapperText: typeof post.text === 'string' ? post.text : '', incomplete,
    source: source ? { id: source.id, text: source.text,
      authorId: source.authorId ?? null, handle: source.handle ?? null } : null });
  return { incomplete, reason, referenceId, fingerprint };
}

function normalizedOriginal(value, referenceId, capturedWithPost = null) {
  if (!validOriginal(value, referenceId)) return null;
  return { id: value.id, text: value.text, authorId: value.authorId ?? null,
    handle: value.handle ?? null, createdAt: value.createdAt ?? null,
    capturedAt: value.capturedAt ?? capturedWithPost,
    fetchedAt: value.fetchedAt ?? null };
}

// archive is a synchronous (id) => original|null lookup, such as archiveLookup.
// The caller owns any filesystem reads; this helper never fetches missing data.
// Bad embedded/cache entries can fall back to a valid archived original.
export function createRepostResolver({ quoted = {}, archive = () => null } = {}) {
  if (!object(quoted) || typeof archive !== 'function') throw new Error('Invalid repost resolver dependencies');
  return (post) => {
    if (post?.type !== 'retweet' || !numericId(post.refId)) return null;
    const referenceId = post.refId;
    const embedded = normalizedOriginal(post.reposted, referenceId, post.capturedAt ?? null);
    if (embedded) return embedded;
    const cached = Object.hasOwn(quoted, referenceId) ? quoted[referenceId] : null;
    // Legacy quoted cache entries omit id; their numeric key is the source ID.
    const fromCache = object(cached) ? normalizedOriginal({ ...cached, id: cached.id ?? referenceId }, referenceId) : null;
    if (fromCache) return fromCache;
    return normalizedOriginal(archive(referenceId), referenceId);
  };
}
