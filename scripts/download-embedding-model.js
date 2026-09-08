import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { embeddingModel, modelFileDigest } from '../src/embedding-models.js';

const model = embeddingModel(process.argv[2] ?? 'minilm');
const root = resolve('data/models');
const destination = join(root, model.artifactKey);
const staging = `${destination}.partial-${randomUUID()}`;

async function verify(directory) {
  for (const [name, size, digest] of model.files) {
    const bytes = await readFile(join(directory, name));
    if (bytes.length !== size || modelFileDigest(bytes, digest) !== digest) throw new Error('Model file verification failed.');
  }
}

try {
  await verify(destination);
  await writeFile(join(destination,'manifest.json'),JSON.stringify(model,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({ status: 'already-verified', model: model.name, fingerprint: model.fingerprint }));
} catch {
  // The only network-enabled step. No post, review, query, cookie or credential is sent.
  await mkdir(join(staging, 'onnx'), { recursive: true, mode: 0o700 });
  try {
    for (const [name, size, digest] of model.files) {
      const url = `https://huggingface.co/${model.repository}/resolve/${model.revision}/${name}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(120000), credentials: 'omit' });
      if (!response.ok || !response.body || !response.url.startsWith('https://')) throw new Error('Model download failed.');
      const parts = []; let length = 0;
      for await (const part of response.body) {
        length += part.length;
        if (length > size) { await response.body.cancel().catch(() => {}); throw new Error('Model download exceeded its pinned size.'); }
        parts.push(part);
      }
      const bytes = Buffer.concat(parts);
      if (length !== size || modelFileDigest(bytes, digest) !== digest) throw new Error('Model digest mismatch.');
      await writeFile(join(staging, name), bytes, { mode: 0o600, flag: 'wx' });
    }
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(model, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await verify(staging);
    // Refuse to replace an existing corrupt directory; it needs an explicit local repair.
    await rename(staging, destination);
    console.log(JSON.stringify({ status: 'downloaded-and-verified', model: model.name,
      fingerprint: model.fingerprint, bytes: model.files.reduce((n, f) => n + f[1], 0) }));
  } finally { await rm(staging, { recursive: true, force: true }); }
}
