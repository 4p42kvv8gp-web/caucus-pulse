# Caucus Pulse — product scope and development plan

Updated September 8, 2026. Owner: Jacob. Implementation: Codex in this task.

September 8 update: Jacob requested seven hours of autonomous work without guidance, ending at 11:57:54 UTC / 7:57:54 AM Eastern. Preserve existing private-data and spending limits; continue independent implementation when access is missing. Read the new Hugging Face intelligence plan and Claude design integration notes under caucus-pulse/docs/. The Build Spec is available; its two reference screen files remain pending. No hosting destination or paid service has been selected. At the deadline, pause the existing development heartbeat and provide a verified completion/status report.

## Product outcome

A private, continually updated workspace for understanding what House Democratic members say publicly on X. Capture comes before classification: a post must enter the archive even when its subject is new or unknown. Every label, event summary, and language pattern must lead back to the underlying posts.

The first useful release is a working collection-to-dashboard product with a persistent teaching loop. We will improve the intelligence while using the product, without waiting for a perfect taxonomy or custom model training.

## Decisions already made

- Start from the reviewed Fable/Claude implementation; preserve useful behavior and replace the collection, storage, and analysis paths that failed review. Keep one product in `4p42kvv8gp-web/caucus-pulse`.
- Use Jacob's [X List](https://x.com/i/lists/1841177179872243858) as the starting account inventory. Validate it against the current House Democratic roster. List membership alone does not establish House eligibility or account ownership.
- House members only. Include verified official, personal, and campaign accounts; keep those account types separate and map them to one stable member identity. Track membership and district changes over time.
- Begin with collection every 30 minutes and a page that refreshes its data every minute. Measure actual delay. Add event delivery after proving endpoint access, recovery, and cost.
- Capture new original posts, replies, quotes, and reposts. Distinguish the member's own wording from referenced or amplified wording. Retain full permitted text, source identifiers, references, edit information, and context availability.
- Private local pilot first; prepare deployment as part of the build. Do not put source-post archives, credentials, or local databases into Git.
- Budget: Jacob reports $400 already in the account and wants at least two weeks. Working assumption: this is prepaid X credit. Verify available balance before collection. Set a $25 UTC-day maximum and $350 cumulative pilot ceiling, leaving a $50 reserve. These are conservative local estimates, not a guarantee of provider billing or coverage. Account usage outside this app must also be reconciled.
- Prioritize new-post capture. Initially disable bulk historical downloads, repeated engagement refreshes, and speculative context lookups. Do not buy more credits or initiate additional paid hosting/AI subscriptions. Existing authorized resources can be assessed; build the interfaces locally in the meantime.

## First release

| Capability | User experience | Completion check |
| --- | --- | --- |
| Reliable capture | See freshness, roster coverage, and any unfinished collection interval. | A crash, page limit, timeout, duplicate delivery, or midnight boundary cannot silently advance past uncaptured posts. Recovery tests pass. |
| Post explorer | Search complete text; filter by member, account type, date, topic, and post type; open the source. | Exact original wording remains available, including negation and long posts. Missing media/context is visible. |
| Topics and subtopics | Browse broad subjects, narrower subjects, and newly observed groups with source posts and descriptive counts. | Multiple labels are supported; parent counts deduplicate posts; multiple accounts do not inflate member counts. |
| Events and local reports | See what a member reports happened, the named place, when it was posted, and supporting wording. | One post can create an event candidate. The member's district is never substituted for an unresolved event location. A post is not treated as independent verification of its claim. |
| Wording | Inspect exact phrases and longer repeated passages, with chronological occurrences and surrounding text. | No two-word or four-word storage cutoff. Exact reuse, paraphrase, quotation, rebuttal, and reposting remain distinguishable. |
| Teaching desk | Review one real post, see proposed labels and a concise evidence-based explanation, correct it, and save the lesson. | Feedback survives restart; post-specific corrections are separate from proposed general rules. No assistant proposal is marked human-approved. |
| Operations | See collection/analysis freshness separately, incomplete work, budget estimates, and service errors. | Budget is reserved before requests; optional enrichment stops first; interruptions are visible and recoverable. |

Topic and event panels describe observed language and volume. They do not grade members, political positions, policies, or electoral prospects. Present source chronology and descriptive counts without political rankings or endorsement.

## Intelligence design

1. **Read the complete available context.** Preserve source text separately from the normalized search index. Identify whose words appear in quotes and reposts; mark unreviewed images, videos, and links.
2. **Assign several complementary labels.** Broad topic, narrower subject, named entities, event/development, and evidence status are separate fields. A facility is not the same thing as a particular event at that facility.
3. **Discover new subjects continuously.** Examine posts inside existing topics as well as unclassified posts. New groups appear provisionally, with evidence and explicit uncertainty. Existing labels must not prevent discovery.
4. **Explain with evidence.** Give short justifications, exact supporting spans, and missing-context notes. Distinguish machine suggestions, accepted post corrections, and reviewed general rules.
5. **Learn from corrections.** Store the original prediction, corrected interpretation, reason, scope, reviewer, and version. A correction applies to that post immediately; broader changes become versioned examples or rules. Retrieve relevant reviewed examples for later classifications.
6. **Test before broad promotion.** Keep separate reviewed examples for evaluation; compare candidate changes against the current version, especially on negation, quotes, emerging entities, overlapping topics, and local incidents. Preserve rollback and a change log. Do not claim that conversation alone retrains model weights.

The current pilot uses local Political DEBATE large for provisional subjects and communicative functions, BGE for semantic retrieval/discovery, and BERT NER for source-exact named mentions. A transparent literal baseline remains available when no semantic result exists. Human corrections take immediate precedence; a needs-context decision keeps tentative labels out of topic counts. The selected fixed-hypothesis model does not consume saved examples or train itself. Reviewed-example retrieval and isolated candidate evaluations are prepared for the next learning stage. Generalization and model promotion require varied real judgments and a separate held-out comparison. Keep providers replaceable and measure any proposed hosted model before paying for it.

## Jacob's voice exercises

Use the existing verified historical examples in `calibration/voice-session.json` first. Present one full post with original date and context limits, then the proposed topic, subtopic, entities/event, and explanation. Ask one focused question. Record the answer faithfully; restate the lesson; test it on a different post. Evaluate novelty at publication time, not based on how old the example is today.

Start with about 15 minutes on the three real posts currently available. Resolve boundaries through examples instead of asking Jacob to design a taxonomy from scratch. Then assemble a broader authorized sample with multi-topic posts, facilities, district incidents, quotes/reposts, vague political language, negation and media-dependent content. Keep some new examples independently reserved for testing before showing candidate predictions. Session length and sample size are suggestions, not blockers to development. Voice conversations can happen in this task; browser review and durable feedback also work without voice. The dashboard itself does not record audio.

## Delivery sequence

| Milestone | Deliverable | Gate to completion |
| --- | --- | --- |
| M0 — ownership and scope | Scope, separate task lists, durable handoff, development location, continuation schedule. | Files exist; next worker can resume without reconstructing the conversation. |
| M1 — usable local slice | Database, source-text preservation, baseline labels, evidence explorer, saved correction flow using already verified examples. | Local application runs, changes survive restart, samples are explicitly historical and incomplete. |
| M2 — reliable live capture | List/roster synchronization, bounded collection, durable unfinished intervals, budget ledger, health. | Offline recovery tests plus a bounded live trial. Verify current API shapes and billing; demonstrate known coverage. |
| M3 — intelligent pilot | Semantic labels and entities, provisional event discovery, exact/semantic language views, reviewed-example retrieval. | Labels cite input evidence; outputs validate against requested post IDs; held-out review demonstrates the intended behavior. |
| M4 — private deployment | Authentication, controlled storage, jobs, secrets, backups/removals, monitoring, launch instructions. | End-to-end trial, removal propagation and recovery verified, concrete operating cost and access reviewed. |
| M5 — evolve | Event delivery, selective OCR/transcription, targeted history, quality monitoring and model improvements. | Each addition proves value and fits remaining budget; expand in small measured steps. |

The local pilot runs with three admitted real posts, current local analysis/search results, and one authentic saved review. A capped X trial observed 300 List profiles and five posts; official House links support 120 current account bindings, with four captures still unresolved and the List scan incomplete. The $3.025 trial is exhausted. Provider credit verification returned 404, so automatic collection remains off. Schema 11, durable model queues, interruption recovery, private owner-access support, sealed backups and managed removal cleanup pass local tests. Linux package locks and service templates are prepared but have not run on a Linux host. Held-out classification quality, visual browser inspection, the complete roster/collection cadence, actual owner login and off-host recovery remain release gates. The preview must keep these distinctions visible; no live site replacement or hosted deployment has been made.

## Deferred from the first pilot

Bulk historical backfill; universal video/audio transcription; electoral forecasting; public bulk exports; automatic outbound messages; a separate mobile app; custom foundation-model training; engagement-based member rankings. Attachments retain explicit coverage gaps until media analysis is added. A small, bounded historical sample can support calibration within the budget.

## Working architecture

Keep Node.js, using a supported pinned runtime and a conventional database. Start with SQLite for one local service, behind a storage module; move to Postgres when independent hosted workers require it. Store ingestion intervals, posts, accounts/member mappings, versioned analyses, feedback, and usage as separate records. Use idempotent queues; analysis failures never block capture. Keep the browser independent of collection and model providers. Git stores code/configuration, never raw source archives.

The first collector uses bounded polling with explicit incomplete intervals, followed by account-based reconciliation. Test X Activity as a later primary delivery option. Preserve permitted content in storage that supports modification/removal, with corresponding derived-data cleanup. Provider API schemas and access must be validated against actual responses, because the reviewed documentation contains old/new field-name inconsistencies.

## References and provenance

- [Detailed local assessment](review/caucus-pulse-assessment.md), including seven reproduced failures and the original test results.
- [Reviewed original source](https://github.com/4p42kvv8gp-web/X-Decibel-Reader/tree/a93d72349104418ca59c9845eb9b949d7f9c77e1/caucus-pulse). The reference copy remains under `review/reference/`.
- [X List endpoint](https://docs.x.com/x-api/lists/get-list-posts), [X pricing](https://docs.x.com/x-api/getting-started/pricing), [X Activity](https://docs.x.com/x-api/activity/introduction), [X Developer Policy](https://docs.x.com/developer-terms/policy).
- [Local scheduled work](https://learn.chatgpt.com/docs/automations?surface=app) requires the computer on and the desktop app running. Development continuation is separate from a deployed product collector.
