// Three-way git merge driver for data/anthropic-usage.json.
//
// Same problem merge-state.js solves for X reads: a poll job and a nightly
// job (or a Claude Code session) both start from the committed ledger and
// each add their own tokens. Every leaf is a counter, so the merge is
// base + (a − base) + (b − base) at every leaf, recursing through
// day → stage → model → live|batch. Nothing is ever taken from one side
// only: a day either side spent on is a day that was spent on.
// Registered via .gitattributes (data/anthropic-usage.json merge=ledger) and
// git config merge.ledger.driver "node src/merge-anthropic-usage.js %O %A %B"
// in .github/scripts/commit-data.sh. Dependency-free on purpose.
import fs from 'node:fs';

const read = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } };
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function mergeLedger(base, a, b) {
  if (isObj(base) || isObj(a) || isObj(b)) {
    const out = {};
    const keys = new Set([...Object.keys(base || {}), ...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const k of [...keys].sort()) out[k] = mergeLedger(base?.[k], a?.[k], b?.[k]);
    return out;
  }
  const o = Number(base) || 0;
  return o + Math.max(0, (Number(a) || 0) - o) + Math.max(0, (Number(b) || 0) - o);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const [basePath, oursPath, theirsPath] = process.argv.slice(2);
  if (!basePath || !oursPath || !theirsPath) {
    console.error('usage: node src/merge-anthropic-usage.js <base> <ours> <theirs>   (git merge driver: %O %A %B)');
    process.exit(2);
  }
  const merged = mergeLedger(read(basePath), read(oursPath), read(theirsPath));
  fs.writeFileSync(oursPath, JSON.stringify(merged, null, 1) + '\n');
  console.error(`[merge-anthropic-usage] merged ${Object.keys(merged).length} day(s)`);
}
