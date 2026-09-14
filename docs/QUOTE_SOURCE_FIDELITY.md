# Complete quoted context and bounded interpretation

Ordinary quote/reply inputs now preserve the original post's complete captured
wording, source ID, author, handle and creation time. The old 400-character cut
discarded qualifications and story details, and the resolver also omitted the
original date. These changes apply when an input next reaches classification;
they do not automatically reopen every accepted historical interpretation.

The source resolver tries embedded context, the shared cache and then the
archive. A legacy embedded/cache record without its own ID can use the matched
reference ID. An explicit mismatch, blank text or unavailable record cannot be
relabeled as a valid source; resolution continues to the next source. Unknown
dates stay null. Provider envelopes remain in storage, outside the model input.

The prompt distinguishes the member's post time from the quoted/reposted
original's time. Relative wording in the original belongs to its original
date. A new repost establishes renewed attention, not proof that a previously
reported service suspension or warning remains current.

Two archived examples illustrate the information loss. Becca Balint's
[September 14 quote](https://x.com/i/web/status/2099577178576884201) contains a
1,136-character original; the former cut omitted details about China, Google,
Finland, permitting and data centers. Laura Gillen's
[September 14 quote](https://x.com/i/web/status/2099572340568776885) contains a
678-character original dated August 25; previously the classifier saw the
member's “New Report” wording without that original date. Tests verify complete
wording and dates against the stored source records. They do not establish that
a model's classification improves, and no extra historical inference calls are
triggered merely by these examples.

## Source receipts

The request manifest derives `quotedContextByPost` from the actual submitted
JSONL. Accepted results retain a compact `provenance.quotedContext` containing
the original ID, attribution, date, full-text character count and SHA-256 text
hash. It is a receipt for input supplied to the model, not independent source
verification or evidence that the model reasoned correctly. The source wording
itself remains in the archive/cache. Older requests without an original ID
remain readable but do not acquire invented source provenance.

## Oversized inputs

`planChunkRequests` returns sendable requests and per-post `inputBlocks`.
It measures the exact serialized JSONL, including line separators, and caps
each request at 120,000 characters as well as the existing post/evidence limits.
A single oversized source stays intact in storage and is excluded from API
submission. It remains pending with `reason: input-too-large`, input size,
limit and a hash of the complete serialized input. Ordinary sources proceed;
blocked sources do not consume the live inference allowance.

Live, nightly and range paths persist these diagnostics before provider calls.
Batch resumes retain them. A newly evaluated input that fits, a later accepted
result, or an authoritative human correction clears the corresponding block.
Clearing a size block does not mark a still-pending interpretation complete.
Requests containing only blocked
inputs make no inference calls. The compatibility `chunkRequests` wrapper
throws when any source would be excluded, so other callers cannot silently
lose records by ignoring the new diagnostics. No path silently truncates the
source to fit.

Missing parent context does not automatically make every quote or reply
unclassifiable: the member's own statement may be self-contained. The existing
model ambiguity rule remains. Reposts retain their separate deterministic
missing-original rule.

Validation covers complete source text/dates/identity through every resolver,
invalid-source fallback, actual public examples, exact request boundaries,
oversized-only zero calls, mixed live and batch workloads, durable diagnostics,
corrections and source-receipt integrity. Semantic quality still requires
separate evaluation of actual model answers.
