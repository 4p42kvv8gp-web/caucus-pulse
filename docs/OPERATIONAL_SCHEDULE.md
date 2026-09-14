# Capture, interpretation, and publication

## Nominal schedule

| Work | Schedule | What it actually does |
| --- | --- | --- |
| Capture and live interpretation | Every hour at :07, :27, :47 UTC | Resume the current List interval, persist every page, live-interpret up to 120 pending posts from today/yesterday, retrieve an existing durable batch without submitting a new one, rebuild the dashboard, then publish valid work. |
| Public news acquisition | Every hour at :17 UTC | Refresh the registered feeds/articles without holding the capture writer lock. Publish the resulting public snapshot under the shared writer lock. New evidence reaches live interpretation on a later poll. |
| Nightly pipeline | 07:30 UTC daily, 03:30 EDT / 02:30 EST | Refresh yesterday's ET archive metrics, embed, submit/resume classification across unfinished archived days, then run corrections, syntax, incidents, rollup, report, and dashboard stages. Longer story discovery, promotion, and taxonomy maintenance require manual selection. Classification consumes already acquired public news before sending its requests. |
| Author/account table | Monday 06:00 UTC, 02:00 EDT / 01:00 EST | Refresh author records against the configured roster/List. |

These are scheduled attempts, not measured latency guarantees. GitHub documents delayed or dropped schedule events under high load, default-branch-only schedules, and automatic disabling of inactive public-repository schedules after 60 days. Moving capture away from the top of each hour reduces one documented source of contention; it does not provide continuous ingestion. [GitHub schedule documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

The shared `data-writes` concurrency group admits one publisher/collector at a time. `queue: max` retains up to 100 pending jobs instead of replacing the prior waiter with every new event. A full queue still rejects additional jobs. The news acquisition job has its own group; only its publication waits for `data-writes`. [GitHub concurrency documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

A code/configuration push to main also starts the capture smoke run; news-specific code/configuration pushes start acquisition. Generated data paths do not match these push triggers. Empty nightly stage selection uses the operational defaults; select `stories`, `promote`, `taxonomy-learn`, or `all` explicitly for maintenance. This leaves live named-event detection enabled while reducing capture-lock duration.

## Work persists before a failed run is reported

The poll wrapper preserves the collector's status. Exit 2 means a valid unfinished interval; rate limits, page caps, and recoverable provider errors can therefore leave useful archived pages and continuation state. The following publication step runs on either success or failure. It validates state, every archive file, staged JSON, incident output, and all dashboard feed shards referenced by the manifest before committing. Shard hashes, total row counts, and unique IDs must match. Malformed source bytes prevent publication and are not rewritten or discarded.

The poll then resumes existing model batches with `classify --resume-only`. An empty queue causes no model submission. The nightly default batch wait is zero: one provider status check, followed by a later scheduled retrieval. Live classification handles recent unfinished posts; the nightly planner includes older unfinished dates. A completed batch with rejected/missing rows is still partial; subsequent runs must interpret the unresolved IDs. A provider submission with an uncertain outcome requires reconciliation rather than blind resubmission.

`lastPollAttemptAt` is an attempt; `lastPollSuccessAt` means an API response succeeded; `lastPollAt` means the complete requested interval was captured. Only that last field can represent interval completion. An initial baseline cannot certify the history that preceded it.

Publication validates again after a rebase. A state merge preserves a coherent capture transition: cursor, partial token, counts, outcome, and capture timestamps travel together. Divergent collector transitions fail rather than selecting the largest cursor. The old automatic overwrite of conflicting model results has been removed; classification results and durable request manifests are not disposable regenerated files.

Before a push, the publisher saves a Git bundle containing the validated data commit. Failed publication retains that bundle as a seven-day Actions artifact. An operator can fetch its `HEAD` into a recovery branch, inspect its changes against current main, and reconcile them. A new source/configuration conflict is never resolved by silently choosing the job's version. For news, the public transfer artifact also survives seven days; publication checks that the news base has not changed before applying its snapshot.

## Remaining limits

- The current X source is the configured List endpoint. This does not prove every roster account is present, nor that replies, removed posts, long outages, or provider-window gaps are fully covered. Boundary exhaustion remains an explicit recovery condition.
- The daily engagement refresh is yesterday's ET archive, not a rolling queue that refreshes each post at 24 hours. The dashboard must display observation time rather than imply current totals.
- News evidence is limited to registered publishers, accessible pages, and the acquisition/retrieval windows. Failed fetches and headline-only records remain distinguishable from article passages. Private inbox context is excluded from this public lane.
- Long synchronous downstream nightly stages can still hold the shared writer lock. Zero-minute batch waits and independent news fetches remove two avoidable waits; they do not make all model work instantaneous.
- The poll pipeline step is bounded to 12 minutes inside an 18-minute job. A stage timeout can still publish previously written valid files; cancellation, runner loss, or a hard overall timeout can prevent the publication step. A permanent worker and durable external store would be needed to remove that remaining runner-lifetime risk.
- The offline tests prove partial-publication behavior, strict validation, conflict refusal, snapshot integrity, and safe input handling. They do not prove live X/model credentials, actual scheduler timing, deployed source coverage, or classification accuracy.
