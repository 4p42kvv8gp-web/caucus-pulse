# Bounded capture timing experiment

The nominal twenty-minute GitHub schedule has not provided twenty-minute capture. In the measured 24 hours ending September 16, 2026 at 00:51:55 UTC, there were 15 completed captures (6 scheduled, 8 manual dispatches, 1 code push), with a maximum completion gap of 152 minutes 26 seconds. Jobs started within five seconds after creation. The main observed delay was before creation, rather than during collection or while waiting for the writer lock.

This experiment asks whether an independent timed dispatch can reliably start the existing collector. It does not establish permanent scheduling, complete List membership, or a model-quality result.

## Execution and limits

`capture-reliability-pilot.yml` can start manually on main or when its own workflow file is changed on main. There is no cron, self-dispatch, or automatic retry. The controller stops after at most 50 minutes or ten dispatch intents, has a 55-minute runner bound, and checks once a minute. Each dispatch must be at least five minutes after both the latest observed capture attempt and the prior dispatch.

The controller uses only its job's GitHub token, with `actions: write` and `contents: read`; checkout does not retain credentials. It has no X or model credentials. Its only remote mutation is dispatching `poll.yml` on main with `capture_only: true`. That input disables live classification, skips retrieval of existing model batches, and skips additional repost lookup. Capture still uses the existing X credential and read guard, retains complete List pagination, and validates/publishes sources and dashboard data. Ordinary poll behavior is unchanged.

The controller uses a separate concurrency group. Before dispatch it scans all noncompleted workflow statuses with complete pagination; known data writers and unknown workflows block dispatch. It does not restrict that scan to main because writers on other branches share the same data lock. Pages and named read-only checks are excluded. This observation cannot be atomic with dispatch, so the collector's existing `data-writes` lock remains the protection against overlapping writers.

## Receipts and interpretation

Intent is journaled with file and directory synchronization before dispatch. API version `2026-03-10` must return HTTP 200 and the exact workflow run ID and canonical URLs. A timeout, malformed receipt, 204, server error, failed journal write, or unresolved saved intent stops the experiment; there is no blind retry. Definite rejection also stops. Each request is bounded to ten seconds; the experiment allows at most 400 REST requests and 120 decision ticks.

The child must complete and its committed `lastPollAt` must advance after dispatch. `lastPollRunId` and `lastPollRunAttempt` must match that exact child attempt. A green job alone, or a timestamp advanced by another poll, cannot count as a verified capture. Only complete captures update that identity; partial captures retain the previous completed identity, and a completed local run clears it.

The journal and summary are uploaded as a 14-day artifact even when the pilot fails. No source text, credentials, or arbitrary provider error bodies enter the journal. Runner loss before artifact upload can still lose this local journal; never infer that a missing receipt means the dispatch did not occur. A manually rerun workflow is a new experiment, not recovery or permission to duplicate an uncertain action. Review prior run evidence first.

At the deadline an outstanding child is reported as unobserved, not successful, and is not cancelled: it may hold useful capture work. A newer unrelated capture may overwrite the latest run marker before observation; that also stops attribution rather than crediting the wrong child. Report the actual observed run IDs, capture times, gaps and failures. A short successful sample cannot prove unattended reliability or replace appropriate permanent hosting.

GitHub references: [workflow dispatch response](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event), [workflow run listing](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-repository), [schedule limitations](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
