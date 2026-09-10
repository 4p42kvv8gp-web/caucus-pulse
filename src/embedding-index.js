// The committed vector index for the corpus: one row per archived post.
//
//   data/embeddings/index.bin   n rows × dim int8 (row-major), then n float32
//                               per-row scales, little-endian
//   data/embeddings/index.json  { version, format, model, dim, count, ids, updatedAt }
//
// Rows are stored int8 with a per-row scale (|error| < 0.5 × scale per
// component, cosine error ~1e-4 for a normalised 384-d vector) so ten
// thousand posts cost ~4 MB in git instead of 16 MB as float32. In memory the
// rows are dequantised back to normalised float32 once, and neighbours are a
// dot product over the whole matrix — 4M multiplies for 10k posts, well
// under 10 ms, so there is no approximate structure to maintain.
//
// upsert() is the incremental path: the poller (later) embeds only the ids
// the index does not have and saves. The manifest carries the model id so a
// changed model forces a rebuild rather than mixing vector spaces.
import fs from 'node:fs';
import path from 'node:path';
import { p } from './util.js';
import { normalise } from './embeddings.js';

export const FORMAT = 'int8-rowscale-v1';
export const indexDir = () => process.env.EMBEDDING_INDEX_DIR || p('data', 'embeddings');
export const binPath = (dir = indexDir()) => path.join(dir, 'index.bin');
export const manifestPath = (dir = indexDir()) => path.join(dir, 'index.json');

export function quantiseRow(vec) {
  let maxAbs = 0;
  for (let i = 0; i < vec.length; i++) maxAbs = Math.max(maxAbs, Math.abs(vec[i]));
  const scale = maxAbs > 0 ? maxAbs / 127 : 1;
  const q = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(vec[i] / scale)));
  return { q, scale };
}

export function dequantiseRow(q, scale) {
  const vec = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) vec[i] = q[i] * scale;
  return normalise(vec);
}

export function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // both inputs are unit vectors
}

export function createIndex({ dim, model }) {
  if (!dim || !model) throw new Error('createIndex needs {dim, model}');
  let ids = [];
  const pos = new Map();
  let matrix = new Float32Array(0);
  const ensure = (rows) => {
    if (rows * dim <= matrix.length) return;
    const grown = new Float32Array(Math.max(rows, ids.length * 2, 256) * dim);
    grown.set(matrix);
    matrix = grown;
  };

  const index = {
    dim, model,
    get count() { return ids.length; },
    get ids() { return ids.slice(); },
    has: (id) => pos.has(String(id)),
    // A copy, so callers can mutate freely (centroid maths, etc.).
    get(id) {
      const r = pos.get(String(id));
      return r == null ? null : matrix.slice(r * dim, (r + 1) * dim);
    },
    // Insert or replace rows. Vectors are normalised on the way in so the
    // dot product in neighbors() is a cosine regardless of what was passed.
    upsert(newIds, vectors) {
      if (newIds.length !== vectors.length) throw new Error('upsert: ids and vectors differ in length');
      ensure(ids.length + newIds.length);
      newIds.forEach((rawId, i) => {
        const id = String(rawId);
        const vec = vectors[i];
        if (!vec || vec.length !== dim) throw new Error(`upsert: vector for ${id} has ${vec?.length} dims, index has ${dim}`);
        let r = pos.get(id);
        if (r == null) { r = ids.length; ids.push(id); pos.set(id, r); }
        matrix.set(normalise(Float32Array.from(vec)), r * dim);
      });
      return index;
    },
    // Nearest rows to a unit vector. `exclude` is a Set of ids or a predicate
    // on id; `minSim` drops weak matches before the top-k cut.
    neighbors(vector, k = 10, { exclude = null, minSim = -Infinity } = {}) {
      if (!vector || vector.length !== dim) throw new Error('neighbors: query vector has the wrong dimension');
      const skip = exclude instanceof Set ? (id) => exclude.has(id) : (typeof exclude === 'function' ? exclude : () => false);
      const hits = [];
      for (let r = 0; r < ids.length; r++) {
        const off = r * dim;
        let dot = 0;
        for (let j = 0; j < dim; j++) dot += matrix[off + j] * vector[j];
        if (dot < minSim || skip(ids[r])) continue;
        hits.push({ id: ids[r], sim: dot });
      }
      hits.sort((a, b) => b.sim - a.sim);
      return hits.slice(0, k);
    },
    // Serialise. Written to temp files then renamed so a reader never sees a
    // half-written pair.
    save(dir = indexDir()) {
      fs.mkdirSync(dir, { recursive: true });
      const n = ids.length;
      const buf = Buffer.alloc(n * dim + n * 4);
      for (let r = 0; r < n; r++) {
        const { q, scale } = quantiseRow(matrix.subarray(r * dim, (r + 1) * dim));
        buf.set(new Uint8Array(q.buffer), r * dim);
        buf.writeFloatLE(scale, n * dim + r * 4);
      }
      const manifest = { version: 1, format: FORMAT, model, dim, count: n, updatedAt: new Date().toISOString(), ids };
      const tmpBin = `${binPath(dir)}.tmp`, tmpJson = `${manifestPath(dir)}.tmp`;
      fs.writeFileSync(tmpBin, buf);
      fs.writeFileSync(tmpJson, JSON.stringify(manifest));
      fs.renameSync(tmpBin, binPath(dir));
      fs.renameSync(tmpJson, manifestPath(dir));
      return { bytes: buf.length + fs.statSync(manifestPath(dir)).size, count: n };
    }
  };
  return index;
}

// Read the committed index. Returns null when there is none yet; throws on a
// manifest/bin mismatch rather than serving vectors for the wrong ids.
export function load(dir = indexDir()) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8')); } catch { return null; }
  if (manifest.format !== FORMAT) throw new Error(`embedding index format ${manifest.format} is not ${FORMAT}`);
  const { dim, model, ids } = manifest;
  const n = ids.length;
  const buf = fs.readFileSync(binPath(dir));
  if (buf.length !== n * dim + n * 4) throw new Error(`index.bin is ${buf.length} bytes, manifest implies ${n * dim + n * 4}`);
  const index = createIndex({ dim, model });
  const vectors = new Array(n);
  for (let r = 0; r < n; r++) {
    const q = new Int8Array(buf.buffer, buf.byteOffset + r * dim, dim);
    vectors[r] = dequantiseRow(q, buf.readFloatLE(n * dim + r * 4));
  }
  index.upsert(ids, vectors);
  return index;
}
