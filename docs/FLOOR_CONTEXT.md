# Official weekly House floor context

`src/floor-context.js` reads the Office of the Clerk's current [weekly floor listing](https://docs.house.gov/floor/), discovers its `downloadXML` link, and retrieves the complete official weekly XML. It makes at most two successful document fetches, each capped at 1 MB and 15 seconds, with at most three same-host redirects. It never fetches linked bill documents or calls a model/X API.

## Public API and storage

- `refreshFloor({file=FLOOR_FILE, fetchImpl=fetch, now=ISO_TIMESTAMP, dryRun=false})` fetches and atomically writes one JSON containing `status` and the last good `snapshot`, then returns the public view. Failures change attempt/error status without replacing the snapshot. Dry runs return the proposed view without writing.
- `loadFloor({file=FLOOR_FILE, now=ISO_TIMESTAMP})` returns `{status, available, current, stale, congress, weekStart, weekEnd, observedAt, sourceUrl, xmlUrl, snapshotHash, sourceUpdatedAtRaw, items}`. Raw XML is omitted from this view. Missing/corrupt files return unavailable, not an invented empty agenda.
- `floorEvidenceForPost(post, {agenda, now=ISO_TIMESTAMP})` returns compact `kind: 'floor-agenda'` records, suitable for the classifier's separate official agenda input. The evidence URL points to the weekly XML; bill document links remain in `documents`. Evidence IDs bind Congress, week, item ID and exact source revision hash.

The persisted snapshot includes exact `rawXml` and its SHA-256 hash, reparsed and verified on load. The narrow parser requires complete, well-formed, bounded XML with the expected root and known structure. It rejects DTDs, external/custom entities, unknown elements/namespaces, duplicate IDs/attributes, malformed timestamps used as dates, week mismatches, and unapproved document domains. A zero-item response does not prove an authoritative empty/recess schedule; it is retained as a fetch error instead of erasing the last good agenda.

Items retain typed bill IDs such as `119-hr9576`, designation, full title, procedure, observation time, withdrawal marker, bill documents, publisher timestamps, and subordinate document rows. Empty subordinate bill labels never inherit invented bill identities. The September 14 fixture contains **77 top-level items and two subordinate document rows, with 83 document links**; later official revisions can add/remove items.

## Timing and interpretation limits

`weekStart` and inclusive `weekEnd` are Monday–Sunday calendar dates interpreted in America/New_York. `current` requires that week and an observation no more than 24 hours old. Outdated schedules remain visible as stale. A failed latest fetch withholds retained data from inference even while display can show the previous snapshot and error.

`observedAt`/`fetchedAt` describe our successful acquisition; `lastAttemptAt` separately records failed attempts. Publisher create/update/publish/remove timestamps are preserved verbatim in `*Raw` fields; their timezone is not supplied by XML. No timezone is invented, and evidence `publishedAt` remains null.

Retrieval requires a member post dated within the current agenda week and an exact typed bill identifier. Bare numbers, title similarities, another bill type, and explicit references to another Congress do not match. Quoted/reposted originals are considered separately only when their known publication timestamp falls within the same Congress and is not in the future; an old original may renew attention to a bill but does not establish a new vote. URLs are not parsed as bill mentions. Unknown original dates are conservatively withheld from this exact identity lane.

Every evidence record says the item **may be considered** in the specified week. It does not establish a specific floor time, actual consideration, passage, or enactment. No retrospective mass reclassification is triggered by this adapter.

## Offline verification

Run `node --test tests/floor-context.test.js`. Tests use the saved official XML and injected HTTP responses, including malformed/partial/unsafe acquisition, failure retention, stale dates, resolution-type collisions, withdrawn items, and old-Congress original controls.

## Application integration

The public news workflow acquires the agenda before article refresh, outside the capture writer lock. Its validated transfer includes floor.json; publication preserves the agenda before rebuilding the dashboard. The Floor agenda page independently shows the weekly list, bill-text links, supporting documents and exact current-week captured references with distinct-member counts. Withdrawn items are excluded from the active display. References from quotations/reposts retain linked original wording and do not imply agreement.

New live, nightly and range inference receive exact bill matches as officialAgenda. Per-post manifests retain exactly the supplied weekly evidence; evidence_used cannot cite another post's sources. Historical decisions are not mass-reclassified on first acquisition. Matching is exact bill identity, not an assessment of policy stance or prediction.
