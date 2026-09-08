# Reading operational status

The Coverage & budget view now puts setup and processing status before detailed counts. `GET /api/operations` returns the same archive-wide summary for an authenticated operator. It contains no source text, account names, post identifiers or credentials and performs no provider calls. Dashboard filters do not hide an archive-wide fault.

## What the summary distinguishes

| Status | Meaning and next step |
| --- | --- |
| Automatic collection off | No repeating collection service is installed. Enabling bounded passes in configuration does not create a scheduler. |
| Token present | A private credential is available; this does not prove access, price or account balance. |
| Spending blocked | Resolve any recorded operational fault or uncertain request first. Otherwise obtain a fresh verified balance and remain within daily/pilot/reserve limits. A local total cannot substitute for provider credit. |
| Account evidence incomplete | Refresh the dated House observation and complete the List scan; investigate captured accounts that still lack supported ownership. Current bindings alone do not prove complete coverage. |
| Model starting | The local runtime is loading. Source posts and earlier results remain readable. |
| Model unavailable | Inspect the selected model files, process status and last failure. Avoid repeatedly creating competing model processes. |
| Processing incomplete | Pending work can finish in later local passes. Failed or skipped sources retain their wording; inspect the recorded reason before explicitly retrying. |
| Local results available | The current source versions have results in this archive. This establishes availability, not model accuracy or complete X coverage. |
| Review needed | Real judgments and independent reserved examples are still required. Review counts do not automatically approve training. |

Only issues that need operator action contribute to the attention count. Loading, ordinary processing, intentionally disabled collection and future classification review remain separately labeled. A zero attention count is not an approval to deploy or start paid collection.

## Inspecting captures before attribution

Coverage's **Inspect saved captures** control uses authenticated `GET /api/captures/unverified` to display the newest 25 stored sources awaiting account/membership evidence, across all dates. Full displayed wording is retained; the API omits whole sources beyond its 60,000-character per-post and 300,000-character response-source limits and reports omissions. It returns no provider payload, inferred member identity or topic labels. Promoted and removed sources are excluded. Viewing the panel does not promote a capture, save feedback or contact X. Once opened, it reloads during Coverage refreshes and when the view is reopened.

## Safe service restart

Normal shutdown cancels model startup and active work, waits for workers to exit, and defers a still-current interrupted job. Its attempt is returned so a routine restart does not manufacture an analysis failure. A newer source, explicit analysis or worker lease prevents the old worker from changing that record. Unexpected process crashes still rely on durable lease expiry and existing bounded attempts.

`node scripts/host-shutdown-smoke.js` runs a bounded check with temporary synthetic archives and local models. It verifies startup cancellation, inference cancellation and completion once after restart, then removes the temporary archive. Stop the real preview first because the classifier has a single-process lock. Its private report contains counts and runtime observations, with no actual archive opened or provider requests.

The check passed on this Mac. The selected Linux host must run it separately; the prepared service's stop timeout and memory limits are not a Linux measurement.

## Checks outside this summary

Actual owner login, TLS/tunnel behavior, off-host backup recovery, provider deletion discovery, disk capacity and model quality still need their own checks. `/healthz` deliberately returns only process liveness. Do not expose the operational summary as a public health endpoint or interpret a healthy web process as current source coverage.
