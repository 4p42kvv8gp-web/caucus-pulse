# Caucus Pulse

A permanent, growing corpus of everything a curated X List of House Democratic
caucus accounts posts — plus a nightly pipeline that turns it into topic
rollups, "strategic syntax" phrase tracking, and a daily report. Full product
rationale: `docs/caucus-pulse-brief.md` in the
[X-Decibel-Reader](https://github.com/4p42kvv8gp-web/X-Decibel-Reader) repo,
where this project was first drafted as a subdirectory.

The repo itself is the datastore: tweets land in append-only
`data/archive/YYYY-MM-DD.jsonl` files committed by GitHub Actions, everything
downstream (metrics, topics, rollups, reports) is derived and rebuildable.
Zero servers, zero hosting cost.

## Setup

Everything runs from this repo's GitHub Actions; nothing is hosted. The
scheduled workflows only run from `main` (`poll` every 20 min, `nightly` at
07:30 UTC, `authors` weekly).

1. **Repo → Settings → Secrets and variables → Actions:**
   - Secret `X_BEARER_TOKEN` — X API v2 bearer token (pay-per-use project).
   - Variable `X_LIST_ID` — the numeric id of the X List (from its URL:
     `x.com/i/lists/<this number>`). Alternatively set `list_id` in
     `config/settings.json`.
   - Daily X read ceiling: `config/settings.json` → `daily_read_budget`
     (50,000 as of 2026-09-10; $0.005 per post read). Git-controlled so it can
     be changed in a PR. `X_DAILY_READ_BUDGET` in the environment overrides it
     for a one-off local run; the old repo variable of that name is no longer read.
   - Variable `CLASSIFY_LIVE` — `false` to skip poll-time tagging until the
     pipeline is trusted; `true` (or unset) to tag each poll's new posts.
2. **Claude access needs no secret.** Workflows authenticate to the Anthropic
   API with [workload identity federation](https://docs.anthropic.com): the
   job's GitHub OIDC token is exchanged for a 10-minute access token
   in-process (`src/anthropic-auth.js`), re-minted as needed during long batch
   waits. The federation ids live in `config/settings.json` → `anthropic`
   (public identifiers); the rule only trusts tokens from this repo's `main`.
   `.github/workflows/anthropic-wif-test.yml` is a manual smoke test.
   Outside Actions, export `CLASSIFIER_ANTHROPIC_API_KEY` instead (hosted
   sandboxes such as claude.ai/code reserve the `ANTHROPIC_API_KEY` name, so
   the classifier reads its own name first; a plain `ANTHROPIC_API_KEY` also
   works on a laptop). `npm run check-anthropic` confirms whichever credential
   resolved without printing it.
3. **Settings → Actions → General:** Workflow permissions "Read and write"
   (the workflows commit data back to the repo).
4. **Settings → Pages:** deploy from branch `main`, folder `/` (root). The
   dashboard is `site/index.html`, reading the committed rollups directly.
5. **Fill in `config/accounts.csv`** with every account on the List: handle,
   member name, official/personal/campaign, caucus tags separated by `|`
   (`progressive`, `newdem`, `cbc`, `chc`, `capac`, `leadership` — overlap is
   normal), state/district. The checked-in rows are a hand-drafted starter —
   verify them; caucus tags drive the per-caucus report.
6. Run **check-x-access** by hand (Actions tab → Run workflow, probe = true)
   to confirm the X credential, then **authors** once to build the author
   table, then **poll** once to verify capture. The crons take over from there.
   Optionally run `npm run backfill` once from a session: it pages past the
   first poll's cap to the end of what the list endpoint still serves (about
   800 posts — X's cap on this timeline, not a full 7 days) so the corpus
   starts a day or two earlier.
7. **Historical backfill (recommended once).** The List endpoint can't reach
   further back, but each member's own timeline can. `npm run backfill-members
   -- --days=21` walks every on-List account back three weeks (one request per
   100 posts, ~10k posts ≈ $50–65, X's limit on this endpoint is 10,000 calls
   per 15 min so the daily read budget is the only ceiling), seeds
   `data/metrics/` from capture metrics for posts already older than 24h, and
   is resumable. Then `npm run classify-range` classifies every unclassified
   day in one Claude batch, and `npm run syntax -- --date=…` per day (oldest
   first), `npm run rollup`, `npm run report`, `npm run sitedata` rebuild the
   derived layers. Without this, Momentum's 7-day baselines are empty for the
   first week.

### Running from a Claude Code cloud session

Cloud sessions get X access through a proxy-injected credential registered
for `api.x.com` (the token never reaches the session). Set `X_PROXY_AUTH=1`
and the X client sends bare requests for the proxy to authenticate; the npm
scripts already pass `--use-env-proxy` so Node's fetch honours `HTTPS_PROXY`.
`npm run check-x -- --probe` reports which auth mode worked.

`.claude/settings.json` (committed) pre-approves the project's own commands
for Claude Code sessions and sets `X_PROXY_AUTH=1` and the list id; put
personal overrides in the gitignored `.claude/settings.local.json`. Claude
classification in a session needs `CLASSIFIER_ANTHROPIC_API_KEY` in the
session's environment variables (the platform reserves the plain
`ANTHROPIC_API_KEY` name); the scripts read it directly, so nothing needs
re-exporting. `npm run check-anthropic` confirms it resolved. Without it,
capture still runs and the tagging stages skip. Every script that talks to
X or Anthropic runs node with `--use-env-proxy` so fetch honours the
session's `HTTPS_PROXY`; it is a no-op where no proxy is set.

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
| `src/poll.js` | every 20 min | List timeline → `data/archive/*.jsonl`, cursor + dedupe; then live-tags the new posts and rebuilds site data | $0.005/tweet — the floor |
| `src/classify-live.js` | with each poll | Tags the poll's new posts against the taxonomy (prompt-cached; skipped without an Anthropic credential or with `CLASSIFY_LIVE=false`) so the dashboard feed carries topics all day | ~$3–5/day at 2k tweets |
| `src/authors.js` | weekly | `config/accounts.csv` → `data/authors.json` (no expansions ever) | $0.01/account/week |
| `src/refresh.js` | nightly | 24h-old originals get one batched metrics re-read → `data/metrics/` | $0.005/original |
| `src/classify.js` | nightly | Claude Batch API + `config/taxonomy.yaml` → `data/topics/` (authoritative), emerging clusters, incident flags | ~50% batch rates |
| `src/backfill-members.js` | once | Per-member timelines back N days → archive + seeded metrics (the List endpoint stops at ~800 posts) | $0.005/post |
| `src/classify-range.js` | after a backfill | Every unclassified day in one Claude batch; retweets inherit across days | ~50% batch rates |
| `src/syntax.js` | nightly | 2–4-word n-grams by distinct-member spread → `data/syntax/`, `data/phrases.json` (with per-member first-use for adoption curves) | free |
| `src/intel.js` (+ `src/intel-lists.js`) | nightly, after `stories` (never in a poll) | Narrative intelligence (`docs/NARRATIVE_INTELLIGENCE.md`): reconciles the X ledger with `/2/usage/tweets`, reserves what capture still needs, then scans the owner's public Lists (GOP, press, delegation), runs counts + one sample per top story, phrase counts, incident probes; measures four voices per story by rule and asks Claude once per sampled story (web search/fetch on) → `data/narratives/<key>.json`, `index.json`, evidence + spend files. Every X call is reserved, ledgered, logged and cached (a same-day rerun is free). | ≤ `settings.intel.nightly_cap` units (2,500 ≈ $12.50); `X_INTEL_NIGHTLY_CAP=0` kills it; ~$2–4 Claude |
| `src/incidents.js` | nightly (+grouping each poll) | Groups incident-flagged posts into `data/incidents.json` with the active → monitoring → resolved lifecycle; nightly runs also extract intel panels | pennies |
| `src/rollup.js` | nightly | topic × day × caucus aggregates → `data/rollups/` | free |
| `src/report.js` | nightly | `reports/YYYY-MM-DD.md` + `reports/latest.md` | free |
| `src/sitedata.js` | every poll + nightly | Everything above → `site/data/rollups.json`, the one file the dashboard reads | free |

## The dashboard

`site/index.html` (dashboard) and `site/incidents.html` (incident desk) are a
static, dependency-free recreation of the high-fidelity design handoff:
caucus/window filters driving every number, four stat cards, the
topics × caucus matrix with 7-day trends and **Momentum** (0–100, 50 = steady:
40% volume lift · 20% acceleration · 20% member adoption · 10% caucus
spread · 10% engagement lift, each against the topic's own 7-day baseline),
a filterable live feed, the phrase table with caucus-split adoption bars,
emerging clusters, breaking-in-district cards, and a **Compose** modal that
builds paste-ready plain text for Signal. The incident desk shows each
incident's timeline, intel panels, and a copy-brief button; its X-search
panel is a stub until an X search connector is added. Serve via GitHub Pages
(deploy from branch, path `/`) and open `/site/`.

Emerging cards also carry an **In the news** list — newsletter hits for the
story candidate from the owner's briefing inbox (`data/context.json`, see
`docs/OUTSIDE_CONTEXT.md`): unreviewed context, not verification.

Real windows, no fakery: `rollups.json` carries separate Today and 7-day
aggregates per caucus for every topic — the design's sample data scaled one
window into the other; the pipeline computes both. Engagement lags ~one day
by design (the 24h re-read is the only metrics read).

The list endpoint rejects `since_id` (probed live, 2026-09-10: HTTP 400), so
the poller runs boundary-stop pagination with an adaptive page size (floor 5,
the endpoint minimum) — slightly above the per-tweet floor (one partial page
of re-reads per non-empty poll), still far cheaper than search or per-account
polling, and the archive stays exact thanks to local dedupe. The detection
stays in code: set `sinceIdSupported` to `null` in `data/state.json` to
re-test if X ever changes the endpoint.

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
npm run check-anthropic # one 5-token request; prints auth mode, never the key
X_BEARER_TOKEN=... X_LIST_ID=... CLASSIFIER_ANTHROPIC_API_KEY=... npm run poll
npm run report -- --date=2026-09-01
```

State (`data/state.json`) tracks the capture cursor, in-flight Claude
batches, and a per-day X read ledger the budget guard enforces. Nothing else
is stateful; delete any derived file and the nightly rebuild recreates it
from the archive.

### Correcting the classifier

`config/corrections.yaml` is the editors' override list — one entry per
mislabeled post, by tweet id or by `handle` + `date` (the ET archive day) +
`match` (a distinctive excerpt of the text), with the right `topics`
(`[macro, subtopic]` pairs from the taxonomy), a `note` saying why, `by`,
and `on`. Never edit `data/topics/` by hand.

```bash
npm run corrections -- --dry-run   # what would change, nothing written
npm run corrections                # overwrite the assignment in data/topics/<date>.json
node src/corrections.js examples   # the precedents block the live classifier sees
```

Applying marks the post under `corrected` (with the note), drops it from
`unclassified` and emerging clusters, and gives its retweets the same topics.
It is idempotent and the nightly re-runs it right after classification, so a
correction filed for a day the nightly hasn't reached yet lands the next
morning, and corrections survive a re-classify. The most recent entries
(`settings.classify.correction_examples`, default 8; 0 disables) are rendered
into the poll-time classifier's prompt as few-shot precedents — the block is
sorted and timestamp-free so the prompt cache only turns over when the YAML
changes. Commit the YAML (and the topics files, if you applied locally).
