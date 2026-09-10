// Embed the archive into data/embeddings/. Incremental by default: only posts
// the index has never seen are embedded, so a poll-time call costs seconds.
//
//   node src/embed-archive.js               # embed new posts, save   (npm run embed)
//   node src/embed-archive.js --rebuild     # start from an empty index
//   node src/embed-archive.js --limit=500   # cap this run (smoke test)
//
// Needs the model on disk (npm run download-model). No network. Without the
// model, a run that has posts to embed reports `skipped` and exits 0 — the
// nightly chain and the poller must not fail because the 35 MB download
// never happened on this checkout (`--require-model` makes it an error).
import { loadEmbedder, modelId, modelAvailable, MODEL } from './embeddings.js';
import { createIndex, load, indexDir } from './embedding-index.js';
import { loadArchive } from './store.js';

const arg = (name, dflt) => {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);

export async function embedArchive({ rebuild = false, limit = Infinity, log = () => {}, embedder = null, requireModel = false } = {}) {
  const posts = loadArchive();
  let index = rebuild ? null : load();
  if (index && index.model !== modelId()) {
    log(`index was built with ${index.model}; rebuilding for ${modelId()}`);
    index = null;
  }
  const fresh = !index;
  index ??= createIndex({ dim: MODEL.dim, model: modelId() });
  const todo = posts.filter((t) => !index.has(t.id)).slice(0, limit);
  if (!todo.length && !fresh) {
    // Nothing new: leave the committed files untouched (no manifest churn).
    return { embedded: 0, total: index.count, seconds: 0, postsPerSecond: null, bytes: null, dir: indexDir() };
  }
  if (todo.length && !embedder && !requireModel && !modelAvailable()) {
    return { embedded: 0, pending: todo.length, total: index.count, skipped: 'embedding model not downloaded (run: npm run download-model)', dir: indexDir() };
  }
  const started = Date.now();
  let seconds = 0;
  if (todo.length) {
    const emb = embedder ?? await loadEmbedder();
    log(`embedding ${todo.length} of ${posts.length} posts with ${MODEL.name} on ${emb.threads} threads`);
    const CHUNK = 256;
    for (let at = 0; at < todo.length; at += CHUNK) {
      const chunk = todo.slice(at, at + CHUNK);
      const vectors = await emb.embed(chunk.map((t) => t.text));
      index.upsert(chunk.map((t) => t.id), vectors);
      const done = Math.min(at + CHUNK, todo.length);
      log(`  ${done}/${todo.length}  ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
    seconds = (Date.now() - started) / 1000;
    if (!embedder) await emb.close();
  }
  const saved = index.save();
  return { embedded: todo.length, total: index.count, seconds, postsPerSecond: seconds ? +(todo.length / seconds).toFixed(1) : null, bytes: saved.bytes, dir: indexDir() };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const result = await embedArchive({
    rebuild: flag('rebuild'),
    limit: Number(arg('limit', Infinity)),
    requireModel: flag('require-model'),
    log: (m) => console.error(m)
  });
  if (result.skipped) console.log(`[embed] skipped: ${result.skipped}; ${result.pending} post(s) not in the index`);
  else console.log(JSON.stringify(result));
}
