// Tool-result cache for the narrative layer (docs/NARRATIVE_INTELLIGENCE.md
// §11.4, level 1). Key = sha1(endpoint + canonical JSON args + UTC date), so
// an identical X call on the same UTC day — a crash retry, a second story
// asking the same phrase, an --ask after the nightly, the Actions nightly
// after a session run — is served from disk at 0 units. Files live under
// data/narratives/cache/<utc-date>/ (gitignored) and dirs older than
// keepDays are pruned.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { p } from './util.js';

export const cacheRoot = p('data', 'narratives', 'cache');

// Stable serialisation: object keys sorted recursively so argument order
// never changes the key.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export function utcDate(d = new Date()) {
  return new Date(d).toISOString().slice(0, 10);
}

export function cacheKey(endpoint, args, date = utcDate()) {
  return createHash('sha1').update(`${endpoint}\n${canonical(args)}\n${date}`).digest('hex');
}

export function cachePath(endpoint, args, date = utcDate(), root = cacheRoot) {
  return path.join(root, date, `${cacheKey(endpoint, args, date)}.json`);
}

export function cacheGet(endpoint, args, { date = utcDate(), root = cacheRoot } = {}) {
  try {
    const hit = JSON.parse(fs.readFileSync(cachePath(endpoint, args, date, root), 'utf8'));
    return hit && typeof hit === 'object' && 'result' in hit ? hit : null;
  } catch {
    return null;
  }
}

export function cachePut(endpoint, args, { result, units = 0 }, { date = utcDate(), root = cacheRoot } = {}) {
  const file = cachePath(endpoint, args, date, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ endpoint, args, result, units, at: new Date().toISOString() }));
  fs.renameSync(tmp, file);
  return file;
}

// Remove cache day-directories older than keepDays (by their UTC date name).
export function pruneCache({ keepDays = 2, now = new Date(), root = cacheRoot } = {}) {
  let removed = 0;
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return 0; }
  const cutoff = utcDate(new Date(new Date(now).getTime() - keepDays * 86_400_000));
  for (const d of dirs) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoff) {
      fs.rmSync(path.join(root, d), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}
