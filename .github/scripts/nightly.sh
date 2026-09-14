#!/usr/bin/env bash
# The nightly pipeline, stage by stage, where one broken stage does not cost
# the night's other work.
#
# `npm run nightly` chains every stage with &&, so the first failure stops
# everything after it. That is wrong here: most stages need no Anthropic
# credential at all, and on 2026-09-10 the org ran out of credit, which would
# have taken syntax, incidents, rollups, the report and the dashboard rebuild
# down with the classifier — none of which touch Claude.
#
# So each stage runs regardless of what came before, and the script exits
# non-zero at the end if any stage failed. The run still goes red; it just
# stops being all-or-nothing. Order still matters, because each stage reads
# the previous stage's committed files — a stage whose input is missing does
# less work, or none, but it gets its turn.
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

stage refresh        npm run refresh
stage embed          npm run embed
# The classifier attaches the latest committed, dated public evidence from
# data/news. Acquisition runs hourly outside this writer lock; an unavailable
# publisher cannot block capture here. A pending batch returns immediately and
# is retrieved by a later poll invocation instead of holding this lock waiting.
stage classify       npm run classify
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
