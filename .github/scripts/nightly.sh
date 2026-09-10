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

FAILED=()

stage() {
  local name="$1"; shift
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
