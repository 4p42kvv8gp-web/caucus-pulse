# Teaching and checking classifications

The teaching loop records the prediction shown at review time, the corrected labels, the reason, the reviewer, and the source version. The current local Political DEBATE model uses fixed hypotheses; it does not consume reviewed examples or retrain its weights. A separate provider interface can supply relevant reviewed examples to future evaluated models. Neither path automatically approves a general rule.

Local model classification and semantic search are connected and run without a hosted endpoint. The evaluation command can run the literal baseline or the selected local classifier; an actual comparison still needs independently reserved human judgments. Three real posts are admitted to the pilot, and one authentic review is saved. This is enough to begin a voice exercise, not enough to claim accuracy or train a new classifier.

## A first voice session

1. Open a real saved post with its original date, complete available wording, source link, and context limitations.
2. Read its proposed subjects and short evidence explanation. Ask one focused question about a distinction: broad topic versus facility, separate subjects in one post, a reported event, quotation, or missing context.
3. Restate Jacob's answer and save the post-specific labels and reason only when his instruction authorizes that judgment. Include the displayed `sourceHash`, `predictionHash` and `reviewId` (including null for a first review); an edited source, changed prediction or intervening review rejects an outdated correction. Keep a possible general rule in `ruleProposal`, which remains unapproved.
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

The teaching form explicitly offers all three decisions and requires a reason. A supported empty answer is distinct from uncertainty. Older empty-label reviews are not treated as negative test answers. A new review stores the earlier prediction and previously accepted labels without replacing history. Save-in-progress controls protect the displayed form; concurrent source/prediction/review changes still require reloading.

## Reserved examples

`reserveHoldouts` keeps selected posts out of future reviewed-example retrieval. It also excludes copies that match after case/whitespace normalization, direct reference relationships, and known edit siblings. Previous held-out wording stays protected after source edits. Source removal clears the associated stored content and fingerprints.

These checks do not identify every paraphrase, shared image, or related story. They cannot undo earlier exposure or tell whether a provider has seen a public post before. Reserve test examples early and review related cases together. There is no automatic release from the held-out role.

## Local commands

All commands below use the local private database and make no network requests. Only `local` invokes the selected offline model; stop the preview classifier first so the two processes do not compete for the model lock. `CAUCUS_DB_PATH` can select a separate test database. Substitute actual stored post/set/run IDs for the uppercase placeholders; do not paste credentials.

```sh
node scripts/learning.js status
node scripts/learning.js reserve POST_ID OTHER_POST_ID
node scripts/learning.js create "First calibration" POST_ID OTHER_POST_ID
node scripts/learning.js baseline SET_ID
node scripts/learning.js local SET_ID
node scripts/learning.js report RUN_ID
```

Creating a set requires 1–25 distinct, reviewed, current sources and also reserves them. The expected topic/subtopic labels and feedback identifiers are frozen. A changed source or later correction requires a new set version; old reports retain their earlier comparison but mark it outdated. A set cannot proceed after one of its sources is removed.

Both comparison commands store a separate evaluation run and print descriptive case counts. The local command records the full selected model fingerprint, refuses an outdated set before model startup, and closes the model on completion or failure. Fixed-hypothesis NLI and the literal baseline explicitly receive no reviewed examples. Detailed private results are available at `GET /api/evaluations/RUN_ID`, including expected labels, candidate explanations, missing/extra labels, and validity. Neither command replaces dashboard labels. Exact label matching is order-independent and case-sensitive; it does not grade politicians or political positions.

## Inspecting learning

- `GET /api/learning` returns current-source review counts, accepted/empty/unresolved decisions, up to 25 taught subjects, broader proposals, held-out sources, evaluations and unfinished runs. Superseded or edited-source judgments do not inflate the current summary. Review counts are not a training-readiness threshold.
- `GET /api/posts/POST_ID/learning` lists the newest 50 semantic runs and the reviewed examples supplied to each, with an omitted-run count; older runs remain stored. Removed, edited, superseded, or newly held-out lessons are marked accordingly.
- `GET /api/dashboard` includes the same counts under `operations.learning` for the redesigned dashboard to display.

An example's presence documents what the request received. It is not proof that the example caused an output. Updated examples reject late semantic output; previous saved runs remain available with provenance. Restoring an earlier run remains an explicit action and preserves its original example references and the current human correction.

## Evaluation execution and limits

The provider-neutral `runEvaluation` helper records pending cases before invoking a supplied callback, validates source evidence, and stores results independently of production analyses. It never supplies frozen expected answers to the callback. Each request receives a separate copy, preventing accidental callback changes to the saved input manifest. Removed sources cannot be recreated by late results; changed source, review, or examples invalidate late output. Provider errors are redacted, and invalid or failed cases never count as matches.

A crash leaves a visible unfinished run. There is no automatic retry, resume, promotion, or paid provider integration. The offline adapter uses the existing model's input limits, process lock and per-source deadline; a 25-case run can take time. Do not attach a paid callback until its cost reservation, timeouts, durable worker, and authorization are implemented. This helper bounds a set to 25 cases but is not a financial guard.

The comparison currently covers exact topic/subtopic labels only. Event/location quality, quotation and negation interpretation, new-subject discovery, semantic equivalence, and broader regression evaluation remain required intelligence work. Database removal cascades through stored evaluation cases/results; the [archive operations](ARCHIVE_OPERATIONS.md) command also cleans managed backups and diagnostics. External copies remain a separate responsibility.

Keep real posts, corrections, test sets, results, and database files private and out of Git. The repository contains only implementation, documentation, and synthetic automated tests.
