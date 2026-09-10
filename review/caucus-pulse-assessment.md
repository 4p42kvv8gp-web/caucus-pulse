# Caucus Pulse: implementation assessment and build brief

Reviewed September 7, 2026. Recommendation: retain the useful scaffold, repair collection and text preservation before launch, and build a private corpus that supports independent analysis programs. Prove a 30-minute service first, then use public post events for near-real-time delivery if the account-level trial succeeds.

**What was actually inspected**

The source is [X-Decibel-Reader, commit a93d723](https://github.com/4p42kvv8gp-web/X-Decibel-Reader/tree/a93d72349104418ca59c9845eb9b949d7f9c77e1/caucus-pulse), on branch `claude/twitter-data-capture-setup-kd9wvo`, plus the two Caucus Pulse briefs. All 25 files in `caucus-pulse/` were retrieved. The separate [caucus-pulse repository](https://github.com/4p42kvv8gp-web/caucus-pulse) currently has one branch containing only a short README; no implementation has been moved there yet.

The user-supplied `caucuspulsecodereviewbundle.md` was also compared against this commit. All 23 included file sections match the GitHub snapshot, ignoring trailing whitespace at the end of each file. The local reference copy preserves the inspected source. All 12 existing tests pass. Seven additional offline reproductions confirm failure cases described below. No live X or Anthropic request was made, no X credentials were accessed, and no remote repository, deployment, or schedule was changed. Tests establish source behavior, not live API compatibility or completeness.

**The useful foundation**

The code separates capture, author lookup, classification, phrase mining, rollups, and reports. It treats post IDs as large integers, stores original/reply/quote/repost types, and deduplicates parent-topic counts when a post receives several subtopics under one parent. Account metadata supports overlapping caucus tags. These are useful parts to retain.

The pasted plan is substantially ahead of the code. The implementation has nightly classification using the configured Opus model, nightly phrase calculation, a static daily table, and no automatic dashboard refresh. It has no live classifier, event subscriptions, search backfill, intraday metrics loop, semantic clustering, district-event model, or durable queue for collecting pending batches.

**Findings that must shape the build**

| Priority | Finding and evidence | Required change |
| --- | --- | --- |
| P1 | `src/poll.js:108` advances the global checkpoint after downloading only part of the new interval. A page-limit hit or an error on page two still advances it. Reproduced with IDs 100 → 500: posts 200 and 300 remain permanently skipped on subsequent normal polls. | Persist unfinished collection work. Store downloaded pages safely, but mark an interval complete only after reaching its old boundary. Retry incomplete intervals, dedupe by post ID, and reconcile against account timelines. |
| P1 | `src/x.js:42,139` neither requests long-post content nor saves it when provided. Normalization keeps only `text` and discards entities, attachment metadata, edit history, and even the requested conversation ID. | Preserve the permitted original payload and complete text before analysis. Add explicit full-text, source-context, and attachment-coverage status. |
| P1 | `src/classify.js:157–177` only resumes a pending batch when its date equals the current target date. If the 55-minute wait expires, tomorrow targets a different day and can overwrite the previous batch pointer. | Keep a queue of batches keyed by batch ID, source date, input manifest, taxonomy version, and status. Submit and collect in separate short jobs. |
| P1 | “Permanent append-only Git archive” cannot implement content removal reliably. Old copies persist in commit history and clones. | Keep raw content in controlled storage that supports required removals, including derived indexes and backups. Keep application code and taxonomy in Git. |
| P2 | `src/syntax.js:53` counts X account IDs as members. Two accounts belonging to one representative plus one other representative are reported as three members. | Use a stable member ID for spread; retain account ID separately. Apply the same rule to all analysis modules. |
| P2 | `src/syntax.js:36,83,91` excludes phrases with certain common words at the ends, limits phrases to four words, scans one calendar day, and records first-seen only after a phrase enters that day's retained results. | Preserve exact spans and an occurrence index; rank separately. Use rolling windows and record first observed use before thresholding or top-N truncation. |
| P2 | `src/store.js:35–47` counts returned objects in Eastern calendar days, including repeated reads, rather than distinct billable resources per UTC day. The poller checks budget only before its entire page loop. A one-read budget fetched two posts in an offline reproduction. | Separate returned objects, estimated billable resources, and reported charges. Use UTC billing windows, dollar-aware reservation before requests, and an explicit ingestion reserve. |
| P2 | `src/refresh.js:18` selects yesterday's archive, rather than posts reaching 24 hours of age. At 03:30 ET, yesterday's posts range roughly from 3.5 to 27.5 hours old. Deferred work is not automatically revisited once that date falls out of the selection. | Schedule per-post refresh due times, retain overdue work, record actual measurement time, and avoid calling calendar-day snapshots “24-hour engagement.” |
| P2 | `site/index.html:48` loads rollups once. Only the nightly workflow builds them. The caucus selector filters topic rows but phrase rows still use the overall daily phrase file. | Publish fresh data independently of site deployment, periodically refetch it, and make filter scope explicit and consistent across panels. |
| P2 | `config/accounts.csv` contains 14 starter accounts. There is no list-membership synchronization, complete House roster, or historical membership table. | Establish the complete House Democratic member universe, then associate official/personal/campaign accounts and time-bounded caucus membership. Track unresolved accounts visibly. |

Additional source findings: missing metrics become zero; unavailable lookup results are not distinguished from transient failures; partial classification output causes future automatic runs to skip that day's file; classifier outputs are not validated against a strict input-ID manifest; and the shared workflow writer lock includes a potentially 55-minute classification wait. The current test suite mainly checks helper functions and cannot establish end-to-end capture reliability.

**Correcting the technical assumptions**

The current X Activity documentation offers public-account `post.create` and `post.delete` subscriptions by user ID, without requiring authorization from each public account. It lists 1,500 self-serve subscriptions and webhook or persistent-stream delivery. That is a promising fit for this project, subject to testing with the actual developer app. [X Activity documentation](https://docs.x.com/x-api/activity/introduction)

The event-payload documentation says `post.create` covers authored standalone posts, replies, quotes, and reposts. This is different from subscriptions to interactions received by an account. Validate each type, long text, edits, duplicate delivery, and recovery using captured fixtures before choosing this as the primary collector. [X event payloads](https://docs.x.com/x-api/activity/event-payloads)

Filtered Stream is another documented option, with pay-per-use access and author rules. Keep a single primary delivery path to avoid needless operational complexity; use timeline/search reconciliation to find gaps. [Filtered Stream](https://docs.x.com/x-api/posts/filtered-stream/introduction)

The List endpoint documents pagination but no `since_id`. Per-user timelines document ID and time bounds, making them useful for recovery. The current generated List reference uses `post.fields` and related renamed fields, while the general fields guide still shows `tweet.fields`. Avoid blindly replacing strings across the repository: verify the accepted request fields for each endpoint and normalize observed old/new response shapes at the API boundary. [List reference](https://docs.x.com/x-api/lists/get-list-posts), [user timeline reference](https://docs.x.com/x-api/users/get-posts), [fields guide](https://docs.x.com/x-api/fundamentals/fields)

The claim that public endpoint rate limits are unavailable is outdated: X now publishes a table. Treat response headers and the actual app's entitlements as the operating constraints. [Rate-limit reference](https://docs.x.com/x-api/fundamentals/rate-limits)

The older brief's claim that all history older than seven days is unrecoverable is also too strong. X documents full-archive search for pay-per-use customers. Historical availability, retrieval scope, and cost still need a measured trial. Deleted or inaccessible posts cannot be promised. [Search documentation](https://docs.x.com/x-api/posts/search/introduction)

GitHub warns that scheduled Actions may be delayed or dropped. Actions can support an inexpensive trial, but a 30-minute cron expression does not establish a 30-minute service guarantee. [GitHub schedule documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

X's policy requires stored content to follow modifications/removals and restricts bulk redistribution. The public status of a representative's posts does not by itself permit a publicly downloadable permanent raw archive. Private storage still needs content-removal handling. [X Developer Policy](https://docs.x.com/developer-terms/policy)

**What “understand what members are saying” requires**

Capture should be independent of today's taxonomy. The collector must not omit an account's post because it lacks known keywords. All eligible public posts enter the corpus before classification, including posts that are unclassified, routine, or unrelated to policy.

Maintain three distinct analytical layers:

1. **Subjects:** multi-label parent topics and subtopics. A post can address Immigration and Health Care simultaneously; counts across topics are consequently non-additive. Parent counts use unique post IDs.
2. **Entities and events:** facilities, agencies, bills, places, incidents, and their relationships. A new incident within an existing topic must be discoverable even when the post already has a valid parent-topic label. Clustering only wholly unclassified posts misses that case.
3. **Language:** exact repeated wording, longer recurring passages, sentence-level near duplicates, and paraphrases. Keep exact matches distinct from semantic similarity and from quoting or rebutting someone else's words.

A geographic correction matters here: Dilley is in Texas. Delaney Hall is in Newark, New Jersey. The original taxonomy incorrectly places “NJ detention” among Dilley aliases; remove that alias and model the facilities separately. District relevance should come from resolved places and the member's district at the event date, with evidence and uncertainty. [ICE Dilley audit](https://www.ice.gov/doclib/foia/prea_audit/southTexasFRC_Mar5-7_2024.pdf), [ICE Delaney Hall contract](https://www.ice.gov/doclib/foia/detFacContracts/70CDCR25D00000007-BASEDelaney%20HallCDF-NewarkNJ.pdf)

For phrase preservation, store exact original text, character offsets, capitalization, punctuation, hashtags, and surrounding sentences. Keep a normalized search/index copy separately. Use configurable phrase lengths and repeated-span extraction; expanding four words to eight alone does not satisfy the requirement. Avoid removing negation or merging opposite meanings. Original wording remains available for any later custom analysis, even if a phrase never appears in the ranked dashboard.

The offline checks show that “not a crime” is excluded by the stopword rule and “we will not be silent” cannot fit the four-word limit. Three members using wording within 15 minutes across Eastern midnight are missed by the daily threshold. These are direct failures of the requested use case.

Track first observed use across the indexed corpus, first use per member, and adoption over rolling windows. Label the result “first observed in our archive,” with the archive's coverage dates. Shared wording alone does not establish coordination. Keep authored uses, quoted uses, and repost amplification separate.

Preserve original text for quotes and replies alongside referenced context. Fetch a referenced original once when needed and available; distinguish its author's words from the member's added words. A repost can inherit content labels while remaining an amplification event. Image-only statements and videos require a separate OCR/transcription stage if their wording is in scope; keep machine-extracted content marked and linked to its source, and show media coverage gaps until implemented.

**Recommended operational design**

Use the existing Node code as a starting point. A conventional database should hold current permitted content, membership, analysis results, jobs, and metrics snapshots. Postgres is a reasonable production default for independently running collectors and analysis workers; SQLite is adequate for a single-worker local trial. Export versioned analysis datasets where permitted, with documented content-removal behavior. An open-model hosting platform is optional, not necessary to establish this foundation.

The processing path should be: public post delivery → durable store → analysis queue → labels/entities/phrases → incremental dashboard data. Add a separate scheduled reconciliation process. Classification outages must leave posts safely stored and visibly pending, without stopping capture. Use uniqueness constraints so replay is harmless.

Keep these records separate:

| Record | Purpose |
| --- | --- |
| Members, accounts, membership intervals | Stable identities, multiple accounts, House-only eligibility, district and caucus history |
| Post versions and references | Full permitted source content, original creation time, capture time, edit relationships, quote/reply/repost context |
| Ingestion intervals and deliveries | Checkpoints, event IDs, unfinished pagination, retry state, confirmed coverage gaps |
| Analysis runs and assignments | Model/prompt/taxonomy versions, input IDs, evidence spans, processing status, review corrections |
| Entities and events | Place/facility/incident identity, merge/split history, district relevance and evidence |
| Phrase occurrences | Original spans, normalized form, post ID, member ID, first-observed time, authored/amplified status |
| Metrics observations | Timestamped measurements, unavailable status, source, actual post age |
| Usage ledger | UTC billing day, resource class/ID, estimated charges, provider reconciliation |

For 30-minute service, begin with corrected polling and refresh analysis after each successful ingestion. For event-driven service, trial X Activity for public creation/deletion events, then retain periodic gap recovery. A webhook receiver must validate provider signatures, save before acknowledging, handle duplicate/out-of-order events, and expose collection health. An ordinary managed receiver can avoid maintaining a persistent connection. Choose a host after the delivery trial clarifies requirements.

Do not redeploy the site's application every time a member posts. Let the running page request updated dashboard data, initially every 30–60 seconds; add push updates if the measured benefit warrants it. Show collection freshness separately from classification freshness and engagement age.

**Dashboard scope for the first useful release**

| Panel | What it should answer |
| --- | --- |
| Emerging topics and subtopics | What is newly appearing or accelerating over 30 minutes, 2 hours, and 24 hours? How many distinct members, and compared with what baseline? |
| District incidents | Which member has reported a possible local emergency? What happened, where, when, and what exact wording supports the flag? |
| Wording and adoption | Which exact phrases or longer passages are spreading? Who first used them in the archive, who followed, and which uses are reposts? |
| Evidence explorer | Show the complete permitted posts behind every aggregate, with member/account, time, topic, event, and source link filters. |
| Coverage and health | Which accounts are covered, when collection last succeeded, where gaps remain, how much is awaiting analysis, and current spend? |

District incident candidates must be eligible with one member's post. A three-member rule is appropriate only as a tunable broad-spread signal. Keep a candidate's source and confidence visible; a member reporting an incident is evidence of what the member said, not independent confirmation of the incident.

For broad trends, combine distinct-member counts, share of active members, new entities, and change from a comparable recent baseline. Require both an absolute floor and relative increase so one-to-two-post changes do not dominate. Use minimum-baseline handling during the first weeks. Keep raw totals alongside normalized rates. Engagement is a secondary measure of audience response, with its observation age shown; it should not hide the first report of a crisis.

**Cost and classifier choice**

X's published price is $0.005 per post read or creation event. Its daily resource deduplication resets at midnight UTC and is described as a soft guarantee. Under the unverified assumption of 2,000 posts/day and a 30-day month, capture alone is approximately $300. Refreshing every post on another UTC day adds approximately $300; refreshing 65% adds approximately $195. These are estimates before extra context, backfill, user lookups, and hosting. [X pricing](https://docs.x.com/x-api/getting-started/pricing)

Do a seven-day measured pilot with a small daily cap and a representative account sample before extrapolating caucus-wide cost. Prioritize capture over elective engagement refreshes when budget is constrained. Record the resulting coverage gaps rather than implying completeness when collection is paused.

Start with a small hosted classifier benchmarked on a human-reviewed set of representative posts, including long posts, district incidents, quotes, negation, overlapping topics, and new facilities. Haiku 4.5 is a plausible first candidate, with selective escalation for difficult cases. The published rates are $1/$5 per million input/output tokens; batch rates are $0.50/$2.50. The pasted ~$60 monthly two-pass estimate depends on its token/cache assumptions and is not a measured budget. Current Sonnet 5 pricing also differs from the pasted scheduled-increase assumption. [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)

Automatically rerunning the same model over every post nightly is not evidence of better accuracy. Prefer retries for failures, selected uncertain cases, a quality sample, and explicit reclassification after taxonomy changes. Keep old run metadata so differences are explainable. Defer distillation until there is a stable taxonomy, a human-reviewed evaluation set, and a demonstrated cost or latency need; evaluate permission to use the corpus for training separately.

**Build sequence and acceptance criteria**

1. **Establish the new repository:** bring the existing package into the new repository root with provenance, safe defaults, and disabled production schedules until configured. Keep credentials in secret storage. Use the user's requested House-only scope. Confirm the X List/account roster, history range, and a measured-pilot budget.
2. **Repair and prove collection:** implement incomplete-interval recovery, per-account reconciliation, complete-text normalization, deletion/edit handling, transactional persistence, and cost accounting. Test ordinary posts, replies, quotes, reposts, long text, page caps, 429/5xx responses, restart mid-page, duplicate delivery, and a simulated outage. Acceptance: no unexplained missing API-accessible posts in the bounded reconciliation interval, and all unresolved gaps visible.
3. **Create the usable corpus:** complete member/account mapping and versioned analysis records. Acceptance: two accounts from one member count once; source wording is recoverable; unknown/unclassified content stays searchable; retention changes propagate to derived views.
4. **Deliver the 30-minute dashboard:** topic/subtopic evidence, rolling phrase analysis, district candidates, filter consistency, and health status. Acceptance: a fixture incident from one member appears; a three-member phrase spanning midnight is found; negation and long text survive; every aggregate opens its underlying evidence. Measure publication-to-capture and capture-to-analysis latency separately.
5. **Trial event delivery and expand:** validate the actual app's subscriptions and bill, measure replay/reconciliation performance, then expand to all verified accounts. Choose operational latency/error targets from the pilot and monitor them. Expand historical coverage with an explicitly bounded backfill budget.

**Astra/Codex versus Fable/Claude Code**

Continue from the existing codebase rather than commissioning a second disconnected build. The development assistant, classifier used by the product, and infrastructure that runs collection are separate choices. This review does not establish that either assistant is categorically better. Choose the working environment that can access the repository, run the failure tests, make reviewable changes, and inspect production health. The next milestone is reliable collection plus complete text and a working 30-minute dashboard; changing assistants alone does not deliver it.

The accompanying `reproduced-findings.json` records seven offline scenarios. `reproduce-findings.mjs` recreates them using synthetic payloads against temporary copies of the inspected source. `bundle-comparison.json` records the 23 matching bundle sections. The source snapshot is included under `review/reference/` to make the assessment reproducible.
