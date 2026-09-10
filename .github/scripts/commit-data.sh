#!/usr/bin/env bash
# Commit generated data and push, surviving concurrent writers.
#
#   .github/scripts/commit-data.sh "<commit message>" <path>...
#
# main moves under a job whenever a session or another job pushes first. A
# plain `git pull --rebase` then fails on the generated files, which is what
# took down the first nightly and poll runs. Three rules make the replay safe:
#   - data/state.json merges field by field (src/merge-state.js: usage adds
#     up, the cursor takes the larger id) — .gitattributes names the driver,
#     this script registers it;
#   - data/archive/*.jsonl are append-only, so both sides' lines are kept
#     (merge=union in .gitattributes; loadDay dedupes by id on read);
#   - every other generated file (rollups, topics, reports, site data) is
#     rebuilt from the archive on each run, so on conflict the version this
#     job just produced wins (-X theirs during a rebase = the replayed commit).
set -euo pipefail
msg="$1"; shift

git config user.name "caucus-pulse"
git config user.email "actions@users.noreply.github.com"
git config merge.state.name "caucus-pulse state.json field merge"
git config merge.state.driver "node src/merge-state.js %O %A %B"

git add "$@"
if git diff --cached --quiet; then echo "nothing to commit"; exit 0; fi
git commit -q -m "$msg"

for attempt in 1 2 3 4 5; do
  if git push; then exit 0; fi
  echo "push rejected (attempt $attempt) — rebasing onto origin/main"
  git fetch origin main
  if ! git rebase -X theirs origin/main; then
    echo "rebase could not be completed automatically:"
    git status --short | head -20
    git rebase --abort
    exit 1
  fi
done
git push
