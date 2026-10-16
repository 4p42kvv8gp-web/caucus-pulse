#!/usr/bin/env bash
# Shared scheduled/local nightly runner. Each selected stage runs even if an
# earlier one fails, preserving reports and site publication. The final exit
# still reports failures. New classification is scoped to one closed ET day;
# discovery and taxonomy mutations require explicit stage selection.
set -uo pipefail

# NIGHTLY_STAGES="classify,rollup,report" (the workflow_dispatch `stages`
# input) runs only the named stages. Empty uses the operational defaults;
# "all" explicitly includes discovery, promotion, and taxonomy maintenance.
# Those longer stages remain available manually but do not hold up scheduled
# collection by default. Live emerging-event detection remains enabled.
DEFAULT_STAGES='refresh,embed,classify,corrections,syntax,incidents,rollup,report,sitedata'
ONLY="${NIGHTLY_STAGES:-$DEFAULT_STAGES}"
if [ "$ONLY" = all ]; then ONLY=''; fi
FAILED=()

stage() {
  local name="$1"; shift
  if [ -n "$ONLY" ] && [[ ",$ONLY," != *",$name,"* ]]; then
    echo "skip $name (NIGHTLY_STAGES=$ONLY)"
    return
  fi
  echo "::group::$name"
  if "$@"; then
    echo "::endgroup::"
  else
    local code=$?
    echo "::endgroup::"
    echo "::warning title=nightly stage failed::$name exited $code — continuing with the remaining stages"
    FAILED+=("$name")
  fi
}

classify_recent() {
  local target
  # Never fall back to the unbounded archive if date resolution fails.
  target="$(node .github/scripts/classify-date.mjs)" || return 1
  echo "nightly: classification scope=$target; older backlog requires explicit catch-up"
  npm run classify -- "--date=$target"
}

stage refresh        npm run refresh
stage embed          npm run embed
# The classifier attaches the latest committed, dated public evidence from
# data/news. Acquisition runs hourly outside this writer lock; an unavailable
# publisher cannot block capture here. A pending batch returns immediately and
# is retrieved by a later poll invocation instead of holding this lock waiting.
# New nightly work is scoped to yesterday ET. The classifier still resumes an
# existing paid batch first, preserving its original manifest and accounting.
stage classify       classify_recent
stage stories        npm run stories
stage promote        npm run stories -- --auto-promote --retire
stage taxonomy-learn npm run taxonomy-learn -- --apply
stage corrections    npm run corrections
stage syntax         npm run syntax
stage incidents      npm run incidents
stage rollup         npm run rollup
stage report         npm run report
stage sitedata       npm run sitedata

if [ ${#FAILED[@]} -gt 0 ]; then
  echo "nightly: ${#FAILED[@]} stage(s) failed: ${FAILED[*]}"
  exit 1
fi
echo "nightly: all stages completed"
