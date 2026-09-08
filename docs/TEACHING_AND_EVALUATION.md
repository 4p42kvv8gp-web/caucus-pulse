# Teaching and checking classifications

The teaching loop now records the prediction shown at review time, the corrected labels, the reason, the reviewer, and the source version. A later model request can receive relevant reviewed examples. This changes the examples supplied to the model; it does not retrain model weights or automatically approve a general rule.

No semantic provider is connected yet. The working evaluation command runs the local literal baseline without any network requests. Real voice calibration and model comparisons still need Jacob's saved judgments and a provider with spending controls.

## A first voice session

1. Open a real saved post with its original date, complete available wording, source link, and context limitations.
2. Read its proposed subjects and short evidence explanation. Ask one focused question about a distinction: broad topic versus facility, separate subjects in one post, a reported event, quotation, or missing context.
3. Restate Jacob's answer and save the post-specific labels and reason. Include the displayed `sourceHash`; an edited source will reject an outdated correction. Keep a possible general rule in `ruleProposal`, which remains unapproved.
4. Reserve a different post for testing before using its answer as a teaching example. Collect a judgment for that post independently.
5. Compare later candidate output on the reserved examples. Inspect missing and extra labels and the underlying wording. A matching topic label alone does not establish correct event interpretation or location.

Do not mark an assistant's suggested answer as a human correction. Synthetic automated test records are never user reviews. One saved local review was observed during this milestone; no real evaluation set or model comparison has been created from it.

## Decisions and uncertainty

The feedback API accepts `decision` with these meanings:

| Decision | Meaning | Used as a reviewed example or test answer? |
| --- | --- | --- |
| `classified` | The supplied nonempty topic labels are accepted for this post. | Yes, when otherwise eligible. |
| `no-supported-topic` | The reviewer explicitly decided that no subject label is supported. Labels must be empty. | Yes. Previous predicted topics can locate relevant negative examples. |
| `needs-context` | The interpretation is unresolved. | No. |

Existing forms infer `classified` for nonempty labels and `needs-context` for empty labels. An explicit negative decision is available through the feedback API for a facilitated voice session; a dedicated control can be connected with the incoming dashboard design. Older empty-label reviews are not treated as negative test answers. A new review stores the earlier prediction and previously accepted labels without replacing history.

## Reserved examples

`reserveHoldouts` keeps selected posts out of future reviewed-example retrieval. It also excludes copies that match after case/whitespace normalization, direct reference relationships, and known edit siblings. Previous held-out wording stays protected after source edits. Source removal clears the associated stored content and fingerprints.

These checks do not identify every paraphrase, shared image, or related story. They cannot undo earlier exposure or tell whether a provider has seen a public post before. Reserve test examples early and review related cases together. There is no automatic release from the held-out role.

## Local commands

All commands below use the local private database and make no network or model requests. `CAUCUS_DB_PATH` can select a separate test database. Substitute actual stored post/set/run IDs for the uppercase placeholders; do not paste credentials.

```sh
node scripts/learning.js status
node scripts/learning.js reserve POST_ID OTHER_POST_ID
node scripts/learning.js create "First calibration" POST_ID OTHER_POST_ID
node scripts/learning.js baseline SET_ID
node scripts/learning.js report RUN_ID
```

Creating a set requires 1–25 distinct, reviewed, current sources and also reserves them. The expected topic/subtopic labels and feedback identifiers are frozen. A changed source or later correction requires a new set version; old reports retain their earlier comparison but mark it outdated. A set cannot proceed after one of its sources is removed.

The baseline command stores a separate evaluation run and prints descriptive case counts. Detailed private results are available at `GET /api/evaluations/RUN_ID`, including expected labels, candidate explanations, missing/extra labels, and validity. It never replaces dashboard labels. Exact label matching is order-independent and case-sensitive; it does not grade politicians or political positions.

## Inspecting learning

- `GET /api/learning` returns review, held-out, evaluation, and unfinished-run counts.
- `GET /api/posts/POST_ID/learning` lists semantic runs and the reviewed examples supplied to each. Removed, edited, superseded, or newly held-out lessons are marked accordingly.
- `GET /api/dashboard` includes the same counts under `operations.learning` for the redesigned dashboard to display.

An example's presence documents what the request received. It is not proof that the example caused an output. Updated examples reject late semantic output; previous saved runs remain available with provenance. Restoring an earlier run remains an explicit action and preserves its original example references and the current human correction.

## Evaluation execution and limits

The provider-neutral `runEvaluation` helper records pending cases before invoking a supplied callback, validates source evidence, and stores results independently of production analyses. It never supplies frozen expected answers to the callback. Each request receives a separate copy, preventing accidental callback changes to the saved input manifest. Removed sources cannot be recreated by late results; changed source, review, or examples invalidate late output. Provider errors are redacted, and invalid or failed cases never count as matches.

A crash leaves a visible unfinished run. There is no automatic retry, resume, promotion, or paid provider integration. Do not attach a paid callback until its cost reservation, timeouts, durable worker, and authorization are implemented. This helper bounds a set to 25 cases but is not a financial guard.

The comparison currently covers exact topic/subtopic labels only. Event/location quality, quotation and negation interpretation, new-subject discovery, semantic equivalence, and broader regression evaluation remain required intelligence work. Database removal cascades through stored evaluation cases/results; backup/WAL cleanup remains deployment work.

Keep real posts, corrections, test sets, results, and database files private and out of Git. The repository contains only implementation, documentation, and synthetic automated tests.
