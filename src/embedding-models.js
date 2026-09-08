import { createHash } from 'node:crypto';

// Public model revisions and blob digests inspected on September 8, 2026.
// ONNX conversions are distinct artifacts from their original model repositories.
const definitions = {
  minilm: {
    repository: 'Xenova/all-MiniLM-L6-v2', original: 'sentence-transformers/all-MiniLM-L6-v2',
    revision: '751bff37182d3f1213fa05d7196b954e230abad9', license: 'Apache-2.0',
    pooling: 'mean', maxTokens: 256, queryPrefix: '',
    files: [
      ['config.json', 650, '72147e4ff4426ebedbfa2146c4a0999def51a313'],
      ['tokenizer.json', 711661, 'c17ed520ed8438736732a54957a69306b8822215'],
      ['tokenizer_config.json', 366, '37fca74771bc76a8e01178ce3a6055a0995f8093'],
      ['onnx/model_quantized.onnx', 22972370, 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1']
    ]
  },
  bge: {
    repository: 'Xenova/bge-small-en-v1.5', original: 'BAAI/bge-small-en-v1.5',
    revision: 'ea104dacec62c0de699686887e3f920caeb4f3e3', license: 'MIT (original model)',
    pooling: 'cls', maxTokens: 512,
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
    files: [
      ['config.json', 683, '0c4d86248983ce46dfc09a9091b6f56bb0224550'],
      ['tokenizer.json', 711396, '688882a79f44442ddc1f60d70334a7ff5df0fb47'],
      ['tokenizer_config.json', 366, '37fca74771bc76a8e01178ce3a6055a0995f8093'],
      ['onnx/model_quantized.onnx', 34014426, '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4']
    ]
  }
};

export const EMBEDDING_RUNTIME_VERSION = '3.8.1';
export const PASSAGE_VERSION = 'utf16-covered-overlap-plus-unique-sentences-v3';
export function embeddingModel(name = 'minilm') {
  if (!Object.hasOwn(definitions, name)) throw new Error('Unknown embedding model.');
  const model = { name, ...structuredClone(definitions[name]), dimensions: 384, dtype: 'q8',
    runtime: `@huggingface/transformers@${EMBEDDING_RUNTIME_VERSION}`, passageVersion: PASSAGE_VERSION,
    overlapTokens: 40, maxCharacters: 100000, maxPassages: 256 };
  const fingerprint = createHash('sha256').update(JSON.stringify(model)).digest('hex');
  const artifactKey = `${name}-${model.revision}`;
  return Object.freeze({ ...model, fingerprint, artifactKey });
}

export function modelFileDigest(bytes, expected) {
  if (expected.length === 64) return createHash('sha256').update(bytes).digest('hex');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}
