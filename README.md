# Caucus Pulse

A private listening and classification workspace for public X posts by House Democratic members.

The application preserves available source text, supports indexed and semantic search, proposes topics with a local model, and records corrections against the exact source and displayed prediction. Collection, account verification, analysis and review run as separate recoverable steps.

**Current pilot:** a bounded X trial captured 300 List account profiles and five recent posts. Official House links established 120 current account bindings and admitted one captured post; four captures await verification. The archive also contains two historical examples and one authentic saved review. The List scan is incomplete. The $3.025 connection-trial ceiling is exhausted and automatic polling remains off because the provider's credits endpoint returned 404. No paid AI or hosted deployment is active.

The selected local classifier is Political DEBATE large, used for provisional topic/subtopic and communicative-function suggestions. It returns source passage references, rather than rewriting quotations or generating unsupported narratives. It is an initial classifier, not a verified measure of truth. Your corrections take precedence; automatic weight training is not enabled. See [Local classification](docs/LOCAL_CLASSIFICATION.md).

## Run locally

Use Node 24.19.x and pnpm 11.19.0. The inference dependency and transitive packages are pinned in the lockfile; keep the workspace override when installing. The runtime's built-in SQLite module may print an experimental warning on Node 24.

```sh
pnpm install --frozen-lockfile --ignore-scripts
node --test
node scripts/download-embedding-model.js bge
node scripts/import-calibration.js /absolute/path/to/calibration/voice-session.json
node src/server.js
```

Open http://127.0.0.1:4317. Import is optional: without it the application shows an empty archive. Import makes no network requests. Source-post content is deliberately not bundled in the repository. `PORT` changes the local port; `CAUCUS_DB_PATH` selects the private database file.

The model-download command retrieves about 35 MB of public, revision-pinned BGE assets and verifies their digests. Application inference then runs locally with remote loading disabled. Without those assets, the archive still opens and semantic search explicitly reports unavailable. See [Local semantic search](docs/LOCAL_SEMANTIC_SEARCH.md) for model choices, limits, and the engineering benchmark.

## Local classification setup

The tested classifier runtime uses Python 3.12 on macOS ARM64:

```sh
python3 scripts/setup-local-classifier.py
python3 scripts/download-classifier-model.py
node scripts/classifier.js status
```

The public Political DEBATE download is about 1.75 GB. After setup, enable `intelligence.localClassifier.enabled` in `config/settings.json` and restart the preview. The server processes up to five local classification jobs per pass. `CAUCUS_DISABLE_LOCAL_CLASSIFIER=1` allows archive maintenance without loading the model. The current dependency lock was tested on this Mac; a Linux CPU lock must be validated before deployment. No model or source dataset is downloaded at application startup.

## Boundaries of this milestone

- Current preview is loopback-only. Optional [private owner authentication](docs/PRIVATE_ACCESS.md) is implemented and tested with synthetic signed tokens; actual hosting, owner login and tunnel verification remain pending. Public configuration cannot fall back to unauthenticated local mode.
- The light dashboard includes topic/subtopic drill-down, a recent source feed, bounded language/emerging cards, and a source-backed [incident desk](docs/INCIDENT_DESK.md). Indexed selection and bounded pages retain full-selection topic counts. Short text queries still scan the SQLite text projection; exact phrase search and reviewed-example retrieval are bounded. See [Indexed explorer](docs/INDEXED_EXPLORER.md).
- Preserves full available API text, original payload, references, and provenance. It does not claim that absent long text, referenced posts, or media have been retrieved.
- Classification failure leaves source posts and previous analysis visible. Durable jobs preserve failure status; explicit retries are bounded and tied to source versions.
- Corrections are tied to the current source content. If text changes, old reviews remain visible but no longer apply. General lessons are proposals. Reviewed-example retrieval, held-out label evaluation, and learning provenance are implemented; real calibration and production deployment remain required work.
- [Archive operations](docs/ARCHIVE_OPERATIONS.md) provide verified backups, staged recovery that preserves spending/removals, and cleanup of managed source copies. Off-host backup protection and automatic provider removal detection remain required before live deployment.
- Automatic collection remains disabled. The resumable collector passed a capped authenticated trial as well as offline recovery tests. Captured records await verified roster mapping before appearing as member posts. No collection scheduler has been enabled.

## Collection and spending foundation

`src/collect.js` records an unfinished interval and pagination token before resuming later runs. It advances the confirmed checkpoint only after reaching the earlier boundary. First-time setup is explicitly a first-page sample, not a historical completeness claim. An exhausted feed without its previous boundary, partial errors, unexpected ordering, or stalled pagination creates a visible reconciliation requirement. `restartInterval` starts again at the feed head without clearing the old boundary. Source leases fence overlapping or expired workers.

`src/budget.js` reserves each request's maximum resource cost transactionally. It enforces the configured daily and pilot limits and a protected prepaid reserve. Balances must be observed within five minutes. Failed/ambiguous requests keep their entire reservation, including after restart; there is no automatic refund or quota reset. Cross-midnight requests conservatively count in both days, and resource deduplication does not reduce this local spending guard. Unexpected response volume freezes paid reads for review. Account activity outside this app can still affect the provider balance; local accounting is not a billing guarantee.

```sh
node scripts/collection-status.js
```

This prints local readiness only. Configure the product token through the local Coverage & budget → Private X connection form, or through `CAUCUS_X_BEARER_TOKEN`. Then `--refresh-balance` makes one read-only call to X's credit endpoint. The status command never fetches posts. Never pass a secret as a command-line argument or reuse the single-post reader's private credential file for this collector. The adapter has no automatic request retries and sends credentials only to `https://api.x.com`, with redirects rejected.

The List adapter supports explicit `tweet` or `post` field dialects because current generated documentation and observed single-post responses differ. The capped trial succeeded with the `tweet` field dialect. Full-history coverage and provider dollar billing remain unverified. No profile, media, or referenced-post expansions are requested in this initial adapter.

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

Account observations request only public ID, username, display name, and protected status, with no metrics or expansions. Their local storage supports identity investigation; official-link verification and actual bindings are separate steps. The current pilot has 120 current official-account bindings; unresolved accounts remain excluded. Documentation checked: [List members](https://docs.x.com/x-api/lists/get-list-members).

## Private local token setup

See [Private X setup](docs/PRIVATE_X_SETUP.md). The local form writes only `data/secrets/x-bearer-token`, using an atomic replacement with owner-only file permissions and a private directory. It requires an allowed loopback Origin and never returns the token in API responses. Saving does not validate access or make a network request. An environment token takes precedence, and the form refuses to shadow it.

This is private local file storage, not an encrypted managed vault. Hosting requires private host credential provisioning plus the owner authentication mode; the development service remains loopback-only. Credential tests use temporary directories and synthetic tokens, never the real product credential location.

## Roster and account attribution

```sh
python3 scripts/fetch-house-roster.py
node scripts/import-roster.js data/reference/house-roster.json
```

The first command downloads the public [House Clerk roster](https://clerk.house.gov/xml/lists/MemberData.xml); it does not contact X. The second imports its minimal member inventory, publication/retrieval dates, and raw-source hash. The ignored JSON file is local reference material, not an account verification. Existing downloaded XML can instead be parsed with `--input` and its actual `--retrieved-at` time.

`src/roster.js` treats a current roster as a dated observation. Its operational window starts at the publication date and ends 24 hours after retrieval; it does not establish caucus affiliation earlier in the term. Newer snapshots take precedence. Source observations cannot be silently rewritten under the same identifier.

The account-binding function requires a record of an official House page linking the exact profile, a matching numeric X user ID/username response, explicit ownership dates, and a source explanation. The public-source caller now fetches the official directory and member pages, records hashes and dates, and extracts exact profile anchors. A separate local import joins them to the previously observed numeric X profiles. See [Account evidence](docs/ACCOUNT_EVIDENCE.md). No account should be bound from a List entry alone. Personal/campaign accounts lacking an official link remain unresolved pending another reviewed evidence path.

Local processing moves captured records into the explorer only after attribution succeeds. Identity and district are saved on each post, so later edits to account mappings cannot relabel its history. Failed verification retains the source in the queue. The local server processes at most 100 queued captures and 100 baseline jobs per minute. A separate local CPU worker indexes at most 25 posts per pass when its verified model is available; none of this makes X or hosted-model requests.

## Evidence and learning framework

`src/intelligence.js` prepares complete available text, source version, context limits, and relevant reviewed examples for an explicitly supplied provider callback. Its strict JSON contract separates subjects, entities, event descriptions, named locations, and district evidence. Supporting spans must match the source exactly, including UTF-16 offsets. Named entities/locations must appear in those spans; canonical entity resolution awaits a verified registry. Returned events remain provisional and do not assert novelty or independent verification.

These checks verify the output's structure and source references; they cannot prove that the interpretation is correct. Negation, quoted language, location meaning, and classification boundaries still require model evaluation and human calibration.

Each successful semantic run records the provider/model, input hash, reviewed-example IDs, source hash, and output. Changed or removed source text and changed teaching examples reject late output. Rollback creates another recorded run, and current human corrections retain precedence. Reviewed examples use bounded BGE passage retrieval with a topic fallback and persisted exclusions for held-out sources, text copies, direct references, and edit siblings; proposed general rules and unresolved reviews are excluded. The optional generative adapter can consume retrieved examples. The selected NLI classifier uses fixed hypotheses and records that it did not consume them; it does not pretend to learn weights from one review. Durable local reclassification and cross-post subject candidates are implemented.

The [teaching and evaluation guide](docs/TEACHING_AND_EVALUATION.md) describes voice-session recording, explicit negative decisions, reserved test posts, and separate candidate runs. Evaluations freeze accepted subject labels and record missing/extra labels without changing dashboard output. They expose stale, failed, removed, and unfinished cases. The local baseline evaluation makes no requests; the provider callback still needs a cost-controlled adapter. Semantic run history shows which examples were supplied, without claiming causal influence.

The teaching desk can display semantic labels, source spans, entities, and event candidates when an actual provider result exists. Actual completed local runs replace the literal baseline, while current human labels retain precedence. Synthetic tests never count as real model output or user feedback.

## Automatic language discovery

`GET /api/language` and `node scripts/language.js` now detect exact repeated passages in a bounded rolling window. Longer wording, punctuation, spacing, negation, source offsets, and post chronology are preserved. Reposts are excluded, quote captions remain explicitly uninterpreted, and member counts deduplicate multiple accounts. Every limit is disclosed; no source text is truncated in storage.

See [Language discovery](docs/LANGUAGE_DISCOVERY.md) for filters, coverage limits, full source evidence, and interpretation boundaries. This exact-language service makes no X/model requests and does not infer events, stance, novelty, or coordination.

The separate **Emerging candidates** view groups related subject passages across both classified and unclassified posts. It uses bounded local embedding comparisons, current labels and source versions, representative source wording, distinct-member counts, and explicitly incomplete comparison windows. Groups can overlap and remain provisional: similarity does not establish a shared event, agreement, novelty, or coordination. See [Emerging subject candidates](docs/SUBJECT_GROUPS.md).

## Provenance

The [Hugging Face plan](docs/HUGGING_FACE_PLAN.md) records installed skills, candidate classification models, evaluation requirements, and archive/cost decisions. MiniLM and BGE now have a verified local retrieval implementation; BGE is the preview default after bounded synthetic comparisons. This engineering choice still needs real-post calibration. Other proposed models remain candidates. The [Claude design integration notes](docs/DESIGN_INTEGRATION.md) distinguish the supplied build specification from still-missing screen HTML and document the data rules to reconcile.

Based on the reviewed [original Caucus Pulse project](https://github.com/4p42kvv8gp-web/X-Decibel-Reader/tree/a93d72349104418ca59c9845eb9b949d7f9c77e1/caucus-pulse). The new local foundation replaces file archives and nightly-only reports with a database-backed service. Broad subject structure is informed by the original taxonomy; facility identities are kept separate. See the workspace's PROJECT_SCOPE.md, TASKS.md, and DEVELOPMENT_HANDOFF.md for the complete build plan.

Code/configuration belong in Git. Credentials, source posts, review content, and local databases do not.
