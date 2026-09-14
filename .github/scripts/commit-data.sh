#!/usr/bin/env bash
# Scheduled writers share data-writes. Concurrent external edits can still
# race a push: merge archives/ledgers, but never overwrite paid interpretations,
# queue manifests, configuration, or source code to make the push succeed.
set -euo pipefail
msg="$1"; shift

git config user.name "caucus-pulse"
git config user.email "actions@users.noreply.github.com"
git config merge.state.name "coherent capture state merge"
git config merge.state.driver "node src/merge-state.js %O %A %B"
git config merge.ledger.name "anthropic usage merge"
git config merge.ledger.driver "node src/merge-anthropic-usage.js %O %A %B"
git add -- "$@"
node .github/scripts/validate-publication.mjs
if git diff --cached --quiet; then echo "nothing to commit"; exit 0; fi
# Retain validated work before a push/rebase; failure-only workflow artifacts
# make it recoverable after an ephemeral runner exits.
recovery="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/caucus-pulse-recovery"
mkdir -p "$recovery"
base=$(git rev-parse HEAD)
git commit -q -m "$msg"
git bundle create "$recovery/validated-data.bundle" "$base..HEAD"
for attempt in 1 2 3 4 5; do
  if git push; then exit 0; fi
  echo "push rejected (attempt $attempt) — trying a lossless rebase"
  branch=$(git symbolic-ref --short HEAD)
  git fetch origin "$branch"
  if ! git rebase "origin/$branch"; then
    echo "::error::Concurrent edits could not merge safely. No interpretation/checkpoint was overwritten; validated work is in the recovery artifact."
    git rebase --abort
    exit 1
  fi
  git diff --name-only -z "origin/$branch..HEAD" | node --input-type=module -e '
    import fs from "node:fs";
    import { validatePublication } from "./.github/scripts/validate-publication.mjs";
    validatePublication({ files: fs.readFileSync(0, "utf8").split("\0").filter(Boolean) });
  '
done
echo "::error::Publication still rejected after five attempts; recover the validated data bundle."
exit 1
