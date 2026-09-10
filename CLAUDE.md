# Caucus Pulse — notes for Claude Code sessions

## Standing authorizations (from the repo owner, 2026-09-10)

- **Merge your own pull requests** once `npm test` passes and the branch
  merges cleanly. Do not wait for a human click. Draft → ready → merge.
- **Spend within the configured ceilings** without asking: the X read
  budget is `config/settings.json` → `daily_read_budget` (50,000/day as of
  2026-09-10, set by the owner); Claude classification runs on
  `settings.classify.model` at batch rates. Ask before anything that would
  exceed a day's ceiling.
- **main is the spine.** The Codex-built branch `codex/caucus-pulse-foundation`
  (PR #1) is a separate, self-hosted design; borrow ideas from it (story-level
  subtopics, provisional incidents, correction loop, outside context), do not
  merge it.

## Product principle: the story is the unit (owner, 2026-09-10)

- A macro topic like "Congress & campaign politics" means nothing to the
  Leader's office on its own. Macros are shelves for navigation; the rows
  that matter are specific, named, dated developing stories: "AI safety →
  Jacob Coxon resignation", "Immigration → Liam Ramos / Dilley".
- Every macro should carry story subtopics (`story: true`, `since:`) fed by
  the emerging-cluster pipeline; a post about a named event is assigned the
  story, never left at the bare macro. Generic subtopics exist only where a
  durable subject has volume and no story.
- Promotion is continuous: candidates that clear the thresholds in
  `settings.stories` are promoted nightly as provisional stories; the owner
  prunes rather than approves one by one.

## Product principle: the taxonomy learns from the data (owner, 2026-09-10)

- Rows like "2026 midterms" mean nothing; rows must be what the caucus is
  actually talking about at the granularity the posts support. Subtopics
  are discovered from the posts (semantic clusters inside a macro, named
  by reading them), not authored from a list of policy areas.
- Volume decides shape: a subtopic that draws as much attention as its
  parent (settings.taxonomy_learn.elevate_share of the macro over 7 days)
  becomes its own bucket — dual-listed for continuity when that keeps
  history readable, single when it does not. Posts may carry both.
- The pipeline proposes and applies these changes nightly within
  thresholds (`npm run taxonomy-learn`), the report lists them, and the
  owner prunes. Hand edits to config/taxonomy.yaml remain authoritative.

## Product principle: intelligence everywhere (owner, 2026-09-10)

- "Keyword searches and numerical data are not enough." Every layer that
  counts, matches strings, or ranks by a formula must also READ the posts
  and JUDGE, with a stated reason and the evidence it used: what is this
  post about, is it the same story as that one, why is this topic moving,
  is this the same message in different words, is this the same incident.
- Numbers stay (they are measured); judgments sit next to them and are
  labelled as judgments; anything unverified says so. See
  docs/INTELLIGENCE_EVERYWHERE.md for the layer-by-layer map and status.

## How things run

- GitHub Actions on `main` do the capture (`poll` every 20 min), the nightly
  batch classification, and the weekly author refresh. Claude auth there is
  workload identity federation; there is no API key in Actions.
- In a Claude Code cloud session: X goes through the proxy-injected credential
  (`X_PROXY_AUTH=1`, set by `.claude/settings.json`), Claude through
  `CLASSIFIER_ANTHROPIC_API_KEY` (the platform reserves `ANTHROPIC_API_KEY`).
  `npm run check-x` and `npm run check-anthropic` confirm both without
  printing secrets.
- The repo is the datastore. `data/archive/*.jsonl` is the corpus; everything
  else under `data/` and `site/data/` is derived and rebuildable.
- Repo Settings pages (secrets, variables, Pages) are not reachable from a
  cloud session. Ask the owner for those.

## Conventions

- One-writer concurrency group `data-writes`: a long nightly run queues polls.
- Never re-bill an X read you already have: backfilled posts older than 24h
  seed `data/metrics/` from capture metrics.
- Momentum compares the rolling last 24h to the six prior full days.
- Emerging clusters → `npm run stories` merges them across days into story
  candidates; `--promote=key` writes an approved one into
  `config/taxonomy.yaml` as a developing story. Re-classify afterwards.
- Narrative intelligence (`npm run intel`, docs/NARRATIVE_INTELLIGENCE.md)
  never runs inside `poll.js`: capture first, intelligence second, and
  intelligence is the first thing shed. Its caps live in
  `config/settings.json` → `intel` (nightly 2,500 units, ≤300 per story
  per night, ≤1,000 per story per rolling week); `X_INTEL_NIGHTLY_CAP=0` is
  the kill switch. Units are $0.005 post-read equivalents (a user read = 2,
  a counts request = 1).
- Every billed X call in the intel layer goes reservation → `addUsage` +
  `saveState` → spend log (`data/narratives/spend/<date>.json`) → tool-result
  cache, in that order, so the ledger is written before any output. An
  identical call on the same UTC day is a `cacheHit` at 0 units; a story
  whose `inputsHash` is unchanged the same ET day is skipped unless `--force`.
  `--dry-run` prints the plan and spends nothing; `--replay` rebuilds records
  from disk with zero X spend.
- MEASURED numbers carry `{value, source, units}`; anything under `judged`
  is a MODEL judgment; a claim is `confirmed` only by a fetched primary
  source or an official-account post in the evidence pack (the validator in
  `src/intel-assess.js` enforces it — a press post or newsletter is
  `reported`, everything else `circulating-unverified`).
- A stray `X_DAILY_READ_BUDGET` in a session's environment overrides the
  50,000 ceiling (that is what the env var is for); `npm run intel --
  --dry-run` prints which ceiling it planned against.
