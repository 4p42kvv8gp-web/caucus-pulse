// Three-way git merge driver for data/state.json.
//
// Two writers (an Actions job and a Claude Code session, or two jobs whose
// pushes race) both start from the same committed state and each add their
// own X reads to the usage ledger and advance the cursor. A textual merge
// can't reconcile that; this driver can, field by field:
//   usage[day][posts|users]  base + (a − base) + (b − base)   — both sides' spend counts
//   sinceId                  the larger id                     — cursors only move forward
//   lastPollAt               the later timestamp
//   recentNewCounts,
//   pendingBatch,
//   sinceIdSupported         from whichever side polled more recently; a
//                            non-null pendingBatch always survives
// Registered via .gitattributes (data/state.json merge=state) and, in the
// workflows, git config merge.state.driver "node src/merge-state.js %O %A %B".
// Dependency-free on purpose: it runs before npm ci would matter.
import fs from 'node:fs';

const read = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } };
const idGt = (a, b) => Boolean(a) && (!b || BigInt(a) > BigInt(b));

export function mergeState(base, a, b) {
  const aNewer = String(a.lastPollAt || '') >= String(b.lastPollAt || '');
  const [recent, older] = aNewer ? [a, b] : [b, a];

  const usage = {};
  const days = new Set([...Object.keys(base.usage || {}), ...Object.keys(a.usage || {}), ...Object.keys(b.usage || {})]);
  for (const day of days) {
    const o = base.usage?.[day] || {};
    const x = a.usage?.[day] || {};
    const y = b.usage?.[day] || {};
    const fields = new Set([...Object.keys(o), ...Object.keys(x), ...Object.keys(y)]);
    usage[day] = {};
    for (const f of fields) {
      const ob = o[f] || 0;
      usage[day][f] = ob + Math.max(0, (x[f] || 0) - ob) + Math.max(0, (y[f] || 0) - ob);
    }
  }

  return {
    ...older,
    ...recent,
    sinceId: idGt(a.sinceId, b.sinceId) ? a.sinceId : (b.sinceId || a.sinceId || null),
    sinceIdSupported: recent.sinceIdSupported ?? older.sinceIdSupported ?? null,
    recentNewCounts: recent.recentNewCounts || older.recentNewCounts || [],
    pendingBatch: recent.pendingBatch || older.pendingBatch || null,
    usage,
    lastPollAt: [a.lastPollAt, b.lastPollAt].filter(Boolean).sort().at(-1) || null
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const [basePath, oursPath, theirsPath] = process.argv.slice(2);
  if (!basePath || !oursPath || !theirsPath) {
    console.error('usage: node src/merge-state.js <base> <ours> <theirs>   (git merge driver: %O %A %B)');
    process.exit(2);
  }
  const merged = mergeState(read(basePath), read(oursPath), read(theirsPath));
  fs.writeFileSync(oursPath, JSON.stringify(merged, null, 1) + '\n');
  console.error(`[merge-state] merged usage ${JSON.stringify(merged.usage)}; sinceId ${merged.sinceId}`);
}
