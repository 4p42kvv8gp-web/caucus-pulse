# Story context and outside reporting

The product should recognize a specific developing story inside a broader topic. User direction: surface even one member's district report immediately as provisional, and look beyond member accounts for context. Outside reporting must remain attributable and dated.

## Working behavior

The classification workshop presents three distinct records:

- The original member post and its existing model analysis.
- Researched story suggestions, with exact supporting source passages, dated background links, and the scope of what those links support.
- Outside news leads, with their search terms, date window, lookup status, and links awaiting content review.

Current human topic decisions retain precedence. A correction saves the displayed context alongside the source, prediction and prior-review versions. Changed context requires a reload before saving. Researched examples and news results never create human feedback or modify model weights.

Each incoming incident candidate receives a provisional story title on its first source. This appears immediately after incident extraction, including when only one member is represented. The source's date, event evidence and district wording are preserved. These per-source suggestions do not merge incidents, confirm an occurrence, or count as accepted taxonomy labels. Existing incident review and tracked cases remain available.

## Researched story library

`src/story-context.js` reads the private `data/reports/story-memory.json` library. Missing or invalid context cannot replace existing analysis. The library is deliberately absent from Git; a fresh checkout starts without researched examples.

Each schema-version-1 story requires an ID, topic, subtopic, short summary, `curator: "assistant"`, named aliases with a `specific` boolean, two or more context groups, an explicit matching date window, optional historical date phrases, and HTTPS sources with title, publication date (or null) and a short statement of support.

An exact specific name needs a nearby context group. A partial name needs two independent groups in the same paragraph and within 400 characters. Out-of-window references need a nearby explicit historical date. Every returned span is copied from the post; an expanded name found in background research is never presented as words the member wrote. Library changes invalidate the context version.

The matcher examines up to 25 researched stories and returns at most four. It recognizes this bounded library; it is not a general web-reading model, semantic event resolver or automatically trained classifier. National prominence, stance, factual verification, and what was knowable at the original publication time are not inferred from a match.

## Bounded outside lookup

`src/outside-context.js` queries the [GDELT DOC API](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/) for public news metadata. Only exact, validated public names/place/event phrases are sent. Private feedback, credentials, full post bodies and the archive are not transmitted. The adapter uses one fixed API host, rejects redirects, applies a 12-second timeout and caps the response at 250 KB and eight displayed links.

`intelligence.outsideContext.enabled` in settings enables a local-preview worker. Once a minute it considers the newest 200 posts from seven days, and makes at most one due lookup. Known story evidence, a named incident, or multiple source entities are required. The workshop can also request a lookup for a historical post. Searches cover three days before through at most one day after the post, capped at the lookup time. Follow-up coverage is explicitly retrospective. Provider coverage for older dates is not guaranteed.

A private lock, persistent minimum spacing and a 60-request hourly ceiling prevent overlapping requests and restart bursts. Responses and failures are cached for 30 minutes; rate limits or provider errors also pause the provider for 30 minutes. No paid X reads or paid AI services are involved. Requests may remain unavailable because the public index is rate limited.

Results are discovery leads, not corroborated facts. An index timestamp is not the article's publication date. An empty response does not prove that a story is absent. A government domain is a source-type hint, not verification; member offices can also use government domains. Article counts do not establish national attention or independent corroboration.

Private caches live in `data/reports/outside-context-<postId>.json`; source changes invalidate them and in-flight completion rechecks the source under the archive maintenance lock before saving. At most 1,000 caches are retained, evicting the oldest files as needed. Each background pass caps examined source text at 300,000 characters, skipping posts over 60,000 characters. Managed source removal finds these reports. Reviewed context is retained inside the feedback record and its database backups; unreviewed caches and the curated library need separate private backup if retention is desired.

## Validation and remaining work

Synthetic tests cover partial-name ambiguity, paragraph/date boundaries, exact offsets, changed-context review guards, one-member surfacing, public-only queries, unsafe/out-of-window links, rate-limit persistence, concurrent requests and source removal during lookup. They are engineering checks, not measured classification accuracy.

Still needed: reliable additional search/official-alert adapters, full-article assessment with citations and conflicting-source handling, automatic new-story naming and identity reconciliation, and a human-reviewed held-out set before promoting broader rules or training weights. Continuous X capture and hosted operation remain separate launch requirements.
