#!/usr/bin/env bash
# Commit generated data and push, surviving concurrent writers.
#
#   .github/scripts/commit-data.sh "<commit message>" <path>...
#
# main moves under a job whenever a session or another job pushes first, and a
# plain `git pull --rebase` then fails on the generated files. Three rules make
# the replay safe, and one rule keeps it honest:
#
#   - data/state.json merges field by field (src/merge-state.js: usage adds up,
#     the cursor takes the larger id) — .gitattributes names the driver, this
#     script registers it. data/anthropic-usage.json is all counters and merges
#     the same way (src/merge-anthropic-usage.js).
#   - data/archive/*.jsonl are append-only, so both sides' lines are kept
#     (merge=union in .gitattributes; loadDay dedupes by id on read).
#   - Files this job rebuilt from the archive are safe to overwrite with the
#     job's version, because the job's version is the newer derivation of the
#     same source. REGENERABLE below is exactly that set.
#   - Everything else — config/, src/, .github/, tests, docs — is hand-written.
#     A conflict there means a human or another session changed something this
#     job would clobber, so the script ABORTS and says so rather than picking
#     a winner. An earlier version of this script used a blanket
#     `rebase -X theirs`, which silently discarded concurrent edits to
#     config/taxonomy.yaml — the one hand-written file a nightly run also
#     writes (story auto-promotion), and the one most expensive to lose.
set -euo pipefail
msg="$1"; shift

# Paths whose content is a pure function of the archive, so the replayed
# commit's version always wins. Anchored prefixes, matched against the paths
# git reports as conflicted.
REGENERABLE='^(data/(rollups|topics|syntax|metrics|embeddings|topics-live)/|data/(phrases|incidents|stories|why|quoted|context)\.json$|reports/|site/data/)'

git config user.name "caucus-pulse"
git config user.email "actions@users.noreply.github.com"
git config merge.state.name "caucus-pulse state.json field merge"
git config merge.state.driver "node src/merge-state.js %O %A %B"
git config merge.ledger.name "caucus-pulse anthropic-usage.json counter merge"
git config merge.ledger.driver "node src/merge-anthropic-usage.js %O %A %B"

git add "$@"
if git diff --cached --quiet; then echo "nothing to commit"; exit 0; fi
git commit -q -m "$msg"

for attempt in 1 2 3 4 5; do
  if git push; then exit 0; fi
  echo "push rejected (attempt $attempt) — rebasing onto origin/main"
  git fetch origin main

  if git rebase origin/main; then continue; fi

  # Conflicted. Auto-resolve only the files this job regenerates; anything
  # else is someone's real work and must not be overwritten silently.
  conflicts=$(git diff --name-only --diff-filter=U)
  unsafe=$(echo "$conflicts" | grep -Ev "$REGENERABLE" || true)
  if [ -n "$unsafe" ]; then
    echo "rebase hit conflicts in files this job does not regenerate:"
    echo "$unsafe" | sed 's/^/    /'
    echo "refusing to overwrite them — resolve by hand."
    git rebase --abort
    exit 1
  fi

  echo "resolving regenerated files in favour of this run:"
  echo "$conflicts" | sed 's/^/    /'
  # During a rebase, --theirs is the commit being replayed (this job's).
  echo "$conflicts" | while read -r f; do [ -n "$f" ] && git checkout --theirs -- "$f" && git add -- "$f"; done
  if ! GIT_EDITOR=true git rebase --continue; then
    echo "rebase could not be completed:"
    git status --short | head -20
    git rebase --abort
    exit 1
  fi
done
git push
