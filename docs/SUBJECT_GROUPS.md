# Emerging subject candidates

The Emerging candidates view proposes related passages across classified and unclassified posts. A new event can appear inside an established broad topic; restricting discovery to unlabeled posts would miss it. This service groups similar subject matter. It does not establish event identity, shared claims, agreement, factual truth, coordination, or that a subject is new outside the selected archive window.

## Evidence and coverage

`GET /api/emerging` uses the same current-label, member, caucus and literal filters as the explorer. The default window is 24 hours; explicit dates may span at most 31 days. Reposts are excluded. Quote captions remain eligible with unresolved quotation attribution. Titles are representative source passages, not generated facts or assigned taxonomy labels. The interface shortens the displayed excerpt but retains the complete source and highlighted evidence.

The snapshot includes at most 250 newest indexed posts, 1,000 passages and 150,000 UTF-16 source characters. A post that cannot fit is omitted whole. Passages with fewer than four Unicode word units are excluded and counted. The response distinguishes selected, indexed, examined and omitted sources, and never treats a partial scan as complete coverage. Groups need at least two posts and two distinct stored member identities; two accounts belonging to one member count once.

Recent and previous 30-minute counts describe observed posts and members. The previous comparison is unknown when the selection or index does not fully cover that window. A known zero and an incomplete observation are different states. First/last observed dates apply only to this selected source window, not the incident's actual start or end. Groups may overlap; their counts must not be added as though mutually exclusive. Current source-topic rollups are not group labels.

## Local computation and invalidation

Algorithm `passage-complete-link-candidates-v1` compares normalized source-passage embeddings. For each anchor it picks the best passage from each other post, then requires every admitted representative to meet the threshold against every other admitted representative. This prevents a chain of individually adjacent passages from silently joining unrelated endpoints. Overlapping groups are suppressed only when their representative passages are also related, preserving separate subjects discussed in the same posts.

The initial BGE threshold is 0.68, adjustable from 0.5 to 0.95 for engineering evaluation. It is not a confidence or agreement percentage. The choice is provisional and model-specific. The result limit defaults to 20 and caps at 50. There is no 30-member membership cap; the snapshot can include all 250 selected posts in a group when the evidence supports it.

Each request computes a fresh bounded snapshot in a worker with an empty inherited environment, a 128 MB JavaScript heap limit and a 15-second timeout. One group computation may run at a time; extra calls return 429. A source, review or attribution change during computation rejects its result with 409. Invalid parameters fail before worker execution. No source text leaves the local application and no model download is triggered by this endpoint.

Candidate IDs include source versions and passages. They are not stable incident identities or historical trend tracks. There is no persistent group cache, automatic event merge, or learned threshold. The open view refreshes once a minute and after filter changes. New embeddings become eligible on the next request.

## Engineering checks, September 8, 2026

All 110 local tests pass, including eight group tests for labeled/unlabeled discovery, distinct topics in the same posts, chaining, member/account deduplication, reposts/quotes, missing comparison windows, resource limits, invalid vectors, source/review/removal races and HTTP behavior. Tests use synthetic records and create no real feedback.

`node scripts/benchmark-subject-groups.js bge` compares 17 synthetic posts with 31 passages across five subjects and two unrelated examples. At 0.68 BGE recovered all three central-bank paraphrases, three detention examples and the three-post flood, wildfire and shooting families, with one overlapping shooting subgroup. The equivalent MiniLM run fragmented detention and omitted the central-bank paraphrase. At 0.55 BGE merged unrelated subjects, illustrating why the threshold needs calibration. Corrective and opposing claims can remain subject-related; no shared position is inferred.

A separate worst-case local check with 1,000 identical passage vectors across 250 posts evaluated 498,000 cross-post pairs in about 697 ms, with roughly 110 MB process RSS. This is a local synthetic timing, not a production throughput guarantee. The 24-hour preview currently has zero candidate groups because the two actual archived examples are historical. Their dates were not changed to populate the card.
