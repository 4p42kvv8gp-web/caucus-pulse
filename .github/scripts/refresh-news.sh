#!/usr/bin/env bash
# workflow_dispatch values are data, never interpolated into shell source.
set -euo pipefail
args=()
if [ -n "${SOURCES:-}" ]; then
  [[ "$SOURCES" =~ ^[a-zA-Z0-9_-]+(,[a-zA-Z0-9_-]+)*$ ]] || { echo 'Invalid source list'; exit 1; }
  args+=("--sources=$SOURCES")
fi
case "${DRY_RUN:-}" in
  true) args+=(--dry-run) ;;
  false|'') ;;
  *) echo 'DRY_RUN must be true or false'; exit 1 ;;
esac
if [ -n "${RECONSIDER:-}" ]; then
  node --input-type=module -e '
    const value = process.env.RECONSIDER;
    const date = new Date(`${value}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(+date) || date.toISOString().slice(0,10) !== value) process.exit(1);
  ' || { echo 'Reconsideration date must be a valid YYYY-MM-DD'; exit 1; }
fi
node --use-env-proxy src/context-refresh.js "${args[@]}"
if [ -n "${RECONSIDER:-}" ] && [ "${DRY_RUN:-}" != true ]; then
  node src/context-refresh.js "--reconsider=$RECONSIDER"
fi
