import { createHash } from 'node:crypto';
import { atomic } from './sqlite.js';

export const LANGUAGE_VERSION = 'exact-passages-v1';
export const LANGUAGE_LIMITS = Object.freeze({ posts: 500, characters: 200_000, tokens: 40_000,
  candidates: 300, candidateCharacters: 500_000, scanCharacters: 20_000_000,
  matchChecks: 100_000, occurrencesPerGroup: 200, responseCharacters: 1_000_000 });

const wordPattern = /^[\p{L}\p{N}\p{M}]/u;
function tokenize(text) {
  const segments = []; let from = 0;
  for (const url of text.matchAll(/https?:\/\/[^\s]+/giu)) {
    segments.push({ start: from, end: url.index }); from = url.index + url[0].length;
  }
  segments.push({ start: from, end: text.length });
  return segments.map(segment => {
    const tokens = [...text.slice(segment.start, segment.end).matchAll(/[\p{L}\p{N}\p{M}]+(?:['’][\p{L}\p{N}\p{M}]+)*|\s+|[^\p{L}\p{N}\p{M}\s]+/gu)]
      .map(m => ({ value: m[0], start: segment.start + m.index, end: segment.start + m.index + m[0].length, word: wordPattern.test(m[0]) }));
    return { ...segment, tokens, wordStarts: new Set(tokens.filter(t => t.word).map(t => t.start)),
      wordEnds: new Set(tokens.filter(t => t.word).map(t => t.end)) };
  }).filter(s => s.tokens.length);
}

// Prefix doubling and Kasai LCP avoid enumerating every possible n-gram.
function suffixes(values) {
  const n = values.length; const order = Array.from({ length: n }, (_, i) => i);
  let ranks = values.slice();
  for (let width = 1; width < n; width *= 2) {
    const compare = (a, b) => ranks[a] - ranks[b] || (ranks[a + width] ?? -1) - (ranks[b + width] ?? -1);
    order.sort(compare);
    const next = new Int32Array(n);
    for (let i = 1; i < n; i++) next[order[i]] = next[order[i - 1]] + (compare(order[i - 1], order[i]) !== 0 ? 1 : 0);
    ranks = next;
    if (ranks[order[n - 1]] === n - 1) break;
  }
  const positions = new Int32Array(n); order.forEach((offset, rank) => { positions[offset] = rank; });
  const lcp = new Int32Array(n); let length = 0;
  for (let offset = 0; offset < n; offset++) {
    const rank = positions[offset];
    if (!rank) { length = 0; continue; }
    const prior = order[rank - 1];
    while (offset + length < n && prior + length < n && values[offset + length] === values[prior + length]) length++;
    lcp[rank] = length; if (length) length--;
  }
  return { order, lcp };
}
function equalRunEnds(values) {
  const ends = new Int32Array(values.length);
  for (let i = values.length - 1; i >= 0; i--) ends[i] = i + 1 < values.length && values[i] === values[i + 1] ? ends[i + 1] : i;
  return ends;
}

function candidatePassages(documents, minWords, limits) {
  const tokens = []; const symbols = new Map(); const contexts = new Map();
  const intern = (map, value) => { if (!map.has(value)) map.set(value, map.size); return map.get(value); };
  for (let owner = 0; owner < documents.length; owner++) {
    const doc = documents[owner];
    for (const segment of doc.segments) {
      let previousWord = null;
      for (const token of segment.tokens) {
        const left = previousWord ? doc.post.text.slice(previousWord.start, token.start) : Symbol('source boundary');
        tokens.push({ ...token, owner, symbol: intern(symbols, token.value), left: intern(contexts, left) });
        if (token.word) previousWord = token;
      }
      tokens.push({ word: false, owner: -1, symbol: intern(symbols, Symbol('source boundary')), left: -1 });
    }
  }
  const { order, lcp } = suffixes(tokens.map(t => t.symbol));
  const ownerEnds = equalRunEnds(order.map(i => tokens[i].owner));
  const leftEnds = equalRunEnds(order.map(i => tokens[i].left));
  const priorWord = new Int32Array(tokens.length); const wordCount = new Int32Array(tokens.length + 1);
  let prior = -1;
  tokens.forEach((t, i) => { if (t.word) prior = i; priorWord[i] = prior; wordCount[i + 1] = wordCount[i] + (t.word ? 1 : 0); });
  const phrases = new Map(); let characters = 0; let limited = false;
  const stack = [];
  for (let i = 1; i <= order.length; i++) {
    const depth = lcp[i] ?? 0; let left = i - 1;
    while (stack.length && stack.at(-1).depth > depth) {
      const node = stack.pop(); left = node.left;
      const start = order[node.left]; const end = priorWord[start + node.depth - 1];
      if (!tokens[start].word || end < start || ownerEnds[node.left] >= i - 1 || leftEnds[node.left] >= i - 1) continue;
      const words = wordCount[end + 1] - wordCount[start];
      if (words < minWords) continue;
      const phrase = documents[tokens[start].owner].post.text.slice(tokens[start].start, tokens[end].end);
      if (phrases.has(phrase)) continue;
      if (phrases.size >= limits.candidates || characters + phrase.length > limits.candidateCharacters) { limited = true; continue; }
      phrases.set(phrase, words); characters += phrase.length;
    }
    if (depth && (!stack.length || stack.at(-1).depth < depth)) stack.push({ depth, left });
  }
  return { phrases, limited };
}

function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}.`);
}

export function discoverLanguage(posts, { minWords = 3, minMembers = 1, limit = 40, limits = LANGUAGE_LIMITS } = {}) {
  integer(minWords, 'minimum phrase words', 2, 100); integer(minMembers, 'minimum members', 1, 500); integer(limit, 'phrase limit', 1, 100);
  // Callers may narrow resource ceilings for a smaller device or test; never silently raise them.
  limits = { ...LANGUAGE_LIMITS, ...limits };
  for (const key of Object.keys(limits)) integer(limits[key], 'language resource limit', 1, LANGUAGE_LIMITS[key] ?? 0);
  const documents = []; const seen = new Set(); let characters = 0; let tokens = 0;
  let excludedReposts = 0; let omittedPosts = 0;
  const ordered = [...posts].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  for (const post of ordered) {
    if (seen.has(post.id)) continue; seen.add(post.id);
    if (post.type === 'repost') { excludedReposts++; continue; }
    if (documents.length >= limits.posts || characters + post.text.length > limits.characters) { omittedPosts++; continue; }
    const segments = tokenize(post.text);
    const size = segments.reduce((sum, segment) => sum + segment.tokens.length + 1, 0);
    if (tokens + size > limits.tokens) { omittedPosts++; continue; }
    documents.push({ post, segments }); characters += post.text.length; tokens += size;
  }
  const candidates = candidatePassages(documents, minWords, limits);
  const groups = []; let scanCharacters = 0; let matchChecks = 0; let scanLimited = false;
  for (const [phrase, wordCount] of candidates.phrases) {
    const occurrences = []; const postIds = new Set(); const memberIds = new Set(); let count = 0; let first = null; let last = null;
    for (const { post, segments } of documents) {
      scanCharacters += post.text.length;
      if (scanCharacters > limits.scanCharacters) { scanLimited = true; break; }
      for (const segment of segments) {
        let from = segment.start;
        while (from < segment.end) {
          if (++matchChecks > limits.matchChecks) { scanLimited = true; break; }
          const start = post.text.indexOf(phrase, from);
          if (start < 0 || start + phrase.length > segment.end) break;
          const end = start + phrase.length;
          if (segment.wordStarts.has(start) && segment.wordEnds.has(end)) {
            postIds.add(post.id); if (post.memberId) memberIds.add(post.memberId); count++;
            first = first === null || post.createdAt < first ? post.createdAt : first;
            last = last === null || post.createdAt > last ? post.createdAt : last;
            if (occurrences.length < limits.occurrencesPerGroup) occurrences.push({ postId: post.id, sourceHash: post.contentHash,
              memberId: post.memberId ?? null, createdAt: post.createdAt, postType: post.type, start, end,
              wordingRole: post.type === 'quote' ? 'quote-post-caption' : 'source-caption',
              interpretation: 'Authorship of embedded quotations and stance are not assessed.' });
          }
          from = start + 1;
        }
        if (scanLimited) break;
      }
      if (scanLimited) break;
    }
    if (scanLimited) break; // Do not present incomplete occurrence counts as complete.
    if (postIds.size < 2 || memberIds.size < minMembers) continue;
    occurrences.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.postId.localeCompare(b.postId) || a.start - b.start);
    groups.push({ id: createHash('sha256').update(phrase).digest('hex'), phrase, wordCount,
      matchingPosts: postIds.size, distinctMembers: memberIds.size, occurrenceCount: count,
      firstObservedInSelection: first, lastObservedInSelection: last, occurrences,
      occurrencesOmitted: count - occurrences.length });
  }
  // Source chronology determines presentation. These are observations, not importance rankings.
  groups.sort((a, b) => b.lastObservedInSelection.localeCompare(a.lastObservedInSelection) || a.phrase.localeCompare(b.phrase));
  let sources = documents.map(({ post }) => ({ id: post.id, memberId: post.memberId, memberName: post.memberName,
    sourceHash: post.contentHash, sourceUrl: post.sourceUrl, createdAt: post.createdAt, type: post.type,
    text: post.text, textCoverage: post.textCoverage, contextCoverage: post.contextCoverage,
    provenanceKind: post.provenance?.kind ?? 'unresolved', identityNote: post.identityNote ?? 'Attribution not verified' }));
  const returned = []; let responseCharacters = JSON.stringify({ groups: [], sources }).length;
  let responseLimited = responseCharacters > limits.responseCharacters;
  if (responseLimited) sources = []; // Retain complete text in the archive; never return a silently cut source.
  for (const group of groups.slice(0, limit)) {
    if (!sources.length) break;
    const size = JSON.stringify(group).length + 1;
    if (responseCharacters + size > limits.responseCharacters) { responseLimited = true; break; }
    returned.push(group); responseCharacters += size;
  }
  return { version: LANGUAGE_VERSION, method: 'Exact repeated passages', groups: returned,
    sources,
    coverage: { analyzedPosts: documents.length, analyzedCharacters: characters, excludedReposts, omittedPosts,
      candidateLimitReached: candidates.limited, scanLimitReached: scanLimited, responseLimitReached: responseLimited,
      discoveredGroups: groups.length, groupsOmittedFromResponse: groups.length - returned.length,
      partial: omittedPosts > 0 || candidates.limited || scanLimited || responseLimited,
      limits, minWords, minMembers },
    note: 'Exact, case-sensitive repeated passages in this bounded selection. Words, negation, punctuation, and spacing are preserved. URLs are discovery boundaries; full source text remains available. Reposts are excluded. Counts describe observed posts and attributed members, not agreement, coordination, novelty, or verified breaking news. Paraphrases and embedded quotation meaning are not assessed.' };
}

export function languageData(store, filters = {}, options = {}) {
  const now = options.now ?? Date.now();
  const hours = options.windowHours ?? 24; integer(hours, 'language window hours', 1, 744);
  const untilMs = filters.until ? Date.parse(filters.until) : now;
  const sinceMs = filters.since ? Date.parse(filters.since) : untilMs - hours * 3_600_000;
  if (![untilMs,sinceMs].every(Number.isFinite) || sinceMs >= untilMs || untilMs - sinceMs > 31 * 86_400_000) throw new Error('Invalid language date window: choose up to 31 days.');
  const since = new Date(sinceMs).toISOString(); const until = new Date(untilMs).toISOString();
  const bounds = { query: 2000, memberId: 150, topic: 100, subtopic: 160, type: 20 };
  for (const [key, max] of Object.entries(bounds)) if (filters[key] !== undefined && (typeof filters[key] !== 'string' || filters[key].length > max)) throw new Error('Invalid language filter.');
  if (filters.type && !['original','reply','quote','repost'].includes(filters.type)) throw new Error('Invalid post type.');
  const labels = `COALESCE(json_extract((SELECT feedback_json FROM feedback f WHERE f.post_id=p.id AND f.source_hash=p.content_hash ORDER BY sequence DESC LIMIT 1),'$.labels'),json_extract(n.analysis_json,'$.labels'),'[]')`;
  const member = `COALESCE(json_extract(p.attribution_json,'$.memberId'),a.member_id)`;
  const where = ['p.created_at>=?', 'p.created_at<?']; const values = [since, until];
  if (filters.query) { where.push('instr(lower(p.text),lower(?))>0'); values.push(filters.query); }
  if (filters.memberId) { where.push(`${member}=?`); values.push(filters.memberId); }
  if (filters.type) { where.push('p.type=?'); values.push(filters.type); }
  if (filters.topic || filters.subtopic) {
    const matches = [];
    if (filters.topic) { matches.push("json_extract(label.value,'$.topic')=?"); values.push(filters.topic); }
    if (filters.subtopic) { matches.push("json_extract(label.value,'$.subtopic')=?"); values.push(filters.subtopic); }
    where.push(`EXISTS (SELECT 1 FROM json_each(${labels}) label WHERE ${matches.join(' AND ')})`);
  }
  const from = `FROM posts p JOIN accounts a ON p.author_id=a.author_id LEFT JOIN analyses n ON n.post_id=p.id WHERE ${where.join(' AND ')}`;
  const { counts, rows } = atomic(store.db, () => {
    const counts = store.db.prepare(`SELECT COUNT(*) AS selected,COALESCE(SUM(p.type='repost'),0) AS reposts ${from}`).get(...values);
    // Stream at most 500 rows; reject oversized text in SQL before it reaches JavaScript.
    const cursor = store.db.prepare(`SELECT p.id,CASE WHEN length(CAST(p.text AS BLOB))<=${LANGUAGE_LIMITS.characters * 4} THEN p.text ELSE NULL END AS text,p.type,p.created_at,p.content_hash,${member} AS member_id,
    COALESCE(json_extract(p.attribution_json,'$.memberName'),a.member_name) AS member_name,
    COALESCE(json_extract(p.attribution_json,'$.identityNote'),a.identity_note) AS identity_note,
    json_extract(p.normalized_json,'$.contextCoverage') AS context_coverage,
    json_extract(p.normalized_json,'$.textCoverage') AS text_coverage,
    json_extract(p.normalized_json,'$.provenance.kind') AS provenance_kind
      ${from} AND p.type<>'repost' ORDER BY p.created_at DESC,p.id DESC LIMIT ?`).iterate(...values, LANGUAGE_LIMITS.posts);
    const rows = []; let characters = 0;
    for (const row of cursor) {
      if (row.text === null || characters + row.text.length > LANGUAGE_LIMITS.characters) continue;
      rows.push(row); characters += row.text.length;
    }
    return { counts, rows };
  });
  const posts = rows.map(p => ({ id: p.id, text: p.text, type: p.type, createdAt: p.created_at, contentHash: p.content_hash,
    memberId: p.member_id, memberName: p.member_name, identityNote: p.identity_note,
    contextCoverage: p.context_coverage, textCoverage: p.text_coverage,
    sourceUrl: `https://x.com/i/web/status/${p.id}`, provenance: { kind: p.provenance_kind } }));
  const result = discoverLanguage(posts, options);
  const selectionOmissions = counts.selected - counts.reposts - rows.length;
  return { ...result, generatedAt: new Date(now).toISOString(), window: { since, until }, filters,
    coverage: { ...result.coverage, selectedPosts: counts.selected, excludedReposts: counts.reposts,
      omittedPosts: result.coverage.omittedPosts + selectionOmissions, partial: result.coverage.partial || selectionOmissions > 0,
      queryMatching: 'SQLite case-insensitive matching folds ASCII letters; exact passage discovery preserves Unicode source text.' } };
}
