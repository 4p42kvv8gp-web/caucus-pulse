import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { embeddingModel, modelFileDigest, EMBEDDING_RUNTIME_VERSION } from './embedding-models.js';
import { semanticPassages } from './passages.js';

export async function createEmbeddingRuntime({ name = 'minilm', modelRoot = resolve('data/models') } = {}) {
  const model = embeddingModel(name), directory = join(modelRoot, model.artifactKey);
  for (const [file, size, digest] of model.files) {
    const bytes = await readFile(join(directory, file));
    if (bytes.length !== size || modelFileDigest(bytes, digest) !== digest) throw new Error('Local embedding model failed verification.');
  }
  const { pipeline, env } = await import('@huggingface/transformers');
  if (env.version !== EMBEDDING_RUNTIME_VERSION) throw new Error('Embedding runtime version differs from the pinned version.');
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.useFSCache = false;
  env.useBrowserCache = false;
  env.localModelPath = modelRoot;
  const extractor = await pipeline('feature-extraction', directory, {
    device: 'cpu', dtype: model.dtype, local_files_only: true,
    session_options: { intraOpNumThreads: 2, interOpNumThreads: 1, executionMode: 'sequential' }
  });
  const countTokens = text => extractor.tokenizer(text, {
    padding: false, truncation: false, add_special_tokens: true, return_tensor: false
  }).input_ids.length;
  let disposed = false;
  async function vectors(texts) {
    if (disposed) throw new Error('Embedding runtime is closed.');
    if (!Array.isArray(texts) || !texts.length || texts.length > 8) throw new Error('Invalid embedding batch size.');
    for (const text of texts) if (typeof text !== 'string' || !text.length || countTokens(text) > model.maxTokens) throw new Error('Embedding input exceeds the pinned token limit.');
    const output = await extractor(texts, { pooling: model.pooling, normalize: true });
    try {
      if (output.dims.length !== 2 || output.dims[0] !== texts.length || output.dims[1] !== model.dimensions) throw new Error('Unexpected embedding dimensions.');
      const result = output.tolist();
      for (const vector of result) {
        const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
        if (vector.some(v => !Number.isFinite(v)) || Math.abs(norm - 1) > 0.001) throw new Error('Embedding is not a finite normalized vector.');
      }
      return result;
    } finally { output.dispose(); }
  }
  return {
    model, countTokens,
    async embedPost(text) {
      const {passages,detailOmitted,detailDuplicateOccurrences} = semanticPassages(text, countTokens, model);
      const unique = [...new Set(passages.map(p => p.text))], cache = new Map();
      for (let offset = 0; offset < unique.length; offset += 4) {
        const batch = unique.slice(offset, offset + 4);
        const values = await vectors(batch);
        batch.forEach((text, index) => cache.set(text, values[index]));
      }
      for (const passage of passages) passage.vector = cache.get(passage.text);
      return { modelFingerprint: model.fingerprint, textLength: text.length, coveredCharacters: text.length, detailOmitted, detailDuplicateOccurrences, passages };
    },
    async embedQuery(text) {
      if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('A semantic query must contain 1–2,000 characters.');
      const prefixed = model.queryPrefix + text;
      if (countTokens(prefixed) > model.maxTokens) throw new Error('Semantic query is too long for this model; shorten it without changing its meaning.');
      return { modelFingerprint: model.fingerprint, vector: (await vectors([prefixed]))[0] };
    },
    async close() { if (!disposed) { disposed = true; await extractor.dispose(); } }
  };
}

export function cosine(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || !left.length || left.length !== right.length) throw new Error('Incompatible embedding vectors.');
  let dot = 0, a = 0, b = 0;
  for (let i = 0; i < left.length; i++) {
    if (!Number.isFinite(left[i]) || !Number.isFinite(right[i])) throw new Error('Invalid embedding vector value.');
    dot += left[i] * right[i]; a += left[i] * left[i]; b += right[i] * right[i];
  }
  if (a === 0 || b === 0) throw new Error('An embedding cannot be a zero vector.');
  return Math.max(-1, Math.min(1, dot / Math.sqrt(a * b)));
}
