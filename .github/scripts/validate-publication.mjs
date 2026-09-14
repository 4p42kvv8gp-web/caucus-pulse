// Refuse publication of torn JSON/JSONL and invalid capture state. Runs before
// committing and after rebasing; no network and no repair of source bytes.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadState } from '../../src/store.js';

export function validateFile(file, { archive = false } = {}) {
  const text = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.jsonl')) {
    for (const [index, line] of text.split('\n').entries()) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { throw new Error(`Invalid JSONL: ${file}:${index + 1}`); }
      if (archive && (!row || typeof row.id !== 'string' || !/^\d+$/.test(row.id)
          || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt)))) {
        throw new Error(`Invalid archive record: ${file}:${index + 1}`);
      }
    }
  } else if (file.endsWith('.json')) {
    JSON.parse(text);
  }
}
export function validatePublication({ root = process.cwd(), files = [] } = {}) {
  const state = path.join(root, 'data/state.json');
  if (fs.existsSync(state)) loadState(state);
  const archiveDir = path.join(root, 'data/archive');
  const all = new Set(files);
  if (fs.existsSync(archiveDir)) for (const name of fs.readdirSync(archiveDir)) {
    if (name.endsWith('.jsonl')) all.add(`data/archive/${name}`);
  }
  const rollups = path.join(root, 'site/data/rollups.json');
  if (fs.existsSync(rollups)) {
    const data = JSON.parse(fs.readFileSync(rollups, 'utf8'));
    all.add('site/data/rollups.json');
    if (data.feedAllFiles?.length) {
      const posts = [];
      for (const name of data.feedAllFiles) {
        const match = /^feed-\d+(?:-([a-f0-9]{16}))?\.json$/.exec(name);
        if (!match) throw new Error('Invalid archive shard name');
        const file = path.join(root, 'site/data', name);
        const page = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Array.isArray(page)) throw new Error(`Invalid archive shard: ${name}`);
        if (match[1] && createHash('sha256').update(JSON.stringify(page)).digest('hex').slice(0, 16) !== match[1]) throw new Error(`Archive shard hash mismatch: ${name}`);
        posts.push(...page);
        all.add(`site/data/${name}`);
      }
      if (posts.length !== data.feedAllTotal || new Set(posts.map((p) => p.id)).size !== posts.length) throw new Error('Archive shards do not match published coverage');
    }
  }
  if (fs.existsSync(path.join(root, 'data/incidents.json'))) all.add('data/incidents.json');
  for (const relative of all) {
    const file = path.resolve(root, relative);
    if (!file.startsWith(path.resolve(root) + path.sep)) throw new Error('Publication path escapes checkout');
    if (!fs.existsSync(file)) continue; // deliberate deletion
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Refusing publication of symlink: ${relative}`);
    if (fs.statSync(file).isFile()) validateFile(file, { archive: relative.startsWith('data/archive/') });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = execFileSync('git', ['diff', '--cached', '--name-only', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  validatePublication({ files });
  console.log('Publication validation passed: capture state, archives, and staged JSON.');
}
