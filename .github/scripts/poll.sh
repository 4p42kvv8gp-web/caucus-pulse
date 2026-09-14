#!/usr/bin/env bash
# Preserve capture before interpretations. An unfinished interval (exit 2) is
# a useful checkpoint, not a reason to skip publication in the following step.
set -uo pipefail
capture=0
npm run poll || capture=$?
# Corrupt source bytes stop further interpretation and fail publication too.
node .github/scripts/validate-publication.mjs || exit 1
classification=0
npm run classify -- --resume-only || classification=$?
site=0
npm run sitedata || site=$?
if [ "$capture" -ne 0 ]; then
  echo "::warning::Capture interval unfinished or failed (exit $capture); validated partial results will be published before this run reports failure."
  exit "$capture"
fi
if [ "$classification" -ne 0 ] || [ "$site" -ne 0 ]; then
  echo "::warning::Capture saved; interpretation resume or dashboard rebuild failed."
  exit 1
fi
