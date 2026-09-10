# Blind classifier eval — 2026-09-10

823 items, labelled independently by a model that saw only the sealed package
(823 posts as `{item_id, text}`, the taxonomy rekeyed to `M##`/`M##_S##`, the
output schema, seven worked examples). No repo access, no label statistics, no
knowledge of what the shipped classifier had assigned.

Graded with `eval/score.py`. The returned file validated on the first pass:
823 items, every id once, in order, every taxonomy key resolving.

## The finding: the subtopic layer is barely used

The taxonomy has 46 subtopics. The shipped classifier almost never reaches them.

| | shipped pipeline | blind labeler |
|---|---|---|
| total label pairs | 905 | 1,056 |
| of which subtopics | **208** | **757** |
| posts carrying any subtopic | **137 (17.5%)** | **487 (62.2%)** |

Restricting to the 420 posts where **both labelers chose the same macro set** —
so there is no disagreement about what the post is about — the gap is starker:

- pipeline assigned a subtopic on **95 (22.6%)**
- blind labeler assigned one on **338 (80.5%)**

This is not a few edge cases. Across the sampled corpus, 228 of 262 request
chunks came back with **zero subtopic assignments for any post in the chunk**.

That is what drives the headline agreement numbers: 36.1% identical label sets
but **69.6% identical macro sets**. The two labelers largely agree about what
posts are about. They disagree about whether to say so specifically.

## Why, most likely

The eval brief carried an explicit anti-default instruction that the production
prompt does not:

> **Before you emit `[macro, null]` for a macro, read that macro's full subtopic
> list once and confirm none of them fits. Do not default to `null`.**

`src/taxonomy.js` tells the model to "assign the most specific level that fits:
use `macro/sub` when a subtopic applies, bare `macro` when only the macro level
fits" — the same *permission*, with no instruction to check before defaulting.

This is a hypothesis, not a proven cause. The experiment designed to isolate it
was the NO-SWEEP arm (one batch labelled without rule 5, compared against the
rest), and that arm produced nothing measurable — see below.

## What this does NOT establish

**Nothing here says the pipeline is wrong.** `eval/keys/calibration.csv` holds 40
items with an empty `owner_labels` column. Until a human fills them, every number
above is *disagreement between two automated labelers*, and it is entirely
possible the blind labeler over-assigns subtopics rather than the pipeline
under-assigning them. The 3.6x gap is large enough to be interesting; it is not
self-interpreting.

**The blind labeler's own reliability caps everything.** On 28 verbatim twins —
the same post shown twice under two ids — it agreed with itself 23 times
(82.1%). On 12 paraphrase canaries (one place name swapped) 9 times (75.0%). So
roughly a sixth of all measured disagreement could be its own noise.

**Its stated confidence is inverted and should not be trusted.** Agreement was
38.4% on items it called `high` (n=510), 25.8% on `medium` (n=240), and 75.8% on
`low` (n=33). Low-confidence items are mostly thin posts both labelers left
empty, so the field tracks post richness, not correctness.

## The empty-label question, answered

This eval was commissioned to size the failure in `DEVELOPING_STORIES.md`, where
7 of 20 posts about one story carried no label at all.

Corpus-wide, that failure is **small**: 41 of 783 sampled posts (5.2%; 3.7%
weighted to the full corpus) carry no pipeline label but were labelled by the
blind reader. The pipeline and the blind labeler agree on emptiness 125 times.

So the taxonomy holds routine traffic well. The Bunch story's 35% unlabelled rate
is roughly **seven times** the corpus baseline — which supports rather than
undermines the original claim: the gap opens on *new* stories, not on the
everyday drumbeat.

Subjects the blind labeler said no macro covers, most frequent first:
`transportation-infrastructure` (4), `agriculture-farm-policy` (3),
`geographic-naming`, `transportation-policy`, `transportation-safety`,
`public-monuments` (1 each). Transport accounts for 6 of 11 — the clearest
candidate for a missing macro.

## A cost worth recording

The brief was edited before the run: the "process 20 items per turn, do not carry
reasoning between batches" instruction was replaced with "process all 823 items,
no per-turn or batch-size limit." Every other package file is byte-identical to
what was sealed (`items.jsonl`, `taxonomy.md`, `schema.md`, `examples.jsonl` all
match their original hashes).

That edit is why §7 of the report is empty. The NO-SWEEP arm marked one *turn*,
and with no turns there was nothing to mark: the report shows 0.0% vs 0.0% on
n=4. The one experiment that would have tested the rule-5 hypothesis directly is
gone from this run. It is recoverable — a second run with batching restored would
measure it — but it is not in this data.

The single-pass format did not obviously contaminate the labels: if all 823 items
shared one context and the model recognised repeats, twin agreement would be near
100%. It was 82.1%.

## What to do next, in order

1. **Fill the 40 calibration rows.** Nothing above becomes a statement about
   correctness until then, and they must be labelled before reading this
   document to avoid anchoring. This is the highest-value hour available.
2. **Do not add subtopics to a layer that is used 17.5% of the time.** PR #13
   adds 10 more. Land it for coverage, but expect little movement until the
   assignment rate changes.
3. **Test the rule-5 hypothesis cheaply**: add the anti-default sentence to
   `src/taxonomy.js`, re-classify a few closed days, and compare subtopic rates
   against the committed ones. Needs Anthropic credit; it is a one-line change
   and the corpus is already on disk.
4. **Consider a transport macro.** Six of eleven gap reports point at it.

## Files

- `eval/results/2026-09-10-verdicts.jsonl` — the returned labels, 823 lines.
- `eval/results/2026-09-10-report.md` — the full scored report.
- `eval/results/2026-09-10-brief-as-run.md` — the brief actually used, which is
  not the one `eval/build.py` produces.
