# Quoted context

The owner's rule (2026-09-10): **"a post that is a quote tweet on Coxon's
tweet with millions of views, even if it doesn't mention him, should
count."** Example: [x.com/m_adams/status/2097826241533407539](https://x.com/m_adams/status/2097826241533407539)
quotes Coxon's resignation post `2097476196791709843` (139M impressions) and
lists 22 politicians who replied to it; its own text never says "Coxon".

Until tonight an archive record for a quote or reply kept only `refId`, and
the classifier saw only the post's own text — so posts like that were
misclassified or dropped. Now the post being quoted or answered travels
with the post, and stories can be pinned to the posts they are built
around.

## What a record carries

`src/x.js toRecord(t, capturedAt, includes)` attaches, for `quote` and
`reply` records, the referenced post when the page's `includes` has it:

```json
"quoted": {
  "id": "2097476196791709843",
  "authorId": "2013902543974465536",
  "handle": "hilbertspaess",
  "text": "I resigned from Anthropic today. …",
  "metrics": { "likes": 708063, "retweets": 143632, "replies": 16404, "quotes": 33837, "impressions": 139252407 }
}
```

The shape is unchanged when the referenced post is not in `includes`
(deleted, protected, or the page was fetched without expansions).

## Where the context comes from (`src/quoted.js quotedContext(post)`)

In order — the first source that knows the post wins:

1. **The record itself** — `quoted`, captured with the post when the pager
   asked for referenced-post expansions (below).
2. **`data/quoted.json`** — the side store for posts archived before capture
   carried context, keyed by the quoted/replied-to id:
   `{ authorId, handle, text, metrics, fetchedAt }`, or
   `{ unavailable: true, fetchedAt }` for a post X no longer serves (so it
   is never looked up twice).
3. **The archive** — the quoted post may be a caucus post we already hold (a
   member quoting another member). Its handle comes from `data/authors.json`
   and its metrics from `data/metrics/<day>.json` (the 24h refresh, which
   has impressions) when that has run, else from capture.

`quotedResolver()` builds those sources once per run and caches the day
files it reads; `quotingFor(ctx)` reduces a context to what the classifier
gets. Retweets are not quotes — the classifier inherits their original's
assignment instead — so they resolve to `null`.

## Capture: `includeReferenced`

`listTweetsPage`, `userTweetsPage` and `searchRecent` accept
`{ includeReferenced: true }` → `expansions=referenced_tweets.id,referenced_tweets.id.author_id`
with `user.fields=username`, and return `includes: { tweets, users }`. The
poller (`src/poll.js`) and the member backfill (`src/backfill-members.js`)
pass it; `X_INCLUDE_REFERENCED=false` is the kill switch.

### Cost

X bills every post object returned ($0.005) and every user object ($0.01),
included ones too. `usage` on a page already counts the included posts (a
caller cannot under-bill posts by forgetting them); `userReads` carries the
included user objects, and both go through the daily ledger
(`addUsage`) against `settings.daily_read_budget`.

Measured on the archive as of 2026-09-10 (10,482 posts): 15.3% quotes,
6.7% replies, 16.4% retweets. The expansion returns the referenced post for
all three kinds (X does not filter by reference type), and its author.
For a 100-post page, roughly:

| | objects | cost |
|---|---|---|
| the page itself | 100 posts | $0.50 |
| quotes + replies' referenced posts (~22%) | ~22 posts | $0.11 |
| retweets' originals (~16%, deduped within the page) | ~10-16 posts | $0.05-0.08 |
| referenced authors (deduped) | ~25-35 users | $0.25-0.35 |

So the quotes and replies alone are about **+18-22% in post reads**, which
is the part this feature is for; with the retweet originals X sends anyway
and the author objects at twice the post price, a page can cost up to ~2×
what it did. The 20-minute poll reads a few dozen posts a cycle, so the
absolute number is small; the first day's ledger will show the real ratio
and `X_INCLUDE_REFERENCED=false` turns it off if it is not worth it.
Dropping the author expansion (keep `referenced_tweets.id` only) would
halve the overhead at the price of losing the handle for off-roster
authors — an option if the ratio disappoints.

## Backfill: `src/quotes-backfill.js`

```
node --use-env-proxy src/quotes-backfill.js [--max-reads=N] [--dry-run] [--no-replies]
```

Fetches the DISTINCT referenced ids of quote and reply posts in the archive
that `data/quoted.json` does not know, most-referenced first, via
`lookupTweets(ids, { withText: true })` (batches of 100; one post read per
post returned, one user read per distinct author returned). Ids that are in
the archive themselves are skipped — `quotedContext` resolves them locally,
per the never-re-bill rule. Every batch goes through `addUsage`/`saveState`
before the store is written, the daily budget applies, and the file is
written after every batch, so a stopped run resumes where it left off.

Run on 2026-09-10 from the `claude/night-quoted-context` worktree: 1,944
distinct referenced ids in the archive, 572 already archived, 1,372 to
fetch — see the commit for the reads actually billed (the run was capped at
3,000 post reads and finished well under it).

## Classifier input

`chunkRequests` (nightly) and `classify-live` send each post as

```json
{"id": "…", "text": "…", "quoting": {"handle": "hilbertspaess", "text": "<= 400 chars", "impressions": 139252407}}
```

when context exists, and exactly `{"id", "text"}` otherwise. `impressions`
is present only when known (an archived original without its 24h refresh
has none; 0 would read as "no reach"). The system prompt carries one extra
rule, static text so the cached block stays byte-identical between runs:

> Some inputs carry "quoting": the post this one quotes or replies to
> (handle, text, impressions). A quote or reply is about the subject of the
> post it quotes/answers (assign that subject and its story) in addition to
> whatever its own text adds; a quoted post with very high reach is a strong
> signal the story is live.

## Story anchors

A taxonomy subtopic may carry `anchors: [tweet ids]` — the posts a story is
built around. `planDay` (nightly) and `classify-live` assign the story
deterministically, before the model, to any post whose `refId` (quote or
reply) or retweeted id is an anchor (and to the anchor post itself if it is
a caucus post), then merge with the model's output — the model still runs
for the post's own additional topics. An anchored post is classified by
definition: it leaves `unclassified` and the emerging clusters. The day
file records the anchor assignments under `anchored` so a reader can tell a
rule from a judgment. `renderTaxonomy` prints `[anchored]` for such
stories; the ids never reach the prompt.

### Pending: the Coxon anchor

`config/taxonomy.yaml` had no `coxon-resignation` key tonight and is being
rewritten by another process, so it was not edited here. When the story key
exists, the taxonomy owner should add:

```yaml
    coxon-resignation:
      label: Jacob Coxon resignation
      story: true
      since: 2026-09-08
      anchors: ["2097476196791709843"]   # the resignation post, 139M impressions
```

(The same mapping sits in a comment above `anchorIndex` in
`src/taxonomy.js`.) Fourteen archived posts quote that id today; each
becomes `tech/coxon-resignation` the next time its day is classified.

### Deriving anchors from candidates

`src/stories.js scoreCandidates` now emits `topQuoted: [{ id, n }]` per
candidate — the most-referenced `refId`s among its posts (quotes, replies
and retweets) with counts — so the auto-promotion pass can write a
candidate's dominant quoted post as the new story's `anchors:` when it
promotes it.

## Limits

- **Context is one hop.** A reply to a reply carries the post it answers,
  not the thread root; a quote of a quote carries the middle post.
- **Text is capped at 400 characters** for the model; the store keeps the
  full text.
- **Unavailable posts stay unavailable.** A deleted or protected quoted post
  is recorded as such and never re-billed; if it comes back (a protected
  account opening up), delete its entry from `data/quoted.json` to retry.
- **Metrics are a snapshot** at fetch time (`fetchedAt`), not refreshed.
