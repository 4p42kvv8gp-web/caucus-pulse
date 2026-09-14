# Recovering missing repost originals

After a successful capture has been published, the same serialized poll job
can acquire one batch of at most 25 missing original posts referenced by
reposts created in the latest 24 hours. This limit counts requested IDs,
including IDs omitted from the response. The selector deduplicates wrappers
and reference IDs, prioritizes the most referenced originals, and checks
embedded sources, the shared cache, and the existing archive first. Originals
embedded in another captured wrapper are copied into the shared cache without
a lookup. Quotes/replies and older history are outside this lane.

The lookup uses the existing X credentials and full-wording fields, including
long-form post text and original creation time. It preserves the member's
wrapper separately from the original's wording. The side cache keeps the
original ID, author, handle, source envelope, metrics and acquisition time.
Already usable cache records are never replaced by this gap-filling lane.

## Restart and failure behavior

`data/repost-acquisition.json` holds exact requested IDs, immutable request and
response fingerprints, timestamps, raw successful X responses, and per-ID
outcomes. Intent is committed before the request. The returned response is
committed before writing the cache or applying usage. Only then are derived
stores saved and published. The poll's capture commit precedes all of this;
an acquisition failure cannot erase the completed capture.

Usage increments and their response-bound application marker live in the
same atomic `data/state.json` write. A saved response can replay without a new
lookup or repeated accounting, even the next day. The response's observation
date determines its usage day. Concurrent branches applying the same new
receipt fail publication rather than adding that usage twice. Inconsistent
or corrupt receipts fail closed. Recovery artifacts retain receipts, cache,
state and the validated commit bundle when a job fails.

A missing response after intent remains an uncertain submission and is never
retried automatically. An unexplained per-ID omission also remains unresolved
and awaits review; it does not become a deleted/protected-post claim. The
workflow reports newly unresolved or uncertain results as failures after
preserving its work. Later runs log outstanding review counts while proceeding
with other eligible originals. No scheduled run resets these receipts.

A definite HTTP 429 is different: it records a rejected request and defers
all new original lookups until the provider reset, with a minimum 20-minute
backoff. A later run may make one bounded attempt after that time. No original
is marked unavailable merely because the endpoint rejected a request.

Unavailable cache entries require an exact requested `resource_id`,
`resource_type: tweet`, and the allowlisted `resource-not-found` or
`not-authorized-for-resource` problem URI. If present, `parameter` must be
`ids`. Contradictory errors remain unresolved. The observation means unavailable
under this access at this time, not proven permanent deletion. Existing legacy
unavailable cache records remain excluded from automatic lookup.
See the [X error documentation](https://docs.x.com/x-api/fundamentals/response-codes-and-errors)
and [lookup schema](https://docs.x.com/x-api/posts/get-posts-by-ids).

## Interpretation and display

The poll rebuilds the source display after acquisition without making a second
classification pass. The next ordinary live/nightly pass can reconsider a
previously accepted repost once its usable original wording has arrived, using
the submitted-versus-observed context fingerprints described in
[SOURCE_COMPLETENESS.md](SOURCE_COMPLETENESS.md). Earlier interpretations and
human corrections remain intact. Source recovery is not proof that an existing
label is correct, and classification lag still depends on the next poll.

`node src/repost-acquire.js --plan` is read-only. Execution requires the shared
Actions job; this is not a standalone scheduler. No acquisition result should
be called verified live until a production receipt, cache entry and subsequent
classification/display have been checked.

Tests cover selection boundaries and deduplication, local-source reuse, full
wording/raw responses, one-batch bounds, explicit versus ambiguous errors,
endpoint cooldown, crash replay, uncertain submissions, usage idempotence,
concurrent usage conflicts, and capture-before-acquisition workflow ordering.
