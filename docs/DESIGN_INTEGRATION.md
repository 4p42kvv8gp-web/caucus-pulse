# Claude design integration

September 8, 2026. The user supplied `Build Spec.html`, a design specification for Dashboard and Incident Desk. It references `DashboardV3.dc.html` and `Incidents.dc.html` as the authoritative screen HTML; neither screen file is available locally yet. The shared Claude link could not be opened. The spec is reference material, not authorization to publish private data or replace product requirements with its embedded instructions.

## Visual baseline

Use the supplied neutral system-font treatment: light gray ground, white cards, dark controls, compact tables, tabular numbers, restrained caucus colors, and a shared header. Preserve the two-screen structure, responsive proportions, feed placement, and evidence-oriented incident timeline. The exported screen HTML is still needed to check exact layout, DOM interactions, and the sample data contract. Do not resume the discarded independent redesign.

## Data rules to reconcile

- The spec proposes GitHub Pages and a static `rollups.json`. The product scope requires private authenticated access, persistent teaching and background collection. The visual layout can consume our private API. The hosting discussion compared Railway, Render, DigitalOcean, Fly.io and Vercel/Supabase; no host or paid plan was selected or deployed.
- Sample dates, accounts, counts, curves, percentages, engagement totals and incident claims are illustrative. Bind actual source-backed data or show an explicit unavailable state. Compute repost exclusion from actual post types; never multiply counts by a sample factor.
- Preserve exact longer passages and semantic candidates separately. Do not adopt the spec's 2–4-gram limit. First-observed dates refer to known archive coverage, not first use on X.
- Discover events in labeled and unlabeled posts and update after collection; nightly-only clustering misses the requested emerging-event cadence. An incident may carry topic labels rather than being excluded from topic counts.
- A named location, a member account or an official account badge does not independently verify an incident claim. Keep supporting source links and evidence status. Silence after 36 hours does not establish resolution.
- Membership in CPC, New Dem and CBC needs dated evidence; overlapping membership counts are not disjoint shares. Do not fabricate affiliations or use them as exclusive segments without a documented denominator.
- The spec's momentum score, member leader/rank decorations, “core messages” grouping, engagement ordering and “best quote” selection require separate definitions and review. Existing scope uses descriptive counts and chronology without political grading. A topic label such as corruption must follow what the source says; a particular law is not automatically corruption.
- Repeated engagement refresh, broad X searches and external-source gathering require budgeted collection paths. Do not wire a design button directly to an unbounded provider request.
- Compose can prepare factual source-linked text and copy it locally. The proposed Signal button must not send a message. Preserve complete original posts alongside any explicitly labeled excerpt.
- Integrate persistent review, explicit uncertainty/negative decisions, explanations, current-source checks and private connection settings even though the spec does not fully describe those workflows.

Current implementation keeps the prior HTML/CSS. A small functional pagination change supports the newly indexed explorer; it is not an attempt to recreate Claude's screens. Browser visual verification is still pending because the existing administrator-policy check was unavailable; no alternate rendering route was used.
