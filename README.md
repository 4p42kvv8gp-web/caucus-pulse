# Caucus Pulse

A private listening and classification workspace for public X posts by House Democratic members.

This local foundation implements durable source storage, complete available text, provisional subject labels with evidence, a post explorer, exact phrase lookup, and persistent post corrections. It also provides resumable collection, budget enforcement, dated member attribution, and a provider-neutral semantic analysis contract. It has **no active live collector or semantic provider yet**. Imported calibration examples retain their historical dates. General lessons are saved as proposals and do not automatically alter other posts.

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
- Corrections are tied to the current source content. If text changes, old reviews remain visible but no longer apply. General lessons are proposals. Reviewed-example retrieval is implemented; real calibration, evaluation, and production provider integration remain required work.
- Removal clears current database records and prevents replay. Filesystem backup/WAL cleanup and provider removal handling must be completed before live deployment.
- Live collection remains disabled. The resumable collector and budget enforcement modules now exist and are tested offline. Captured records await verified roster mapping before appearing as member posts. No collection scheduler has been enabled.

## Collection and spending foundation

`src/collect.js` records an unfinished interval and pagination token before resuming later runs. It advances the confirmed checkpoint only after reaching the earlier boundary. First-time setup is explicitly a first-page sample, not a historical completeness claim. An exhausted feed without its previous boundary, partial errors, unexpected ordering, or stalled pagination creates a visible reconciliation requirement. `restartInterval` starts again at the feed head without clearing the old boundary. Source leases fence overlapping or expired workers.

`src/budget.js` reserves each request's maximum resource cost transactionally. It enforces the configured daily and pilot limits and a protected prepaid reserve. Balances must be observed within five minutes. Failed/ambiguous requests keep their entire reservation, including after restart; there is no automatic refund or quota reset. Cross-midnight requests conservatively count in both days, and resource deduplication does not reduce this local spending guard. Unexpected response volume freezes paid reads for review. Account activity outside this app can still affect the provider balance; local accounting is not a billing guarantee.

```sh
node scripts/collection-status.js
```

This prints local readiness only. Configure the product token through the local Coverage & budget → Private X connection form, or through `CAUCUS_X_BEARER_TOKEN`. Then `--refresh-balance` makes one read-only call to X's credit endpoint. The status command never fetches posts. Never pass a secret as a command-line argument or reuse the single-post reader's private credential file for this collector. The adapter has no automatic request retries and sends credentials only to `https://api.x.com`, with redirects rejected.

The List adapter supports explicit `tweet` or `post` field dialects because current generated documentation and observed single-post responses differ. The List dialect, full-text availability, and actual charges still need a bounded authenticated trial. No profile, media, or referenced-post expansions are requested in this initial adapter.

References checked September 7, 2026: [X pricing](https://docs.x.com/x-api/getting-started/pricing), [credit balance endpoint](https://docs.x.com/x-api/usage/get-usage-credits), [List posts](https://docs.x.com/x-api/lists/get-list-posts).

## Bounded collection commands

Preview a pass without making requests or reading a credential:

```sh
node scripts/worker.js --mode inventory
node scripts/worker.js --mode posts --trial --field-dialect tweet
```

Inventory defaults to at most three pages of 100 user records: a configured maximum of $3 at the current user-read price. The post trial defaults to one page of five posts: $0.025 at the current post-read price. Those are request plans, not guarantees of actual provider billing. Daily/pilot limits, balance freshness, and the protected reserve still apply before each paid page. Confirm the actual account's prices/access and use the bounded trial to validate accepted fields and costs before choosing a polling pattern.

After private setup, add `--execute` to run the displayed pass. Execution makes a fresh credit check, uses the fixed configured List, and processes stored captures separately. No repeating scheduler or paid subscription is started. Post trials require `--trial` while collection is disabled and cannot exceed 20 posts per page or two pages. Non-trial post passes require the live setting plus fresh inventory/roster observations and verified account bindings.

`--page-size` and `--max-pages` narrow a pass. Interrupted inventory scans retain the original page size and cursor. The latest fully paginated scan remains current until a replacement finishes; malformed/partial responses, duplicate accounts, conflicting handles, cursor cycles, or an observation window over one hour require review. A completed pagination scan is not an atomic snapshot of a List that may change during retrieval. List membership never creates a member binding by itself.

To recover after inspecting a problem, run `--mode inventory --restart` to abandon the incomplete scan while keeping its evidence, or `--mode posts --field-dialect tweet --restart` to restart the pending post interval from its head with the original boundaries. Recovery is local-only and cannot be combined with `--execute`; inspect the result before a separate pass. Do not repeatedly retry unresolved failures or reset spending reservations.

Account observations request only public ID, username, display name, and protected status, with no metrics or expansions. Their local storage supports identity investigation; official-link verification and actual bindings remain separate unfinished integration work. Documentation checked: [List members](https://docs.x.com/x-api/lists/get-list-members).

## Private local token setup

See [Private X setup](docs/PRIVATE_X_SETUP.md). The local form writes only `data/secrets/x-bearer-token`, using an atomic replacement with owner-only file permissions and a private directory. It requires an allowed loopback Origin and never returns the token in API responses. Saving does not validate access or make a network request. An environment token takes precedence, and the form refuses to shadow it.

This is private local file storage, not an encrypted managed vault. Hosting requires a production secret store and authentication; the development service remains loopback-only. Credential tests use temporary directories and synthetic tokens, never the real product credential location.

## Roster and account attribution

```sh
python3 scripts/fetch-house-roster.py
node scripts/import-roster.js data/reference/house-roster.json
```

The first command downloads the public [House Clerk roster](https://clerk.house.gov/xml/lists/MemberData.xml); it does not contact X. The second imports its minimal member inventory, publication/retrieval dates, and raw-source hash. The ignored JSON file is local reference material, not an account verification. Existing downloaded XML can instead be parsed with `--input` and its actual `--retrieved-at` time.

`src/roster.js` treats a current roster as a dated observation. Its operational window starts at the publication date and ends 24 hours after retrieval; it does not establish caucus affiliation earlier in the term. Newer snapshots take precedence. Source observations cannot be silently rewritten under the same identifier.

The account-binding function requires a record of an official House page linking the exact profile, a matching numeric X user ID/username response, explicit ownership dates, and a source explanation. **It validates the submitted evidence record; it does not fetch or verify those pages itself.** The synchronization/verification caller still needs to be built. No account should be bound from a List entry alone. Personal/campaign accounts lacking an official link remain unresolved pending another reviewed evidence path.

Local processing moves captured records into the explorer only after attribution succeeds. Identity and district are saved on each post, so later edits to account mappings cannot relabel its history. Failed verification retains the source in the queue. The local server processes at most 100 queued captures and 100 baseline jobs per minute; this involves no network or model requests.

## Evidence and learning framework

`src/intelligence.js` prepares complete available text, source version, context limits, and relevant reviewed examples for an explicitly supplied provider callback. Its strict JSON contract separates subjects, entities, event descriptions, named locations, and district evidence. Supporting spans must match the source exactly, including UTF-16 offsets. Named entities/locations must appear in those spans; canonical entity resolution awaits a verified registry. Returned events remain provisional and do not assert novelty or independent verification.

These checks verify the output's structure and source references; they cannot prove that the interpretation is correct. Negation, quoted language, location meaning, and classification boundaries still require model evaluation and human calibration.

Each successful semantic run records the provider/model, input hash, reviewed-example IDs, source hash, and output. Changed or removed source text rejects late output. Rollback creates another recorded run, and current human corrections retain precedence. Reviewed examples use deterministic topic matching with explicit exclusions for the target and held-out posts; proposed general rules are excluded. This is retrieval-based adaptation, not model-weight training. Feedback influence/reclassification, a provider worker with cost limits, held-out evaluation, and cross-post discovery remain unfinished.

The teaching desk can display semantic labels, source spans, entities, and event candidates when an actual provider result exists. Current imported examples still use the literal baseline. Synthetic tests never count as real model output or user feedback.

## Provenance

Based on the reviewed [original Caucus Pulse project](https://github.com/4p42kvv8gp-web/X-Decibel-Reader/tree/a93d72349104418ca59c9845eb9b949d7f9c77e1/caucus-pulse). The new local foundation replaces file archives and nightly-only reports with a database-backed service. Broad subject structure is informed by the original taxonomy; facility identities are kept separate. See the workspace's PROJECT_SCOPE.md, TASKS.md, and DEVELOPMENT_HANDOFF.md for the complete build plan.

Code/configuration belong in Git. Credentials, source posts, review content, and local databases do not.
