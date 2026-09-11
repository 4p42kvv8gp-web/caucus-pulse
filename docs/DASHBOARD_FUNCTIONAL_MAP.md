# Caucus Pulse dashboard — functional map

Maintainer reference for what the two pages show, where each number is computed, what it is computed from, what the design spec asks for, and where the two disagree. Built from a read-only review of the checkout at `main` (HEAD `fe27030`) on 2026-09-10 against `site/data/rollups.json` built 2026-09-10T07:30:51Z (03:30 ET; `today` = 2026-09-10 with 8 House posts, 2 of them live-tagged; window 2026-09-04 … 09-10, 2,586 House posts, 142 non-House posts excluded).

Conventions: `file:line` cites HEAD. Spec references are to `docs/design_handoff/README.md` (§2 Dashboard 152–200, §3 Incident desk 202, §4 Metric definitions 210, §5 Data contract 224, §6 Acceptance 245; reference HTML appended from line 257 — the README says the HTML wins where it and the prose disagree). Status vocabulary: **matches** (renders and computes what spec/reference ask), **partial** (right shape, wrong or incomplete semantics), **mismatch** (contradicts spec or reference), **stub** (control or field present, no real behaviour), **unverified** (could not be exercised from the checkout). Numbers quoted were recomputed from `data/` with `node -e` one-liners; the relevant command is given with each finding.

---

## 1. Verdict

The dashboard is a faithful structural port of the reference HTML and its headline volume numbers are real: Posts, composition, the 48-hour curve, per-caucus topic counts, Members, Engagement totals, the feed, phrase Unity, cluster posts/members and the incident plumbing all recompute exactly from `data/archive` + `data/topics` + `data/metrics` + `data/authors.json` (93/93 tests pass). The derived layers are sound in shape but not yet in semantics: **Momentum** is a correct port of the reference formula fed inconsistent inputs (calendar-day acceleration, rolling-24h everything else, a caucus-inflated engagement denominator), so 14/15 topics score `accel = 0` and 13/15 `engLift = 0`; **Engagement** everywhere is still the capture-time snapshot because no real 24-hour X re-read has ever run (every `data/metrics` entry is `fromCapture`) and the promised lag caption does not exist; every **"members"** figure counts X accounts (329 accounts = 201 people this week; 204 of 234 members have two accounts); the **Feed** is silently capped at the newest 200 posts before any filter, which also truncates Compose; **phrase Origin** dates are corpus-edge and top-25-cut artefacts; the **Emerging** panel ranks by 30-day totals and one of its groups ("Dolly Parton tribute") is a label-merge accident; and the **incident desk** has precision ≈ 0.36 against the repo's own audit, with one event split into up to four cards and district suffixes that are the poster's, not the incident's. Explicit stubs: the X-search panel, `official sources` (literal 0), `amplifiers` (always 0 — only List members' retweets are visible), `Add ›` (a link to the YAML), `accountType`, `accounts`/`excluded` (emitted, never rendered). Unverified: the nightly GitHub Action has never completed (no `nightly:` commit), `data/stories.json` (06:26Z) and `reports/latest.md` (06:27Z) are artefacts of the pre-rewrite `stories.js`/`report.js` and will be replaced by the first successful nightly.

---

## 2. Feature map

### 2.1 Header and stat cards (`site/index.html`, `src/sitedata.js` 254–292)

| Feature | Displays | Computed in | From | Spec ref | Status |
| --- | --- | --- | --- | --- | --- |
| Brand lockup + nav | "Caucus ● Pulse" → `./index.html`; Dashboard / Incidents | `site/index.html:22-24` (static) | — | §0, §2 Header (156) | matches |
| Updated dot · date · time | "Thursday, September 10 · updated 3:19 AM"; title "Next poll ~3:39 AM" | `index.html:68-69`; `site/ui.js:25-27,36-38` | `rollups.today` (`sitedata.js` `daysAgoEt(0)`), `rollups.lastPollAt` ← `data/state.json` (`poll.js:135`) | §2 Header (158); §5 `built`/`nextPoll` (230); reference `headerDate` switches to "September 1 – 7" in the 7-day window (README:700) | partial — date ignores window; next poll synthesized as +20 min; `generatedAt` never shown (F27) |
| Daily report link · Compose | quiet link → `../reports/latest.md`; ink pill opens modal | `index.html:25`, `:339-351` | `reports/latest.md` (`report.js:190`) | §2 Header | matches (link target unspecified by spec; see refuted #9) |
| Title block (H1 scope, "· N accounts on X") | not rendered | — (`rollups.accounts` = 427 unused) | `data/authors.json` | §2 Title block (160); §6 "H1 color" (247) — but reference HTML has no H1 (README:309, `scopeLine` computed at :701 and never used) | mismatch vs prose, matches reference; HTML wins (F40 for the unrendered count) |
| Caucus control (All · CPC · New Dem \| CBC · CHC · CAPAC) | 7 segments, fill dots, divider | `index.html:72-73,340-341`; `ui.js:77-84` | `settings.caucus_keys` ← `config/accounts.csv` tags → `authors.json` | §1 Controls (141), §2 (162) | matches |
| Window control (Today · 7 days) | 2 segments, default Today | `index.html:49,74`; `sitedata.js:118-119` | ET calendar day vs 7 ET days (`util.js daysAgoEt`) | §2 (162), §4 Posts | matches |
| Posts count | 8 (Today) / 2,586 (7 days) | `index.html:85`; `sitedata.js:254-292` | every archive row in window/scope, all types, House only (`splitByRoster`, `:143`) | §4 Posts (216) | matches (recomputed: All w 2,586; CPC 1,271; CAPAC 278) |
| 48-hour curve | 108×26 spark, 16×3h buckets | `sitedata.js:284-291`; `ui.js:55-68` | `createdAt` age from build time | §2 (168) | matches (bucket anchor = build time, not clock hour; invisible) |
| Composition bar + caption | "88% original · 0% replies · 12% reposts" | `index.html:86-87`; `sitedata.js` mix; `ui.js:49-51` | archive `type` (tweet+quote = original) | §2 (168), §1 Color (127) | matches |
| Core messages count + "% of posts" | 0 / 0% (Today); 976 / 34% (7 days) | `index.html:77-80,88-89`; `sitedata.js` topic buckets | Σ topic-row `n` over `settings.core_messages` macros ÷ Σ all topic rows | §2 (169), §4 Core messages (217) "share of classified posts" | partial — sums assignments not posts (F13); Corruption = whole `democracy` macro (F14) |
| Core pillar rows | Affordability / Healthcare / Corruption bars | `index.html:90`; `ui.js:44-46` | `config/settings.json core_messages` | §2 (169) | partial (F14) |
| Engagement total | 480 (Today) / 688K (7 days) | `index.html:92`; `sitedata.js:131-138` (engN) | `data/metrics/<day>.json` if present and not `unavailable`, else `metricsAtCapture`; retweets 0 | §4 Engagement (218) "from the 24-hour re-read" | partial — arithmetic matches (recomputed 687,974); provenance is capture-time everywhere (F12) |
| Top-10 share bar | 51% / 49% (7 days) | `index.html:93`; `sitedata.js:266-278` | engN summed per `authorId` | §4 (218) "ten highest members" | partial — accounts not members (F1) |
| Engagement caption | "60 per post · ▼ 100% vs 7-day avg · top 10 members 100%" (Today) | `index.html:94`; `sitedata.js:270-279` | today-so-far vs mean of six prior full days; `engDelta(w)` hard-coded 0 | §2 (170), §4 (218) | partial (F11) |
| Momentum leader card | Today: "67 Tech" (1 post); 7 days: "84 Reproductive rights" (7 posts) | `index.html:81,95-98`; `sitedata.js:209-243`; `src/momentum.js:19-35` | topics with `[win][scope].n > 0`, highest score; score is All-scope, r24-based | §2 (171), §4 Momentum (212); reference never hides the card (README:714) | partial — no volume floor (F15); hidden when window empty (F17); components (F2) |

### 2.2 Topics table (`site/index.html` 109–160, `src/sitedata.js` 156–245)

| Feature | Displays | Computed in | From | Spec ref | Status |
| --- | --- | --- | --- | --- | --- |
| Row set + sort | 15 macros, sorted by Posts in active window/scope | `index.html:116`; build pre-sort `sitedata.js:245` | archive ⋈ `data/topics/<d>.json` ∪ `data/topics-live/<d>.json` (`sitedata.js:35-43`) | §2 (175) | matches (rows with 0 posts still shown — F17) |
| Topic name | `tax[key].label` else `labelOf` | `sitedata.js:238`; `index.html:141` | `config/taxonomy.yaml` | §5 labeler (243) | matches |
| CPC / New Dem columns | count + 3px bar, hidden for single caucus; Posts bar in caucus colour | `index.html:113,128-132,143,153`; `sitedata.js:177,187-192` | author caucus tags; multi-tag members count in each | §2 (175-177), §4 split (219), §6 (247) | matches |
| Rank badges | 15px badge top-3 per column | `index.html:114,122,130-131` | sort by `t[win][k].n`, no `n > 0` guard | §2 (177) | partial — badges on 0-count rows in an empty window (F17) |
| Posts | classified posts in window/scope (retweets included, engN 0) | `sitedata.js:181-192` (`seenMacro` dedupe) | archive + assignments | §4 Posts (216) | matches |
| 7-day trend spark | 64×18, 7 ET days, All scope | `sitedata.js:185`; `index.html:144`; `ui.js:55-68` | calendar-day counts; `trend[6]` = partial today | §2 (178) | partial — last point collapses to 0 beside a positive ▲% (F16) |
| ▲ d% | r24 count vs mean of six prior days | `sitedata.js:212-214`; `ui.js:22` | archive `createdAt` | §2 (178) "vs the 7-day average"; CLAUDE.md r24 convention | partial (F16; not scoped by filter) |
| Momentum score + bar + tooltip | 0–100, navy→#a9c3ee fade; tooltip lists five components | `momentum.js:19-35`; `sitedata.js:213-223,242`; `index.html:133,145,156` | c/m/eng from r24, `trend` calendar, `epAvg` whole week incl. today | §4 (212); reference `momentum()` README:553-564 | partial — inputs mixed (F2); All-scope only (reference same) |
| Drivers | two largest raw components | `momentum.js:32`; `sitedata.js:242` | components | §4 (212) | matches (engagement can never surface while engLift ≈ 0 — F2) |
| Engagement column | Σ engN per bucket | `sitedata.js:190-192` | metrics/capture | §4 (218) | partial (F12) |
| Members column | distinct `authorId` | `sitedata.js:186-201` | archive | §2 (175) | partial — accounts (F1) |
| Subtopic rows | share · lead @handle · counts | `sitedata.js:194-201,225-235`; `index.html:134-139` | `[macro, sub]` assignments; lead = top engN non-retweet author, All scope, 7 days | §2 (180), §5 (232) | partial — order frozen at build, lead ignores filter (F28) |
| Disclosure / default open | chevron, first topic with subs open | `index.html:117-120,140,356`; `ui.js:70-72` | UI state | §1 (150) | matches |
| Empty state | "No classified posts yet …" | `index.html:159` | `D.topics` empty only | — | partial — never fires for an empty window (F17) |

### 2.3 Feed (`site/index.html` 162–183, `src/sitedata.js` 433–454)

| Feature | Displays | Computed in | From | Spec ref | Status |
| --- | --- | --- | --- | --- | --- |
| Header "N posts · N new" | "200 posts · 2 new" (7 days) | `index.html:164-169,180`; `sitedata.js:437,452` | newest 200 window posts; `isNew` = `capturedAt === state.lastPollAt` | §2 Feed (184); reference README:718 | partial — count capped before filtering (F3) |
| Newest / Top | sort by `time` / `engN` | `index.html:166,180` | engN as above | §2 (184) | matches (Top in Today mode ranks capture-time snapshots — F12) |
| Topic dropdown with counts | "All topics (200)" + one option per macro | `index.html:167-168,181`; `ui.js:86-90` | filtered `D.feed` | §1 (146), §2 (184) | matches (counts inherit F3) |
| Window + caucus filtering | `f.date === D.today`; `f.caucus.includes(scope)` | `index.html:61,163-164`; `sitedata.js:445-449` | `authors.json` caucuses | §6 (247) | matches |
| Avatar disc | initials; CPC green / New Dem navy / gray | `ui.js:94-98`; `index.html:173` | `member` else name | §2 (184) | matches (numeric-id fallback — F32) |
| Handle · caucus dots · ET time | `@handle`, per-caucus dot+label, "3:19 AM" / "Sep 9, 4:49 PM" | `index.html:175`; `ui.js:8-12,24-35` | archive `createdAt`, authors | §2 (184), §5 (243) | matches |
| Text | 13px/1.45 escaped; RTs are X's truncated "RT @…" | `index.html:176`; `src/x.js` | archive `text` | §2 (184) | matches |
| Topic chips | ≤2 macro chips + "+n" | `index.html:171-172` | `f.topics` = `['macro/sub','macro']` | §2 (184); reference shows sub chips (README:656) | partial (F30) |
| Engagement footer | "↻ repost" / "❝ N" / N | `index.html:177`; `sitedata.js:451` | engN, kind | §2 (184) | matches (value is capture-time — F12) |
| New dot | 6px ink dot, "Captured in the latest poll" | `index.html:175`; `sitedata.js:452` | `state.lastPollAt` | reference README:349,718 | matches (documented semantics; refuted #2) |
| 200-post cap | newest 200 of the window, pre-filter | `sitedata.js:437` | — | §5 feed (238) has no cap | mismatch (F3) |
| Members map / accounts | `members['@h'] = [name, district, caucuses]`; `accounts` = 427 | `sitedata.js:458-463,481` | `authors.json` House accounts | §5 (239), §2 (162) | matches shape; `accounts` unrendered and includes off-List stray (F40) |
| Account status badges | none in feed (`badge()` only imported by desk, unused) | `ui.js:104-108` | — | §3 (206) badges belong to search results | matches (absent by spec) |
| Empty state / internal scroll | "No posts match…"; absolute-positioned card, `scrollbar-gutter: stable` | `index.html:31-35,182` | — | §6 (250) | matches (scroll resets on every re-render — F31) |

### 2.4 Phrases (`src/sitedata.js` 294–364, `src/syntax.js`, `site/index.html` 185–215)

| Feature | Displays | Computed in | From | Spec ref | Status |
| --- | --- | --- | --- | --- | --- |
| Mining | 2–4-grams, ≥3 distinct authors, retweets excluded, containment dedupe | `syntax.js:18-82`; thresholds `config/settings.json syntax`; `sitedata.js:302-306` (top 30 by spread) | 7-day non-retweet House corpus | §4 (220); brief 128-133 | partial — no background-rate filter (refuted #5 says spec has none); tokenized lowercase |
| Families / canonical / variants | one-token-edit or containment+same-tail, union-find | `sitedata.js:51-88,307,315-320` | top-30 mined phrases only | §4 (220) | partial — variants only sought inside the top 30 (F19) |
| Pillar + fine topic | Affordability / Healthcare / Corruption / Off-pillar, sub label | `sitedata.js:347-353` | plurality macro and plurality sub over hit posts, chosen independently | §2 (188), §4 (220) | partial (F33; Corruption mapping F14) |
| Origin | "@handle · Aug 20 · leadership" | ledger `syntax.js:95,109-123`; read `sitedata.js:344-346,354-356`; `index.html:193,201` | `data/phrases.json` firstSeen/firstAuthorId; `leadership` tag | §2 (188) "first user · date" | mismatch (F4, F5) |
| Adoption count | distinct window users | `sitedata.js:320-324,357` | archive | §4 (220) "distinct members" | partial — accounts (F1) |
| Adoption curve + gain | 64×18 from-zero cumulative, "+N" | `sitedata.js:331-343`; `index.html:190,202` | window first-use merged with ledger `memberFirst` of every variant | §2 (188), §4 (220) "gain = day 7 minus day 1" | mismatch — curve population ≠ count (F18) |
| Unity dots + n/5 | filled when ≥3 adopters and ≥10% of caucus active accounts | `sitedata.js:357-359,470-473,487`; `index.html:186-192,198,203` | `caucusActive` = distinct posting accounts per caucus, 7 days | §4 (220) "active accounts" | matches |
| Discipline % | exact canonical ÷ all family hits | `sitedata.js:319-320,360`; `index.html:191,204,213` | hits over top-30 variant set | §4 (220) | partial — 10/12 rows are 100% by construction (F19) |
| Ledger `data/phrases.json` | firstSeen, firstAuthorId, memberFirst, byDay per exact n-gram | `syntax.js:84-123` (one ET day per run, top-25 cut) | archive per day | brief 128-133 | partial (F5) |
| Per-day `data/syntax/<d>.json` | report "Strategic syntax" top 5 | `syntax.js:125-135`; `report.js` | same day | brief 150 | matches (dashboard never reads it) |
| Row selection / filters | top 12 by spread; ignores caucus/window controls | `sitedata.js:364`; `index.html:185` | — | reference does not filter phrases (README:663) | matches |

### 2.5 Emerging (`src/sitedata.js` 366–431, `src/stories.js`, `site/index.html` 217–227)

| Feature | Displays | Computed in | From | Spec ref | Status |
| --- | --- | --- | --- | --- | --- |
| Candidate selection | 11 cards today | `sitedata.js:372-376` (first 12 non-noise, non-promoted candidates) then window intersection `:385-386` | `data/stories.json` candidates (30-day, sorted by posts) ⋈ 7-day archive | §2 (190), §4 (221), §5 (234) | partial — ranked by 30-day totals before windowing, no members floor (F20) |
| Label | `placement.label` from one Claude call per 20 candidates | `stories.js` placeBatch; `sitedata.js:380` | `stories.json placements` | §2 (192) | partial — label covers a polluted merged group (F10) |
| "since" | earliest in-window post | `sitedata.js:388-389`; `ui.js:32-35` | archive | §2 (192) "since Sep 5"; story `firstSeen` exists but is not rendered | mismatch (folded into F20: "Agriculture & farmers" firstSeen Aug 20 reads "since Sep 4") |
| posts · members · engagement | window subset | `sitedata.js:401-409` | archive, metrics | §2 (192), §4 (218) | matches (members = accounts, F1) |
| Growth curve | 72×18, 8 cumulative buckets from first window post | `sitedata.js:390-395` | archive | §5 shape[8] (234) | matches |
| Caucus bar | 5-segment, members by caucus | `sitedata.js:408`; `index.html:221` | authors caucuses | §2 (192) | matches |
| Sample quote | highest-engN post, ≤160 chars | `sitedata.js:402,414` | archive text | §2 (192) | matches (author not emitted — F21) |
| "N% say “phrase”" | most common 2–3-gram; coherence = share containing it | `sitedata.js:396-400,410-411` | window text | §4 (221) | matches (trivial at n = 2–3) |
| Suggested tag | raw placement key, e.g. `dolly-parton-tribute` | `index.html:224` | `stories.json placements` | §2 (192); reference passes through `label()` (README:723); §5 (243) | partial (F42) |
| "In the news" block | up to 3 outside hits | `sitedata.js` context; `data/context.json` | hand-built context file | not in spec (docs/OUTSIDE_CONTEXT.md) | matches (extra) |
| Compose button | subject `cluster:<label>` | `index.html:224,274` | `who`, `sample` | §2 (200) | partial (F21) |
| Add › | link to `../config/taxonomy.yaml` | `index.html:224` | — | §2 (192); reference `href="#taxonomy"` | stub (real path is `npm run stories -- --promote=<key>` / nightly auto-promote) |
| Cross-day merge | label-token Jaccard ≥ 0.5 or containment (size diff ≤ 2), union-find over 30 days | `stories.js:58-75` | `data/topics/*.json emerging` | §4 (221) "embedding similarity" | partial (F10) |
| Scoring / model merge / placement | `applyMerges` then full re-score; batches of 20; cache keyed by candidate slug | `stories.js:247,298,427-430` | archive, taxonomy | CLAUDE.md | partial (F34); the committed `stories.json` predates this code (refuted #6/#7) |
| Promotion / retirement | `story: true`, `since`, `provisional`, `promoted` rows; auto-promote with thresholds in `settings.stories` | `stories.js:418-428,579,610-622`; `taxonomy.js:13-16,60` (`ymd`) | `config/taxonomy.yaml` (4 story rows today, 1 provisional) | CLAUDE.md | matches (Date round-trip handled — refuted #17); see open question 9 |
| Automation | `nightly` = refresh → classify → stories → stories --auto-promote --retire → corrections → syntax → incidents → rollup → report → sitedata | `package.json:25`; `.github/workflows/nightly.yml` | — | CLAUDE.md | unverified — chain exists, no nightly Actions run has completed yet |

### 2.6 Breaking in district and Incident desk (`src/incidents.js`, `site/incidents.html`, `site/index.html` 229–239)

| Feature | Displays | Computed in | From | Spec ref | Status |
| --- | --- | --- | --- | --- | --- |
| Dashboard card | "Breaking in district · 3 active", 3-up cards, "Thread ›" | `index.html:229-239` | `rollups.incidents` (verbatim `data/incidents.json`) | §2 (194-196) | partial — count inflated by F6/F7; single-post cards read "3:17 PM → 3:17 PM" |
| Classifier flags | `{kind, place}` per post | `taxonomy.js` prompt rule (~:131-138); `classify.js:43` (model sees `{id, text}` only); `classify-live.js` | `data/topics*/<d>.json incidents` (174 flags, 21 days) | §4 Incident (222) | mismatch — precision 0.36 per `data/incident-audit.json` (F6) |
| Grouping key | `norm(place)--norm(kind)` | `incidents.js:23-26,48-57` | flags | none; prompt asks for identical strings | mismatch — 29 rows ≈ 18 events (F7) |
| Status lifecycle | ≤12h active, ≤36h monitoring, else resolved; dropped after 7 quiet days | `incidents.js:28-33,65-66`; `ui.js:110-112` | newest flagged post vs build time | §4 (222) 36h; §3 header | matches (labels freeze between rebuilds — F35) |
| List cards + status control | dot, kind tag, last time, place, N posts, handle · member, "· viewing" | `incidents.html:61-66,94-102,150-154` | rollups | §3; reference :763-773 | matches |
| Detail header + four figures | member posts · engagement · amplifying · official sources | `incidents.html:114-127`; `incidents.js:68,78,80,146` | engN (metrics/capture), member retweets of flagged posts, literal `0` | §3 (204); reference :877 | partial — amplifiers 0 for all 29 (only List retweets visible); official sources hard-coded (F36) |
| Timeline | ET time, dot, @handle, MEMBER pill, text, engagement; "N new in the latest poll · members only" | `incidents.js:83-90`; `incidents.html:129-139` | flagged posts, `state.lastPollAt` | §3 Timeline; §5 (236) | partial — press RTs shown as MEMBER (F24); no official/unverified rows (documented pending X search) |
| Intel panels | Confirmed ✓ / Circulating-unverified ? / What's new | `incidents.js:97-118` (Claude, nightly, cached by post count); `incidents.html:111,140-143` | member post text | §3 Intel; §5 (237) | partial (F23) |
| Who else is on it | other handles | `incidents.js:67,81`; `incidents.html:144` | grouped posts | §3 | matches (MN-04 on a Miami incident — F6) |
| Copy brief for Signal | plain text; "Copied ✓" 1.8 s | `incidents.html:72-85,157-161`; `ui.js:114-122` | selected incident | §6 (251); reference :889 | matches (header duplicates place — F36) |
| X-search panel | input, inert Run, 3 chips, static note | `incidents.html:34-39,53-57,104-105` | — | §3 (206) "sample results until X connector is live" | stub (honest; caption still says "sample results") |
| Place · district | `flag.place + ' · ' + leadAuthor.stateDistrict` | `incidents.js:73,82` | earliest poster's district | §3/§5 examples read as the incident's district (reference "Houston, TX · TX-18" led by a TX-29 member) | mismatch (F22) |
| Roster filter | none — every List account's flags grouped | `incidents.js:121-137` (`loadDay` without `splitByRoster`) | — | §4 "member" incidents; ROSTER_COVERAGE.md "Not changed" | mismatch (F26) |
| Plumbing | each poll: `buildIncidents({withIntel:false})` → `buildSiteData()`; nightly `incidents` with intel | `poll.js:155-158`; `package.json:25` | `data/incidents.json` (07:19Z) → `rollups.incidents` (identical) | §5 (224) "one file rebuilt every poll" | matches (contract shape differs: `intel.*` nested, no `official/unverified/meta`) |

### 2.7 Compose and daily report (`site/index.html` 242–337, `src/report.js`, `src/rollup.js`)

| Feature | Displays | Computed in | From | Spec ref | Status |
| --- | --- | --- | --- | --- | --- |
| Subject list | Topic · (15), Phrase · (first 6), Incident · (29 incl. resolved), Emerging · (11) | `index.html:309-313` | rollups | §2 Compose (198-200) | matches |
| Scope / Include / Order / Format / X-search | caucus + window, 8 checkboxes, 3 orders, 3 formats, disabled "not connected yet" | `index.html:48-52,324-329,339-364` | UI state | §2 (200); §6 (251) | matches (X search honest stub) |
| Topic subject text | "N officials on <Topic> · scope · window · M posts", one line per person, quote ≤110, footer | `index.html:242-304` (`:266` topic branch) | `D.feed` (200 newest) ⋈ `D.members` | §2 (200) | mismatch — population capped at the feed (F3); quotes keep newlines/t.co (F37) |
| Phrase subject | origin flagged "first use <date>", then feed posts containing the canonical text | `index.html:270-271` | `phrases[].first/firstSeen`, feed | reference :419-422 | partial (F3; variants ignored) |
| Emerging subject | one line per `who`, sample pinned to `who[0]`, posts = 1, eng = 0 | `index.html:274` | `clusters[].who/sample` | reference :423-426 | mismatch (F21) |
| Incident subject | timeline authors + `others` as "amplified" | `index.html:275-279` | `incidents[].timeline/others` | reference :427-429 | matches (window control has no effect, as reference) |
| Counter · Copy text · textarea | "N entries · N characters"; "Copied ✓" | `index.html:313-315,331-333,350`; `ui.js:114-122` | `composeText()` | §6 (251) | matches |
| Report: Top topics of the day | top 3 macros by posts+RTs, members, engagement, top-3 subs | `report.js:15-27,70-75`; `rollup.js:23-54` | `data/rollups/topic-days.json` | brief "Daily report v1" | partial — "0 engagement" ×18 for 09-09 (F8); members = persons here vs accounts on the dashboard (F1) |
| Report: Per caucus | top 3 per `settings.caucuses` | `report.js:45-54,80-86` | topic-days rows by raw tag | — | matches (same F8) |
| Report: Strategic syntax | top 5 per-day phrases with first-seen | `report.js:56-62` | `data/syntax/<d>.json`, ledger | brief 150 | partial — first-seen = corpus start (F4/F5) |
| Report: Volume & spend | originals, X reads / budget, classifier model/failed/unclassified | `report.js:64-68`; `store.js` | archive, `state.usage`, `data/topics/<d>.json` | — | matches (usage booked under run date, so the reported day's refresh cost is never on its own line) |
| Report: Developing stories / Taxonomy gaps / promoted tonight | top 8 each, hand-promotion hints, provisional list | `report.js:48-58,105-125,140-143` | `stories.json`, `taxonomy.yaml` | CLAUDE.md | partial — `reports/latest.md` at HEAD is the 06:27 pre-rewrite artefact (still prints "Promote:" for null-macro rows and stale 26-member counts); current code does not (refuted #6-#8) |
| Report outputs | `reports/<date>.md` + `reports/latest.md`; usage trim | `report.js:186-190` | — | README:119,166 | matches (`latest.md` follows any `--date` re-run — F38) |

### 2.8 Pipeline and provenance (`src/poll.js`, `classify.js`, `refresh.js`, `sitedata.js`, workflows)

| Feature | Displays | Computed in | From | Spec ref | Status |
| --- | --- | --- | --- | --- | --- |
| Capture, ET bucketing, dedupe | every count | `poll.js:43-160`; `store.js:72-103`; `backfill-members.js` | X list timeline (boundary-stop pagination), `/2/users/:id/tweets` for backfill | README "list endpoint rejects since_id" | matches (0 duplicate lines over 22 days; `state.sinceId` lags backfilled ids — cost only) |
| `today` / `days` | window definitions | `sitedata.js:118-119`; `util.js:14-22` | ET calendar | §2 title block; reference `headerDate` | matches |
| Topic assignments | Topics, feed chips, Core, momentum | `sitedata.js:35-43` (`{...live, ...nightly}`); `classify.js:165-180,253` (one day, `daysAgoEt(1)`); `classify-live.js:46-80` (poll-time, originals only, retweets inherit) | `data/topics/*.json` (21 days, all written 06:09Z by `classify-range`), `data/topics-live/2026-09-10.json` (2 assignments, commit `2b8fc5b`) | §4 split (219) | partial — no catch-up (F9); seed/backfill captures of today are never live-tagged (F17); `hasNightly` computed (`:41`) but never emitted |
| engN and the 24h refresh | every engagement figure | `sitedata.js:131-138`; `refresh.js:17-21,33-39`; `backfill-members.js` seed | `data/metrics`: 09-08 297/445 originals (all `fromCapture`), 09-09 3/532, 09-10 0/7; zero X re-reads to date | §4 (218) | partial (F12) |
| Stats per scope × window | cards | `sitedata.js:254-292` | archive, metrics, roster | §2, §4 | partial (F1, F11) |
| Momentum inputs | column + leader | `sitedata.js:152-155,185,209-223`; `momentum.js` | r24 + calendar trend | §4 (212); CLAUDE.md | mismatch (F2) |
| Emerging hydration | Emerging card | `sitedata.js:366-431`; `stories.js` | `stories.json` (06:26Z, pre-rewrite) | §4 (221) | partial (F20; stale artefact) |
| Feed build + isNew | Feed | `sitedata.js:433-454` | archive, `state.lastPollAt` | §5 (238) | partial (F3) |
| accounts / members / caucusActive / excluded | Compose, Unity denominators; `excluded` unrendered | `sitedata.js:456-473,481-487`; `authors.js:25-68` | `authors.json` (weekly `authors.yml` + CSV overlay) | §5 (239) | partial (F40) |
| Report-side rollups | `data/rollups/topic-days.json` | `rollup.js:23-54` (no capture fallback, `:37`) | archive, topics, metrics | README table | mismatch (F8) |
| Cadence and write path | freshness | `poll.yml` (*/20, `CLASSIFY_LIVE`), `nightly.yml` (07:30Z), `authors.yml` (Mon 06:00Z), `commit-data.sh` (union merge archive, field-merge state) | — | README "How the pieces fit" | partial — `&&` chain with no retry (F9); budget-exhausted poll returns before rebuild (F35) |
| Double-count audit | Posts, topic n, caucus columns | `store.js:100-103`; `sitedata.js:181-192` | — | §4 | matches (only true double count: momentum `tot = Σ c`, F2) |

### 2.9 Roster and attribution (`src/authors.js`, `config/accounts.csv`, `data/authors.json`)

| Feature | Displays | Computed in | From | Spec ref | Status |
| --- | --- | --- | --- | --- | --- |
| Author table | handle, member, district, caucuses, status, accountType | `authors.js:25-52,73-124` | X List members (447) + CSV overlay (447 rows); 448 entries incl. off-List stray `@RepAguilar` | §5 members | matches (CSV and table in sync) |
| CSV parser + status | house / senate / former / org; unknown → throws | `util.js:86-112`; `test/roster.test.js` | `accounts.csv` (427/6/14/1) | docs/ROSTER_COVERAGE.md | matches |
| House-only filter | stats, topics, phrases, feed, members exclude 21 non-House accounts (142 posts) | `authors.js:60-67`; `sitedata.js:143-147`; `rollup.js`; `syntax.js` | `status` column | brief "House only" | partial — not applied in `incidents.js` (F26) |
| Caucus scope fan-out | a post counts in All and every caucus of its author; `leadership` has no key | `sitedata.js:20,25-32,177` | `settings.caucus_keys` | §4 (219) | matches (All 2,586 vs Σ caucus 3,884; 171 posts from 25 untagged House accounts appear in All only — by design, refuted #13) |
| Members / top-10 / active accounts | per-scope Sets | `sitedata.js:186-201,266-278,470-473` | `authorId` | §4 (218,220), §2 (175) | partial — accounts not people (F1) |
| Leadership flag | Origin "· leadership" | `sitedata.js:356`; `settings.leadership_tag` | 26 accounts / 13 persons tagged | §4 leadership definition | matches (list broader than the spec's illustrative parenthetical — refuted #16) |
| Feed attribution | handle, dots, avatar | `sitedata.js:434-454`; `ui.js:94-98` | authors | §2 (184) | matches |
| accountType | stored, unused | `authors.js:34` | CSV `account_type` | brief column only | stub (harmless; refuted #15) |
| Report vs dashboard members | report dedupes by `member` name, dashboard by `authorId` | `rollup.js:30` vs `sitedata.js` | — | — | mismatch (F1: 09-09 economy 71 vs 82) |

### 2.10 Acceptance checklist (§6) and data contract (§5)

| Item | Result | Where | Status |
| --- | --- | --- | --- |
| §6.1 Filters change every number, the H1 color, hide caucus columns | Stats/Topics/Feed rescope; columns hide; no H1 exists (reference has none); Phrases, Emerging, Breaking, Momentum/trend/▲% are filter-independent (as reference) | `index.html:58,65-66,128-132,143,153,163-165` | partial |
| §6.2 No caucus hue on links/buttons/status; green = CPC only | ink pills/links; monitoring dot #ea580c is specified by §3 (206) | `index.html:10,15,232`; `ui.js:110-112` | matches |
| §6.3 Contrast ≥ 4.5:1 | one deviation: disabled X-search label #8e8e93 on #f7f7f9 (~3.3:1) | `index.html:329` | partial |
| §6.4 Feed height = Topics; internal scroll | equal side-by-side (≥ ~955px); wraps below | `index.html:31-35,182` | matches |
| §6.5 Compose copies plain text, "Copied ✓" | yes | `index.html:242-305,350` | matches |
| §6.6 Layout 920–1440, header never wraps | yes (rendered by the acceptance reader at 920/1440) | headers | matches |
| §6.7 Tabular numbers, Catmull-Rom sparks with end dot, 3–5px bars | yes | `ui.js:44-68`; `index.html:9` | matches |
| §5 `built`/`nextPoll`/`accounts` | emitted as `generatedAt`; `nextPoll` absent (page synthesizes); `accounts` = 427 unrendered | `sitedata.js:475-481` | partial (F27, F40) |
| §5 `topics[]` | scope-resolved `t/w` objects + server-side `momentum` instead of `c[5]`/tuple subs (documented deviation, both windows real) | `sitedata.js:236-245` | partial |
| §5 `phrases[]` | `when` → `firstSeen`; `variants` excludes canonical; `adopt[6] ≠ spread` | `sitedata.js:350-363` | partial (F18) |
| §5 `clusters[]` | all keys present + `who`, `kind`, `macro`, `days`, `context` | `sitedata.js:412-420` | matches |
| §5 `incidents[]` | `intel.*` nested; timeline lacks `official/unverified/meta`; extra `tweetIds`, `amplifiers` | `incidents.js:60-95` | partial |
| §5 `feed[]` | all keys + `id`, `district`, `date`, `isNew`; capped at 200 | `sitedata.js:433-454` | partial (F3) |
| §5 `members` | matches | `sitedata.js:458-463` | matches |
| §5 ET display / UTC storage | matches | `ui.js:24-38` | matches |
| §5 labeler (Title Case, acronyms) | server yes; page fallback and cluster `suggest` no | `taxonomy.js:154-163`; `index.html:56,224` | partial (F42) |

---

## 3. Confirmed findings (most severe first)

Each was checked by an independent verifier against HEAD; line numbers are HEAD's.

### High

**F1. Every "members" figure counts X accounts, not people, and the daily report counts people — the two surfaces disagree.**
Where: `src/sitedata.js:186-201` (topic/sub `members` Sets), `:266-278` (`stats.members`, top-10 share), `:320-324,357-358` (phrase spread/cm), `:401` (cluster members), `:470-473` (`caucusActive`), `:481` (`accounts`); `src/rollup.js:30` dedupes by `author.member`.
Evidence: `config/accounts.csv` has 447 rows for 234 member names, 204 with two accounts. Current window: 329 distinct posting accounts = 201 people; Economy row Members 191 → 150 people; `caucusActive.NewDem` = 179 for a 113-member coalition; top-10 share 51% by account vs 58% by person (today's top 10 happen to be 10 distinct people); report 09-09 economy "71 members" vs 82 by the dashboard's method. Verify: `node -e` — load 7 days via `loadDay` + `splitByRoster`, compare `new Set(authorId).size` (329) with `new Set(authors[id].member).size` (201).
Why it matters: the spec says "distinct members" (README:175,188,218,220); the brief says "distinct accounts" (brief 129-130). The number is neither labelled nor consistent across surfaces, and Unity's 10% denominator is roughly doubled.
Fix: resolve `authorId → authors[id].member` (or a member id) before every `Set.add` listed above and in `rollup.js`, or relabel every cell/caption "accounts". Decide the unit first (open question 1).

**F2. Momentum inputs are mixed: acceleration reads the partial calendar day, engagement lift divides All-scope engagement by a caucus-inflated post count against an age-mismatched baseline — 14/15 topics score `accel = 0`, 13/15 `engLift = 0`, "steady" ≈ 35 not 50.**
Where: `src/momentum.js:21` (`avg` over all 7 entries incl. partial today), `:24` (`accel` from `tr[6]`), `:22,28` (`tot = Σ c`, `engLift = (eng/tot)/epAvg`); `src/sitedata.js:185` (`trend[6]` = calendar today), `:213-223` (c/m/eng from r24; `c` per caucus only, untagged authors dropped; `epAvg` includes the current window); comment at `:152-155` states the r24 intent; `momentum.js:8-12` still documents `c` as "posts today" and `mAvg` as "7-day daily average"; column tooltip `index.html:156` says "7-day baseline".
Evidence: `node -e 'const R=require("./site/data/rollups.json");R.topics.forEach(t=>console.log(t.key,t.trend[6],t.momentum.accel,t.momentum.engLift))'` → `trend[6]` 0 or 1, `accel` 0 for 14/15, `engLift` 0 for 13/15. Σ`w[k].n`/`w.All.n` = 1.37–1.78 per topic; economy r24: 101 posts, Σc 151, eng/post 63 (vs 94 with the right denominator, vs `epAvg` 177). Substituting the r24 count for `trend[6]` moves scores +9 to +20 (foreign-policy 67→87, democracy 61→79). Commit `ac4a298` moved volume/adoption/spread to r24 and left accel/engLift.
Why it matters: the column and the leader card are systematically depressed and "engagement" can never be a driver; the tooltip components are not what they claim.
Fix: feed `accel` a rolling series (r24 vs previous 24h windows) or at least six full days with `trend[6] := r24`; use `rAll.n` as the engagement denominator; compare capture-time eng/post against a capture-time baseline (or drop engLift until a real 24h re-read exists); update `momentum.js:8-12` and the tooltip.

**F3. The feed is capped at the newest 200 posts before any filter; the feed header, topic-dropdown counts and every Compose subject built from `D.feed` contradict the Posts card and Topics table.**
Where: `src/sitedata.js:437` (`.slice(0, 200)`); `site/index.html:164-168,180` (header/dropdown), `:266,271` (Compose topic/phrase branches).
Evidence: 7-day view: "200 posts" / "All topics (200)" beside Posts 2,586; the 200 kept posts span 2026-09-09T20:41Z → 09-10T07:19Z (~10.6 h); Compose "Economy · all · 7 days" lists ~25 officials / 27 posts vs 473 posts / 191 members in the table; CBC Economy 8 vs 91. A normal day has ~600 posts, so Today truncates too. Verify: `node -e 'const R=require("./site/data/rollups.json");console.log(R.feed.length,R.stats.All.w.posts,R.feed.at(-1).time)'`. Neither §5 (238) nor the reference caps the feed.
Why it matters: the composer sends "7 officials have posted" for a topic 191 accounts posted on.
Fix: cap per window after filtering (or raise the cap — 2,586 posts ≈ 1 MB), compute Compose/dropdown counts server-side per scope × window, and label the header "newest N of M".

**F4. Phrase Origin dates are a corpus-edge artefact: "Aug 20" is the first archived day, and the day-one first author (and its leadership flag) is whoever tweeted earliest that day.**
Where: `src/syntax.js:109-115` (entry created with `firstSeen = run date`, `firstAuthorId` = earliest tweet that day); rendered unqualified at `site/index.html:193,201`.
Evidence: `data/archive` starts 2026-08-20; 25/240 ledger entries and 5 of 12 displayed rows carry `firstSeen = 2026-08-20` ("working people", "donald trump", "trump administration", "lower costs", "keep fighting", "health care"); "donald trump" reads "@RepJeffries · Aug 20 · leadership" because his 13:18Z tweet was the earliest of 18 that day. Verify: `node -e "console.log(Object.values(require('./data/phrases.json')).filter(e=>e.firstSeen==='2026-08-20').length)"` → 25.
Why it matters: the column's job is "who started it"; the reference expects origins that can predate the window (README:485,487).
Fix: render `firstSeen === corpus start` as "≤ Aug 20" without author/leadership, or compute first use from the full archive at sitedata time with a corpus-start flag.

**F5. The ledger records first-seen only on days the exact n-gram makes the day's top 25, never re-dates, and is order-dependent — 6 of 12 rows name a member who was not the first user.**
Where: `src/syntax.js:95` (`.slice(0, settings.syntax.top_phrases)` before the ledger loop), `:110` (`ledger[ph.phrase] || {...}`), `:117-119` (`memberFirst` only on those days).
Evidence: "gas prices" had 4 members on Aug 20 (rank 30 of 73) and 7 on Aug 28 (rank 42) but is recorded 2026-08-31 @MarkPocan; archive first user is @RepShontelBrown Aug 20. Same for "labor movement" (Aug 21 @Mfume4Congress vs shown Sep 7 @RepRileyNY), "keep our communities", "fair wages", "hard work", "men and women". Sparse `memberFirst` also lets returning users count as new in the gain. Verify: `minePhrases(loadDay('2026-08-20'), {minMembers:3,minNgram:2,maxNgram:4}).findIndex(x=>x.phrase==='gas prices')` → 30. README:66-67 tells operators to run `syntax` oldest-first.
Fix: record `memberFirst`/`firstSeen` for every phrase over `min_members` (drop the cap for the ledger), take `min(date)` on re-runs, or derive first use from the archive at build time.

**F6. Most incidents are not breaking district emergencies the member is handling; "N active" on the dashboard is mostly advisories, recovery notices and condolences.**
Where: the only guard is the prompt rule (`src/taxonomy.js` incident clause, ~:131-138); the model sees `{id, text}` only (`src/classify.js:43`, `classify-live.js:53`); `src/incidents.js:48-57` applies no post-filter.
Evidence: `data/incident-audit.json` (in the repo, 07:18Z) grades the 29: 9 TRUE, 16 FALSE POSITIVE, 4 AMBIGUOUS, precision 0.36, `active_true` 1. Source posts: 4× Mrvan "daily storm update" recovery notices, a FEMA deadline notice, "this week's Schrier Flyer", heat advisories (San Diego, Orange/LA), disaster-declaration politics (Aspen), Miami condolences incl. @BettyMcCollum04 (MN-04). 8 of 174 flags have author state ≠ place state. See `docs/INCIDENT_AUDIT.md`.
Why it matters: the dashboard's red "Breaking in district" strip and the desk's headline counts are dominated by non-incidents.
Fix: pass the author's district into the prompt; post-filter in `groupIncidents` (state match, recovery/deadline/newsletter keywords, no retweets — F24); consider requiring a second signal (quote of an official, evacuation vocabulary) before "active".

**F7. Grouping by free-text `kind + place` splits single events into 2–4 cards: 29 rows ≈ 18 events.**
Where: `src/incidents.js:23-26` (`incidentKey`), prompt asks for "identical kind+place strings" across 40-tweet chunks classified independently (`classify.js:29-48`).
Evidence: la-habra-ca--chemical-leak vs --hazmat-release (same Sep 8 event, same member); detroit-mi--tornado / detroit-mi--severe-storms / southeast-michigan-mi--severe-storms / michigan-mi--severe-weather (one Sep 3 storm); gary-in / lake-station-in / porter-county-in / northwest-indiana-in (one August storm, all @RepMrvan); monterey-county-ca vs big-sur-ca; aspen-co vs aspen-acres-gold-mountain-co; ka-hi vs hawaii-island-hi. `norm()` strips non-ASCII so "Kaʻū, HI" → `ka-hi`. `data/incident-audit.json .grouping_issues` lists the same six splits. Header reads "3 active · 7 monitoring · 19 resolved this week" from these rows verbatim (`incidents.html:91`).
Fix: group by member + state + time window (or fuzzy kind families) before keying; pass currently-open incidents into the classifier prompt so it can reuse ids.

**F8. `rollup.js` has no capture-time engagement fallback, so the daily report prints "0 engagement" for every topic and disagrees with the dashboard for the same topic-day.**
Where: `src/rollup.js:13-16,37` (`engagementOf(metrics[t.id])` → 0 when absent) vs `src/sitedata.js:136-138` (falls back to `metricsAtCapture`); `report.js:73,85` print it verbatim; `refresh.js:33-39` `break`s on budget/rate-limit and never revisits.
Evidence: `grep -c '0 engagement' reports/2026-09-09.md` → 18 (metrics file has 3 entries for 532 originals); 2026-09-08 economy/all: topic-days 11,938 vs 21,611 recomputed the dashboard's way (27 originals lack entries). `node -e 'console.log(require("./data/rollups/topic-days.json").rows.find(x=>x.date==="2026-09-08"&&x.macro==="economy"&&!x.sub&&x.caucus==="all").engagement)'`.
Why it matters: §4 defines one Engagement metric; the report linked from the dashboard header shows a different one, and an all-zero day prints no warning.
Fix: one shared `engagementOf(post, metrics)` in `store.js` used by `rollup.js`, `sitedata.js` and `incidents.js`; print a coverage note when < N% of originals have refreshed entries.

**F9. Nightly classification has no catch-up: a batch still processing at the deadline is orphaned by the next run, a failed stage leaves a permanent silent hole, and rollups carry no coverage flag.**
Where: `src/classify.js:253` (one date, `daysAgoEt(1)`), `:262` (`pendingBatch?.date === date` — tomorrow's date differs, so the batch is never resumed), `:268` (overwritten), `:284` ("tomorrow's run picks it up"); `package.json:25` `&&` chain; `refresh.js:57,66` exit 1 on `x.js fail()`; `sitedata.js:41` computes `hasNightly` and never emits it.
Evidence: trace `main()` with `state.pendingBatch = {id, date: '2026-09-08'}` and `daysAgoEt(1) = '2026-09-09'` → `batchId` null, new batch submitted. Only multi-day path is the manual `classify-range` (README:116). No gap exists yet because the nightly Action has never run (no `nightly:` commit; 22 archive days vs 21 topics files differ only by today).
Why it matters: a missed day zeroes `trend[di]` and dilutes `avg6`/`mAvg`/`epAvg` for six builds with no visible signal.
Fix: iterate every archived day < today lacking a topics file (reuse the `classify-range` planner, bounded by budget); key `pendingBatch` by its own date; emit per-day `{posts, tagged}` coverage in rollups and show it.

**F10. Label-token merge folds unrelated memorial / first-responder clusters into "Dolly Parton tribute".**
Where: `src/stories.js:58` (STOP strips `tribute(s)`), `:59-75` (`labelTokens`, `similar`: containment of a 1-token set with size diff ≤ 2); placement cache labels the union-find group `celebrity-tribute` → "Dolly Parton tribute". `test/stories.test.js:16` (`=== false || true`) never exercises the containment rule.
Evidence: `similar(labelTokens("memorial-tributes"), labelTokens("first-responder-memorial"))` → true, bridging celebrity ↔ memorial ↔ first-responder. Today's card: 2 window posts — one Dolly (@RepCohen) and one George Dean / Phoenix Urban League (@RepGregStanton); its coherence phrase "profound loss" comes from the Stanton post. HEAD's `mergeEvidence` drops the hint-only Dolly fold on a re-run (67 → 29 posts) but the memorial/first-responder mix and the cached label survive.
Fix: require ≥ 2 shared tokens for containment merges (or stop stripping `tribute`), fix the tautological test, regenerate `stories.json`.

### Medium

**F11. Engagement card "▼ 100% vs 7-day avg" compares a partial ET day of capture-time engagement with six full days; no lag caption exists; `engDelta(w)` is a hard-coded 0.**
Where: `src/sitedata.js:270-279`; `site/index.html:94`. `sitedata.js:8-10` claims "the dashboard captions say so" — `grep -in 'lag' site/index.html` finds nothing.
Evidence: `stats.*.t.engDelta` = −100/−99/−100/−100/−100/−99 at the 03:30 ET build (480 vs ≈114.6K/day). The reference hard-codes `arrow(8)` (README:713), so no logic was ported. The momentum comment at `sitedata.js:152-155` names exactly this collapse as the reason it moved to r24.
Fix: use the r24 window or prorate the baseline to elapsed hours; compare age-matched (capture-time vs capture-time) numbers; add the caption; emit `null`, not 0, for the 7-day delta.

**F12. Every engagement number is a capture-time snapshot — no real 24h re-read has ever run, `refresh.js` only ever targets yesterday, and 148 originals from 2026-09-08 will never be refreshed; nothing on either page says so.**
Where: `src/refresh.js:17-21` (`duePasses` = `daysAgoEt(1)` only), `:33-39` (deferred ids never revisited); `src/sitedata.js:136-138` (silent fallback); `backfill-members.js` seed skipped for ids already seen; feed `Top` sort `index.html:166`, per-post figure `:177`.
Evidence: `data/metrics` entries: 09-08 297/445 originals (all `fromCapture`), 09-09 3/532, 09-10 0/7; X re-reads to date: 0. The 148 unrefreshed 09-08 originals were captured 25.7–33 h old by the one-time `backfill.js` and carry 45,873 capture-time engagement. In Today mode "Top" ranks on numbers seen ≤ 20 min after posting.
Fix: make `duePasses` scan every archived day ≥ 24 h old for originals lacking an entry (bounded by budget); emit a per-post `engSettled` flag and a caption ("as of capture · settles after 24h"); consider hiding Top in Today mode.

**F13. Core messages count and "% of posts" sum topic assignments, not posts.**
Where: `site/index.html:79-80` (Σ core rows ÷ Σ all rows); `sitedata.js:181-192` counts a post once per distinct macro.
Evidence: 7-day All: Σ topic rows 2,838 for 2,586 posts (640 posts carry >1 macro); card shows 976 / 34% "of posts", distinct-post figures are 915 core / 2,156 classified → 42% of classified (35% of all). The reference uses the same Σ (README:667,671) but its sample has one macro per post; §4 (217) and the label say posts.
Fix: emit `stats[scope][win].classified` and `.core` as distinct-post counts from sitedata and read them in the card.

**F14. "Corruption" pillar counts the entire "Democracy & rule of law" macro; Affordability likewise absorbs tariffs, jobs and taxes.**
Where: `config/settings.json core_messages` (`Corruption: ['democracy']`), passed through at `sitedata.js:467`.
Evidence: spec (README:169,217) and reference (README:669: `epstein_files`, `gop_reconciliation_law`) define two story topics; `config/taxonomy.yaml` has neither. Week's `democracy` assignments: no-sub 337, voting-rights 17, executive-overreach 16, corruption-ethics 15, courts-doj 7, press-speech 4.
Fix: add the two story subtopics (auto-promotion can now carry them) and point `Corruption` at them, or relabel the pillar "Democracy". Open question 2.

**F15. Momentum leader has no volume floor: the 7-day leader is "Reproductive rights" (7 posts all week) at 84.**
Where: `site/index.html:81` (`n > 0` only); `sitedata.js:212,215` (`avg6 || 1`, `mAvg || 1` let tiny baselines saturate every ±50% term).
Evidence: `w.All.n` 7, trend `[3,1,0,0,0,3,0]`, d +157, volume/accel/adoption all 1, ranked above tech (67 posts) and foreign-policy (264). A brand-new topic with one r24 post reads "▲ 0%". Spec (212) sets no floor; the reference's smallest sample topic had 159 posts.
Fix: require `avg6 ≥ N` or `r24 ≥ N` before a topic can lead, or shrink scores toward 50 by volume.

**F16. The 7-day trend sparkline and the ▲% beside it are on different windows: the curve collapses to the partial-day 0/1 while the delta says +28%.**
Where: `site/index.html:144` (`spark(t.trend)` + `arrow(t.d)`), `:96-98` (leader card reuses both); `sitedata.js:185` (calendar `trend`), `:212-214` (r24 `d`).
Evidence: economy `[98,40,46,87,101,101,0]` with d +28; foreign-policy `[…,52,71,0]` with d +57. `ui.js:58` scales to min..max so the end dot sits on the baseline. Spec (178) pairs the curve with a delta of the same series.
Fix: set `trend[6]` to the r24 count (consistent with d and momentum — also fixes half of F2), or label the delta "24h vs prior 6 days".

**F17. In an empty or nearly empty window the table awards rank badges to 0-count rows, shows live momentum beside Posts 0, hides the Momentum-leader card, never shows an empty state, and cannot distinguish "quiet" from "not yet tagged".**
Where: `site/index.html:114,130-131` (top3 without `n > 0`), `:81,95` (leader card conditional), `:159` (empty state only when `D.topics` is empty); `classify.js:253` (nightly = yesterday); live tagging covers only posts captured by tagged polls.
Evidence: today has 8 posts, 2 tagged (`data/topics-live/2026-09-10.json`, poll `2b8fc5b`); the other 6 came from the 05:27Z seed and the backfill and stay untagged until the nightly. `node -e 'const R=require("./site/data/rollups.json");const M=["CPC","NewDem"];console.log(M.map(k=>R.topics.slice().sort((a,b)=>b.t[k].n-a.t[k].n).slice(0,3).map(t=>[t.key,t.t[k].n])))'` → badge 2 and 3 on 0-count rows in both columns. The reference never hides the leader card (README:714). At midnight ET rollover all four symptoms appear until the first tagged poll.
Fix: guard badges with `n > 0`; always render the leader (fall back to r24 or an explicit "no posts yet"); add a window-level empty state; emit per-day `{posts, tagged}` and show "N posts awaiting tags".

**F18. Phrase Adoption number and its curve describe different populations (7 of 12 rows).**
Where: `src/sitedata.js:357` (`spread` = window users) vs `:331-343` (`adopt` seeded with every variant's ledger `memberFirst`, pre-window dates bucketed into day 0); gain at `index.html:190`.
Evidence: "working people" 121 beside a curve ending at 176; "donald trump" 51 / 129; "trump administration" 41 / 112; "lower costs" 32 / 65; "health care" 27 / 69; "keep fighting" 29 / 54; "gas prices" 27 / 33. §4 (220): count = last 7 days, curve = cumulative by day, gain = day 7 − day 1; every reference row has `adopt[6] === spread` (README:485-495).
Fix: choose one scale — build `adopt` from window users only (spec), or display `adopt[6]` as the count (reference) — and say which in the column title.

**F19. Discipline reports the arbitrary top-30 cut, not wording drift: variants are only sought among the 30 highest-spread phrases, so 10 of 12 rows read 100% with an empty variants tooltip.**
Where: `src/sitedata.js:302-307` (`.slice(0, 30)` then `clusterFamilies`).
Evidence: 1,123 phrases clear the 3-member threshold this week; below the cut sit "lowering costs" (11 members, variant of "lower costs"), "american labor movement" (4), "keep our communities safe/moving" (5/6), "hardworking men and women" (10), "fair wages safe" (8). The only multi-variant family ("working people", 39%) is the spec's loose bigram rule at work (refuted #4).
Fix: cluster the top-N canonicals against all phrases over threshold, then compute exact/variants.

**F20. The Emerging panel ranks and truncates candidates by 30-day totals before applying the 7-day window, has no members floor, and dates cards from the window edge.**
Where: `src/sitedata.js:372-376` (filter → `.slice(0, 12)` in stories.json order) then `:385-389` (window intersection, `since` = first in-window post; story `firstSeen`/`days` never rendered).
Evidence: shown — "Dolly Parton tribute" 2 posts / 2 members, "Small business & SBA" 2/2, "Christian nationalism" 2/1, "Public lands" 1/1; cut — "Amy Acton campaign attack" 5/5 (story), "Trump Arch" 4/2, "USPS" 3/3, "Smithsonian" 3/3, "Epstein files & investigation" 3/3. "Agriculture & farmers" (firstSeen Aug 20, 16 days) reads "since Sep 4, 6:50 PM". A 12th slot is lost when a candidate's window posts fail the roster filter.
Fix: intersect with the window first, then rank by in-window posts (tie-break members) with a ≥ 2-member floor; render the story's `firstSeen` (or "since Aug 20 · 16 days").

**F21. Compose for an Emerging subject credits the sample quote to the earliest poster, prints "1 post · 0 engagement" for everyone, and ignores the window.**
Where: `site/index.html:274` (`add(h, i === 0 && cl.sample ? {engN:0, text: cl.sample} : null)`); `sitedata.js:401,407` (`who` = members in `createdAt` order) vs `:402,414` (`sample` = highest-engN post); `inWin` applied only at `:266,271`.
Evidence: 7 of 11 clusters mismatch — "9/11 25th anniversary" quote by @RepJerryNadler under @Mike_CA05; "Mental health" @RepPressley under @RepMikeQuigley; "Data centers" @jamie_raskin under @JoaquinCastrotx; Dolly @RepCohen under @RepGregStanton. Header "M posts" = member count (Mental health card 15 posts / 14 members → "14 posts").
Fix: emit `sampleHandle` and per-member `{posts, eng}` for each cluster from sitedata; attach the quote to its author; apply the window filter.

**F22. Incident district suffix is the lead poster's home district, not the incident's location.**
Where: `src/incidents.js:73` (`place + ' · ' + leadAuthor.stateDistrict`), `:82` (title repeats place); `test/momentum.test.js:77` locks it in.
Evidence: "Miami, FL · FL-09" (Soto, Orlando), "Aspen, CO · CO-06" (Crow, Aurora; Aspen is CO-03), "Kauai, HI · HI-01" (Case, Honolulu; Kauai is HI-02), "Eastern Oregon, OR · OR-03" (Portland), "Orange County, CA · CA-25"; state-scale places "Washington, WA · WA-08". The reference's own sample ("Houston, TX · TX-18" led by a TX-29 member) makes the suffix the incident's district.
Fix: label the suffix as the member's ("· lead CO-06") or drop it when the place is a county/state or its state differs from the district.

**F23. The "Confirmed" intel panel and the Signal brief present member-only assertions as confirmed, inconsistently across incidents, with raw UTC source times beside ET timeline times.**
Where: `src/incidents.js:97-118` (`extractIntel` — model output taken as-is, `slice(0,5)` only); `site/incidents.html:141` (green ✓), `:77` (`briefOf` copies rows under "Confirmed").
Evidence: 8 of 46 confirmed rows say in their own text "stated directly by the member, with no official source (police/OEM/fire) cited"; 16 incidents are all-confirmed (gary-in, washington-wa, aspen-co, big-sur-ca …) while 7 structurally identical ones (san-diego-ca, ka-hi, burlingame-ca, miami-fl …) are all-unverified. All 46 `src` strings carry "2026-09-09 19:17 UTC"-style timestamps; §5 (243) requires ET display.
Fix: post-validate (rows without an official attribution move to unverified, or rename the panel "Member-stated"); feed ET-formatted times into the prompt.

**F24. Retweets of press and officials are classified from their truncated "RT @…" text and rendered as MEMBER timeline posts.**
Where: `src/classify.js:165-180` (`planDay` sends a retweet to the model when its original has no assignment; `deferInCorpus` is off in the nightly); `src/incidents.js:85-86` (`tag: 'member'`, attributed to the retweeter); `classify-live.js:47` excludes retweets, so live and nightly disagree.
Evidence: la-habra-ca--chemical-leak is exactly "RT @ocregister: Shelter-in-place order lifted…" and "RT @ABC7: UPDATE: All-clear given…" — shown as "2 member posts · @RepLindaSanchez · MEMBER"; monterey-county-ca `timeline[0]` is a truncated "RT @MCoSheriff: *** Timber Fire Evacuation…". The reference timeline vocabulary distinguishes police / fire / press rows (README:824-858) and `ui.js:104` has a `press` badge the desk never uses.
Fix: skip `type === 'retweet'` for incident flags in `planDay`/`writeDay`, or render them as press/official rows with the original handle.

**F25. Live (poll-time) incident flags can never be revoked by the nightly re-classification.**
Where: `src/incidents.js:37-46` (`Object.assign(flags, live.incidents)` then `Object.assign(flags, nightly.incidents)` — nightly wins only on shared keys; comment at `:36` overstates it).
Evidence: fixture `data/topics-live/<d>.json` with an incident id absent from `data/topics/<d>.json` → the id survives `collectFlags()` for the whole 8-day window. Live tagging is now producing files (`2b8fc5b`), so this is no longer dormant.
Fix: when a nightly file exists for a date, ignore that date's live incidents.

**F26. Incident grouping bypasses the House-only roster filter, so senator-led incidents render as member incidents.**
Where: `src/incidents.js:121-137` (`loadDay` without `splitByRoster`; file imports only `loadAuthors`), unlike `sitedata.js:143`, `rollup.js`, `syntax.js`.
Evidence: detroit-mi--tornado and southeast-michigan-mi--severe-storms are led solely by @SenatorSlotkin (status `senate`), place "Detroit, MI" with no district; both count in "19 resolved this week" and appear in Compose's subject list; while active they would show in "Breaking in district". `docs/ROSTER_COVERAGE.md` ("Not changed") records the gap.
Fix: `splitByRoster(loadDay(...), authorsById).house` in `buildIncidents` — no API spend.

### Low

**F27. Header: the date ignores the window, "Next poll" is synthesized, and the build time is never shown.**
`site/ui.js:36-38` (`headerDate(today)` takes no window; reference shows "September 1 – 7" for 7 days, README:700); `index.html:69` (`lastPollAt + 20 min` instead of a contract `nextPoll`, README:230 — can read as a past time when polling stalls); `sitedata.js:475-481` emits `generatedAt` that nothing renders, so a nightly rebuild does not move the timestamp. Fix: pass the window to `headerDate`, emit `nextPoll` from the builder, show `generatedAt` in the title.

**F28. Subtopic rows keep their build-time order and the lead handle ignores the caucus filter.**
`src/sitedata.js:235` (sorted once by `t.All.n`, `w.All.n`), `index.html:134` (no re-sort); `sitedata.js:198,227` (lead = top engN author, All scope, 7 days) shown at `index.html:138` in every scope (9 of 38 sub leads are not CPC members, 28 of 38 not New Dem). Even the committed file has 5 sub lists out of order for 7-day CPC/NewDem views (democracy CPC 12, 11, 7, 3, 4). Fix: sort subs in `renderTopics` by `s[win][scope].n`; optionally compute lead per scope from the tracked `leadEng`.

**F29. Feed topic chips drop the subtopic tags the reference shows.**
`site/index.html:171-172` keeps only keys without `/`; the reference labels the first two of a flat list that includes subs (README:656, sample `dilley_facility`); `sitedata.js:447,248-252` already emit `macro/sub` keys and labels. 7 of 200 feed posts carry subs today. Fix: prefer the `macro/sub` label when present, keep the two-chip + "+n" limit.

**F30. Any click on the page re-renders the feed and resets its scroll position and dropdown focus.**
`site/index.html:340-364` (global handlers call `render()` for segmented buttons, `[data-toggle]` rows, Compose toggles) → `renderFeed` replaces `$('feed').innerHTML` (`:180-182`). The reference is React with keyed diffing. Fix: skip `renderFeed` when only `state.open`/Compose state changed, or preserve `scrollTop` across the swap.

**F31. Unknown authors render a raw numeric id as the handle and a digit as the avatar (latent; 0 cases today).**
`src/sitedata.js:442-443` (`handle = authorId`, `member = ''`), `site/ui.js:96`; `isHouse(undefined)` = house so such posts pass the roster filter; authors refresh is weekly (`authors.yml`), so a member added to the List mid-week shows as "227073090" for up to 7 days. Fix: resolve unknown ids during the poll (one `users` lookup) or render "unknown account" with a "?" disc.

**F32. Pillar and fine topic are chosen from different macros.**
`src/sitedata.js:347-348` (`topMacro`, `topSub` picked independently), `:352-353`. "keep our communities": `labor` → Off-pillar, but topic "Jobs & wages" (economy/jobs-wages, an Affordability subtopic). Fix: restrict `topSub` to subs whose macro === `topMacro`.

**F33. Placement cache keyed by raw-label slug leaves duplicate and stale placements.**
`src/stories.js:128,298` (key = dominant raw-label slug), `:304` (merge_into visible only within a 20-candidate batch), `:427-430` (cache reuse), `:488` (`--promote` takes the first match). "epstein-files" and "epstein-investigation" are both placed to `democracy/epstein-files` with no merge; "transit-infrastructure" and "infrastructure-transportation" are separate placed candidates; 7 placement keys no longer exist as candidates. Fix: key placements by group content (sorted id hash) or re-run merge resolution across batches; prune orphans.

**F34. Incident status labels freeze between rebuilds; a budget-exhausted poll returns before the rebuild.**
`src/poll.js:115-119` (early return on `budgetExhausted`) vs `:155-158` (`buildIncidents` + `buildSiteData`); `statusOf` runs only inside `groupIncidents` (`incidents.js:65`); both pages read `status` verbatim. Rollups built 07:30Z already differ from `statusOf(now)` for the two most recent incidents. The rebuild costs no X reads. Fix: move the rebuild above the early return, or compute status client-side from `since`/`last` with the 12h/36h thresholds.

**F35. Desk deviations from the contract: literal 0 "official sources", "Kind · place" title that duplicates place in the brief, "sample results" caption with no results, unused `badge` import.**
`site/incidents.html:125` (hard-coded `0`; reference `timeline.filter(e => e.official).length`, README:877), `:75` + `incidents.js:82` (brief header "Wildfire · Napa County, CA — Napa County, CA · CA-04 · active · …"), `:35` (caption) vs `:105` (explanatory paragraph), `:46` (`badge` unused). Fix: compute official count from timeline tags (0 today), make `title` a headline or drop the place from the brief header, reword the caption "X search not connected".

**F36. Compose quotes keep tweet newlines and t.co tails, breaking the plain-text-for-Signal intent.**
`site/index.html:248` (`trim` only cuts at 110 chars), `:301`. Over a quarter of feed texts remain multi-line after trimming and ~20 end in a bare t.co link. Fix: collapse whitespace and strip trailing `https://t.co/…` before trimming.

**F37. `reports/latest.md` follows any `--date` re-run.**
`src/report.js:190` writes it unconditionally; README:194 documents `npm run report -- --date=…`; the nightly commit script includes `reports/`, so a committed re-run of an old day repoints the dashboard's "Daily report" link until the next nightly. Fix: only rewrite `latest.md` when `date === daysAgoEt(1)` or when the date ≥ the current latest.

**F38. `src/rollup.js` (4) and `src/stories.js` (2) contain literal U+0000 bytes as key separators, so git and grep treat them as binary.**
`rollup.js:26,44,46`; `stories.js` key builders. `git diff --stat` shows "Bin"; `grep` reports "binary file matches"; no readable diffs or textual merges for two core files. Fix: use the escape `'\u0000'` (or `'\x1f'`) in the template strings; behaviour is identical.

**F39. `accounts` and `excluded` are emitted but never rendered, and `accounts` includes the off-List stray.**
`src/sitedata.js:458-462` (no `onList`/`stale` check for House authors), `:481,484`; neither page reads `D.accounts`/`D.excluded`. 427 = 426 on-List House accounts + `@RepAguilar` (`onList:false`, 1 follower, CSV typo per ROSTER_COVERAGE.md), which also ships in the Compose members map. Fix: exclude `onList === false`/`stale` from `members`; render "· N accounts on X · N non-House excluded" if the title block is wanted (open question 4).

**F40. Caucus index order is duplicated between `config/settings.json` and `site/ui.js:10`; `cm[]` arrays would silently mislabel if either changes.**
`sitedata.js:20,358,408,485` emit `cm` in `settings.caucus_keys` insertion order; `index.html:192,198,203,221` index with the hard-coded `KEYS`; neither page reads `D.caucusKeys`; no test asserts the orders agree. Fix: derive `KEYS` from `D.caucusKeys` at load, or emit `cm` keyed by caucus, or add a test.

**F41. Cluster `suggest` tags bypass the labeler and the page-side `label()` fallback has no acronym table.**
`site/index.html:224` (`tag(c.suggest)` → "dolly-parton-tribute", "sept-11-anniversary"); `:56` (fallback `label()` lacks `ACRONYMS`, unlike `src/taxonomy.js:154-163`); reference passes `suggest` through `label()` (README:723), §5 (243). Fix: emit `suggestLabel` via `labelOf()` from sitedata, or port `ACRONYMS` into `ui.js`.

**F42. The Emerging card lists up to 12 clusters with newsletter blocks, stretching the Phrases card to its height.**
`src/sitedata.js:374` (`.slice(0, 12)`), `index.html:37` (`align-items: stretch`), `:218-226`; 11 clusters, 9 with context blocks, vs 3 in the reference. Fix: cap the visible list (top 4, "show more"), make the Emerging body scroll like the Feed, or drop `stretch` for that row.

---

## 4. Refuted claims

Raised by area readers and rejected on verification; listed so they are not re-raised.

1. *Non-House accounts flow into feed/stats/accounts unmarked.* — Commit `1b4e0c7` added the `status` column and `splitByRoster`; `sitedata.js:143-147` drops 142 non-House posts before every number; the gray avatar is the spec's "everyone else" case.
2. *"N new" wrongly collapses to 0 after an empty poll.* — "New" is defined as captured in the latest poll (reference README:349,718; `poll.js:135`, `sitedata.js:452`); "2 new" beside "updated 3:19 AM" is a true statement.
3. *Replies are indistinguishable and posts do not link to X.* — Neither the reference `kindGlyph` (README:656) nor the §5 feed contract (238) defines a reply marker or an id/link; enhancement, not defect.
4. *Family clustering over-merges bigrams ("working people" ∪ "american people").* — That is the spec's own rule ("one token edit", README:220); the transitive-chain example ("american workers") ranks 30 and is outside the top-30 cut. Spec-quality note, not a code finding.
5. *Phrases are generic collocations; no baseline-rate filter; the brief's Claude grouping pass is missing.* — §4 defines adoption as raw 7-day spread with no baseline, the reference sorts by raw spread, §2 says engagement is deliberately absent; the LLM pass is recorded as queued in `docs/INTELLIGENCE_EVERYWHERE.md:16`, not presented as built.
6. *Model-merge corrupts merged candidates' members/days via a never-set `_dates`.* — That code is gone; HEAD's `applyMerges` (`stories.js:247`) re-scores from the unioned ids and `test/stories.test.js:171-204` asserts it. The wrong numbers in `data/stories.json` (06:26Z) and `reports/latest.md` are a stale artefact awaiting the first nightly.
7. *`stories.js` merge leaves members/who/days stale (duplicate of 6).* — Same.
8. *The report prints a Promote command that throws for null-macro stories.* — HEAD `report.js:120-125` prints "No macro fits — add … by hand" for those; the "Promote:" lines in `reports/latest.md:61-62` are the 06:27 pre-rewrite artefact.
9. *"Daily report" links to raw Markdown; the Incident desk header drops the link and Compose despite "Same header".* — The reference desk header (README:759) has neither control; the link target is unspecified and resolves inside the deployed tree (README:46,135). UX nit at most.
10. *The Today view has no topic data by construction; live tagging has never produced output.* — `data/topics-live/2026-09-10.json` exists (Actions poll `2b8fc5b`, 07:19Z, 2 assignments); Σ`t.All.n` = 2, `stats.All.t.posts` = 8, and the leader card renders (tech). Residual symptoms are F17.
11. *Emerging reads a `stories.json` no workflow rebuilds.* — `package.json:25` nightly includes `stories` and `stories -- --auto-promote --retire` (commit `e1a4afa`); `config/settings.json stories` documents "run nightly after classify". The chain has not yet run in Actions (see §5), and the committed file is stale, but the automation exists. The earlier "stub" verdict was against a pre-`e1a4afa` checkout.
12. *Live-tagging output never exists; nightly only classifies yesterday (acceptance reader).* — Same as 10; the one-day nightly is F9's catch-up gap, not a missing feature.
13. *6.6% of All-scope posts come from caucus-less House accounts and the page hides it.* — "All" = every House Democrat by definition; `docs/ROSTER_COVERAGE.md` documents the 15 untagged members as correct; neither spec nor reference has an "Other" row or gap caption (`rosterNote` is computed and never rendered in the reference).
14. *A List account with no CSV row silently counts as House.* — Intended, documented (`authors.js:56-62`) and tested (`test/roster.test.js:40-63`) default; the weekly refresh warns about untagged List members.
15. *`account_type` is stored but unused; three CSV rows disagree with the official House list.* — The brief lists it only as a CSV column; no spec surface uses it; the official list is itself incomplete (Randall, Menefee absent), so it cannot adjudicate; only `@WhipKClark` typed "personal" looks like a one-cell slip that affects nothing.
16. *`leadership` tag is broader than the spec's definition.* — The spec's parenthetical is illustrative (it omits the Assistant Leader); the 13 tagged persons are plausible; not verifiable from the repo.
17. *Promotion writes an unquoted `since:` that leaks a JS `Date` string into the classifier prompt.* — HEAD's `renderTaxonomy` passes it through `ymd()` (`taxonomy.js:13-16,60`); round-trip prints "[developing story since 2026-09-01]"; existing rows in `taxonomy.yaml` are quoted. Residual: `promoteToTaxonomy` (`stories.js:428`) still emits it unquoted — cosmetic.
18. *The missing title block / H1 is a spec mismatch.* — The dashboard reference has no H1 (README:309; `scopeLine` at :701 is never used) and the README says the HTML wins; §6's "H1 color" line is a spec-internal inconsistency (open question 4).
19. *Momentum/trend/▲% ignoring the caucus filter violates §6.1.* — The reference's `momentum(t)` (README:557-563,637) is equally unscoped; tolerated under HTML-wins. The stale input documentation is folded into F2.
20. *Top stories placed with macro null: the report tells the operator to run promote (duplicate of 8).* — Same; the dashboard omitting `kind`/`macro`/`days` is spec-consistent (§2 lists only the suggested tag).

---

## 5. Open questions only a human can answer

1. **Unit of "members".** The spec says members, the brief says accounts, the dashboard counts accounts and the report counts people (F1). Which is it, and should Unity's denominator stay on accounts (the one place the spec says "active accounts")?
2. **Core messages.** Is "Corruption" meant to be the whole `democracy` macro, or should the taxonomy grow `epstein-files` / `gop-reconciliation-law` story subtopics (now possible through auto-promotion) as the spec and reference define (F14)? Same question for Affordability = all of `economy`.
3. **Momentum window.** CLAUDE.md commits to "rolling last 24h vs six prior full days"; the spec's acceleration is "slope of the last two days". Should every component (and the 7-day sparkline's last point) move to r24, or should acceleration use only full days (F2, F16)?
4. **Title block.** Keep the reference (no H1, no "· N accounts on X") and strike §6's "H1 color" line, or build §2's title block (F27, F39)?
5. **Feed cap.** Is a size cap acceptable at all, and if so per window/scope after filtering or with an explicit "newest N of M" (F3)?
6. **Incident definition and district.** Should the desk include recovery notices, advisories and condolences (audit precision 0.36), or only breaking emergencies the member is handling (F6)? Is the district suffix meant to be the incident's or the poster's (F22)? Should retweets of press/officials be timeline rows at all (F24)?
7. **Phrase origin.** Is "first use since tracking began (Aug 20)" acceptable if labelled, or should pre-window history be shown as unknown (F4)? Should the ledger keep every phrase over threshold rather than the daily top 25 (F5)?
8. **Emerging ranking.** Rank by 7-day activity (what is emerging now) or by 30-day story size (F20)? Should the card show `kind`/`macro`/`days`, which rollups already carry?
9. **Story-layer consistency.** `config/taxonomy.yaml` holds four `story: true` rows including a provisional `midway-blitz-anniversary` "promoted 2026-09-10", while `data/stories.json` (06:26Z) records `promoted: []` and no `promotions`. Was that promotion made by hand or by a branch whose `stories.json` was lost in the merge? Which artefact is authoritative until the first nightly regenerates both?
10. **Actions history.** Was `CLASSIFY_LIVE` off (or the credential missing) for the 05:29Z and 06:40Z polls, leaving 465 captured posts untagged until the nightly? Only the Actions logs can say (F17).
11. **Leadership roster.** Are the 13 persons tagged `leadership` in `config/accounts.csv` the intended set (refuted #16)?
12. **Engagement provenance.** Until a real 24h re-read has run, should engagement figures carry an explicit "capture-time" caption or be hidden (F11, F12)?
