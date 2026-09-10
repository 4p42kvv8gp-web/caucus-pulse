# Intelligence everywhere — layer map

Owner's rule (2026-09-10): *"We need to look at the posts and examine them for
similarities in the current trends we're tracking; keyword searches and
numerical data are not enough."* And: *"the story is the unit."*

Every layer keeps its measured numbers and adds a reading-and-judging step
that reads the posts, decides, and says why. Judgments are labelled as
judgments; unverified claims say so.

| Layer | Counted / matched today | Reads and judges (target) | Status |
|---|---|---|---|
| Topic classification | Claude reads every post against the taxonomy | story-first taxonomy; quoted-post context; anchors (a viral post defines a story); similarity candidates as hints; editors' corrections as precedents | quoted context + anchors merged (#12); semantic hints built (`withCandidates`, night-semantic-integration); taxonomy v2 in progress tonight |
| Emerging → stories | label-token merge; placement call | evidence-backed merges; duplicate confirmation across batches; continuous promotion with retirement | merged (#11) / promotion in progress |
| Semantic matching | local embedding index (every post, incremental per poll); centroid per story; "similar, unlabeled" on every emerging card and story row; hints to the classifier | neighbors judged by Claude with a reason, in the nightly loop (today: on demand via `npm run semantic-proof`) | index, dashboard lists and hints built (night-semantic-index + night-semantic-integration); nightly judge queued |
| Strategic syntax (phrases) | 2–4-gram counts by distinct members | message families by meaning: paraphrases of one line grouped and named, adoption measured on the family; n-grams remain one signal | queued (chain step 3) |
| Momentum / trends | formula over counts | "why it moved": for each top mover, Claude reads the driving posts and writes the reason with example posts | queued (chain step 1) |
| Incidents | kind+place string grouping; nightly intel | semantic corroboration (same event, different words/places); provisional single-post cards with evidence spans; audit-driven prompt rules | audit + provisional build in progress; corroboration queued (chain step 2) |
| Feed | newest / top | grouped by story with the reason a post belongs; unlabeled posts that look like a tracked story flagged | queued (chain step 4) |
| Outside context | newsletter snippet matches | X search + List scans matched to stories by meaning, judged; web articles read for the claim check; sources cited | design in progress; pilot on the Coxon story running |
| Daily report | template strings over rollups | written from the evidence: what moved and why, who carried it, what is new, what needs a decision; every line sourced | after the layers above land |
| Corrections | — | editors' precedents in the prompt; applied to stored assignments and retweets | merged (#11) |

Rules for every judging step:

1. Input is the post text (plus quoted context), never a keyword hit alone.
2. Output carries `reason` and `evidence` (ids or exact spans) next to the verdict.
3. Bounded: fixed batch sizes, cached results keyed by content, ledgered spend.
4. Measured numbers are never overwritten by a judgment; they sit side by side.
