// Local sentence embeddings for the corpus: BGE-small (ONNX, int8 weights)
// through @huggingface/transformers on the CPU. Nothing here touches the
// network: the model is fetched once by scripts/download-embedding-model.js
// into data/models/ (git-ignored) and re-verified against the pinned digests
// every time it is loaded.
//
// Model choice. Both candidates the Codex branch shipped are 384-dimensional
// and cost about the same per token on CPU; BGE-small-en-v1.5 scores higher
// on retrieval benchmarks (MTEB) and won the Codex branch's own paraphrase
// probe, which is what story matching needs ("wakeup call for Congress" has
// to land next to "Anthropic researcher resigns"). Its 512-token ceiling is
// moot for 280-character posts. The price is ~3x MiniLM's wall time — a few
// minutes for the whole archive on four cores, see docs/SEMANTIC_MATCHING.md.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { p } from './util.js';

// @huggingface/transformers, pinned exactly in package.json. The q8 file
// layout and the pipeline options below were verified against this version.
export const RUNTIME_VERSION = '3.8.1';

export const MODEL = Object.freeze({
  name: 'bge-small-en-v1.5',
  // ONNX conversion of BAAI/bge-small-en-v1.5 (MIT). A conversion is its own
  // artifact, hence the pin on the conversion repo + commit, not the original.
  repository: 'Xenova/bge-small-en-v1.5',
  revision: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
  dim: 384,
  // The original model's contract is CLS pooling + L2 normalisation; the
  // conversion's README example uses mean pooling, which is not the same model.
  pooling: 'cls',
  dtype: 'q8',          // -> onnx/model_quantized.onnx
  maxTokens: 512,
  // BGE's instruction for short free-text queries against passages. Not used
  // for post-to-post or centroid comparisons, which are symmetric.
  queryPrefix: 'Represent this sentence for searching relevant passages: ',
  // [path, bytes, digest]. 40 hex = git blob sha1 (what the Hub shows for
  // small files); 64 hex = sha256 (what the Hub shows for LFS objects).
  files: Object.freeze([
    ['config.json', 683, '0c4d86248983ce46dfc09a9091b6f56bb0224550'],
    ['tokenizer.json', 711396, '688882a79f44442ddc1f60d70334a7ff5df0fb47'],
    ['tokenizer_config.json', 366, '37fca74771bc76a8e01178ce3a6055a0995f8093'],
    ['onnx/model_quantized.onnx', 34014426, '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4']
  ])
});

// Stable identity written into index manifests: a vector is only comparable
// with vectors from the same conversion, pooling and weight precision.
export const modelId = () => `${MODEL.repository}@${MODEL.revision}#${MODEL.pooling}/${MODEL.dtype}`;

export const modelsRoot = () => process.env.EMBEDDING_MODELS_ROOT || p('data', 'models');
export const modelKey = () => `${MODEL.name}-${MODEL.revision.slice(0, 12)}`;
export const modelDir = () => path.join(modelsRoot(), modelKey());

export function fileDigest(bytes, expected) {
  if (expected.length === 64) return createHash('sha256').update(bytes).digest('hex');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

// Throws naming the first file that is missing, the wrong size or the wrong
// digest; returns the total byte count when everything matches.
export function verifyModelFiles(dir = modelDir()) {
  let total = 0;
  for (const [name, size, digest] of MODEL.files) {
    const file = path.join(dir, name);
    let bytes;
    try { bytes = fs.readFileSync(file); } catch { throw new Error(`embedding model file missing: ${file} (run: npm run download-model)`); }
    if (bytes.length !== size) throw new Error(`embedding model file has ${bytes.length} bytes, expected ${size}: ${file}`);
    if (fileDigest(bytes, digest) !== digest) throw new Error(`embedding model file digest mismatch: ${file}`);
    total += size;
  }
  return total;
}

// Is the model on disk and intact? The poller, the nightly embed step and the
// classifier's similarity hints ask this before doing any work, so a checkout
// that never ran `npm run download-model` skips with one line instead of a
// stack trace. Costs one read + digest of the 34 MB weights (~0.1 s).
export function modelAvailable(dir = modelDir()) {
  try { verifyModelFiles(dir); return true; } catch { return false; }
}

// What actually gets embedded. Post text minus the link tokens X appends
// (t.co stubs carry no meaning and a post that is only a card link would
// otherwise embed as noise); HTML entities decoded; whitespace folded.
// Quotes and replies get nothing extra for now — the quoted post's text is
// another builder's job and a later index version.
export function prepareText(text) {
  const out = String(text ?? '')
    .replace(/https?:\/\/t\.co\/\w+/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return out || '(no text)';
}

export function normalise(vec) {
  let s = 0;
  for (let i = 0; i < vec.length; i++) s += vec[i] * vec[i];
  const n = Math.sqrt(s);
  if (n > 0) for (let i = 0; i < vec.length; i++) vec[i] /= n;
  return vec;
}

// Load the model once. Returns { embed(texts, {query, batchSize}), dim, close }.
// embed() resolves to one Float32Array per input, L2-normalised, in input order.
export async function loadEmbedder({ dir = modelDir(), threads = Math.max(1, os.availableParallelism?.() ?? 1) } = {}) {
  verifyModelFiles(dir);
  const { pipeline, env } = await import('@huggingface/transformers');
  if (env.version !== RUNTIME_VERSION) {
    throw new Error(`@huggingface/transformers ${env.version} loaded, ${RUNTIME_VERSION} pinned`);
  }
  // Belt and braces: never fetch, never cache anywhere but our directory.
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.useFSCache = false;
  env.useBrowserCache = false;
  env.localModelPath = path.dirname(dir);
  const extractor = await pipeline('feature-extraction', path.basename(dir), {
    device: 'cpu',
    dtype: MODEL.dtype,
    local_files_only: true,
    session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 }
  });
  let closed = false;

  async function embed(texts, { query = false, batchSize = 32 } = {}) {
    if (closed) throw new Error('embedder is closed');
    const prepared = texts.map((t) => (query ? MODEL.queryPrefix : '') + prepareText(t));
    // Sort by length so a batch pads to its own longest member, not the
    // corpus's; the tokenizer pads every batch to a rectangle.
    const order = prepared.map((t, i) => i).sort((a, b) => prepared[a].length - prepared[b].length);
    const rows = new Array(texts.length);
    for (let at = 0; at < order.length; at += batchSize) {
      const idx = order.slice(at, at + batchSize);
      const out = await extractor(idx.map((i) => prepared[i]), { pooling: MODEL.pooling, normalize: true });
      try {
        const [n, dim] = out.dims;
        if (n !== idx.length || dim !== MODEL.dim) throw new Error(`unexpected embedding shape ${out.dims}`);
        for (let r = 0; r < n; r++) {
          const vec = new Float32Array(out.data.buffer, out.data.byteOffset + r * dim * 4, dim).slice();
          for (let j = 0; j < dim; j++) if (!Number.isFinite(vec[j])) throw new Error('non-finite embedding');
          rows[idx[r]] = normalise(vec);
        }
      } finally { out.dispose(); }
    }
    return rows;
  }

  return {
    model: MODEL, dim: MODEL.dim, threads, embed,
    async close() { if (!closed) { closed = true; await extractor.dispose(); } }
  };
}

// Process-wide lazy embedder for callers that just want vectors. Tests stub
// this by handing their own embed() to the index / semantic layer instead.
let shared = null;
export async function embed(texts, opts) {
  shared ??= loadEmbedder();
  return (await shared).embed(texts, opts);
}
