# Taxonomy v2 — the story is the unit

`config/taxonomy.yaml` was rewritten on 2026-09-10 from three weeks of
classified data (2026-08-20..09-09: 10,482 archived posts, 12,168
assignments, 90% of them bare-macro), two evidence reads, three competing
proposals and a three-judge panel, and then reshaped by the owner's
directive that arrived after the proposals were written. This file records
what changed, why, and the v1 → v2 key mapping.

| | v1 | v2 |
|---|---|---|
| Macros | 15 | 19 (+ oversight, disasters, commemorations, infrastructure) |
| Subtopics in the prompt | 46 | 118 (+ 7 v1 keys kept as `retired: true` for history) |
| Developing stories (`story: true`) | 0 | 44 (21 confirmed, 23 provisional) |
| Aliases | 30 | 84 |
| Rendered taxonomy (`renderTaxonomy`) | 3,514 chars | 11,728 chars (budget 12,000) |
| Full system prompt | 5,346 chars | 13,887 chars |
| `node --test` | 93 pass | 93 pass |
| v1 keys deleted | – | 0 (7 retired in place, 39 live and unchanged) |

Validation used the repo's own loader: `node -e "import('./src/taxonomy.js')…"`
gives `19 macros 118 subtopics 11728 chars`; the file round-trips through
`stories.js promoteToTaxonomy` and `markRetired` (the nightly can still insert
and retire entries), `quietStories` retires nothing today, every `since` and
`promoted` is a quoted `YYYY-MM-DD`, there are no duplicate keys, and
`config/corrections.yaml` still validates against it.

## 1. The owner's directive (verbatim) and the story-first rule

> Congress and campaign politics means literally nothing to me, we need
> hyperfocused data, e.g. Liam Ramos or Jacob Coxon on the AI stuff; for the
> AI safety stuff the topic can be AI safety, subtopic Jacob Coxon.

Read with `CLAUDE.md` ("Product principle: the story is the unit"), the rule
the file is built around is:

1. **Macros are shelves for navigation only.** A count of "Democracy & rule
   of law" tells the Leader's office nothing; "Democracy → Epstein files:
   62 posts, 30 members, peak 13 on 9/3" does.
2. **The rows that matter are specific, named, dated developing stories**
   (`story: true`, `since: "YYYY-MM-DD"`, aliases the classifier will
   recognise). Every macro carries the stories the archive supports. A post
   about a named event is assigned the story, never left at the bare macro.
3. **Generic subtopics survive only where a durable subject has real volume
   and no story** (prices, housing, Medicaid, ICE enforcement…). Dead rows
   were retired, not kept for symmetry.
4. **Catch-all rows are forbidden.** "Congress & campaign politics",
   "political rhetoric", "party and caucus activity", "2026 midterms" are
   gone; what replaces them are named fights, votes and events (Speaker
   Johnson cancels September votes; the GOP midterm convention; the
   September CR vote; the stock-trading-ban discharge petition).
5. **Promotion is continuous and pruning is cheap.** Stories the nightly
   promotes, and every date-bound message event added here, carry
   `provisional: true` + `promoted:` so `stories --retire` drops them from the
   prompt once they go quiet (keys stay for history). The owner prunes; the
   owner does not approve one by one.

### The fields (header of the YAML explains them too)

| Field | Meaning |
|---|---|
| `label` | required; what the dashboard (`sitedata.js` copies it verbatim) and the classifier see. No rule text in labels. |
| `aliases` | nicknames, hashtags, misspellings the label cannot carry. Every alias is rendered into the prompt, so they were cut from 180 to 84 during sizing. |
| `story: true` | a developing story: named event, person, place, bill or vote. Sits beside its generic sibling and wins over it when both fit (prompt rule already in `systemPrompt`). |
| `since` | `"YYYY-MM-DD"`, quoted. The first day the archive shows caucus posts about the story, or the story's real start when it predates the archive (§4 lists the provenance of every date). |
| `provisional: true` | may be pruned without asking; `stories --retire` marks it `retired` after `settings.stories.retire_after_quiet_days` (21) with no assignments. Delete the flag to keep a story until you say otherwise. |
| `promoted` | the day a provisional row entered the file; the retirement clock starts here (all 23 provisional rows say `2026-09-10`). |
| `retired: true` | out of the prompt, key kept so rollups, history and `config/corrections.yaml` resolve. Used for quiet stories and for the seven v1 rows this revision replaced. |
| `anchors` | tweet ids a story is built around; quotes/replies/RTs of one are assigned the story before the model runs (`docs/QUOTED_CONTEXT.md`). Only `tech/coxon-resignation` has one today (`2097476196791709843`, the resignation post, 139M impressions), which closes the "pending anchor" note in `src/taxonomy.js`. |

### Routing rules (in the YAML header; mirror them in the prompt)

- A named event with a story row goes to that story wherever the row sits
  (Labor Day post → `labor/labor-day-2026`; Steinem tribute →
  `commemorations/gloria-steinem`). `commemorations/holidays-observances` and
  `/tributes` are only for observances and obituaries with no story row.
- District emergencies → `disasters`, never `climate`; a disaster alone is
  not climate policy (the Codex rule).
- Fairs, parades, visits, congratulations → `constituent-services`.
  Campaign-trail posts with no named fight get the bare macro or `[]`; there
  is deliberately no campaign row.
- `oversight` rows are additive: an ICE facility visit is
  `immigration/detention` AND `oversight/facility-visits`.
- Spanish-language posts are classified exactly like English ones
  (Hernández, Espaillat and Vasquez posts fell out at a higher rate).

## 2. What changed vs v1, and why

**Why v1 failed the product.** 10,908 of 12,168 assignments (89.6%) were
bare macro; 1,836 posts (17.5%) were `[]`; not one `story: true` row existed
and `data/stories.json` had promoted nothing. The two largest single-day
caucus events were handled in opposite ways (Dolly Parton 85 posts/74
members → 80 empty; Gloria Steinem 71/67 → all `civil-rights/None`, tripling
that macro for a day). The window's biggest democracy stories (vote-by-mail
163 posts, Epstein 62, Lake America 39-53) were invisible below the macro.
Labor Day (328 posts, 238 members) inflated `labor` 20x. 111 disaster-only
posts sat in `climate`. `congress-politics` was a dumping ground (722
originals had it as their only topic; 134 were fairs and parades).
`constituent-services` had no subtopics at all.

**What v2 does about it, macro by macro.**

| Macro | v2 rows (stories in bold) | Evidence |
|---|---|---|
| immigration | **dilley-detention** (Liam Ramos / Dilley), **pierre-damas-bel**, **el-salvador-tps**, **midway-blitz-anniversary**; ice-enforcement, detention, tps-status, citizenship | Dilley/Liam 21 posts/11 members; Pierre Damas Bel 25/21 in 4 days; El Salvador TPS 26/16 with 19 on 9/9 (the live story); TPS overall 55/33; birthright 14/11; Midway Blitz anniversary 11/6 |
| economy | **canada-trade-war**, **trump-dividend**; prices-inflation, tariffs-trade, housing, jobs-wages, taxes, agriculture-farmers, child-care, small-business, consumer-protection | Canada 190/91 over 18 days (50% tariffs 8/22, retaliation 9/8); farm posts 178-228/86-105 (118 dumped as economy/None); child care 58-80/41-50; small business 114/76; scams 48/40 + prediction markets 17/12 |
| healthcare | **vaccine-schedule**, **suicide-prevention-988**; medicaid, medicare, aca, drug-prices, public-health, mental-health | vaccines/measles 39/29; 988 + Suicide Prevention Month 70/55 (31 on 9/8); mental health 114/78; Medicare 66/35; ACA 29/24; drug prices 23/19 |
| reproductive-rights | abortion-access, ivf-contraception | abortion 45/39; IVF/maternal 7/7 — no named event besides the Steinem tribute, which is a commemoration |
| democracy | **mail-voting**, **john-lewis-vra**, **stock-trading-ban**, **white-house-ballroom**, **epstein-files**, **lake-america-renaming**, **new-mexico-renaming**, **trump-arch-monument**, **kennedy-center**, **smithsonian-history**, **national-archives-sanbruno**; voting-rights, courts-doj, executive-overreach, corruption-ethics, press-speech | vote-by-mail 163/98 (SCOTUS 8/24-25, USPS whistleblower 9/1: 42); Epstein 62/30; ballroom 33/26; stock ban 28-66/21-49; Lake America 39-53/26-38; Kennedy Center 19/14; Bunch/Smithsonian 23/20; VRA anniversary 24/22; Arch 9/8; New Mexico 19/5; San Bruno 6/2 |
| oversight (new) | facility-visits, investigations, watchdogs | 162 posts/92 members scattered as bare democracy (94), immigration (46), congress-politics (13); Codex has an Oversight macro |
| public-safety | **minneapolis-shooting**, **amy-acton-attack**; gun-violence, crime-policing, political-violence | Minneapolis 9/2 shooting 7-11 posts/9 members; Acton 10/9 on 9/6; 41% of v1 public-safety posts were generic "safety" |
| disasters (new) | wildfires, storms-flooding, fema-recovery | 219 disaster posts/106 members; 111 climate posts were disaster-only; `climate/disasters` fired 30 times while 58 incident posts sat in bare climate. No multi-member named disaster in the window (Timber/Plaskett Fire is one member, 21 posts) — the incident layer is the story unit here |
| labor | **labor-day-2026**; unions, federal-workforce, workplace-rights | Labor Day 328/238 (261 on 9/7, 104 greeting-only); "working people" 65 posts on 9/7; OSHA/overtime/paid leave 23/20 |
| climate | **nps-110th-birthday**; clean-energy, epa-rollbacks, public-lands, animal-welfare | National Park Week + NPS birthday 40/31 (17 on 8/25); public lands 56/43; animal welfare 24/22 |
| education | public-schools, higher-ed | no named event in the window; Head Start (27/19) lives under economy/child-care |
| civil-rights | **march-on-washington**, **jeffries-racist-attack**, **womens-equality-day**, **hasan-piker**, **latino-museum**; racial-justice, lgbtq, disability, antisemitism, tribal-affairs | March on Washington 59/52 in one day; Jeffries "monkey/errand boy" 22/18; Hasan Piker 30/13; Women's Equality Day 9-24; antisemitism 42/30; disability 29/25; tribal 19/14 |
| foreign-policy | **iran-war**, **venezuela**, **uss-abraham-lincoln**, **nepal-floods**; hegseth-pentagon, middle-east, ukraine-russia, china, military-veterans | Iran 380/154 (344 bare); Venezuela 44/24; USS Lincoln 23-37/17-25; Nepal floods 39/28; Hegseth 121/52; veterans 109/74; China 30/24 |
| budget-appropriations | **september-cr**, **obbba**, **snap-anniversary**; shutdown, social-security, snap-benefits, spending-debt | CR through Dec. 11: 20/19 on 9/1-2; OBBBA 61-70/46-50; SNAP 62nd anniversary 27/27 on 8/31; national debt 48/38 |
| tech | **coxon-resignation** (anchored), **data-centers**; ai-safety, big-tech, surveillance-privacy, space-science-research | Coxon/Hubinger 13 posts on 9/9 (34 core posts by the narrative layer's read); data centers 86/49 split three ways in v1; Flock 17/7; NASA/NSF 31/21 |
| congress-politics (relabelled "Congress: votes, procedure & party events") | **sept-votes-cancelled**, **gop-midterm-convention**, **generational-politics**; house-floor | cancelled votes 10-13/9-11; convention 21/17 (counter-programming 9/4, "Trumpalooza" 9/9); Gen Z 11/3 |
| constituent-services | town-halls, district-events, casework-resources, local-funding, community-recognition | 624 v1 assignments, 100% bare; 306 district-event posts/150 members; town halls 127 |
| commemorations (new) | **dolly-parton-tribute**, **gloria-steinem**, **sept-11-anniversary**; holidays-observances, tributes | Dolly 85/74; Steinem 71/67; 9/11 45-57/26-34 through 9/9 (anniversary is 9/11); ~55 local-obituary empties |
| infrastructure (new) | **gateway-tunnel**; transit-rail, roads-broadband, transportation-safety, utilities-water | transit/rail 58/44 (28 of 47 empty in v1); Gateway 11/7; FAA/aviation 16/10; trucking 36/28; Puerto Rico water/power 15/3 |

Macros with no story row today — oversight, disasters, reproductive-rights,
education, constituent-services — have none because the archive shows no
named multi-member event there in the window; the nightly promotion will add
one the night the evidence appears.

## 3. New macros, subtopics and stories

**New macros (4):** `oversight`, `disasters`, `commemorations`,
`infrastructure`.

**New generic subtopics (28):** immigration/detention, tps-status,
citizenship · economy/agriculture-farmers, child-care, small-business,
consumer-protection · healthcare/mental-health · oversight/facility-visits,
investigations, watchdogs · public-safety/political-violence ·
disasters/wildfires, storms-flooding, fema-recovery · labor/workplace-rights
· climate/public-lands, animal-welfare · civil-rights/antisemitism,
tribal-affairs · foreign-policy/hegseth-pentagon ·
budget-appropriations/spending-debt · tech/ai-safety, surveillance-privacy,
space-science-research · constituent-services/town-halls, district-events,
casework-resources, local-funding, community-recognition ·
commemorations/holidays-observances, tributes · infrastructure/transit-rail,
roads-broadband, transportation-safety, utilities-water.

Keys were chosen to match `data/stories.json` placement keys wherever one
exists (agriculture-farmers, child-care, small-business, mental-health,
data-centers, public-lands, tribal-affairs, surveillance-privacy,
space-science-research, consumer-protection, transportation-safety,
animal-welfare, antisemitism, and every story below that came from a
candidate) so `sitedata.js` maps emerging clusters onto existing rows and a
later `--promote` does not create a duplicate.

## 4. Stories (44) with `since` dates and provenance

Counts are archive keyword sweeps over 2026-08-20..09-09 (posts / members /
peak day). "firstSeen" is the `data/stories.json` candidate's first day where
one exists. Status: **C** confirmed (only the owner removes it), **P**
provisional (auto-retires after 21 quiet days; `promoted: 2026-09-10`).

| Story | since | Provenance | Archive | Status |
|---|---|---|---|---|
| immigration/dilley-detention — Liam Ramos / Dilley child detention (Liam Tadeo) | 2026-08-20 | owner directive; Dilley posts from window start, Liam Ramos named 8/22 | 21 / 11 / 8-27 | C |
| immigration/pierre-damas-bel | 2026-09-01 | archive | 25 / 21 / 9-03 | C |
| immigration/el-salvador-tps | 2026-09-02 | archive; deadline day 9/9 (19 posts) | 26 / 16 / 9-09 | C |
| immigration/midway-blitz-anniversary | 2026-09-08 | anniversary day | 11 / 6 / 9-08 | P |
| economy/canada-trade-war | 2026-08-22 | archive: 50% tariffs announced 8/22 | 190 / 91 / 8-25 | C |
| economy/trump-dividend — $5,000 "Trump Dividend" | 2026-09-09 | owner directive; archive | 3 / 3 / 9-09 | P |
| healthcare/vaccine-schedule — RFK Jr. vaccine schedule & measles | 2026-08-21 | archive (8/20 posts are Immunization Awareness Month greetings) | 39 / 29 / 8-25 | C |
| healthcare/suicide-prevention-988 — 988 Day & Suicide Prevention Month | 2026-09-01 | month start; 988 Day 9/8 | 70 / 55 / 9-08 | P |
| democracy/mail-voting — vote-by-mail crackdown | 2026-08-24 | SCOTUS order day; USPS whistleblower 9/1 inside it | 163 / 98 / 9-01 | C |
| democracy/john-lewis-vra — 5th-anniversary message | 2026-08-24 | anniversary day | 24 / 22 / 8-24 | P |
| democracy/stock-trading-ban | 2026-08-21 | archive (committee vote, White House opposition) | 28-66 / 21-49 / 9-01 | C |
| democracy/white-house-ballroom | 2026-08-21 | SCOTUS ruling day | 33 / 26 / 8-31 | C |
| democracy/epstein-files | 2026-08-20 | predates the window (present from day 1); firstSeen 8/31 only reflects the leftovers the classifier emptied | 62 / 30 / 9-03 | C |
| democracy/lake-america-renaming | 2026-08-25 | = firstSeen; merges the place-renaming (8/28) and lake-renaming-stunt candidates | 39-53 / 26-38 / 8-27 | C |
| democracy/new-mexico-renaming | 2026-09-06 | = firstSeen (state-renaming candidate, 3 posts / 2 members) | 19 / 5 / 9-06 | P |
| democracy/trump-arch-monument — "Arch de Trump" | 2026-09-03 | = firstSeen | 9 / 8 / 9-04 | P |
| democracy/kennedy-center | 2026-08-25 | archive | 19 / 14 / 8-27 | C |
| democracy/smithsonian-history — Lonnie Bunch resignation | 2026-09-08 | archive (firstSeen 9/9 was the tail) | 23 / 20 / 9-09 | C |
| democracy/national-archives-sanbruno | 2026-08-20 | = firstSeen (historical-records candidate; first explicit San Bruno post 8/24) | 6 / 2 / 8-27 | P |
| public-safety/minneapolis-shooting | 2026-09-02 | shooting day | 7-11 / 9 / 9-02 | P |
| public-safety/amy-acton-attack | 2026-09-06 | = firstSeen; attack day | 10 / 9 / 9-06 | P |
| labor/labor-day-2026 — "working people" message | 2026-09-04 | ramp begins 9/4 (14 posts); 261 on 9/7 | 328 / 238 / 9-07 | P |
| climate/nps-110th-birthday — Park Week & NPS birthday | 2026-08-22 | National Park Week start; fee-free day 8/25 | 40 / 31 / 8-25 | P |
| civil-rights/march-on-washington — 63rd-anniversary message | 2026-08-28 | anniversary day | 59 / 52 / 8-28 | P |
| civil-rights/jeffries-racist-attack | 2026-09-04 | archive | 22 / 18 / 9-05 | C |
| civil-rights/womens-equality-day | 2026-08-26 | observance day | 9-24 / 9-24 / 8-26 | P |
| civil-rights/hasan-piker | 2026-08-23 | archive | 30 / 13 / 8-25 | C |
| civil-rights/latino-museum | 2026-09-01 | = firstSeen (placement macro civil-rights; 4 posts / 1 member in the candidate) | 9 / 6 / 9-01 | P |
| foreign-policy/iran-war | 2026-02-28 | inferred from the posts ("since late-February", "six months" wave 8/25-28, Port Shuaiba strike March 1); predates the window | 380 / 154 / 8-28 | C |
| foreign-policy/venezuela — boat strikes & oil deal | 2026-08-24 | archive; one-year anniversary of the strikes 9/2 | 44 / 24 / 9-03 | C |
| foreign-policy/uss-abraham-lincoln | 2026-08-20 | predates the window (6 posts on day 1) | 23 / 17 / 8-20 | C |
| foreign-policy/nepal-floods | 2026-08-26 | archive | 39 / 28 / 8-27 | P |
| budget-appropriations/september-cr — funding through Dec. 11 | 2026-09-01 | vote day | 20 / 19 / 9-01 | P |
| budget-appropriations/obbba | 2025-07-04 | signing date (general knowledge, not the corpus); every "Big Ugly Law" post refers back to it | 61 / 46 / 8-31 | C |
| budget-appropriations/snap-anniversary — Food Stamp Act 62nd | 2026-08-31 | anniversary day | 27 / 27 / 8-31 | P |
| tech/coxon-resignation — Jacob Coxon resignation (Anthropic) | 2026-09-08 | owner directive; the resignation post is 2026-09-09T00:04Z = Mon 9/8 20:04 ET; anchored | 13 core on 9/9 (34 by the narrative read) | C |
| tech/data-centers — the data-center fight | 2026-08-20 | durable fight across all 20 days; promoted to a story on the owner's instruction | 86 / 49 / 9-02 | C |
| congress-politics/sept-votes-cancelled | 2026-09-03 | archive | 10-13 / 9-11 / 9-03 | P |
| congress-politics/gop-midterm-convention — "Trumpalooza", "communist caucus" | 2026-09-04 | Jeffries announces counter-programming 9/4; convention 9/9 | 21 / 17 / 9-09 | C |
| congress-politics/generational-politics | 2026-08-30 | = firstSeen (placement macro congress-politics; 3 posts / 1 member in the candidate) | 11 / 3 / 8-30 | P |
| commemorations/dolly-parton-tribute | 2026-08-25 | archive; the candidate's firstSeen 8/21 is a merge artifact of the celebrity-tribute cluster (she died 8/25) | 85 / 74 / 8-25 | P |
| commemorations/gloria-steinem | 2026-09-03 | archive | 71 / 67 / 9-03 | P |
| commemorations/sept-11-anniversary | 2026-08-27 | archive (firstSeen 9/2); the anniversary itself is 9/11, so the spike is still to come | 45-57 / 26-34 / 9-09 | P |
| infrastructure/gateway-tunnel | 2026-08-26 | archive | 11 / 7 / 9-04 | P |

The `since` policy: the first day the archive shows caucus posts about the
story, or the earlier of that and the candidate's firstSeen when the
candidate's early posts are the same story; the real start when the story
predates the archive (Iran war, OBBBA, Epstein, USS Lincoln); the owner's
date where the owner gave one (Coxon, Dilley). Two candidate dates were
overridden and say so above (Dolly 8/21 → 8/25; Smithsonian 9/9 → 9/8).

`data/stories.json` story-kind candidates with ≥ 3 posts, and where each
went: celebrity-tribute + notable-deaths-tributes → dolly-parton-tribute;
9-11-remembrance → sept-11-anniversary; lake-renaming-stunt + place-renaming
→ lake-america-renaming; epstein-files + epstein-investigation →
epstein-files; trump-arch-monument-project → trump-arch-monument;
political-violence → amy-acton-attack; historical-records-archives →
national-archives-sanbruno; national-museum-of-the-american-latino →
latino-museum; smithsonian-history-erasure → smithsonian-history;
state-renaming → new-mexico-renaming; generational-politics →
generational-politics. The one exception: **ted-cruz-pressler-allegations**
(3 posts, 1 member, 1 day, placement macro `null`) has no placed macro to sit
under and is a single member's thread; it stays a candidate.
aviation-aerospace-innovation (2 posts) is below the 3-post bar.

## 5. Renamed, moved and retired keys (old → new)

No v1 key was deleted. Rows that did not survive were kept in the YAML with
`retired: true` so their historical assignments (235 in all) still resolve
to a label on the dashboard and in rollups, and `config/corrections.yaml`
still validates. For comparisons across the v1/v2 boundary, read the old key
as its successor:

| v1 key | v1 assignments | v2 successor | Note |
|---|---|---|---|
| congress-politics/elections-2026 | 104 | *(none — retired)* | "2026 midterms" is the catch-all the owner named. Campaign posts now land on the bare macro, on a named story (gop-midterm-convention, trump-dividend, amy-acton-attack) or `[]`. |
| congress-politics/town-halls | 70 | constituent-services/town-halls | moved; district events split off to constituent-services/district-events |
| climate/disasters | 30 | disasters/wildfires · storms-flooding · fema-recovery (by kind) | new macro; a disaster is not climate policy |
| tech/ai-policy | 23 | tech/ai-safety | the owner's "AI safety" subtopic; coxon-resignation sits beside it |
| immigration/asylum-refugees | 6 | immigration/tps-status (status cases) or bare immigration | dead row (6 hits in 21 days) |
| immigration/border-policy | 2 | bare immigration | dead row (2 hits) |
| immigration/dreamers-daca | 0 | immigration/citizenship | never fired; birthright + DACA now one row |

**Key kept, relabelled (28)** — the id and history are unchanged, only the
label sharpened: dilley-detention ("Dilley detention facility" → "Liam Ramos
/ Dilley child detention (Liam Tadeo)", now a story), ice-enforcement,
prices-inflation, jobs-wages, taxes, medicaid, aca, public-health,
ivf-contraception, voting-rights, courts-doj, executive-overreach,
corruption-ethics, press-speech, gun-violence, crime-policing, unions,
federal-workforce (absorbs USPS service complaints), clean-energy,
epa-rollbacks, public-schools, middle-east (loses the "Iran" alias to
iran-war), china, military-veterans, shutdown, snap-benefits, big-tech,
house-floor.

**Macro labels changed (5), keys unchanged:** climate → "Climate, energy &
environment"; foreign-policy → "Foreign policy & defense";
budget-appropriations → "Budget, appropriations & safety net"; tech →
"Technology, AI & science"; congress-politics → "Congress: votes, procedure
& party events".

`config/corrections.yaml` entry #1 (`[[immigration, dilley-detention],
[immigration, ice-enforcement]]`) and entries #2-3 (public-safety/gun-violence,
budget-appropriations/shutdown, immigration/ice-enforcement) resolve
unchanged; `test/corrections.test.js` passes against the new file.

## 6. Deliberately not added

- **A culture macro** (P2's "Arts, culture & history"): three judges liked
  it, but the owner's directive puts every stories.json story under its
  placed macro (democracy for Smithsonian, San Bruno, Lake America, Arch;
  civil-rights for the Latino Museum), and the readers filed Kennedy Center
  and Bunch as history-erasure/executive-overreach, so the culture stories
  sit under democracy. A generic "arts & museums" row was dropped: without
  the named stories it is 13 posts.
- **Rhetoric / party-caucus / campaign rows** — forbidden by the directive.
- **Christian nationalism** (23 posts, one member), **hemp**, **youth
  sports**, **foster care**, **semiconductors**, **patents**, **Ted
  Cruz/Pressler** (one member) — single-member or sub-threshold.
- **labor/postal-service** (7 posts/6 members): folded into
  federal-workforce as "USPS service".
- **A generic women's-rights row**: outside the Women's Equality Day wave
  (a story) and the Steinem tribute (commemorations) it is ~10 posts.
- **border-asylum** as a merged generic: border + asylum + refugees drew 8
  assignments in 21 days; the bare macro is the honest home.
- **Timber/Plaskett Fire, Hurricane Lala/Lowell** as disaster stories:
  one member each; the incident desk (`data/incidents.json`) is the story
  unit for district emergencies.
- **Amy Acton, cancelled September votes, USS Lincoln as aliases only**
  (P2/P3's threshold discipline): under the owner's directive a named
  event is a row, so they are stories — the small ones provisional.

## 7. The judges' scores and what was fixed

Three judges scored the proposals on coverage / usability / continuity /
prompt cost (10 each):

| | Judge 1 | Judge 2 | Judge 3 | Total |
|---|---|---|---|---|
| Proposal 1 (Leader's-staffer rows) | 30 (9/8/6/7) | 30 (9/8/6/7) | 31 (9/9/6/7) | **91** — winner |
| Proposal 2 (minimise empties) | 27 (7/8/5/7) | 28 (7/7/7/7) | 26 (7/7/5/7) | 81 |
| Proposal 3 (continuity-first) | 28 (7/6/9/6) | 29 (7/7/9/6) | 28 (7/6/9/6) | 85 |

v2 starts from Proposal 1 and closes every problem the judges listed:

| Judges' problem with P1 | v2 |
|---|---|
| Renaming dilley-detention → dilley-liam breaks corrections.yaml entry #1 and `npm test` | key kept, relabelled; tests pass |
| 8 keys removed, 115 assignments orphaned | 0 keys deleted; 7 retired in place with the mapping above (235 assignments keep their labels) |
| iran-war / obbba `since` = corpus start | 2026-02-28 (inferred from the posts) and 2025-07-04 (signing) |
| sept-votes story on ~10 posts | kept as a story (owner: named events are rows) but provisional; it is above `settings.stories` thresholds (5/3/2) and auto-retires |
| Kennedy Center / Smithsonian under an 11-row democracy shelf | stays under democracy (the placed macro the directive requires); rationale in §6 |
| economy/data-centers diverges from the tech placement; three utility-cost homes | tech/data-centers (story); infrastructure/utilities-water is the only other utility row; clean-energy no longer mentions bills |
| "Christian nationalism" alias under antisemitism; "988 Day" alias under holidays | both removed; 988 Day is a healthcare story |
| oversight/letters-demands is a form-of-action bucket | replaced by P3's watchdogs (inspectors general & whistleblowers) |
| animal welfare only an alias under public lands | climate/animal-welfare row |
| keys diverge from stories.json placements | aligned (agriculture-farmers, lake-america-renaming, sept-11-anniversary, surveillance-privacy, space-science-research, dolly-parton-tribute, …) |
| "war powers" alias on iran-war bleeds into Venezuela | dropped; Venezuela label carries the oil deal (P2's framing) |
| no spending/impoundment row | budget-appropriations/spending-debt (P2) |
| "(greeting-only)" rule text in a dashboard label | removed; rules live in the header and the prompt |
| Hegseth and veterans in one row | hegseth-pentagon + military-veterans (key kept) (P2's split, P3's continuity) |
| sixteen stories need pruning discipline | every date-bound story is provisional with `promoted:`; `stories --retire` prunes after 21 quiet days |
| P2/P3 ideas worth grafting | postal-service folded (not a row), maternal health in ivf-contraception's label, "Department of War"/"SAVE Act"/"KOSA" aliases, watchdogs, spending-debt, Venezuela oil-deal label, real since dates |

## 8. Companion changes this file cannot make

1. **`validAssignments` prefix normalisation** (`src/taxonomy.js`): the
   prompt asks for `"macro/sub"` and the validator only accepts a bare sub
   id, so a model answer of `["economy", "economy/prices-inflation"]` is
   nulled to the bare macro — the second reader's explanation for the 178 of
   231 request windows with zero subtopics. Strip the `macro/` prefix and
   match labels/aliases before re-classifying, or the 118 rows here will be
   nulled exactly like the 46 before them.
2. **Prompt rules** to add beside the taxonomy: the five routing rules in
   the YAML header, plus "incident posts also carry `disasters/<kind>`
   rather than topics `[]`" so the topic view shows emergencies.
3. **Re-classify 2026-08-20..09-09** (`npm run classify-range`, spends
   money) — the story layer only exists once the window is reclassified;
   corrections re-apply automatically.
4. **Nightly promotion/retirement** now has rows to work with:
   `stories --auto-promote` inserts under any of the 19 macros;
   `--retire` will start pruning the 23 provisional rows from 2026-10-01.
   The report's "Provisional stories awaiting review" section is the owner's
   pruning list.
