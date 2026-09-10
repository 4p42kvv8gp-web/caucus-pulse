# GitHub's scheduled workflows are not a 20-minute cron

*Measured 2026-09-10, the pipeline's first full day in production.*

`.github/workflows/poll.yml` is scheduled `*/20 * * * *`. It did not run every
twenty minutes. Over 14.5 hours (05:29Z–20:00Z), counting only runs GitHub
started itself and excluding the two dispatched by hand:

| | |
|---|---|
| scheduled runs that fired | **11** |
| runs a 20-minute cron implies | ~44 |
| **delivery rate** | **25%** |
| median gap | 66 min |
| longest gap | **167 min** |
| gaps over an hour | 6 of 10 |

Observed gaps, in minutes: 71, 39, 148, 167, 58, 26, 40, 66, 106, 150.

This is documented behaviour, not a bug in this repo: GitHub states that
scheduled workflows may be delayed during periods of high load and that runs
can be dropped entirely. The nightly showed the same shape — on 2026-09-09 it
fired 4h47m late.

## Why it matters here, and why it is not yet an emergency

**It is not currently losing data.** `src/poll.js` widens to full page size when
the gap exceeds twice the cadence (`adaptivePageSize`, with `minutesSinceLastPoll`),
and both long gaps today were absorbed cleanly: the 144-minute gap captured 151
posts in one run, the 108-minute gap 111 posts. `poll.max_pages` is 10, which
covers the list endpoint's whole ~800-post window.

The failure mode is a **cliff, not a slope**. The list timeline endpoint only
serves roughly the last 800 posts, and the cursor advances to the newest id seen.
A gap long enough for the caucus to publish more than ~800 posts drops everything
beyond the boundary *permanently* — there is no backfill path through this
endpoint. At today's ~500 posts/day the cliff is far away. On a heavy news day
with a 167-minute gap it is closer than it looks, and nothing currently alarms on
approach.

**It also breaks the product promise.** A dashboard read at 7am is only as fresh
as the last poll. A median 66-minute lag with hour-plus gaps means "as of" can be
two hours stale with no indication on the page.

## What was done today

`src/health.js` gained a capture check that WARNs past 2 hours and FAILs past 8,
and names the cause: *"GitHub's cron is running behind the 20-minute schedule."*
That converts a silent lag into a visible one. It does not fix delivery.

## Options, cheapest first

1. **Do nothing, watch the WARN.** Correct while volume stays near 500/day.
   Revisit if daily volume approaches the ~800-post endpoint window.
2. **Alarm on approach to the cliff**, not just on elapsed time — WARN when
   posts captured in one run exceed some fraction of the window, since that is
   the signal that a longer gap would have lost data. Cheap, and it measures the
   thing that actually hurts.
3. **Drive the poll from an external scheduler** (any always-on cron calling the
   `workflow_dispatch` endpoint). Removes the dependency entirely; adds a second
   system to own.
4. **Shorten the cron interval** so that dropped runs matter less. Does not work:
   the drops are not uniformly random, and GitHub deprioritises frequent
   schedules — this tends to make delivery worse, not better.

Option 2 is the one worth doing before option 3, because it is the measurement
that would tell you whether option 3 is needed.

## Caveat

One day, one repository, one account. GitHub's scheduler load varies by time of
day and by region, and today's 25% may not be representative in either
direction. The number to watch is the gap distribution, not the headline rate.
