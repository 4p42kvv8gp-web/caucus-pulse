# Indexed explorer

Implemented September 8, 2026. This replaces full-archive JavaScript hydration in the dashboard with indexed selection, bounded pages, and SQL rollups. It does not change the visual design or activate collection/model requests.

## API

`GET /api/posts` returns `posts`, normalized `filters`, `searchNote`, and `page`. The dashboard endpoint accepts the same filters and pagination while also returning archive coverage, full-selection topic rollups, and operations.

Filters: `query` (up to 2,000 characters), `memberId`, `accountType` (official/personal/campaign/unverified), `type` (original/reply/quote/repost), `topic`, `subtopic`, `since`, and `until`. Date windows include the start and exclude the end. Topic and subtopic must match the same label. Original available text remains unchanged.

Pagination defaults to 50 posts and permits 1–100 via `limit`. Pass the returned `page.nextCursor` as `cursor` with the same filters. Cursors use `(created_at, string post ID)` in descending order, never numeric conversion of X IDs. `page.totalPosts` counts the entire filtered selection; topic/member counts also cover that selection, independently of the current page. Archive-wide statistics remain separate.

The cursor contains the selection fingerprint and archive revision. New posts, edits, analysis/review changes, attribution changes, and removals invalidate it. The server returns HTTP 409 with `code: EXPLORER_CHANGED`; the caller must refresh rather than combine inconsistent pages. Cursor state is navigation, not authentication or an access credential.

The existing interface now offers Older posts and Back to newest posts. It freezes the date filters across pages, returns to current results after a revision conflict, and pauses automatic refresh while reading older pages or editing a review. The header makes the older-page pause visible. Newest results otherwise refresh once a minute. No HTML/CSS redesign was performed; visual browser verification remains pending.

## Storage and correctness

Schema 6 maintains disposable `post_search`, label, and FTS5 trigram indexes using database triggers. The authoritative source archive and feedback records remain separate. All index mutations share the originating write transaction; rollback, deletion, and current-source review precedence apply to both. Opening an older database backfills the indexes without replacing source or review records. All writers must use `openStore`, which registers the deterministic lowercase function used by the triggers.

Search lowercases Unicode using JavaScript's locale-independent `toLowerCase`. It preserves accents, punctuation, whitespace, negation, and literal query operators. Queries of at least three Unicode code points use a trigram candidate index plus an exact substring check over the lowercase projection. Shorter queries scan the text projection in SQLite and disclose `short-substring-scan`; they do not hydrate the archive in JavaScript. There is no stemming, synonym expansion, paraphrase interpretation, or NFC normalization.

The source browser payload omits the raw provider object inside SQLite before deserialization. Complete available post text, references, provenance, analyses, and review history remain available for returned posts. Per-post source text and review history are not capped by this change; page-size limits are not a strict byte budget.

Current accepted feedback replaces provisional labels, including accepted empty-label decisions. Edits invalidate old feedback. Topic totals deduplicate posts across subtopics; member totals use stored per-post identity and deduplicate multiple accounts. Query summaries return labels attached to all selected posts, including their other topics.

## Verified and remaining

All 88 Node tests pass, including 11 explorer cases covering long text, large IDs, pagination boundaries, revision conflicts, literal Unicode search, current correction precedence, filters, SQL query plans, transactional rollback, migration/reopen, source removal, and HTTP responses. A synthetic in-memory 10,000-post check hydrated only 50 posts per request; the full view took about 7 ms and a 500-match text query about 9 ms on the development machine. These are fixture observations, not hosted performance guarantees.

Remaining scale work includes bounded exact-phrase lookup, bounded reviewed-example retrieval, byte-aware post/history delivery, aggregate caching if measured necessary, and production disk/resource monitoring. The internal `listPosts` compatibility API still returns all matching posts for its callers; it is no longer used by the dashboard. Short-query scans and full-selection counts can still become expensive on very large archives. Deletion removes logical search entries; database/WAL/backup sanitization remains deployment work.
