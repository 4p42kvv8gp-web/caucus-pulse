# Caucus Pulse

A private listening and classification workspace for public X posts by House Democratic members.

This initial local slice implements durable source storage, complete available text, provisional subject labels with evidence, a post explorer, exact phrase lookup, and persistent post corrections. It has **no active live collector or semantic provider yet**. Imported calibration examples retain their historical dates. General lessons are saved as proposals and do not automatically alter other posts.

## Run locally

Use Node 24.19.x. No package dependencies are required for this first slice. The runtime's built-in SQLite module may print an experimental warning on Node 24; evaluate the production database adapter before hosting.

```sh
node --test
node scripts/import-calibration.js /absolute/path/to/calibration/voice-session.json
node src/server.js
```

Open http://127.0.0.1:4317. Import is optional: without it the application shows an empty archive. Import makes no network requests. Source-post content is deliberately not bundled in the repository. `PORT` changes the local port; `CAUCUS_DB_PATH` selects the private database file.

## Boundaries of this milestone

- Loopback-only development service, no external access or hosted authentication. Do not expose it through a public proxy.
- Search currently scans the local dataset; indexed queries/pagination are required for the full roster.
- Preserves full available API text, original payload, references, and provenance. It does not claim that absent long text, referenced posts, or media have been retrieved.
- Classification failure leaves source posts stored and visible. Failed jobs are recorded; scheduled provider retries are future work.
- Corrections are tied to the current source content. If text changes, old reviews remain visible but no longer apply. General lessons are proposals. Semantic feedback retrieval and evaluation remain required work.
- Removal clears current database records and prevents replay. Filesystem backup/WAL cleanup and provider removal handling must be completed before live deployment.
- Live collection remains disabled. The resumable collector and budget enforcement modules now exist and are tested offline. Captured records await verified roster mapping before appearing as member posts. No collection scheduler has been enabled.

## Collection and spending foundation

`src/collect.js` records an unfinished interval and pagination token before resuming later runs. It advances the confirmed checkpoint only after reaching the earlier boundary. First-time setup is explicitly a first-page sample, not a historical completeness claim. An exhausted feed without its previous boundary, partial errors, unexpected ordering, or stalled pagination creates a visible reconciliation requirement. `restartInterval` starts again at the feed head without clearing the old boundary. Source leases fence overlapping or expired workers.

`src/budget.js` reserves each request's maximum resource cost transactionally. It enforces the configured daily and pilot limits and a protected prepaid reserve. Balances must be observed within five minutes. Failed/ambiguous requests keep their entire reservation, including after restart; there is no automatic refund or quota reset. Cross-midnight requests conservatively count in both days, and resource deduplication does not reduce this local spending guard. Unexpected response volume freezes paid reads for review. Account activity outside this app can still affect the provider balance; local accounting is not a billing guarantee.

```sh
node scripts/collection-status.js
```

This prints local readiness only. Once `CAUCUS_X_BEARER_TOKEN` is configured through a private environment, `--refresh-balance` makes one read-only call to X's credit endpoint. The status command never fetches posts. Never pass a secret as a command-line argument or reuse the single-post reader's private credential file for this collector. The adapter has no automatic request retries and sends credentials only to `https://api.x.com`, with redirects rejected.

The List adapter supports explicit `tweet` or `post` field dialects because current generated documentation and observed single-post responses differ. The List dialect, full-text availability, and actual charges still need a bounded authenticated trial. No profile, media, or referenced-post expansions are requested in this initial adapter.

References checked September 7, 2026: [X pricing](https://docs.x.com/x-api/getting-started/pricing), [credit balance endpoint](https://docs.x.com/x-api/usage/get-usage-credits), [List posts](https://docs.x.com/x-api/lists/get-list-posts).

## Provenance

Based on the reviewed [original Caucus Pulse project](https://github.com/4p42kvv8gp-web/X-Decibel-Reader/tree/a93d72349104418ca59c9845eb9b949d7f9c77e1/caucus-pulse). The new local foundation replaces file archives and nightly-only reports with a database-backed service. Broad subject structure is informed by the original taxonomy; facility identities are kept separate. See the workspace's PROJECT_SCOPE.md, TASKS.md, and DEVELOPMENT_HANDOFF.md for the complete build plan.

Code/configuration belong in Git. Credentials, source posts, review content, and local databases do not.
