# Source-backed incident desk

The private dashboard now includes an incident desk and a compact topic overview based on the supplied Claude Build Spec. The exact exported DashboardV3/Incidents screen files were not available; this implements the documented neutral system-font direction and proportions, not verified pixel equivalence.

## Working flow

1. Incoming reports come from the current source analysis or a saved human incident review. Read the original post and its date before interpreting it. The default window is 24 hours; filtered discovery is limited to 31 days.
2. Open any post from the teaching desk to add a missed report. Choose supported reports, no incident reported, or more context needed. Supporting passages must match the source exactly. A named location must occur in the selected passage. District evidence is separate; a repost cannot establish the reposting member's district connection.
3. Save the explanation. This is a review of what the source says, not independent verification that an event occurred. Topic corrections and incident corrections are separate records.
4. Track a current interpretation in a new or existing case. The user decides whether multiple sources concern the same event. A case can contain up to 100 source interpretations, with distinct-post/member counts and an original-source timeline.
5. Set watching, resolved, or dismissed explicitly. Quiet periods never automatically resolve a case. Copying a source digest writes to the local clipboard only; it sends no message.

The live archive has no saved incident cases or human incident reviews as of this milestone. Tests create synthetic fixtures only in isolated stores.

## Version and evidence protection

Schema 9 adds append-only incident reviews, case records, case-source links, and case history. Source edits and changed event interpretations mark prior links outdated. Removed posts cascade out of reviews and case links; ID tombstones prevent collection replay.

Incident review saves require the displayed source hash, model-analysis hash, and incident review revision. Case edits require the displayed case revision. Linking a source validates the current event fingerprint as well as the source/model versions. Updates and history commit together; any failed link or history write rolls back the whole operation.

Supported human interpretations for the current source override model incident suggestions. A need-more-context review preserves suggestions but marks them uncertain. A no-event review explicitly removes current candidates. None of these actions changes topic labels or pretends to train the classifier's weights.

## Private API

- `GET /api/incidents`: bounded incoming suggestions, source projections, case list, filters and coverage.
- `GET /api/posts/:id/incidents`: full source, current suggestions/review revision, and up to 50 review records.
- `POST /api/posts/:id/incidents`: `{sourceHash, predictionHash, revision, decision, events, reason}`.
- `POST /api/incidents/cases`: `{title, sources:[{postId, sourceHash, predictionHash, eventKey}]}`.
- `GET /api/incidents/cases/:id`: current source timeline, outdated links, user status and history.
- `PATCH /api/incidents/cases/:id`: `{revision, title?, status?, addSources?, removeSources?, reason}`.

Incoming processing examines at most 250 candidate posts, returns at most 100 events, and bounds full source text to 300,000 characters and candidate content to 500,000 characters. Oversized sources remain in the archive and omissions are disclosed. Case lists show the newest 100 across all dates; timelines disclose outdated/oversized source omissions. Case digests deduplicate posts while retaining their multiple interpretations and original wording.

## Teaching and exact language improvements

`GET /api/review-queue` returns up to 100 newest unreviewed post identities in the current filters. The workshop loads selected sources independently from explorer pagination, preserves unsaved work, and offers explicit reload when a source, model prediction or prior review changes. HTTP topic corrections require source/prediction hashes and the displayed current review ID. Detailed topic history displays at most 50 records while preserving all history privately and including the current accepted decision.

`GET /api/phrases` now counts exact matching posts and distinct stored members across the entire selection using SQL. It displays bounded, deduplicated full sources and exact UTF-16 occurrence spans. Overlapping highlights merge visually without dropping or duplicating original characters. The source and occurrence limits are separate and disclosed; a large matching count does not imply every occurrence is displayed.

## Verification boundary

Application and isolated HTTP tests cover source/prediction/review conflicts, exact location evidence, case revisions, deduplication, rollback, source removal, bounded processing, Unicode and overlapping highlights. Static HTML identifiers and JavaScript syntax have been checked. Browser visual verification remains unavailable because the existing administrator-policy verification failed; no alternate rendering or browser route was used.
