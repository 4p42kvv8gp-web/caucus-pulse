# Roster coverage

Generated 2026-09-10 after adding the optional `status` column to
`config/accounts.csv`. The X List is the capture roster (whoever is on it
gets archived); `status` says which of those accounts the numbers should
describe. Only `house` counts. Everything else stays in the archive.

| status | meaning | on-List accounts |
|---|---|---|
| `house` (default; blank = house) | sitting House Democrat, official or personal/campaign handle | 426 |
| `senate` | current U.S. senator | 6 |
| `former` | deceased, resigned, or moved to another office | 14 |
| `org` | not a member's account at all | 1 |

447 on the List. `data/authors.json` also carries one off-List stray,
`@RepAguilar` (id 1280266810835730433, "Representative Josue Aguilar",
1 follower) — a leftover from an earlier CSV handle typo that resolved to
the wrong person. It has no CSV row, is never captured, and the next weekly
`npm run authors` marks it stale. Safe to delete from the author table.

## Non-House accounts on the List

Statuses were set from the archive text plus the public record (checked
2026-09-10). Posts = captured in the 7-day window 2026-09-04 → 2026-09-10.

| status | handle | who | why | window posts |
|---|---|---|---|---|
| senate | @SenAdamSchiff, @AdamSchiff | Adam Schiff | Senator (CA) since Dec 2024 | 5 + 0 |
| senate | @SenRubenGallego, @RubenGallego | Ruben Gallego | Senator (AZ) since Jan 2025 | 16 + 53 |
| senate | @SenatorAndyKim | Andy Kim | Senator (NJ) since Dec 2024 | 14 |
| senate | @SenatorSlotkin | Elissa Slotkin | Senator (MI) since Jan 2025 | 23 |
| former | @GerryConnolly, @ElectConnolly | Gerry Connolly | died May 21, 2025 (VA-11 → Walkinshaw) | 0 |
| former | @RepRaulGrijalva, @standwithraul | Raúl Grijalva | died Mar 13, 2025 (AZ-07 → Adelita Grijalva) | 0 |
| former | @repsturner, @SylvesterTurner | Sylvester Turner | died Mar 5, 2025 (TX-18 → Menefee) | 0 |
| former | @repdavidscott, @Electdavidscott | David Scott | died Apr 22, 2026 (GA-13 → Everton Blair, runoff Aug 25, 2026) | 0 |
| former | @RepSwalwell, @ericswalwell | Eric Swalwell | resigned Apr 14, 2026 | 1 + 0 |
| former | @CongresswomanSC | Sheila Cherfilus-McCormick | resigned Apr 21, 2026 | 0 |
| former | @GovSherrillNJ, @MikieSherrill | Mikie Sherrill | resigned Nov 2025; Governor of New Jersey | 20 + 0 |
| former | @JeffJacksonNC | Jeff Jackson | left the House Jan 2025; NC Attorney General | 2 |
| org | @KatieS | Katie Jacobs Stanton | not a member of Congress (tech investor); List curation stray | 8 |

Scott, Swalwell and Cherfilus-McCormick all left office in April 2026;
those three were checked against news coverage on 2026-09-10
(Ballotpedia/PBS/CNN for GA-13; NPR/CNN/CNBC for the two resignations)
rather than assumed. `docs/list-gaps.md` already listed every account in
this table as not a current House Democrat; this file makes that
machine-readable.

Uncertainty: `org` is a loose fit for @KatieS (a person, not an
organisation) — it is the non-member bucket. Consider dropping the account
from the List instead.

## House accounts with no caucus tag

29 on-List accounts (15 members) are `house` but carry no tracked-caucus tag. They
count in **All** and in every stat, topic, phrase and feed, but in no
caucus column. As of 2026-09-10 none of them appears on the New Democrat
Coalition member page (newdemocratcoalition.house.gov/members) or the
Congressional Progressive Caucus member page (progressives.house.gov/
caucus-members) — Steve Cohen left the CPC in 2024 — so the blank is
correct, not missing. CBC/CHC/CAPAC were not checked because none of the
fifteen is a plausible member. None holds a current leadership post (the
`leadership` tag covers the elected leadership team, not Speaker Emerita
Pelosi or former Leader Hoyer).

| member | district | handles | window posts |
|---|---|---|---|
| Betty McCollum | MN-04 | @BettyMcCollum04, @VoteBetty | 16 + 3 |
| Dina Titus | NV-01 | @repdinatitus, @dinatitus | 14 + 7 |
| Jared Golden | ME-02 | @RepGolden, @golden4congress | 2 + 0 |
| Jake Auchincloss | MA-04 | @RepAuchincloss, @JakeAuch | 1 + 4 |
| John Larson | CT-01 | @RepJohnLarson, @JohnLarsonCT | 8 + 0 |
| Kathy Castor | FL-14 | @USRepKCastor, @KathyCastorFL | 7 + 4 |
| Lois Frankel | FL-22 | @RepLoisFrankel, @LoisFrankel | 5 + 0 |
| Marcy Kaptur | OH-09 | @RepMarcyKaptur, @Marcy_Kaptur | 9 + 11 |
| Mike Thompson | CA-04 | @RepThompson, @Mike_CA05 | 17 + 21 |
| Richard Neal | MA-01 | @RepRichardNeal, @NealForCongress | 8 + 0 |
| Steve Cohen | TN-09 | @RepCohen | 2 |
| Stephen Lynch | MA-08 | @RepStephenLynch, @RepLynch | 2 + 0 |
| Steny Hoyer | MD-05 | @RepStenyHoyer, @StenyHoyer | 2 + 2 |
| Zoe Lofgren | CA-18 | @RepZoeLofgren, @ZoeLofgren | 8 + 0 |
| Nancy Pelosi | CA-11 | @SpeakerPelosi, @TeamPelosi | 3 + 5 |

Pelosi and Golden have announced they will not seek re-election; they stay
`house` until they leave office. Kaptur, Golden and Lynch are worth a
second look for Blue Dog / other coalitions if those are ever tracked.

Rows with an explicit `house` in the CSV have been reviewed; a blank status
means the row was tagged before the column existed and never needed it.

## What changed in the numbers

7-day window 2026-09-04 → 2026-09-10, rebuilt 2026-09-10 with
`node src/rollup.js && node src/sitedata.js`.

| | before | after |
|---|---|---|
| window posts counted (`stats.All.w.posts`) | 2,726 | 2,584 |
| posts from non-House accounts in the window | 142 counted (111 senate, 23 former, 8 org) | 142 excluded, reported as `excluded.posts` |
| today's posts from non-House accounts | 0 | 0 (`excluded.t`) |
| distinct members in the window (`stats.All.w.members`) | 338 | 329 |
| window engagement (`stats.All.w.eng`) | 739,754 | 687,901 |
| `accounts` (members map) | 448 | 427 (House only, incl. the off-List stray) |
| per-caucus posts / active counts (`caucusActive`) | unchanged | unchanged — the excluded accounts carried no caucus tag |
| topic counts (All) | e.g. economy 509, labor 399 | economy 473, labor 383 (each topic −0 to −36) |
| phrase families | "working people" 131 members | 121; "men and women" dropped out, "mental health" (26) entered |
| feed (200 newest) | 11 posts from @RubenGallego, @SenatorSlotkin, @SenatorAndyKim, @SenRubenGallego, @GovSherrillNJ, @KatieS | 0 |
| `data/rollups/topic-days.json` (21 classified days) | 3,317 rows, 11,381 post+RT in the `all` macro rows | 3,312 rows, 10,844; `excluded.posts: 555` |

`site/data/rollups.json` now carries `excluded: {accounts: 21, posts: 142,
t: 0}` so the dashboard can say "142 posts from 21 non-House accounts on
the List are not shown". Nothing reads it yet.

## Not changed

- The archive keeps every captured post; `poll` and `backfill` do not
  consult `status`.
- `data/incidents.json` (built by `src/incidents.js`, which calls Claude)
  still groups posts from any List account. `src/syntax.js` now filters,
  but the committed `data/syntax/*.json` and `data/phrases.json` were not
  rebuilt; `sitedata` ignores ledger adopters who are non-House, so the
  adoption curves are already clean.
- `src/backfill-members.js` iterates the whole author table; a follow-up
  could skip non-House accounts to save reads.
