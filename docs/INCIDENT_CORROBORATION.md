# Incident corroboration — the judgment beside the string grouping

`src/incidents.js` keys incident cards on the exact normalised kind+place
string. The audit (docs/INCIDENT_AUDIT.md) found that 16 of 29 cards were
fragments of six events — kind synonyms ("hazmat release" / "chemical leak"),
place granularity ("Big Sur" / "Monterey County", "Detroit" / "Southeast
Michigan"), whichever town a daily update named — and that a second member's
post about the same event never reached the first member's card. Sixteen
of the 29 were not breaking incidents at all (aftermath, reactions, policy).

`corroborate()` is the reading-and-judging step after grouping, following the
rules in docs/INTELLIGENCE_EVERYWHERE.md: input is post text, output carries
a reason and an exact span, the work is bounded and cached, and the measured
numbers stay where they are.

## What the judge reads

- Every **open card** — status `provisional` (the single-post card of the
  provisional build, once that lands), `active` or `monitoring` — with its
  kind, place, evidence span (`evidence.span` when the card has one, else
  the lead post's opening words) and its member posts (handle, district,
  time, text, quoted context when the referenced post is known; the first
  three and the latest when a card is long).
- Every **candidate post**: incident-flagged in the last
  `settings.incidents.candidate_days` days and on no open card — a post on a
  resolved card, or a loose flag — labelled with its classifier kind/place
  and the resolved card it sits on.
- **Unflagged neighbors** (hook): posts the semantic index places near a
  card's centroid that the classifier never flagged, marked "unflagged
  neighbor" with the similarity. `unflaggedNeighbors()` imports
  `src/semantic.js → relatedPosts()` when it exists (branch
  claude/night-semantic-integration) and returns nothing until then; tests
  inject `neighbors` directly.

Cards are batched by state (a split event is almost always in one state),
at most `batch_incidents` (15) cards and `batch_candidates` (40) posts per
call; candidates from a state with no open card ride along in the emptiest
batch so they can still be set aside.

## What it decides

One JSON reply per batch:

- `groups` — one real-world event each: the open cards that are that event
  (two or more = duplicates to merge) and the candidate posts that are that
  event. Reason (≤ 30 words) and `evidence: {post, span}`.
- `drops` — flagged posts that are not a breaking district emergency the
  member is handling, with a fixed vocabulary: `commemoration`,
  `hypothetical`, `national_policy`, `aftermath`, `reaction`. Reason and
  exact span.

The prompt (`JUDGE_SYSTEM`) carries the audit's failure modes as rules and
says: when in doubt, neither merge nor drop.

## How it is applied (deterministic)

`normalizeJudgment()` keeps only ids that were shown, lets a card or post sit
in at most one group (first wins), lets a drop beat a group, refuses unknown
categories and empty reasons, and checks every span verbatim against the
post (an unverified span stays, flagged `verified: false`).

`applyJudgment()` then, in batch order: drops first (the post leaves its
card; a card left empty disappears from the desk), then each group — the
surviving card is the one with the most posts, then the earliest, then the
id, so the fuller card keeps its id and the dashboard's links stay stable;
the other cards and the candidate posts fold into it; each fold is logged.

A provisional card whose distinct-member count reaches two advances to the
measured lifecycle (`statusOf(last)` — `active` when the last post is within
12 h); one that gains only its own member's posts stays provisional.

## What is written

`data/incidents.json`:

- `incidents[].mergeLog` — `[{merged_from, kind, place, posts, reason,
  evidence, at, via}]`; `via` is `card` (a duplicate card), `post` (a loose
  flagged post, `merged_from` = the resolved card it sat on or null) or
  `neighbor` (semantic). Re-applied on the next run before the judge is
  asked again (`sticky: true`), so cards do not re-split between runs.
- `incidents[].sources` — the merge log rolled up per source for the desk.
- `incidents[].timeline[].from` — the source card of a merged-in post.
- `incidents[].corroboration` — `members` and `posts` (measured), `merged`
  (folds applied), `status` (`corroborated` when two or more members,
  else `single-source`), `reason` and `evidence` (the judge's, for the
  latest fold), `judged` (whether the judge read the card this run, fresh
  or cached), `advanced` (`provisional→active` when that happened).
- `dropped[]` — `{tweetId, incidentId, handle, category, reason, evidence,
  at}`, re-applied on later runs.
- `judge` — the run's counts (batches, asked, cached, merges, drops,
  re-applied, skipped, failed).

`data/incident-judgments.json` — every judgment keyed by the sha of exactly
what was asked (system prompt + rendered batch + model), pruned after
`cache_days`; `ledger[<ET day>] = {calls, inputTokens, outputTokens}`,
capped by `daily_calls`. A re-run over unchanged content asks nothing.

## Where it shows

- Incident desk cards: corroboration line ("corroborated · 2 members · 3
  posts · 1 merged", or "single source", or "not judged") and the one-line
  reason; the detail header repeats it with the span on hover; timeline
  entries that came in through a merge carry a "via <card>" chip; a
  "Merged sources · judged by Claude" panel lists each source with its
  reason; a "Set aside by the judge" panel lists the posts dropped from
  that card with category and reason.
- Dashboard "Breaking in district" cards: the same corroboration line.
- `site/data/rollups.json → incidentJudge` carries the dropped list and
  the run counts.

## Running it

- `npm run incidents` — grouping, corroboration, intel (nightly).
- `node --use-env-proxy src/incidents.js --no-corroborate` — grouping
  only; earlier merges and drops are still re-applied.
- `--force` ignores the judgment cache.
- Poll time (`buildIncidents({withIntel: false})`) runs corroboration too:
  with unchanged content it costs nothing; a new flagged post re-asks one
  batch.

## Known limits

- A group with no open card (two resolved cards that are one event) is not
  merged; the judge is asked about open cards only.
- A state with more than 15 open cards is judged in chunks; duplicates
  across chunks are missed until the next run.
- Drops are the judge's call: a wrongly set-aside post can be found in
  `dropped[]` with its reason; deleting the entry from data/incidents.json
  and re-running restores it (the cache key changes, so the judge is asked
  again).
