# Event reconciliation pilot

The live classifier can place several members' posts in the right broad topic without recognizing their shared event. A selected production review found four distinct members discussing Johnson and congressional AI oversight, all broadly categorized as AI policy, without a shared emerging event. This pilot tests a separate pass across inference chunks before any such pass changes the dashboard.

## Scope and evidence

`src/event-pilot.js` selects two fixed public-source bundles from September 14, 2026. The first contains four independently reviewed positive cases and three controls; the second contains four posts involving overlapping political actors but different events. Expected memberships remain reviewer metadata and are never supplied to the model. This is a selected retrospective evaluation, not an accuracy estimate or a prediction benchmark.

Each input retains source IDs, full available wording, quoted/reposted context, roster member identity, unchanged accepted topics and dated per-post public news. Private inbox content is excluded. Missing, pending, corrected, out-of-scope or outdated fixed cases prevent a reduced bundle from being submitted. An incomplete source may remain an explicit abstention control; it cannot establish event membership. Original source versions are not reconstructed, and historical text that was already truncated remains incomplete.

## Execution and recovery

Run `node src/event-shadow.js --plan` for a read-only readiness check. The `event-shadow` workflow executes the fixed pilot after changes to its source files reach main, or by explicit dispatch. It has no recurring schedule and shares the data-writer lock. Normal capture and classification do not invoke this pilot.

The CLI awaits asynchronous source loading, freezes the review time, and builds at most two initial model requests. Before a request, it saves and publishes its exact input and submission intent. Before validation, it saves and publishes the raw response. Each receipt retains source/correction fingerprints and original request metadata. Identical completed work is not resubmitted when the clock advances. A changed source or correction supersedes prior proposals.

The saved ledger caps this pilot at two submission attempts across restarts. Provider timeouts or uncertain submissions are not retried automatically. Explicit provider rejections can be retried only while an attempt remains. A malformed or partial response is retained for review. Incomplete outcomes make the job fail visibly after saving its work. The final state and recovery artifact preserve available work if publication fails. No credentials are written into the ledger.

Validator versions are separate from inference-policy versions. A validator update replays an existing raw response without a model call, preserving the prior validation decision. Request hashes are checked before replay. Provider thinking metadata is retained in the raw envelope but is never parsed as an answer or evidence; exactly one text answer is required.

## Interpretation limits

Validation requires every exact input ID once, unchanged topics, citations drawn from that same post's evidence, and literal supporting spans from each proposed member post or its attached source context. Counts and the rolling 24-hour three-distinct-member threshold are calculated in code. Two accounts belonging to one roster member count once. The roster's normalized member names remain a fallback where durable person IDs are absent.

Passing this contract means a proposal is structurally supported; it does not establish that the model's event label, actor or action is correct. All events remain `provisional`, `verified: false`, and outside the dashboard. Human corrections are not rewritten.

Before broader use, review the saved proposals against the four known positive cases and the unrelated/ambiguous controls. Inspect each label and exact supporting passage, distinguish a member's claim from an independently established fact, and check that quoted/reposted material is not treated as endorsement. Review event misses and false merges separately. A successful fixed pilot would justify further evaluation, not a general accuracy claim or automatic promotion.
