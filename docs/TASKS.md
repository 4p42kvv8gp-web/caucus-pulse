# Tasks

## Active

- [ ] **M1: Complete the visual browser check** - Automated HTTP and persistence checks pass. Browser access could not verify the administrator policy; do not bypass that control. Retry only when the policy service is available. No Jacob review was created by testing.
- [ ] **M2: Validate the supplied X List and House account roster** - List 1841177179872243858; stable member IDs, multiple-account mapping, eligibility dates, and unresolved account queue.
- [ ] **M2: Repair collection correctness** - Durable pagination intervals, full available text and references, idempotent writes, resumable recovery, timeline reconciliation, and coverage diagnostics.
- [ ] **M2: Enforce the prepaid budget before requests** - Verify balance; reserve at most $25 per UTC day and $350 total pilot use, preserving $50. No automatic top-up; prioritize new posts. Include context/user lookup costs and possible duplicate billing in conservative reservations.
- [ ] **M2: Run a bounded live trial** - Validate fields, pagination, post types, observed cost, and recovery before enabling the 30-minute loop. Report any gap honestly.
- [ ] **M3: Implement semantic classification and discovery** - Strict output schemas, source-span validation, replaceable model adapter, multi-topic labels, new entities/events within existing topics, and visible uncertainty.
- [ ] **M3: Preserve language and measure observed spread** - Exact offsets and longer repeated spans, rolling windows across midnight, account-to-member deduplication, and separation of authored/quoted/amplified language.
- [ ] **M3: Connect teaching to future analysis** - Versioned feedback, separate post corrections/general rules, retrieval of reviewed examples, reclassification jobs, held-out evaluations, and rollback.
- [ ] **M3: Prepare Jacob's first voice session** - 8–12 real posts with dates, sources, proposed labels, short justifications, missing-context notes, and one question each. Start with the two verified examples already saved.
- [ ] **M4: Prepare private deployment and operations** - Authentication, secret injection, controlled storage, durable jobs, migrations, backups/removal propagation, monitoring, and a concrete costed launch proposal.
- [ ] **M4: Complete the live pilot acceptance run** - Trace a new source post through capture, analysis, dashboard, correction, and reanalysis; test recovery and data removal; publish setup/run instructions.

## Waiting On

- [ ] **Confirm usable private service access when integration reaches it** - Existing X secret setup is available to the single-post reader; never copy pasted credentials into code. Verify balance/access with the account's supported interface. Additional paid hosting/AI purchases need a concrete proposal and authorization. Owner: Codex to investigate; Jacob only if login/access is required.
- [ ] **Jacob's classification calibration** - Optional until the first review interface works; broader subjective rules remain provisional until reviewed. See YOUR_TASKS.md.

## Someday

- [ ] **M5: Add near-real-time delivery** - Trial public creation/deletion events with reconciliation and duplicate handling after polling is reliable.
- [ ] **M5: Add selective media understanding** - OCR/transcription for missing substantive text, with provenance and budget controls.
- [ ] **M5: Expand historical coverage and evaluation** - Bounded backfill, comparable trend baselines, better language discovery; train only after reviewed examples justify it.

## Done

- [x] ~~Build the first local product slice~~ (2026-09-07) - http://127.0.0.1:4317; post explorer, evidence explanations, teaching desk, exact phrase lookup, and coverage/budget view. Two historical examples imported privately. Live collection and semantic analysis remain pending.
- [x] ~~Verify eight foundation behaviors~~ (2026-09-07) - Full text and offsets, separate facility labels, capture surviving analysis failure, account/member deduplication, midnight phrase search, persistent corrections and edit invalidation, removal/replay, and local HTTP validation all pass with synthetic test records.
- [x] ~~Enable hourly development follow-ups in this task~~ (2026-09-07) - Automation `build-caucus-pulse` confirmed ACTIVE. Computer must remain on and app running.
- [x] ~~Review the complete original source and supplied bundle~~ (2026-09-07) - All 23 bundle code sections match the fetched source; 12 original tests pass; seven additional failures reproduced offline.
- [x] ~~Verify two real historical posts for calibration~~ (2026-09-07) - API text and source dates saved locally; no human reviews invented.
- [x] ~~Record product scope, budget, and starting List~~ (2026-09-07) - PROJECT_SCOPE.md is the working build contract; $400 reported credit, at least two weeks, List 1841177179872243858.
