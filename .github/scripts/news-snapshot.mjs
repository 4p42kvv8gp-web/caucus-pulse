// Fetch news without holding the capture writer lock, then publish against a
// fresh checkout. Reject a changed news base instead of overwriting another
// writer's version numbers/status. The artifact remains recoverable for 7 days.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateFile } from './validate-publication.mjs';
const FILES = ['items.jsonl', 'status.json', 'reconsider.json', 'floor.json'];
const digest = (file) => fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
export function newsDigest(root) {
  return Object.fromEntries(FILES.map((name) => [name, digest(path.join(root, 'data/news', name))]));
}
export function captureNewsBase(root, directory) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ base: newsDigest(root) }));
}
export function packNews(root, directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
  for (const name of FILES) {
    const file = path.join(root, 'data/news', name);
    if (fs.existsSync(file)) {
      validateFile(file);
      fs.copyFileSync(file, path.join(directory, name));
    }
  }
  manifest.result = newsDigest(root);
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
}
export function applyNews(root, directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
  const current = newsDigest(root);
  // A transfer created before floor ingestion existed must leave any newer
  // agenda untouched. New transfers always declare its base/result digests.
  const files = FILES.filter((name) => name !== 'floor.json' || Object.hasOwn(manifest.base || {}, name) || Object.hasOwn(manifest.result || {}, name));
  // Reconsideration output is informational. Classifiers recompute relevance
  // against the source store, so another user's queued day should not be lost.
  for (const name of files) {
    if (current[name] !== manifest.base?.[name]) throw new Error(`News base changed at ${name}; recover/re-run the stored news artifact instead of overwriting it`);
    const file = path.join(directory, name);
    if (digest(file) !== manifest.result?.[name]) throw new Error(`Invalid news snapshot digest for ${name}`);
    if (fs.existsSync(file)) validateFile(file);
  }
  const dest = path.join(root, 'data/news');
  fs.mkdirSync(dest, { recursive: true });
  for (const name of files) {
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) continue;
    const temp = path.join(dest, `.${name}.publish-${process.pid}`);
    fs.copyFileSync(file, temp);
    fs.renameSync(temp, path.join(dest, name));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, directory] = process.argv.slice(2);
  if (!directory || !['base', 'pack', 'apply'].includes(mode)) throw new Error('usage: news-snapshot.mjs base|pack|apply <snapshot-directory>');
  ({ base: captureNewsBase, pack: packNews, apply: applyNews })[mode](process.cwd(), directory);
}
