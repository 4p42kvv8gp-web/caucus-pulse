# Caucus Pulse

A permanent, growing corpus of everything a curated X List of House Democratic
caucus accounts posts — plus a nightly pipeline that turns it into topic
rollups, "strategic syntax" phrase tracking, and a daily report. Full product
rationale: [`docs/caucus-pulse-brief.md`](../docs/caucus-pulse-brief.md) in the
X-Decibel-Reader repo where this scaffold was drafted.

The repo itself is the datastore: tweets land in append-only
`data/archive/YYYY-MM-DD.jsonl` files committed by GitHub Actions, everything
downstream (metrics, topics, rollups, reports) is derived and rebuildable.
Zero servers, zero hosting cost.

## One-time setup (≈15 minutes)

This directory is designed to be lifted verbatim into its own repository:

1. **Create the new repo** (e.g. `caucus-pulse`) and copy the *contents* of
   this `caucus-pulse/` directory to its root, so `.github/workflows/` sits at
   the top level (GitHub only runs workflows from there — inside
   X-Decibel-Reader they are intentionally inert).
2. **Repo → Settings → Secrets and variables → Actions:**
   - Secret `X_BEARER_TOKEN` — the same token X-Decibel-Reader uses.
   - Secret `ANTHROPIC_API_KEY` — for the nightly classifier.
   - Variable `X_LIST_ID` — the numeric id of your X List (from its URL:
     `x.com/i/lists/<this number>`). Alternatively hardcode it in
     `config/settings.json` as `list_id`.
   - Variable `X_DAILY_READ_BUDGET` (optional) — hard daily ceiling on billed
     X reads. Default 8000 (≈$40/day worst case; a 2,000-tweet day uses ~3,300).
3. **Fill in `config/accounts.csv`** with every account on the List: handle,
   member name, official/personal/campaign, caucus tags separated by `|`
   (`progressive`, `newdem`, `cbc`, `leadership` — overlap is normal and
   expected), state/district. The checked-in rows are a hand-drafted starter —
   verify them; caucus tags drive the per-caucus report.
4. **Settings → Actions → General:** allow Actions "Read and write
   permissions" (the workflows commit data back to the repo).
5. Run the **authors** workflow once by hand (Actions tab → authors → Run
   workflow) to build the author table, then the **poll** workflow once to
   verify capture. After that the crons take over: poll every 20 min,
   nightly pipeline at 07:30 UTC, authors weekly.
6. Optional dashboard: Settings → Pages → deploy from branch `main`, then
   open `/site/` on the Pages URL. It reads the committed rollups directly.

## First act: the 24-hour volume measurement

Everything in the cost model is an estimate until measured against *your*
list. After the poller has run for a day or two:

```bash
npm run volume
```

prints tweets/day, the original-vs-retweet mix, actual X reads spent, and a
projected monthly cost — that's the number to budget from. History note: this
API tier only reaches back ~7 days, so the corpus starts when the poller
starts. Every day before that is gone; turn it on early.

## How the pieces fit

| Stage (script) | Schedule | What it does | X / Claude cost |
|---|---|---|---|
| `src/poll.js` | every 20 min | List timeline → `data/archive/*.jsonl`, cursor + dedupe | $0.005/tweet — the floor |
| `src/authors.js` | weekly | `config/accounts.csv` → `data/authors.json` (no expansions ever) | $0.01/account/week |
| `src/refresh.js` | nightly | 24h-old originals get one batched metrics re-read → `data/metrics/` | $0.005/original |
| `src/classify.js` | nightly | Claude Batch API + `config/taxonomy.yaml` → `data/topics/` and emerging clusters | ~50% batch rates |
| `src/syntax.js` | nightly | 2–4-word n-grams by distinct-member spread → `data/syntax/`, `data/phrases.json` | free |
| `src/rollup.js` | nightly | topic × day × caucus aggregates → `data/rollups/` | free |
| `src/report.js` | nightly | `reports/YYYY-MM-DD.md` + `reports/latest.md` | free |

The poller's cursor logic self-detects whether the list endpoint honors
`since_id` (X's docs are ambiguous). If it doesn't, the poller falls back to
boundary-stop pagination with an adaptive page size — slightly above the
per-tweet floor (one partial page of re-reads per non-empty poll), still far
cheaper than search or per-account polling, and the archive stays exact
either way thanks to local dedupe.

## The taxonomy is the intelligence

`config/taxonomy.yaml` — two levels, multi-label. A Dilley tweet counts
toward *Dilley detention facility* and *Immigration*; reports nest subtopics
under macros so nothing double-reads. The nightly classifier surfaces tweets
that fit nothing as **emerging clusters** in the daily report with a
suggested label; approve one by adding it to the YAML. The system never
invents categories silently.

## Local development

```bash
npm install
npm test                # pure-logic tests, no network
X_BEARER_TOKEN=... X_LIST_ID=... npm run poll
npm run report -- --date=2026-09-01
```

State (`data/state.json`) tracks the capture cursor, in-flight Claude
batches, and a per-day X read ledger the budget guard enforces. Nothing else
is stateful; delete any derived file and the nightly rebuild recreates it
from the archive.
