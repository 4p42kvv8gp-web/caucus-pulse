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
