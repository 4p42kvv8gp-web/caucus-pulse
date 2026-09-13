# What Caucus Pulse costs to run

Measured, not estimated. X reads come from the `usage` ledger in
`data/state.json` (every poll, refresh and backfill adds its reads; $0.005
per post read, $0.01 per user read). Claude spend comes from
`data/anthropic-usage.json` (`src/anthropic-usage.js`: every call's token
usage by ET day, stage and model, priced at list rate — cache reads ×0.1,
cache writes ×1.25, batch ×0.5). Written 2026-09-13 15:10Z with three
closed days of data. Three days is not a trend.

## By day (ET)

| day | what ran | posts archived | X reads | X cost | Claude calls | Claude cost |
|---|---|---|---|---|---|---|
| 2026-09-10 Thu | three-week backfill + 447-member author table + first polls | 741 | 16,883 posts + 4,242 users | **$126.84** | 0 (no credit) | $0.00 |
| 2026-09-11 Fri | steady polling, 24h engagement refresh, quoted-context reads; credit restored 20:15Z | 777 | 2,508 posts + 1,600 users | **$28.54** | 24 | **$2.96** (classify 09-10 via `--sync` $2.34; live tagging $0.62) |
| 2026-09-12 Sat | first full nightly with credit; polls every 2–5 h | 325 | 1,642 posts + 730 users | **$15.51** | 33 | **$2.44** (classify 09-11 batch, 775 posts, $1.17; live tagging $1.21; stories $0.07) |
| 2026-09-13 Sun (to 15:00Z) | nightly + polls | 14 so far | 671 posts + 290 users | $6.25 | 11 | $0.73 |

09-10 is not representative: it carries the one-time backfill and the
author-table build. 09-11 is the only full weekday with steady-state polling
and no backfill; the weekend days are lighter on both sides.

## What the numbers say

- **X is the bill.** The one clean weekday cost $28.54 in reads against $2.96
  of Claude. User reads are the surprising half: 1,600 user reads were $16.00
  of that day's $28.54. Whatever reads user objects (author refresh,
  quoted-post author lookups) is the first thing to look at if the bill
  needs to come down.
- **Classification is cheap.** One day of 631–775 posts costs $1.17 as a batch
  or $2.34 synchronously. Live tagging runs about $0.08–0.10 per poll (four
  prompt-cached calls); at the cron's actual delivery rate that is
  $0.60–1.20 a day.
- **Discovery is still unmeasured.** The nightly's stories placement,
  taxonomy-learn (up to 40 calls at 32k/16k max_tokens) and incident intel
  were attempted on 09-12 and 09-13 and every call failed with a federation
  401 (a second process re-used an identity token the first had already
  exchanged — fixed in `src/anthropic-auth.js`, and failed calls now show in
  the ledger and fail `npm run health`). So the ledger's "stories $0.07" is
  one call; the real nightly discovery cost lands on the first night the fix
  runs. Until then the honest number for a full night is unknown, bounded by
  the $40/day cap.

## Guards

- X: `daily_read_budget` 50,000 reads ≈ $250/day, stops capture for the day.
  Ten times the observed weekday; worth lowering to ~3× once a week of data
  exists.
- Claude: `anthropic.daily_budget_usd` 40 in `config/settings.json` — at the
  cap every Claude stage skips and `anthropicClient()` refuses. Observed
  daily spend is under $3.

## A month, roughly

Taking 09-11 as a weekday and 09-12 as a weekend day, X reads run about
22 × $28.50 + 8 × $15.50 ≈ **$750/month**, plus whatever the missing nightly
refresh reads add on busier news days. Claude, without discovery, is about
$3/day ≈ **$90/month**; discovery adds an amount the first working nightly
will show. Neither figure includes GitHub Actions minutes (free tier so far)
or the embedding model (runs locally, no API).

The projection is one weekday and one weekend day extrapolated. Revisit after
2026-09-18 with a full week.
