// A cursor and its unfinished page token are one transition, never independent
// last-write-wins fields. Scheduled writers serialize; an external concurrent
// collector must reconcile explicitly instead of silently skipping an interval.
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const CAPTURE_FIELDS = ['sinceId', 'sinceIdSupported', 'recentNewCounts', 'pollProgress',
  'lastPollAt', 'lastPollAttemptAt', 'lastPollSuccessAt', 'lastPollOutcome'];
const pick = (s, keys) => Object.fromEntries(keys.filter((k) => Object.hasOwn(s, k)).map((k) => [k, s[k]]));
function choose(base, a, b, label) {
  if (isDeepStrictEqual(a, b) || isDeepStrictEqual(b, base)) return a;
  if (isDeepStrictEqual(a, base)) return b;
  throw new Error(`Concurrent changes to ${label}; refusing to mix capture boundaries or discard a pending checkpoint`);
}
function counter(value) {
  if (value == null) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid read counter during state merge');
  return value;
}
export function mergeState(base, a, b) {
  for (const state of [base, a, b]) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Invalid state during merge');
    if (state.sinceId != null && (typeof state.sinceId !== 'string' || !/^\d+$/.test(state.sinceId))) throw new Error('Invalid capture cursor during merge');
  }
  const merged = choose(pick(base, CAPTURE_FIELDS), pick(a, CAPTURE_FIELDS), pick(b, CAPTURE_FIELDS), 'capture state');
  const out = { ...merged };
  for (const key of new Set([...Object.keys(base), ...Object.keys(a), ...Object.keys(b)])) {
    if (CAPTURE_FIELDS.includes(key) || key === 'usage') continue;
    // Wrapping preserves deletion versus an explicit null (e.g. batch finish).
    Object.assign(out, choose(pick(base, [key]), pick(a, [key]), pick(b, [key]), key));
  }
  out.usage = {};
  for (const day of new Set([base, a, b].flatMap((s) => Object.keys(s.usage || {})))) {
    const rows = [base, a, b].map((s) => s.usage?.[day] || {});
    out.usage[day] = {};
    for (const field of new Set(rows.flatMap(Object.keys))) {
      const [o, x, y] = rows.map((r) => counter(r[field]));
      if (x < o || y < o) throw new Error(`Read counters decreased for ${day}/${field}; refusing merge`);
      const sum = o + (x - o) + (y - o);
      if (!Number.isSafeInteger(sum)) throw new Error('Read counter overflow during merge');
      out.usage[day][field] = sum;
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  try {
    const [basePath, oursPath, theirsPath] = process.argv.slice(2);
    if (!basePath || !oursPath || !theirsPath) throw new Error('usage: merge-state.js <base> <ours> <theirs>');
    const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
    const merged = mergeState(read(basePath), read(oursPath), read(theirsPath));
    fs.writeFileSync(oursPath, JSON.stringify(merged, null, 1) + '\n');
  } catch (e) {
    console.error(`[merge-state] ${e.message}`);
    process.exitCode = 1;
  }
}
