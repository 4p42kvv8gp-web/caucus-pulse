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
| `src/poll.js` | every 20 min | List timeline → `data/archive/*.jsonl`, cursor + dedupe, with the post each quote/reply points at (`quoted`, see `docs/QUOTED_CONTEXT.md`); then live-tags the new posts and rebuilds site data | $0.005/tweet + the referenced posts and authors it brings back |
| `src/quotes-backfill.js` | once (re-run after a member backfill) | Fetches the posts that archived quotes/replies point at → `data/quoted.json`, so the classifier reads what a member reacted to | $0.005/quoted post + $0.01/author |
| `src/classify-live.js` | with each poll | Tags the poll's new posts against the taxonomy (prompt-cached; skipped without an Anthropic credential or with `CLASSIFY_LIVE=false`) so the dashboard feed carries topics all day | ~$3–5/day at 2k tweets |
| `src/authors.js` | weekly | `config/accounts.csv` → `data/authors.json` (no expansions ever) | $0.01/account/week |
| `src/refresh.js` | nightly | 24h-old originals get one batched metrics re-read → `data/metrics/` | $0.005/original |
| `src/classify.js` | nightly | Claude Batch API + `config/taxonomy.yaml` → `data/topics/` (authoritative), emerging clusters, incident flags | ~50% batch rates |
| `src/backfill-members.js` | once | Per-member timelines back N days → archive + seeded metrics (the List endpoint stops at ~800 posts) | $0.005/post |
| `src/classify-range.js` | after a backfill | Every unclassified day in one Claude batch; retweets inherit across days | ~50% batch rates |
| `src/syntax.js` | nightly | 2–4-word n-grams by distinct-member spread → `data/syntax/`, `data/phrases.json` (with per-member first-use for adoption curves) | free |
| `src/incidents.js` | nightly (+grouping each poll) | Groups incident-flagged posts into `data/incidents.json` with the active → monitoring → resolved lifecycle; nightly runs also extract intel panels | pennies |
| `src/rollup.js` | nightly | topic × day × caucus aggregates → `data/rollups/` | free |
| `src/report.js` | nightly | `reports/YYYY-MM-DD.md` + `reports/latest.md` | free |
| `src/sitedata.js` | every poll + nightly | Everything above → `site/data/rollups.json`, the one file the dashboard reads | free |
| `src/embed-archive.js` | every poll (new posts) + nightly (`embed`, before `classify`) | Local BGE-small embeddings for every archived post → `data/embeddings/` (4 MB, incremental); `src/semantic.js` turns them into story centroids, similarity hints for the classifier and the dashboard's "similar, unlabeled" lists (see *Semantic matching*) | free (CPU, ~1 min for 10k posts, ~1 s per poll) |

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
`docs/OUTSIDE_CONTEXT.md`): unreviewed context, not verification — and,
like every story row in the topics table, a **Similar, unlabeled** list: the
posts in the window whose wording sits near the story's posts but that carry
no label for it (see *Semantic matching* below).

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
that fit nothing as **emerging clusters**; `src/stories.js` merges them
across days into story candidates and asks Claude once to place each under
a macro as a developing **story** (a named, dated event) or a generic
taxonomy **gap**.

**The story is the unit, so promotion is continuous.** Every night, after
classification, `npm run stories -- --auto-promote --retire`:

- writes each story candidate that clears `settings.stories` (`min_posts`,
  `min_members`, `min_days`; at most `max_per_night`, most posts first) into
  the YAML as a developing story with `provisional: true`, `since:` (first
  post) and `promoted:` (the night it entered), aliases from the placement
  plus the most frequent proper nouns in its posts;
- marks a provisional story `retired: true` once it has had no assignments
  for `retire_after_quiet_days` — it leaves the classifier prompt, but the
  key stays so rollups and history still resolve;
- never auto-promotes a taxonomy gap: where a generic subject lives is a
  human call (`npm run stories -- --promote=key`, which writes a confirmed
  entry).

The daily report lists *Stories promoted tonight* and *Provisional stories
awaiting review* with their last-7-day counts, so the owner prunes (delete
the entry, or set `retired: true`) or confirms (delete `provisional: true`)
rather than approving one by one. A taxonomy edit is only seen by the next
classification run. Set `settings.stories.auto_promote` to `false` to make
the nightly step list-only. The system never invents categories silently.

Keywords are not enough to find a story's posts — "Another AI wakeup call
for Congress" never says Coxon. The next section is the layer that reads
for similarity instead.

## Semantic matching

Every archived post is embedded with a small sentence model on the CPU
(`bge-small-en-v1.5`, ONNX int8, 384 dimensions); every tracked story — a
`story: true` taxonomy row, or a `data/stories.json` candidate the placement
pass called a story — gets a centroid from the posts already tied to it
(assignments plus anchors, so a quote of Coxon's post that never names him
counts); the corpus is ranked against it. Method, measured precision and the
calibration behind the thresholds: `docs/SEMANTIC_MATCHING.md`.

**Getting the model.** `npm run download-model` fetches the four pinned files
(35 MB, sizes and digests in `src/embeddings.js`) into git-ignored
`data/models/`; it is the only network step, refuses anything that does not
verify, and is a no-op once the files are there. The `poll` and `nightly`
workflows restore it from the Actions cache (key = the model revision) and
fall back to the download, best-effort. Then `npm run embed` embeds whatever
the committed index (`data/embeddings/`, 4.3 MB int8 for 10.5k posts) lacks;
`--rebuild` starts over, `--require-model` turns the missing-model skip into
an error.

**What it costs.** CPU time only — no GPU, no API spend. Measured on the
4-core host: the whole archive (10,482 posts) in 60 s, a poll's worth of new
posts in about a second including model load, the index loaded in well under
a second, a nearest-neighbour pass over the whole corpus in a few
milliseconds. Verifying the model on disk reads the 34 MB weights once per
process (~0.1 s). Without the model every step prints one skip line and the
pipeline continues; without the index the classifier's requests are
byte-identical to what they were.

**What it does.**

- The nightly chain is `refresh → embed → classify → …`, and the poller
  embeds each poll's new posts right after capture, so vectors exist before
  anything asks for them.
- Every post sent to Claude — nightly batch, `classify-range`, poll-time
  tagging — carries `candidates`: up to `settings.semantic.candidates`
  stories whose centroid its vector sits within `settings.semantic.min_sim`
  of. A live taxonomy row arrives as `{"story": "macro/sub", "sim": 0.87}`;
  a story candidate the taxonomy has not promoted yet as `{"emerging":
  "<label>", …}` so the model reuses the label the story pipeline already
  merges on. The prompt calls them hints: the model assigns a candidate only
  when the text or quoted context supports it.
- The dashboard's Emerging cards and story rows each carry **Similar,
  unlabeled**: up to `settings.semantic.related_posts` posts from the 7-day
  window whose wording sits near the story's posts but that carry no label
  for it (retweets left out; the original speaks for itself), with the
  similarity number beside each.

**What it does not claim.** Similarity is a retrieval signal, not a
judgment: above the floor a reader — or Claude, via `npm run semantic-proof`,
which reads the nearest posts and gives a reason per post — still decides.
Adjacent subjects inside a dense macro overlap a story in similarity (the
top neighbour of the Coxon story was a data-centre post), a post attacking a
bill sits next to one supporting it, small candidate stories pull in their
genre, retweets embed as the retweeted text, replies and quotes embed as
their own words without the parent, and non-English posts are noise. The
dashboard labels the lists as measured similarity for that reason.

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
