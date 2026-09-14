# Classification integrity and recovery

Live, nightly, and range classification use the same request builder, correction examples, response validator, and day-merging logic. This change concerns faithful record processing; it does not establish model accuracy or validate an event against an independent source.

Each request carries source post IDs as strings. The response must include every requested ID exactly once. Unknown IDs, duplicate assignments, malformed topics, unknown subtopics, invalid incident fields, refusals, truncated responses, and omitted IDs cannot silently become completed work. Valid rows from a partial response can be saved; the remaining source IDs stay pending. Emerging event references must point to accepted records from the same request. Incident names are preserved.

The files in `data/topics/` and `data/topics-live/` retain their existing assignments, incidents, and emerging fields and add:

- `pendingIds`: records still requiring a successful interpretation.
- `complete`: whether that file covers every archived record in its plan.
- `validationErrors` and `requestStatus`: response diagnostics for the most recent attempt.
- `provenance[id]`: the context version, exact public-source lines supplied for that post, source IDs the model said it used, and submitted request hash. Reposts that inherit an interpretation carry `inheritedFrom`; these are not additional model decisions or independent reporting.
- `needsContext[id]`: whether an accepted response explicitly left a reference or event identity unresolved. A broad or empty assignment is also eligible for later reconsideration.
- `contextVersion`: the highest accepted per-post version in that file, not a claim that the whole day was classified using that version. Use per-post provenance for that question.

An accepted empty topic array is a completed classification. An absent result is pending. A deterministic story anchor can supply a useful label while the model interpretation remains pending. A known story or broad topic does not suppress a different supported emerging event. Existing correction overrides remain authoritative when a pending response arrives later.

`data/classification-batches.json` is durable runtime state and must be included in scheduled data commits. It stores the original dates, model, taxonomy snapshot, exact request membership, request hashes, active batch ID, and completed batch IDs. Nightly and range runs share this queue. A local exclusive lock prevents two runner processes using the same queue path from submitting concurrently. Locks live in the operating system temporary directory, outside git-backed data. A lock left by a killed process fails closed and names its recovery path; verify that its owner has exited before removing it. Separate hosts/checkouts still require scheduler-level serialization. Pending batches are retrieved before another batch can be submitted, even after the date or requested range changes. `--sync` also respects an existing batch. It does not cancel and duplicate that work.

The default `CLASSIFY_MAX_WAIT_MINUTES=0` polls a batch once and returns `pending` if the provider has not finished. A later scheduled invocation resumes it. After results arrive, a partial day remains eligible for another invocation, which submits only unresolved records. The runner finishes queued dates before handling newer requested dates; schedulers must invoke it again to drain further work.

Before submission, the queue records an intent. Explicit provider rejection or an instrumented preflight rejection clears an unsent intent. A network timeout or uncertain provider response retains `submission-unknown` and stops automatic resubmission. Reconcile the provider batch ID before retrying; do not delete an uncertain intent merely because no local ID was returned. Existing legacy pending pointers are migrated conservatively from archive order and marked `reconstructedManifest`; releases before this change did not store an exact manifest.

Live classification retries unfinished records from today and yesterday on each poll, including a poll with no new posts. `CLASSIFY_LIVE_MAX_POSTS` defaults to 120 per poll; other unresolved records remain pending. Older unfinished dates are handled by nightly/range runs. Missing credentials or disabled live classification preserve pending records without making a model call. Completed live records are not repeatedly sent. Nightly settled interpretations replace provisional live interpretations when combining the two for retry planning.

The prompt includes post timestamps, distinguishes named events from broad categories, and describes configured examples as mixed-provenance precedents. It treats source text as evidence rather than instructions and does not treat impression counts as proof of truth or recency. These are prompt constraints, not a measured guarantee of factual accuracy.

## Public news and reconsideration

Live, nightly and range runs load one public news snapshot through `news-context.js`. Each selected post can receive up to two retrieved sources. Requests split at 40 posts or 12 evidence lines so a later post does not silently lose the context that triggered reconsideration. Missing news leaves the normal source-post classification path available. No inbox metadata is read by this path.

The prompt distinguishes fetched reports from headline-only leads, asks for unresolved references to stay unresolved, and explicitly labels later reporting as later context. `evidence_used` is validated against **only the source IDs supplied on that post's line**. A forged ID, another post's source, duplicate citation or malformed uncertainty flag rejects that assignment and leaves it pending. Membership validation cannot establish that the model actually used the source appropriately; the displayed source passage remains available for review.

The saved batch manifest contains the exact compact excerpts, dates, URLs, context versions and request hash. Resuming a batch validates against that saved evidence even if the news store has changed. A correction arriving while inference is running is re-read before publication and preserves reviewed topics, incident state, emerging labels and provenance.

When the store changes, a completed macro-only, empty or explicitly uncertain post is reopened only if a newer relevant source passes the news retriever's reconsideration threshold. The previous accepted assignment remains visible while a failed reconsideration stays pending. Successful interpretation stamps the new version, so unchanged or unrelated news does not repeatedly trigger inference. Candidate lists in `data/news/reconsider.json` are diagnostic; the classifier recomputes relevance from the store instead of trusting a potentially stale list. This is lexical retrieval, not a guarantee of coverage or event understanding.

Live runs share the batch-queue lock and omit every ID already present in a durable batch manifest, including an uncertain submission. The queue is resumed through `node src/classify.js --resume-only`; this retrieves existing work but never starts a new batch or requests credentials when the queue is empty. A newer completed live interpretation can supersede older nightly context, while reviewed corrections remain authoritative.

No live model evaluation or factual-accuracy score has been established by these changes. Tests use invented articles and model responses to verify data handling, source attribution, restart behavior and correction authority. Real named-event precision, missing-reference handling and temporal accuracy still require reviewed production examples.

Run the offline regressions with:

```sh
node --test test/classification-news.test.js test/classification-integrity.test.js test/classify-range.test.js test/classify-candidates.test.js test/quoted.test.js test/corrections.test.js
```

The regression clients return synthetic responses and use temporary files. They do not call the model API, change archived production data, or prove live provider credentials/scheduling. The main tests cover response membership, partial replies, retries, incident names, emerging persistence across midnight, provider uncertainty, budget rejection, completed-batch replay prevention, synchronous checkpoints, and live backlog limits.
