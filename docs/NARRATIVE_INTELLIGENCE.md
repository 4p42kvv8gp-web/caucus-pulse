# Narrative intelligence — design for the build

Status: design, 2026-09-10. Synthesised from three proposals and two judge
rounds; the winning lens is **deterministic scans first, model last**, with
the best of the other two grafted in (tool-result cache, provenance classes,
`reported` vs `confirmed`, roster reuse, phrase-level outside signals,
incident-desk wiring). This is the file commit 0f41721 already references.

Ground truth the builder must start from (HEAD 0aec7e0 on
`claude/classifier-anthropic-key-config-9uxdfa`):

- `src/x.js` **already exports `searchRecent()`** (tested in
  `test/x-search.test.js`). Do not add a second search client.
- `data/lists/{cap-hill-reporters,congressional-media,house-democrats,house-news,labor-reporters}.json`
  rosters already exist (949 users, ~$9.49 already paid). Resolve authors
  from them before any paid user read. Only `house-gop` has no roster.
- `data/context.json` **exists** (34 KB, generated 07:01Z) and is keyed by
  story-candidate key: `stories.{candidateKey}.{key,label,kind,window,searched,matches[{sender,from,subject,date,snippet,threadId,why}],note}`.
  There are **no URLs** in it. Match it the way `sitedata.contextKeyFor` does.
- The nightly chain today is
  `refresh && classify && corrections && syntax && incidents && rollup && report && sitedata`.
  **Keep `corrections`.** Every earlier proposal silently dropped it.
- Ledger today (`data/state.json`): 12,691 posts + 1,453 users = 14,144 of
  the 50,000/day ceiling (`config/settings.json` → `daily_read_budget`).
- The pilot (`data/narratives/anthropic-researcher-resignation/x-search.json`)
  spent 793 posts + 991 users = $13.88 on one story. 949 of those users were
  the roster pulls now cached under `data/lists/`; the lesson that survives
  is in §14.

Nothing in this design runs inside `src/poll.js`. Capture first, intelligence
second; intelligence is always the first thing shed.

---

## 1. Purpose and the staff questions

The Leader's research/writing shop needs, per developing story, an answer to
ten questions in under a minute, with every number carrying its source and
its cost, and every judgment marked as a judgment. The layer below answers
them from four sources: the caucus corpus we already own, nightly captures of
the owner's public X Lists, bounded X recent-search / counts probes, and the
newsletter inbox snapshot, with web search/fetch (Anthropic-billed) as the
only path that turns a claim into "confirmed".

| # | Staff question | Answered by | Provenance |
|---|---|---|---|
| 1 | Is this breaking through beyond our own echo? | counts today vs the query's own 7-day mean, control-query lift, originals share, press-List posts, newsletter hits, articles found | MEASURED, status by rule (§2.3) |
| 2 | Who is carrying it — members, caucuses, leadership, outside accounts on no List? | caucus split from the archive; List rosters; resolved organic carriers (capped); top post by engagement | MEASURED; unresolved accounts shown as "n unresolved" |
| 3 | What is the GOP saying back, how fast, or are they silent? | house-gop List capture filtered by aliases + quotes of our top post; lag; the model marks GOP posts that answer us without using our words | MEASURED (volume, lag) + MODEL (frame, which line it answers) |
| 4 | Is the claim true and what is the sourcing? | claims extracted by the model; status assigned only against sources in the evidence pack; `confirmed` needs a fetched primary source or an official-account post | MODEL extraction, code-enforced status; default UNVERIFIED |
| 5 | How is the press framing it? | press-List posts, newsletter matches, articles from web_search/web_fetch | MEASURED (who, how many) + MODEL (frame: ours / theirs / third) |
| 6 | Is our message unified? | phrase adoption across the five caucuses and leadership, active-account reach (existing phrases logic) | MEASURED |
| 7 | Growing or fading? | hour-granularity counts (72h), day-over-day vs the six prior days, Momentum | MEASURED, status by rule |
| 8 | Where did it start and who started it? | earliest row by voice inside each voice's window; newsletter date vs first member post | MEASURED, window stated per voice |
| 9 | Real or manufactured? | top-5 account share of sampled originals, originals share, reply/quote share, follower counts of known carriers, assistant/bot accounts | MEASURED, `manufactured?` flag by rule |
| 10 | What is the hole, and what should the Leader say? | unanswered GOP claim, unaddressed press question, strongest attributed caucus line (must cite a caucus post id in the pack) | MODEL |

Plus two the owner's brief adds: "which reporters picked up a phrase from the
Phrases table" (§7.4, phrase-level outside signal) and "what did the layer
spend today and is the 20-minute capture safe" (§11, spend file + report).

---

## 2. Definitions

### 2.1 A narrative

A contested claim or frame about a **story** (the unit of the product, per
CLAUDE.md), tracked as voices over a window, each with volume, carriers, a
phrase, and a trend against its own 7-day baseline.

Voices and where each comes from:

| voice | source | window |
|---|---|---|
| `caucus` | `data/archive` + `data/metrics` + `data/topics` + `data/phrases.json` + `data/authors.json` (status `house` only) | archive (from 2026-08-20) |
| `gop` | nightly capture of `house-gop` (List 1844074661119717599) + quotes of our top post | List capture (newest ~800 posts per List; pages capped) |
| `press` | nightly captures of `cap-hill-reporters`, `congressional-media`, `house-news`, `labor-reporters`, `ny-news`, `international-news`; `data/context.json` matches; articles surfaced by web_search | List capture + newsletter snapshot |
| `organic` | recent search counts and samples for the story's aliases | last 7 days (hard wall) |
| `delegation` (sub-voice) | `ny-members`, `overlapping-electeds` captures | List capture |
| `expert` (sub-voice) | `economists` capture | List capture, off by default |

`voiceOf(row)` is a pure mapping from the roster that resolved the author:
caucus roster (status house) → `caucus`; `house-gop` → `gop`; the six press
keys → `press`; `ny-members`/`overlapping-electeds` → `delegation`;
`economists` → `expert`; anything else → `organic`. A reporter who is also
on `house-news` is one row with several sources (§7.2 dedupe).

### 2.2 Provenance classes (rendered everywhere)

- **MEASURED** — a number computed by code from fetched X objects, the
  archive, a List capture, a counts bucket, or a newsletter match. Always
  stored with `{source, units}` and rendered with a tooltip naming both
  ("X counts, 2 requests", "Cap Hill Reporters capture, sample of 300,
  incomplete").
- **MODEL** — a Claude judgment: frames, which caucus line a GOP post answers,
  the hole, the suggested line, the one-liner, claim text extraction. Never a
  number. Always rendered beside a MODEL chip.
- **UNVERIFIED** — the default class for every claim. A claim leaves it only
  through the validator (§9.4).

### 2.3 Status, by rule over MEASURED values (never by the model)

Let `lift = countsToday / mean(prior 6 days)` for the story's originals
query, `controlLift` the same ratio for the control query.

- `caucus-only` — only the caucus voice has volume in-window.
- `emerging` — ≥3 distinct members used a story alias/phrase within 48h, or
  the candidate is placed `kind: story`; no other voice above baseline yet.
- `breaking-through` — present in ≥2 of {gop, press, organic} **and**
  organic `lift ≥ 1.5 × controlLift` **and** (press posts ≥ 3 or newsletter
  hits ≥ 1 or articles ≥ 1). An X count never stands alone.
- `contested` — gop alias-matched originals within 0.5×–2× of caucus
  originals over the same 48h.
- `fading` — organic counts below the 7-day mean for two consecutive days
  and caucus posts falling day-over-day.
- `steady` — none of the above transitions apply.

Flags (independent of status): `manufactured?` when the top 5 accounts
produce ≥50% of sampled originals or originals share <25% or a known
assistant/bot account (e.g. `@grok`, 13.7% of originals in the pilot) is a
top-3 carrier; `gop-sample-incomplete` / `press-sample-incomplete` when a
List page cap was hit before the boundary; `newsletter-context-stale` when
`context.json.generatedAt` is older than 48h; `origin-beyond-window` when the
story's `firstSeen` predates the 7-day search window.

### 2.4 Claim statuses

| status | requires (validator-enforced) |
|---|---|
| `confirmed` | a `web_fetch`ed document/article URL that appeared in this story's evidence pack or tool results, **or** a post from an account tagged `official` (curated `config/official-sources.json` or `verified_type: government`) whose id is in the pack |
| `reported` | a post by a press-roster account in the pack, or a newsletter match (subject/snippet) — a named outlet says it, no primary source fetched |
| `circulating-unverified` | the default; member posts and organic posts asserting it |
| `disputed` | two pack sources contradict and at least one is `reported`-grade or better |
| `false` | a fetched primary source contradicts it (same bar as `confirmed`) |

Same-side posts never confirm each other. A press post is `reported`, not
`confirmed` (this corrects the winning proposal). Newsletter hits have no
URLs, so they can never be `confirmed`-grade; `web_search` is the only route
to fetchable articles tonight.

---

## 3. Architecture

Five phases in one runner (`src/intel.js`), each persisting to disk before
the next starts. Phases 2–3 are pure and replayable from committed files
(`--replay`, zero X spend).

```
PHASE 0  budget gate        reconcile ledger vs GET /2/usage/tweets (free) → mode: full | counts-only | off
PHASE 1  collect (X)        1a List scans (fixed, page-capped, boundary-stop, per-List cursor)
                            1b counts pass: 2 requests per story candidate + control + top-12 phrases
                            1c rank by lift → sample top N (relevancy 100 + recency 50, originals only) + quotes of top caucus post
                            1d incident probes (active/monitoring incidents) + owner saved queries
                            1e one-time operator probes (list:, quotes_of_tweet_id:)
                            every response → addUsage + saveState BEFORE anything else is written
PHASE 2  measure (pure)     unified corpus with merged provenance → per-story four voices, baseline, lag, concentration, status
PHASE 3  assess (Claude)    one messages.create per sampled story on settings.classify.model, rubric cached,
                            web_search/web_fetch server tools (max_uses), parseJsonLoose → validator
PHASE 4  publish            data/narratives/<key>.json + index.json; rollups.json additive keys; report section
```

Where it runs:

- **Nightly** (`.github/workflows/nightly.yml`, 07:30 UTC, `main` only, Claude
  via WIF): chain becomes
  `refresh && classify && corrections && syntax && stories && intel && incidents && rollup && report && sitedata`.
  `stories` moves into the chain so intel sees fresh placements; `intel`
  runs before `incidents` so the desk sees search rows. Both skip cleanly
  without credentials. `commit-data.sh ... data reports site/data` already
  sweeps `data/narratives` and `data/lists`.
- **On demand** from a cloud session (proxy X credential +
  `CLASSIFIER_ANTHROPIC_API_KEY`): the same CLI with `--dry-run`, `--story`,
  `--phrase`, `--ask`, `--max-reads`, `--replay`. Commits go through
  `.github/scripts/commit-data.sh` semantics so `state.json` merges by field.
- **Never** in `poll.js`. A feature-branch Actions run has no Claude
  (federation trusts `main` only); the runner degrades to `--no-llm` and
  still writes the MEASURED half.

---

## 4. Modules

Existing files, extended additively (all current tests must stay green):

| file | change |
|---|---|
| `src/x.js` | **Add inside the module** (authFetch is private): `countsRecent(query, {granularity='day', startTime, endTime})` → GET `/2/tweets/counts/recent`, never follows `next_token`, refuses `minute`, returns `{rateLimited, resetAt, buckets:[{start,end,count}], total, usage:{requests:1}}`; `lookupUsersByIds(ids)` → GET `/2/users?ids=` in batches of 100, same `user.fields` as `lookupUsersByHandles` (needs `verified_type` for `government`), returns `{users, usage:{users:n}}`; `usageTweets(days=2)` → GET `/2/usage/tweets` (free; `check-x-access.js` switches to it); `quoteTweetsPage(id, {maxResults≤50})` → GET `/2/tweets/:id/quote_tweets`, used **only** if the `quotes_of_tweet_id:` operator probe fails. `lookupTweets(ids, {fields})` gains an optional fields arg with the default unchanged, pinned by a test. **Reuse `searchRecent()` as is** (`expandAuthors` stays false by policy). |
| `src/store.js` | `addUsage(state, {posts, users, requests, purpose})` adds a flat `requests` counter and, when `purpose === 'intel'`, also increments flat `intelPosts/intelUsers/intelRequests` on the same day object (flat numbers so `src/merge-state.js` keeps summing; a nested object would produce NaN). `budgetExhausted()` sums `posts+users+requests`; `estCost()` adds `requests*0.005`; new `headroom(state)` → `{used, budget, remaining}`. |
| `src/sitedata.js` | additive keys `narratives`, `search`, `intelSpend`, `phrases[].outside`, `clusters[].narrative`, `clusters[].outside`, `incidents[].sources`. The `clusters[]` contract (label unique, since, posts, members, eng, shape[8], cm[5] in KEYS order, sample, who, phrase, coherence, suggest, kind, macro, days, context) is untouched. |
| `src/incidents.js` | when `data/narratives/search/incidents/<id>.json` exists, append its rows to the timeline with `tag: official | press | unverified` (ui.badge already styles them), set `incident.officialSources`, and hand official/press rows to `extractIntel` in a labelled second block so `confirmed` may cite "@handle (official), time". No X calls in this file; poll-time path unchanged. |
| `src/report.js` | `## Narratives` section and intel lines under `## Volume & spend` (units, $, mode, per List, per story, reconciliation drift). |
| `src/check-x-access.js` | call `x.usageTweets()` instead of its inline fetch. |
| `config/settings.json` | `intel` block (§13.1) and three placeholder Lists in `narrative_lists` (§13.2). |
| `package.json` | scripts `intel`, `intel-lists` (both `node --use-env-proxy`); nightly chain as in §3. |
| `.gitignore` | `data/narratives/cache/`, `data/narratives/tmp/`, `data/narratives/transcripts/`. |

New files:

| file | responsibility |
|---|---|
| `src/intel-budget.js` (pure + one file write) | `reconcile(ledgerToday, xUsageByUtcDay)` → `{used, delta, warn}`; `captureReserve(state, {pollsLeft, yesterdayOriginals})`; `planMode({used, reserve, nightlyCap, budget, override})` → `{mode, caps, reason}` (ladder §11.2); `class Reservation { canSpend(expected), commit(usage, {purpose, story, list}), remaining() }` enforcing nightly cap, ceiling-minus-reserve, per-story ceiling and per-story rolling-7-day cap (read from prior spend files); `SpendLog` appending to `data/narratives/spend/<date>.json` after every call. A single async mutex so no two X calls are in flight. 429: sleep to `resetAt` only if <60 s, else close that stage. |
| `src/intel-lists.js` | `scanLists({reservation, mode})` over `settings.narrative_lists` entries with `scan: true`: boundary-stop pagination reusing `x.listTweetsPage`, `poll.newerThan`, `poll.adaptivePageSize` (seeded from the List's own `lastNewCount` so a quiet List costs one small page), page cap per List, local dedupe over the List's last 3 day-files, rows written as `toRecord() + {list}` to `data/lists/<key>/<ET date>.jsonl`, cursors in `data/lists/cursors.json`, `complete:false` recorded when the cap hit before the boundary. 401/403/404 → `unavailableUntil` +24h, continue. `rosterFor(key)` reads `data/lists/<key>.json`; `pullRoster(key)` via `listMembers()` only when the file is missing or `--rosters=<key>` is passed and the file is >7 days old. `resolveAuthors(ids, reservation)` → authors.json → rosters → `carriers.json` → paid `lookupUsersByIds` (capped) → `unresolved`. `probeOperators()` runs once and records `data/narratives/probes.json`. |
| `src/intel-queries.js` (pure) | the one place every X query string is built and validated: `storyQueries(placement|pinned)` → `{organic, originals, control}`; `phraseQuery(phrase)`; `quotesQuery(tweetId)`; `incidentQuery(incident)`; `fromSetQueries(handles, topic)` chunking 25–30 `from:` handles per ≤512-char query; `validate(q)` (length, balanced quotes, rejects `from:list`, rejects `list:` / `quotes_of_tweet_id:` unless `probes.json` says supported, rejects `expansions`). Trimming drops the weakest alias first (shortest, or in a generic stoplist). `lang:en` on by default; `-is:retweet` on the originals/sample variants; `-from:grok` on sample queries (configurable `intel.exclude_from`). |
| `src/intel-search.js` | `probeStory(story, {reservation, mode})`: the fixed plan (§7.3) with reservation checks, idempotent per ET date (a rerun skips stories already sampled today unless `--force`), writes `data/narratives/<key>/<date>.json`. `probeIncident(incident)`, `runOwnerQueries()`, `phraseOutside(phrases)`. Every call goes through the tool-result cache (§11.4). |
| `src/intel-corpus.js` (pure) | `loadCorpus({days:7})` unifies archive rows (+metrics), List day-files, search samples and quotes into `{id, authorId, author:{handle, name, followers, roster, verifiedType}, createdAt, type, refId, lang, text, engN, sources:[{kind, key, query, sort, fetchedAt}]}` deduped by id with merged provenance. `assignStories(rows, stories, phrases)` — deterministic alias/phrase matching via `syntax.tokenize`/`ngrams`. `voiceOf(row)`. |
| `src/intel-context.js` (pure) | `readContext()` → `data/context.json` via `readJSON(…, null)`; `contextFor(story)` uses the same key/placement-key/label slug matching as `sitedata.contextKeyFor` (import it); returns `{available, generatedAt, stale, matches:[{sender, subject, date, snippet, why, threadId, links:[]}]}` — `links` tolerated if the newsletter builder adds it later, empty today. `loadOwnerQueries()` → `config/intel-queries.json` validated. |
| `src/intel-measure.js` (pure) | `measureStory(story, corpus, counts, context)` → the MEASURED core (§8); `statusOf(measured)` (§2.3); `flagsOf(measured)`; `buildEvidencePack(record)` → ≤25 attributed rows with ids + ≤15 GOP posts of the day regardless of alias match + newsletter matches + caucus assertions. |
| `src/intel-assess.js` | `assessStory(record, pack, {client, model, webTools})` — one `messages.create` (§9); `validateAssessment(parsed, pack)` — the code guarantee (§9.4). `client` injectable, like `stories.confirmDuplicates`. |
| `src/intel.js` (CLI) | orchestrates phases 0–4 serially; flags `--dry-run`, `--mode=full|counts|off`, `--stories=k1,k2`, `--story=k`, `--phrase="…"`, `--ask="…"`, `--max-reads=N`, `--no-lists`, `--no-llm`, `--replay`, `--force`, `--rosters=house-gop`, `--full-archive --max-results=N --pages=N` (opt-in only). Prints planned units per stage before spending; `--dry-run` exits after printing. Writes every JSON via tmp-then-rename. Wall-clock caps: 6 min per assess call chain, 30 min per run; on timeout writes what it has and exits 0. |
| `test/intel-*.test.js`, `test/fixtures/intel/` | §15. |

---

## 5. X client contract (additions to `src/x.js`)

```js
// GET /2/tweets/counts/recent — $0.005 per REQUEST (billed like one post read)
export async function countsRecent(query, { granularity = 'day', startTime, endTime } = {})
// → { rateLimited, resetAt, buckets: [{start, end, count}], total, usage: { requests: 1 } }
// refuses granularity 'minute' (a 7-day minute query pages many billed requests)
// never follows next_token; hour granularity is called with startTime = now-72h (72 buckets)

// GET /2/users?ids= — $0.01 per user returned; 100 ids per request
export async function lookupUsersByIds(ids)
// → { users: [{id, username, name, verified_type, public_metrics, created_at}], usage: { users: n } }

// GET /2/usage/tweets?days=N — free; X's own daily_project_usage by UTC date
export async function usageTweets(days = 2)
// → { days: [{date, posts}], projectCap, capResetDay }

// GET /2/tweets/:id/quote_tweets — $0.005 per post; only if the search operator probe fails
export async function quoteTweetsPage(id, { maxResults = 50, paginationToken } = {})
// → { rateLimited, resetAt, tweets, nextToken, usage: n }
```

All parse `x-rate-limit-remaining` / `x-rate-limit-reset` like
`userTweetsPage()`, set `max_results` explicitly, use `TWEET_FIELDS`, add no
expansions, and return `usage` so the caller meters it. `searchRecent()` is
used unchanged: `maxResults` explicit (never the API default of 10), `startTime`
clamped to `now-7d`, `nextToken` never followed by the nightly plan.

---

## 6. Query construction (`src/intel-queries.js`)

```
storyQueries(placement):
  aliases  = placement.aliases (≥4 chars, not in STOP) ∪ [placement.label]      # quoted, OR-ed
  organic  = (("Dolly Parton") OR ("Imagination Library")) lang:en
  originals= organic + ' -is:retweet'
  sample   = originals + ' -from:grok'                                            # settings.intel.exclude_from
  control  = settings.intel.control_query   # default: (Congress OR "House Democrats") -is:retweet lang:en
phraseQuery(p)     = '"<phrase>" -is:retweet lang:en'
quotesQuery(id)    = 'quotes_of_tweet_id:<id> -is:retweet'        # only if probes.listOperator/quotesOperator !== false
incidentQuery(i)   = '(<place tokens>) (<kind synonyms>) -is:retweet lang:en'   # e.g. ("San Diego") (heat OR "heat wave" OR "cooling center")
fromSetQueries(hs) = chunks of ≤28 'from:h' OR-ed, each ≤512 chars, + topic clause
```

Rules: ≤512 chars (plan for 480), balanced quotes, no `expansions`, no `list:`
until `probes.json.listOperator === true`, never the desk's `from:list`
pseudo-operator. Every string that reaches X is produced here and pinned by
`test/intel-queries.test.js`.

---

## 7. The nightly collection plan

### 7.1 List scans (fixed, once per night, shared by every story)

| key | voice | pages (default) | why |
|---|---|---|---|
| `house-gop` | gop | 3 | the counter-message; roster pulled on first run (~200 users, ~$2) |
| `cap-hill-reporters` | press | 3 | 372 reporters; busiest List |
| `congressional-media` | press | 2 | |
| `house-news` | press | 2 | |
| `labor-reporters` | press | 1 | 18 accounts; one small page |
| `ny-members`, `overlapping-electeds` | delegation | 1 each | Leader's district and delegation |
| `ny-news` | press | 1 | |
| `economists`, `international-news` | expert / press | 0 (off) | enable in settings when a story needs them |
| `house-democrats`, `members-of-congress`, `biden-administration` | — | 0 | rosters only / duplicates the caucus corpus / stale |

Worst case ≈ 1,400 posts (~$7); typical far less because boundary-stop ends
a quiet List on its first adaptive page (`lastNewCount`-seeded, floor 5). In
`counts-only` mode every enabled List gets page 1 only. Each page is billed
including overlap; `complete:false` is recorded when the cap hit first.

### 7.2 Corpus and dedupe

Rows from the archive, every List day-file, samples and quotes are unified by
id; a reporter on three Lists is one row with three `sources`. Volumes are
counted on the deduped corpus; the ledger still counts every returned row
(conservative: X's 24h dedup is a soft guarantee the cost model ignores).

### 7.3 Story probes

Candidates = `data/stories.json` candidates with `placement.kind === 'story'`,
`members ≥ 3`, `lastSeen` within 2 days, minus `intel.exclude` keys, plus
pinned stories from `config/intel-queries.json` (which may define a story the
cluster pipeline never surfaced, e.g. the Coxon story: `{key, label, macro, aliases}`).

- **Counts pass (every candidate, ≤30):** 2 day-granularity requests
  (`organic`, `originals`) = 2 units each; 1 control request per night.
- **Rank:** `lift × log(1 + caucusPosts) × (1 + momentum/100)`, where lift is
  the originals query's today ÷ mean of the 6 prior days (if a story has
  fewer than 3 prior days of counts, use `total7d / 7` as the baseline and
  flag `baseline-thin`).
- **Sample the top `intel.sample_stories` (5):**
  1. 1 hour-granularity counts request, `startTime = now-72h` (acceleration);
  2. 1 relevancy page, `max_results 100`, `sample` query ("who matters"
     across the whole 7-day window — relevancy ordering is opaque and is only
     used to reach beyond the newest minutes; ranking is done locally);
  3. 1 recency page, `max_results 50`, `sample` query (what is newest); the
     page's `oldest`/`newest` are stored — the pilot saw a 100-post page span
     5–130 minutes on a hot story, so a sample is a rate inside a window, not
     a total; counts carry the total;
  4. 1 quotes page (≤50) on the story's single top-engagement caucus post
     (`quotes_of_tweet_id:` via search if the probe passed, else
     `quoteTweetsPage`, else skipped);
  5. runner-side author resolution for unresolved authors seen in ≥2 sampled
     posts or in the top 5 by engagement: ≤20 users per story, ≤50 per night,
     cached forever in `data/narratives/carriers.json`.
  Per story: ≤6 counts, ≤200 search posts, ≤50 quotes, ≤20 users; ceiling 300
  units per night, 1,000 per rolling 7 days. Typical ≈ 210 units (~$1.05).

### 7.4 Phrase-level outside signal

Top 12 phrases from `data/phrases.json` by current spread: 1 day-granularity
counts request each (`phraseQuery`) = 12 units, plus local press-List uses of
the exact phrase (handle, post id). Feeds `phrases[].outside` in rollups.json
and answers "which reporters picked up our phrase". Runs in `counts-only`
mode too.

### 7.5 Incident probes and owner saved queries

For each incident with status `active` or `monitoring`: one recency page
(≤50, `incidentQuery`) and ≤10 author resolutions → rows tagged
`official | press | member | unverified` → `data/narratives/search/incidents/<id>.json`.
Owner saved queries (`config/intel-queries.json`, the desk's chips rewritten
with real operators) run as one recency page each at their configured
`max_results` → `data/narratives/search/queries.json`. Both capped at 200
units per night combined.

### 7.6 One-time operator probes (10 units each, recorded in `probes.json`)

`list:1844074661119717599 -is:retweet` and `quotes_of_tweet_id:<a recent caucus post id>`,
`max_results=10`. A 400 records `false` permanently (re-probe by setting the
value to `null`). `list:` support would make topic-filtered List reads
possible; until then List topic-filtering is local over the capture.

---

## 8. Measurement (`src/intel-measure.js`, pure)

Per story, all with `{value, source, units}`:

- per voice `{posts, originals, reposts, quotes, replies, carriers:[{handle|null, id, posts, originals, engN, followers|null, roster}], topPost:{id, handle, engN}, samples:[≤3 {id, handle, at, text≤200}], window:{from, to, complete}}`
- caucus extras: `members`, `cm[5]` in KEYS order (reuse sitedata's
  `caucusKeysOf`), `leadership`, `unity` (phrase adoption spread / active
  accounts), `first:{id, handle, at}`
- gop extras: `lagHours` = first GOP alias-matched post − first caucus post
  (null when none), `silent = posts === 0`, `sampleSize` = GOP posts captured
  in the window and `complete`, `quotesOfTop:{posts, accounts}`; **"silent" is
  always rendered as "no alias match in N captured GOP posts (sample
  complete: yes/no)"** because a rebuttal by definition may avoid our words —
  the assess step is asked to mark GOP posts that answer us (§9.2)
- press extras: `lists:{key: n}`, `newsletterHits:[…]|null`, `articles:[{url, title, outlet, fetched}]`
- organic: `countsToday`, `mean6d`, `lift`, `controlLift`, `total7d`,
  `buckets7d[7]`, `hourly72[72]`, `hourAccel` (last 6h vs prior 18h),
  `originalsShare` (originals counts ÷ organic counts), `concentrationTop5`,
  `assistantShare` (posts by `intel.exclude_from` accounts in the
  retweet-inclusive sample), `carriersOffList`, `unresolvedAccounts`
- origin: earliest row by voice inside each window; `newsletterBeforeFirstMember`
- `status` (§2.3), `flags`

---

## 9. The assess call (`src/intel-assess.js`)

### 9.1 Request

```js
const res = await client.messages.create({
  model: process.env.CLASSIFY_MODEL || settings.classify.model,   // claude-opus-5; adaptive thinking is on by default, do not send `thinking`
  max_tokens: 12000,                                               // reasoning counts against it
  output_config: { effort: 'medium' },                             // 'high' for --ask
  system: [{ type: 'text', text: RUBRIC, cache_control: { type: 'ephemeral' } }],  // byte-stable; ttl '1h' optional
  tools: webTools ? [
    { type: 'web_search_20260209', name: 'web_search', max_uses: 3, blocked_domains: ['x.com', 'twitter.com'] },
    { type: 'web_fetch_20260209',  name: 'web_fetch',  max_uses: 4, max_content_tokens: 8000, citations: { enabled: true } }
  ] : [],
  messages: [{ role: 'user', content: packText }]
});
```

- Web tools are **on by default for sampled stories** (`intel.web_tools: true`)
  because `context.json` carries no URLs: without them question 4 collapses
  to "circulating". They are Anthropic-billed (≈$10 per 1,000 searches plus
  tokens), never the X ledger. `max_uses` is enforced server-side; a
  `max_uses_exceeded` comes back as an error object in the tool-result block
  (success content is a list, error content is an object — branch on that,
  nothing is thrown).
- `stop_reason === 'pause_turn'` (server tools): push `res.content` back as
  the assistant turn and call again, at most 3 continuations.
- `stop_reason === 'refusal'` or `max_tokens` without parseable JSON →
  `judged = null`, `assessmentSkipped = reason`; the MEASURED half is still
  published. (Optional: `client.beta.messages.create` with
  `betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default'` to
  re-run a refusal on a fallback model; not required tonight — the repo's
  precedent is to skip.)
- No assistant prefill, no forced `tool_choice`, no structured-outputs
  branch: one output path, `parseJsonLoose` on the final text block, then
  the validator.
- Log `usage.cache_read_input_tokens`; warn when it is 0 on the second story
  of a run (a silent cache invalidator).
- The rubric contains no dates, budgets, newsletter text or numbers; all of
  that is in the user turn.

### 9.2 What the model is asked to add (and only that)

Given the pack (MEASURED numbers already computed; ≤25 attributed rows with
ids; up to 15 GOP posts of the day regardless of alias match; newsletter
matches; caucus assertions), reply with ONLY a JSON object:

```json
{
  "oneLiner": "≤200 chars for a staffer with 30 seconds",
  "frames": { "ours": "…", "theirs": "…|null", "third": "…|null" },
  "gopAnswering": [{ "id": "<gop post id from the pack>", "answersCaucusPostId": "<id>|null", "why": "…" }],
  "claims": [{ "text": "…", "status": "confirmed|reported|circulating-unverified|disputed|false",
               "source": { "kind": "document|article|official-post|press-post|newsletter|member-post|none", "url": "…|null", "postId": "…|null", "quote": "≤200 chars|null" },
               "assertedBy": ["@handle"] }],
  "hole": { "unansweredGopClaim": "…|null", "unaddressedPressQuestion": "…|null" },
  "suggestedLine": { "postId": "<caucus post id from the pack>", "handle": "@…", "text": "≤200 chars" },
  "whatsNew": ["…"],
  "couldNotVerify": ["…"],
  "citedIds": ["…"]
}
```

The model never emits a number; the rubric says so and the validator drops
any numeric field it invents.

### 9.3 Rubric (static, cached) — the rules in one place

Role: research analyst for the House Democratic Leader's research/writing
shop, writing for staff. Four voices; MEASURED numbers are given and are
authoritative; the model interprets, names frames, extracts claims, marks
which GOP posts answer which caucus line, finds the hole, drafts one line.
Evidence rules: every cited id must be in the pack; a claim is `confirmed`
only by a fetched primary source (official statement, filing, article body)
or an official-account post in the pack; a press post or newsletter makes a
claim `reported`; same-side posts never confirm each other; default every
claim to `circulating-unverified`; `is:verified` means paid, not authority;
X volume is not audience reach; silence from the GOP is a finding only if
the sample was complete; say when a handful of accounts produce most of the
volume. Use `web_search` for articles and `web_fetch` for primary sources;
stop when confident. Reply with ONLY the JSON object.

### 9.4 Validator (code — the guarantee)

1. Every `citedIds`, `claims[].source.postId`, `gopAnswering[].id`,
   `suggestedLine.postId` must exist in the pack's id set; unknown ids are
   dropped and `confidence` capped at `medium`.
2. `confirmed` / `false` require `source.kind ∈ {document, article, official-post}`
   and a URL that appeared in a `web_fetch_tool_result` for this story, or a
   `postId` whose author is tagged `official`; otherwise rewritten to
   `reported` (if the source is a press post or newsletter) or
   `circulating-unverified`, and the demotion appended to `couldNotVerify`.
3. `reported` requires a press-roster `postId` in the pack or a newsletter
   match; otherwise `circulating-unverified`.
4. `suggestedLine.postId` must be a caucus post; else `suggestedLine = null`.
5. Enums enforced, strings truncated, numbers stripped.
6. Every retained URL and post id is written to the record's `provenance`.

---

## 10. Tool definitions

### 10.1 Nightly assess call — server tools only

| tool | definition | per-call cap |
|---|---|---|
| `web_search` | `{type:'web_search_20260209', name:'web_search', max_uses:3, blocked_domains:['x.com','twitter.com']}` | 3 uses per story; 0 X units |
| `web_fetch` | `{type:'web_fetch_20260209', name:'web_fetch', max_uses:4, max_content_tokens:8000, citations:{enabled:true}}` | 4 uses per story; fetches only URLs already in the conversation (search results; newsletter `links` if they ever arrive) |

### 10.2 Ask mode (`--ask`) v1 tonight, v2 next

**v1 (tonight, deterministic):** `npm run intel -- --ask="…" --story=<key>|--phrase="…"`
runs the §7.3 probe plan for that story/phrase under a per-question
reservation (≤300 units), builds the pack, and makes one assess call with the
question appended to the user turn (`effort: 'high'`). Output:
`data/narratives/questions/<date>-<slug>.json` with a Signal-ready answer.
No model-chosen X calls.

**v2 (first follow-up, designed now):** a manual tool loop
(`client.messages.create`, `tool_choice: {type:'auto', disable_parallel_tool_use:true}`,
max 8 iterations, all `tool_result` blocks returned in one user message, a
refused call returned as `tool_result` with `is_error:true` and the
remaining budget in the text). Custom tools are strict JSON-schema tools
(`strict:true`, `additionalProperties:false`, `required` complete). The
executors — not the prompt — enforce caps through the same `Reservation`.

```jsonc
{ "name": "corpus_query", "strict": true,
  "description": "FREE. Rows already on disk (caucus archive, List captures, tonight's samples). Try this before any x_ tool.",
  "input_schema": { "type": "object", "additionalProperties": false, "required": ["days", "limit"],
    "properties": { "story": {"type":["string","null"]}, "phrase": {"type":["string","null"]},
      "voice": {"type":["string","null"], "enum":["caucus","gop","press","organic","delegation",null]},
      "days": {"type":"integer","minimum":1,"maximum":7}, "limit": {"type":"integer","minimum":1,"maximum":50} } } }
// cap: none (disk only)

{ "name": "context_search", "strict": true,
  "description": "FREE. Newsletter matches from data/context.json (subject, snippet, sender, date; no URLs). Returns available:false if the file is absent.",
  "input_schema": { "type":"object","additionalProperties":false,"required":["terms"],
    "properties": { "terms": {"type":"array","items":{"type":"string"},"minItems":1,"maxItems":8} } } }
// cap: none

{ "name": "x_counts", "strict": true,
  "description": "Post volume matching an X query over the last 7 days (no posts returned). $0.005 per call. Cheapest signal; use before any sample.",
  "input_schema": { "type":"object","additionalProperties":false,"required":["query","granularity","originals_only"],
    "properties": { "query": {"type":"string","maxLength":480}, "granularity": {"type":"string","enum":["day","hour"]},
      "originals_only": {"type":"boolean"} } } }
// cap: 1 unit per call; ≤6 calls per question; identical query+granularity same UTC day served from cache at 0

{ "name": "x_search_sample", "strict": true,
  "description": "One page of recent search (posts with ids, handles where known, metrics). Billed max_results units. A page is a sample of minutes on a hot story; use x_counts for volume.",
  "input_schema": { "type":"object","additionalProperties":false,"required":["query","sort","max_results"],
    "properties": { "query": {"type":"string","maxLength":480}, "sort": {"type":"string","enum":["relevancy","recency"]},
      "max_results": {"type":"integer","minimum":10,"maximum":100} } } }
// cap: max_results units, reserved before the call; ≤2 calls and ≤200 units per question; next_token never exposed; -is:retweet appended

{ "name": "x_quotes_of", "strict": true,
  "description": "Quote posts of one post id already seen in this conversation (who is carrying or attacking it).",
  "input_schema": { "type":"object","additionalProperties":false,"required":["post_id","max_results"],
    "properties": { "post_id": {"type":"string","pattern":"^[0-9]{5,25}$"}, "max_results": {"type":"integer","minimum":10,"maximum":50} } } }
// cap: ≤50 units, 1 call per question; post_id must be in the provenance set

{ "name": "x_lookup_posts", "strict": true,
  "description": "Fresh text and metrics for specific post ids (a post cited by a newsletter, the source post of a claim). $0.005 per post returned.",
  "input_schema": { "type":"object","additionalProperties":false,"required":["ids"],
    "properties": { "ids": {"type":"array","items":{"type":"string","pattern":"^[0-9]{5,25}$"},"minItems":1,"maxItems":20} } } }
// cap: ≤20 units per question; deleted posts return nothing and cost nothing

{ "name": "x_resolve_users", "strict": true,
  "description": "Resolve author ids seen in results to handle/followers/verified_type. $0.01 per user; ids already known from rosters are free.",
  "input_schema": { "type":"object","additionalProperties":false,"required":["ids"],
    "properties": { "ids": {"type":"array","items":{"type":"string","pattern":"^[0-9]{1,25}$"},"minItems":1,"maxItems":10} } } }
// cap: ≤10 users (20 units) per question, ≤50 users per day shared with the nightly resolver; cached in carriers.json

{ "name": "submit_answer", "strict": true,
  "description": "Terminal. The answer for staff, with every cited id/url taken from tool results in this conversation.",
  "input_schema": { "type":"object","additionalProperties":false,"required":["answer","citedIds","citedUrls","confidence","couldNotVerify"],
    "properties": { "answer": {"type":"string","maxLength":2000}, "citedIds": {"type":"array","items":{"type":"string"}},
      "citedUrls": {"type":"array","items":{"type":"string"}}, "confidence": {"type":"string","enum":["high","medium","low"]},
      "couldNotVerify": {"type":"array","items":{"type":"string"}} } } }
// cap: none; same validator as §9.4
```

Plus `web_search` / `web_fetch` as in §10.1 with `max_uses` 2 / 3 in ask
mode. Question caps: ≤300 units per question, `X_INTEL_ONDEMAND_CAP` 1,000
per day, the question must name a story key or phrase, planned units printed
first.

---

## 11. Budget policy and caching

### 11.1 Ledger mechanics (every billed call, no exceptions)

1. `reservation.canSpend(expected)` before the call: `expected = max_results`
   for a page, `1` for a counts request, `2 × n` for `n` user lookups (a user
   is $0.01, two post-reads' worth; the state ledger still counts it as one
   object like today — the dollar view lives in `estCost` and the spend file).
2. After the response: `addUsage(state, {posts|users|requests, purpose:'intel'})`
   then `saveState(state)` **before** any output is written (ledger first,
   as `backfill-members.js` does). A 429 bills nothing.
3. `SpendLog.append({t, endpoint, purpose, key, query, units, usd, cacheHit, rateLimited})`
   → `data/narratives/spend/<date>.json`.
4. No parallel X calls anywhere in the runner (async mutex).

### 11.2 Reconcile, reserve, ladder

- **Reconcile** at run start: `GET /2/usage/tweets?days=2` (free);
  `used = max(ledger ET-day, X UTC-day)`; log when they differ by >10%. This
  absorbs a cloud session and the Actions poller spending against un-merged
  copies of `state.json` (the data-writes group serialises Actions only;
  `merge-state.js` reconciles on commit, not in flight).
- **Reserve** = `pollsLeftToday × max(20, mean(recentNewCounts.slice(-6)) × 1.3 + 5) + yesterdayOriginals`.
- **Ladder** on `(used + reserve + nightlyCap) / dailyBudget()`:
  `< 0.70` full · `0.70–0.85` counts-only (no samples, quotes, user lookups; Lists page 1 only; phrases still run) ·
  `0.85–0.95` off · `X_INTEL_NIGHTLY_CAP=0` kill switch · the existing poll guard is the last line.
  Worked example now: 14,144 + ~3,000 + 2,500 = 19,644 = 39% → full.

### 11.3 Caps (settings.intel, env-overridable)

| cap | default |
|---|---|
| `X_INTEL_NIGHTLY_CAP` (units, post-equivalents) | 2,500 (~$12.50) |
| List scans | ≤1,400 (§7.1 pages) |
| story probes | ≤1,000 (counts ≤60, samples ≤5 × 300) |
| phrases outside | 12 |
| incidents + owner queries | ≤200 |
| user lookups | ≤50 users (100 units) per night, cached forever |
| per story | ≤300 per night, ≤1,000 per rolling 7 days |
| `X_INTEL_ONDEMAND_CAP` | 1,000 per day; ≤300 per question |
| full-archive search | opt-in per run only, explicit `--max-results` and `--pages` (one 500-post page is $2.50); never in nightly |

A normal night: ~1,500–2,200 intel units (~$8–11) on top of ~1,300–1,500
capture/refresh units, ≈ 4,000 of 50,000. Claude: 5–8 assess calls at
~10–15k input (rubric cached across back-to-back calls) + ≤7 server-tool uses
each ≈ $0.30–0.60 per story, $2–4 per night; web search ≤ $0.15.

### 11.4 Never re-bill: caching at three levels

1. **Tool-result cache** — key `sha1(endpoint + canonical JSON args + UTC date)`
   → `data/narratives/cache/<utc-date>/<sha1>.json` `{args, result, units, at}`
   (gitignored). An identical call the same UTC day — a crash retry, a second
   story asking the same phrase, an `--ask` after the nightly, the Actions
   nightly after a session run — returns the cached result at 0 units and the
   spend log marks `cacheHit:true`. Cache dirs older than 2 days are pruned.
2. **Story-level `inputsHash`** = `sha1(sorted caucus ids + aliases + context match threadIds + capture date)`
   stored in `data/narratives/<key>.json`; a same-ET-day rerun with an
   unchanged hash skips the story unless `--force` (this file is committed,
   so it also protects a session run from being repeated by the nightly).
3. **Rosters and carriers** — a user object is never fetched twice:
   `data/authors.json` → `data/lists/<key>.json` → `data/narratives/carriers.json` → paid.

List captures are paid once per night and read locally by every story;
`--replay` rebuilds phases 2–4 from disk with zero X spend.

---

## 12. Output schemas

All under `data/` (committed by the poll job's `git add data` — so every
write is tmp-then-rename, and scratch is gitignored).

### 12.1 `data/narratives/<story-key>.json` — the narrative record (latest)

```jsonc
{
  "key": "dolly-parton-tribute", "label": "Dolly Parton tribute", "macro": null, "kind": "story",
  "candidateKey": "celebrity-tribute", "aliases": ["Dolly Parton", "Imagination Library"],
  "queries": { "organic": "…", "originals": "…", "sample": "…", "control": "…" },
  "generatedAt": "2026-09-11T07:41:00Z", "date": "2026-09-11", "mode": "full", "inputsHash": "…",
  "status": "breaking-through",                       // §2.3, by rule
  "flags": ["press-sample-incomplete"],
  "windows": { "archive": ["2026-08-20", "2026-09-11"], "lists": ["2026-09-09", "2026-09-11"], "search": ["2026-09-04", "2026-09-11"], "newsletter": "2026-09-10T07:01Z|null" },

  "measured": {                                       // every leaf is {value, source, units}
    "organic": { "countsToday": {"value": 312, "source": "counts:originals:day", "units": 1}, "mean6d": …, "lift": …, "controlLift": …,
                 "total7d": …, "buckets7d": [7], "hourly72": [72], "hourAccel": …, "originalsShare": …,
                 "concentrationTop5": …, "assistantShare": …, "carriers": [{"id","handle|null","roster","originals","engN","followers|null"}],
                 "unresolvedAccounts": 3, "topPost": {"id","handle|null","engN"}, "samples": [≤3], "sampleWindows": [{"sort","oldest","newest","n"}] },
    "caucus":  { "posts","originals","members","cm":[5],"leadership","unity":{"spread","reach"},"first":{"id","handle","at"},"topPost":…,"samples":[≤3] },
    "gop":     { "posts","originals","accounts","sampleSize","complete","first":…|null,"lagHours":…|null,"silent":true|false,"quotesOfTop":{"posts","accounts"},"carriers":[…],"samples":[≤3] },
    "press":   { "posts","accounts","lists":{"cap-hill-reporters":4},"newsletterHits":[{"sender","subject","date","why","threadId"}]|null,"articles":[{"url","title","outlet","fetched":true}],"carriers":[…],"samples":[≤3] },
    "delegation": { "posts","accounts","samples":[≤3] },
    "origin":  { "voice","at","id","newsletterBeforeFirstMember": false }
  },

  "judged": {                                         // MODEL, validated; null when skipped
    "oneLiner": "…", "frames": {"ours","theirs","third"},
    "gopAnswering": [{"id","answersCaucusPostId","why"}],
    "hole": {"unansweredGopClaim","unaddressedPressQuestion"},
    "suggestedLine": {"postId","handle","text"}, "whatsNew": [], "confidence": "medium",
    "model": "claude-opus-5", "webUses": {"search": 2, "fetch": 1}
  },
  "assessmentSkipped": null,                          // "no-credential" | "refusal" | "unparseable" | "timeout"

  "claims": {                                         // grouped by validated status
    "confirmed": [{"text","source":{"kind":"article","url","quote"},"assertedBy":["@…"]}],
    "reported":  [{"text","source":{"kind":"press-post","postId","outlet"},"assertedBy":[]}],
    "unverified":[{"text","status":"circulating-unverified|disputed","assertedBy":["@…"]}]
  },
  "couldNotVerify": ["…"],

  "provenance": { "ids": ["…"], "urls": ["…"], "evidenceFile": "data/narratives/dolly-parton-tribute/2026-09-11.json",
                  "spend": {"posts": 203, "users": 6, "requests": 4, "units": 219, "usd": 1.10}, "cacheHits": 2,
                  "claude": {"input": 11800, "cacheRead": 2100, "output": 1900} }
}
```

Every number is under `measured` with its source and units; every quoted id
exists in the evidence file, a List day-file, or the archive; everything
under `judged` renders with a MODEL chip; `claims.unverified` is the default
bucket.

### 12.2 `data/narratives/index.json`

```jsonc
{ "generatedAt", "date", "mode", "reconcile": {"ledger", "xUtcDay", "used", "deltaPct"},
  "stories": [{ "key", "label", "macro", "status", "flags", "lift", "gopPosts", "pressPosts", "newsletterHits", "confirmed", "reported", "unverified", "spendUnits", "updatedAt" }],
  "phrasesOutside": { "<phrase>": { "countsToday", "mean6d", "lift", "pressUses": [{"handle", "id"}] } },
  "incidents": ["<incidentId with search rows>"], "skipped": [{"key", "reason"}],
  "totals": {"units", "usd", "byPurpose", "byList", "byStory"} }
```

### 12.3 Evidence and support files

- `data/narratives/<key>/<YYYY-MM-DD>.json` — raw fetched evidence with full
  provenance (the pilot's `x-search.json` is the precedent, trimmed): `{story, counts:[{q, granularity, buckets, total, fetchedAt, cacheHit}], pages:[{q, sort, maxResults, fetchedAt, oldest, newest, n, ids}], quotes:{ofId, ids}, posts:[compact rows: id, authorId, handle|null, roster, createdAt, type, refId, lang, text≤280, metrics], units, usd}`; pruned after 14 days.
- `data/lists/<key>/<YYYY-MM-DD>.jsonl` — `toRecord()` + `{list}`; `data/lists/cursors.json` — `{lists:{<key>:{listId, newestId, lastScanAt, lastNewCount, pagesLast, complete, unavailableUntil}}}`.
- `data/narratives/carriers.json` — `{byId:{<id>:{handle, name, followers, verifiedType, createdAt, firstSeenIn, resolvedAt}}}`; never merged into `data/authors.json`.
- `data/narratives/probes.json` — `{listOperator: null|true|false, quotesOperator: null|true|false, probedAt}`.
- `data/narratives/spend/<date>.json` — `{date, mode, reason, reconcile, reserve, cap, calls:[…], byPurpose, byList, byStory, total, usd}`.
- `data/narratives/search/incidents/<incidentId>.json` — `{query, ranAt, units, rows:[{id, handle|null, tag, at, text≤280, engN}], officialSources}`; `data/narratives/search/queries.json` for owner saved queries.
- `data/narratives/questions/<date>-<slug>.json` — `{question, story|phrase, plannedUnits, calls, answer, citedIds, citedUrls, confidence, spend}`.
- `data/narratives/cache/`, `tmp/`, `transcripts/` — gitignored.
- `data/state.json` gains only flat `usage[day].requests / intelPosts / intelUsers / intelRequests`.

### 12.4 `site/data/rollups.json` additive keys (≤80 KB added, test-guarded)

- `narratives[]` (≤10): the record minus `provenance.ids/urls`, samples
  trimmed to 3 per voice and 200 chars, plus `provenanceClass` on each leaf.
- `search: { incidents: {<id>: rows≤25}, queries: [{key, label, query, ranAt, units, results≤25}] }`
- `intelSpend: { date, mode, units, usd, byList, byStory, reconcileDeltaPct }`
- `phrases[].outside: { countsToday, lift, pressUses: [{handle, id}] }|null`
- `clusters[].narrative: <key>|null`, `clusters[].outside: { press, gop, xToday, lift }|null`
- `incidents[].sources: rows` and `incidents[].officialSources`

---

## 13. Configuration the owner must supply

### 13.1 `config/settings.json` → `intel` (placeholder block, spelled out)

```jsonc
"intel": {
  "_comment": "Narrative intelligence caps. Units are $0.005 post-read equivalents (a user read = 2). Env overrides: X_INTEL_NIGHTLY_CAP (0 = kill switch), X_INTEL_ONDEMAND_CAP, INTEL_MODEL.",
  "nightly_cap": 2500,
  "ondemand_cap": 1000,
  "per_question_cap": 300,
  "story": { "counts": 6, "search_posts": 200, "quotes": 50, "user_lookups": 20, "ceiling": 300, "week_ceiling": 1000 },
  "counts_stories": 30,
  "sample_stories": 5,
  "phrases_outside": 12,
  "lists_cap": 1400,
  "list_pages": { "house-gop": 3, "cap-hill-reporters": 3, "congressional-media": 2, "house-news": 2, "labor-reporters": 1,
                  "ny-members": 1, "overlapping-electeds": 1, "ny-news": 1, "economists": 0, "international-news": 0,
                  "gop-leadership": 0, "national-press": 0, "influencers": 0 },
  "user_lookups_per_night": 50,
  "incidents": { "search_posts": 50, "user_lookups": 10, "cap": 200 },
  "control_query": "(Congress OR \"House Democrats\") -is:retweet lang:en",
  "exclude_from": ["grok"],
  "exclude": ["dolly-parton-tribute", "sept-11-anniversary"],
  "web_tools": true,
  "web_uses": { "search": 3, "fetch": 4 },
  "ladder": { "full": 0.70, "counts_only": 0.85, "off": 0.95 },
  "list_keep_days": 14,
  "evidence_keep_days": 14
}
```

### 13.2 `config/settings.json` → `narrative_lists` placeholders (owner fills the ids)

Existing entries gain `"voice"` and `"scan"`; three placeholders are added.
App-only bearer auth reads **public** Lists only.

```jsonc
"house-gop":        { "id": "1844074661119717599", "name": "HR Officials/Campaigns", "role": "House Republicans (counter-message only)", "priority": 3, "voice": "gop", "scan": true },
"gop-leadership":   { "id": "",  "name": "GOP leadership & committees", "role": "Speaker, Majority Leader, Whip, NRCC/RNC, committee GOP accounts — OWNER: create a public List and paste its id", "priority": 1, "voice": "gop", "scan": false },
"national-press":   { "id": "",  "name": "National press", "role": "national outlets, White House and Hill reporters not on Cap Hill Reporters — OWNER: public List id", "priority": 2, "voice": "press", "scan": false },
"influencers":      { "id": "",  "name": "Influencers", "role": "high-reach commentators the office tracks — OWNER: public List id (one entry per List is fine: influencers-left, influencers-right)", "priority": 2, "voice": "organic", "scan": false }
```

An empty `id` or `scan:false` is skipped with one log line; a 401/403/404 is
recorded as unavailable for 24h with the instruction "make the List public or
supply a `from:` handle set in config/intel-queries.json".

### 13.3 `config/intel-queries.json` (new; owner-editable)

```jsonc
{
  "pin": ["<stories.json placement key to always sample>"],
  "exclude": [],
  "stories": [                                       // stories the cluster pipeline has not surfaced
    { "key": "anthropic-researcher-resignation", "label": "Coxon / Anthropic resignation", "macro": "tech",
      "aliases": ["Coxon", "Hubinger", "Anthropic resignation", "Anthropic superintelligence"] }
  ],
  "queries": [                                       // incident-desk chips and ad-hoc phrases, real operators only
    { "key": "district-emergency", "label": "Any district emergency", "scope": "incidents",
      "query": "(shelter OR evacuation OR \"active shooter\" OR \"shelter in place\") -is:retweet lang:en", "max_results": 50 },
    { "key": "flooding", "label": "Flooding", "scope": "incidents", "query": "(flood OR flooding) (shelter OR OEM OR evacuat*) -is:retweet lang:en", "max_results": 50 },
    { "key": "wildfire", "label": "Wildfire", "scope": "incidents", "query": "(wildfire OR \"brush fire\") (evacuat* OR contain*) -is:retweet lang:en", "max_results": 50 }
  ],
  "from_sets": { "gop-leadership": ["SpeakerJohnson", "SteveScalise", "GOPLeader", "NRCC", "GOP"] }   // fallback when no List exists; ≤28 per query
}
```

### 13.4 `config/official-sources.json` (new; optional but recommended)

`{ "handles": ["NWS", "fema", "SDFD", "NYCEmergencyMgt", …], "verified_types": ["government"] }` —
the only accounts (besides `verified_type: government`) whose posts can tag a
row `official` on the incident desk and confirm a claim.

---

## 14. Dashboard surface

### 14.1 Emerging card (`site/index.html`, additive; contract untouched)

Each cluster with `narrative` set gains a one-line strip under the existing
"In the news" list: `outside the caucus: press 4 · GOP 0 (of 212 captured) · X 312 today (+180% vs 7d, control +12%) · originals 41%`
with a status pill (`breaking through` / `contested` / `caucus-only` /
`fading`), and a `Narrative ›` anchor. Numbers carry a title tooltip naming
source and units. Absent `outside` renders nothing extra. The header stays
"Emerging — outside the taxonomy".

### 14.2 Incident desk (`site/incidents.html`)

- Search panel caption becomes "precomputed nightly and on request"; the
  SAVED chips come from `rollups.search.queries` (real operators); clicking
  a chip renders its precomputed rows with `badge(tag)`, handle or
  "unresolved account", time, text, engagement, and a footer
  "ran <time> · <units> reads · refreshes nightly; `npm run intel -- --incidents` for a live pull".
- The Run button gets a handler: an exact match to a precomputed query
  renders it; otherwise "Not run yet — add it to config/intel-queries.json
  (~<max_results> reads nightly)" with the text ready to copy. The page
  never pretends to search live.
- "official sources" = `incident.officialSources`; timeline rows from
  `incident.sources` interleave with member rows carrying `tag` official /
  press / unverified so `ui.badge` styles them; Copy brief includes them
  under "Official / press".

### 14.3 Narratives panel (Wave 2 — same night if time, else next)

One card per `rollups.narratives` item: status pill + flags; four-column
voice strip (Caucus posts·members with `seg(cm)`; GOP posts or "no alias
match in N captured", lag; Press posts · newsletter hits · articles; X today
vs 7-day with `spark(buckets7d)`, control lift, originals %); the one-liner
with a MODEL chip; carriers (caucus handles, roster-resolved press/GOP,
resolved organic with follower counts, "n unresolved accounts"); Counter-
message and Press framing rows (MODEL chip, ≤3 id-linked samples); Truth
check with status colours and evidence links; Next action; footer "<units>
X reads (~$) · <n> Claude calls · windows per voice"; `Copy brief` (Signal
text in the `briefOf` style) and `Compose` (subject `narrative:<key>`).

### 14.4 Daily report

`## Narratives` (status, four-voice volumes, lift vs control, top off-List
carrier, claims by status, one-liner, units) and intel lines under
`## Volume & spend` (mode, units, $, per List, per story, reconciliation
drift, Lists unavailable).

---

## 15. Test strategy without spending

- **Recorded fixtures** under `test/fixtures/intel/`: a counts response (day
  and hour), a relevancy page and a recency page (built from the pilot's
  `x-search.json` posts, trimmed), a List timeline page, a `context.json`
  slice in its real shape, a `stories.json` slice with a story and a noise
  placement, a synthetic archive day, rosters.
- **Stubbed fetch** (copy `withStubbedFetch` from `test/x-search.test.js`)
  for `countsRecent`, `lookupUsersByIds`, `usageTweets`, `quoteTweetsPage`:
  URL shape, explicit `max_results`, no expansions, `usage` accounting, 429 →
  `resetAt`, 400 → thrown with `status`, `minute` refused. Pin
  `lookupTweets(ids)` default fields unchanged.
- **Injectable clients**: `probeStory({x})`, `scanLists({x})`,
  `assessStory({client})` take the client as a parameter (the
  `confirmDuplicates` precedent) so the plan, the caps and the parse/validate
  path run against canned responses.
- **Pure-module tests**: queries (length trimming, quoting, `from:` chunking,
  pseudo-operator rejection, operator gating by probes); budget (ladder with
  today's 14,144-used state → full, a 40,000 state → off, reservation refusal,
  reconcile skew, per-story week cap from spend files); corpus (dedupe with
  merged provenance, `voiceOf`, alias matching); measure (lift with thin
  baselines, lag, silence with incomplete sample, concentration, status
  transitions, flags); context (matching by candidate key / placement key /
  label against the real shape, `available:false` when absent); validator
  (unknown id dropped, `confirmed` without a fetched URL → `reported` or
  `unverified`, press post → `reported`, non-caucus suggested line → null,
  numbers stripped); cache key stable under arg reordering; `inputsHash`
  skip; store (`addUsage` flat fields, `budgetExhausted` with requests,
  `estCost`) and merge-state (new flat fields sum across two writers).
- **Guards**: a path test asserting intel writers never resolve into
  `data/archive` or `data/authors.json`; a size test keeping the added
  rollups payload under 80 KB; `--replay` over the fixtures produces a
  byte-identical record; `renderTaxonomy`/rubric byte-stability.
- **Free live checks**: `npm run check-x` (usage + credits), `npm run
  check-anthropic`, `npm run intel -- --dry-run` (prints the whole plan with
  planned units per stage and spends nothing).

---

## 16. Ordered build steps

Gate: nothing spends X until step 11; the first live spend is ≤120 units.

| # | step | est | must tonight |
|---|---|---|---|
| 0 | `git pull --rebase`; `npm ci`; `npm test` green; `npm run check-x`, `npm run check-anthropic` (free). Branch `claude/narrative-intel`. | 5 | yes |
| 1 | `src/store.js`: flat `requests` + `intel*` fields, `budgetExhausted`/`estCost`/`headroom`; tests incl. merge-state sum. | 10 | yes |
| 2 | `src/x.js`: `countsRecent`, `lookupUsersByIds`, `usageTweets`, `quoteTweetsPage`, `lookupTweets` fields option; `check-x-access.js` uses `usageTweets`; stubbed-fetch tests. | 15 | yes |
| 3 | `config/settings.json` `intel` block + list `voice`/`scan` + placeholders; `config/intel-queries.json`; `.gitignore`; `package.json` scripts and the nightly chain **with `corrections` kept**. | 10 | yes |
| 4 | `src/intel-budget.js` + tests (ladder, reserve, reservation, reconcile, spend log). | 15 | yes |
| 5 | `src/intel-queries.js` + tests. | 10 | yes |
| 6 | `src/intel-lists.js`: cursors, boundary-stop scan, page caps, dedupe, day-files, roster reuse + one-time `house-gop` roster pull, lazy resolver with `carriers.json`, probes, unavailable handling. `npm run intel-lists -- --dry-run`. | 15 | yes |
| 7 | `src/intel-search.js`: counts pass, ranking, sampling plan, quotes, phrases outside, incident probes, owner queries, tool-result cache, per-date idempotence, evidence files. | 15 | yes |
| 8 | `src/intel-corpus.js`, `src/intel-context.js` (real `context.json` shape via `contextKeyFor`), `src/intel-measure.js` + fixture tests. | 20 | yes |
| 9 | `src/intel-assess.js`: rubric, pack renderer, `messages.create` with server tools, `pause_turn`/refusal handling, `parseJsonLoose`, validator + tests. | 15 | yes |
| 10 | `src/intel.js` runner: phases 0–4, flags, tmp-then-rename, wall-clock caps, `--replay`, `--ask` v1. `npm run intel -- --dry-run` and review the printed plan. | 20 | yes |
| 11 | **First live spend, bounded:** `npm run intel -- --stories=<one placed story> --max-reads=120 --no-lists` (probes 20 + counts + one 100-row page ≈ $0.60). Check: spend file, evidence file, ledger delta in `state.json` before outputs, `cache_read_input_tokens`, validator output, record written. Re-run the same command: every call must be a `cacheHit` and the `inputsHash` skip must fire. | 10 | yes |
| 12 | `src/sitedata.js` additive keys; `src/incidents.js` search-row merge + `officialSources`; `src/report.js` sections; `npm run sitedata && npm run report` (free); size guard. | 15 | yes |
| 13 | `site/index.html` Emerging strip + anchor; `site/incidents.html` chips, Run handler, official-sources stat. Serve `site/` locally and confirm nothing changes when `narratives` is absent. | 15 | yes |
| 14 | Full nightly-shaped run from the session under the caps (`npm run intel`, then `incidents`, `rollup`, `report`, `sitedata`); `npm test`; commit via `commit-data.sh` semantics; PR with units, reconciliation figures and the pilot comparison; self-merge once green (CLAUDE.md). Tonight's Actions nightly then runs the first scheduled pass. | 15 | yes |
| 15 | Narratives panel (§14.3) + Compose subject + Copy brief. | 20 | if time |
| 16 | `--ask` v2 tool loop (§10.2) with the custom tools and the same validator. | 30 | follow-up |
| 17 | README pipeline row, CLAUDE.md conventions (intel never in poll; caps live in `settings.intel`; kill switch). | 5 | yes |

Trim order if the window runs short: 15 → 13's Narratives-related bits →
`--ask` v1 → phrases outside. Never trim 1, 4, 11 or the validator.

---

## 17. Failure modes (condensed)

| risk | handled by |
|---|---|
| intel drains the shared ledger; `poll.js` stops capturing for the ET day | reserve before spend; ladder; nightly cap; per-call reservation; ledger-first persistence; kill switch; never in poll |
| ledger race between a session and Actions | reconcile with `/2/usage/tweets`; flat usage fields for `merge-state`; single-writer intel files; tool-result cache and `inputsHash` make a repeat free |
| cost fan-out (search default 10 but pages fan out; minute counts page; 500-post archive pages; users cost 2×) | explicit `max_results`; no `next_token` loops; `minute` refused; full-archive opt-in; lookups capped and cached; `--dry-run` |
| a 100-post page is a 5-minute sample on a hot story | counts carry volume; pages store `oldest/newest`; relevancy page reaches across the window; always `-is:retweet` on samples (37–70% RT share in the pilot) |
| assistant/bot amplification (`@grok` 13.7% of originals in the pilot) | `exclude_from` on samples; `assistantShare` measured; `manufactured?` flag |
| `list:` / `quotes_of_tweet_id:` unavailable on pay-per-use | 10-unit probes recorded once; local List filtering; `quoteTweetsPage` fallback |
| GOP rebuttal avoids our words → false "silent" | silence reported with sample size and completeness; ≤15 GOP posts of the day go to the model regardless of alias match; quotes of our top post |
| hallucinated confirmation | validator §9.4; `reported` distinct from `confirmed`; same-side rule; default unverified; only fetched URLs or official posts confirm |
| newsletter file absent/stale/no URLs | `readJSON` fallback, `stale` flag, matches are `reported`-grade at most; `web_search` supplies fetchable URLs |
| private/deleted/renamed Lists (app-only auth reads public only) | `unavailableUntil` +24h; `from_sets` fallback; report lists them |
| Claude unavailable (feature branch in Actions), refusal, truncation | `anthropicConfigured()` gate → `--no-llm`; `judged:null` with reason; MEASURED half always published |
| prompt-cache invalidation | rubric static; volatile content in the user turn; `cache_read_input_tokens==0` warning |
| archive/author contamination | List rows under `data/lists/<key>/`, outsiders in `carriers.json`; path-guard test; `voiceOf` explicit |
| torn files swept into the next poll commit | tmp-then-rename; per-date idempotent evidence files; scratch gitignored |
| rollups bloat (already 294 KB, `cache:no-store`) | ≤10 records, 3 samples/voice, 200-char text, 25 rows/query; size test |
| 7-day search wall, ~800-post List horizon | windows stated per voice; `origin-beyond-window` flag; List day-files accumulate as memory |
| rate limits (search 450/15m, counts 300/15m, users 300/15m, quote_tweets 75/15m) | sequential calls; `resetAt` honoured once if <60 s, else stage closed; 429 bills nothing |
| nightly runtime queues polls | 6-min per-assess and 30-min per-run caps; exit 0 with partial output |
| sibling edits to `store.js`, `x.js`, `settings.json`, `package.json`, `nightly.yml` | rebase on HEAD before the PR; additive changes only; `npm test` green before self-merge |

---

## 18. Open questions for the owner

1. **List ids.** Is `house-gop` (1844074661119717599, "HR Officials/Campaigns")
   public and current? Will you create public Lists for GOP leadership /
   committees, national press beyond Cap Hill Reporters, and influencers
   (§13.2), or should those voices come from `from:` handle sets in
   `config/intel-queries.json` for now?
2. **Official sources.** Which handles count as official for confirmation and
   the incident desk (`config/official-sources.json`): NWS/FEMA/state OEMs/
   city police, or also agency press offices and member official accounts?
3. **Caps.** Nightly intel cap 2,500 units (~$12.50) and 5 sampled stories
   per night — raise, lower, or make story count adaptive to lift?
4. **Web tools on by default** for sampled stories (Anthropic-billed, ≤3
   searches + 4 fetches per story). Keep on, or restrict `allowed_domains` to
   a list of outlets and `.gov`?
5. **Noise stories.** `dolly-parton-tribute` and `sept-11-anniversary` are
   excluded by default; anything else to exclude or pin (Coxon is pinned as a
   custom story)?
6. **Newsletter builder.** Can `data/context.json` matches carry an optional
   `links: []` array (URLs extracted from the newsletter body) and a
   `stories.<key>.searchedAt`? That would let `web_fetch` reach the articles
   the inbox already pointed at, and let the record say how fresh the context
   is. The reader tolerates both fields' absence.
7. **On-demand v2.** Is the model-driven tool loop (§10.2, model chooses
   which X calls to make within caps) wanted for staffer questions, or is v1
   (bounded probe + one call) enough for the first week?
8. **Delegation and expert voices.** Should `ny-members` /
   `overlapping-electeds` be surfaced on the Narratives card as a fifth
   column, and should `economists` scan by default?
9. **Full-archive search** for "who started it" beyond 7 days: enable as an
   explicit opt-in flag (one 500-post page is $2.50), or leave off until
   asked?
10. **Public exposure.** Evidence files commit sampled third-party post text
    (≤280 chars per row) to a repo whose `site/` is served by GitHub Pages.
    Acceptable as today with the pilot file, or should evidence files move
    to the gitignored set and only the trimmed record commit?

---

## 19. What the pilot taught (`data/narratives/anthropic-researcher-resignation/x-search.json`)

- 8 recent-search pages (793 posts, $3.97) plus 949 roster users ($9.49, now
  cached under `data/lists/`) and 42 lookups ($0.42): $13.88 for one story.
  The roster cost is sunk; the per-story number to budget from is ~$1.
- Newest-first pages spanned 5.4 minutes (hot query) to 701 minutes (niche
  query): a page is a rate sample, never a total. Counts are the total.
- 743 unique posts, 610 unique authors, 37% retweets across all pages and
  70% in retweet-inclusive pages: originals-only sampling is mandatory and
  the originals share must be reported.
- `@grok` replies were 13.7% of originals: exclude assistant accounts from
  samples and measure their share.
- One caucus post in 743: the caucus is not where the organic conversation
  is, which is exactly what question 1 is designed to show.
- The JUDGED framings block in that file had ids from the same fetched set —
  the validator rule in §9.4 is the code version of that discipline.
