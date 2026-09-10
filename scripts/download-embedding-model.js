// Fetch the pinned embedding model into data/models/ (git-ignored) and verify
// every file's size and digest before it is published to its final directory.
// This is the only network-enabled step of the semantic layer; it downloads
// four public files from the Hub at a fixed commit and sends nothing.
//
//   node --use-env-proxy scripts/download-embedding-model.js   (npm run download-model)
import fs from 'node:fs';
import path from 'node:path';
import { MODEL, modelDir, verifyModelFiles, fileDigest } from '../src/embeddings.js';

const destination = modelDir();

try {
  const bytes = verifyModelFiles(destination);
  console.log(JSON.stringify({ status: 'already-verified', model: MODEL.name, revision: MODEL.revision, dir: destination, bytes }));
  process.exit(0);
} catch { /* missing or corrupt → fetch into a staging dir */ }

const staging = `${destination}.partial-${process.pid}`;
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(path.join(staging, 'onnx'), { recursive: true });

try {
  for (const [name, size, digest] of MODEL.files) {
    const url = `https://huggingface.co/${MODEL.repository}/resolve/${MODEL.revision}/${name}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(180_000), redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`download failed (${res.status}): ${name}`);
    const parts = [];
    let length = 0;
    for await (const part of res.body) {
      length += part.length;
      if (length > size) throw new Error(`download exceeded pinned size: ${name}`);
      parts.push(part);
    }
    const bytes = Buffer.concat(parts);
    if (bytes.length !== size || fileDigest(bytes, digest) !== digest) throw new Error(`digest mismatch: ${name}`);
    fs.writeFileSync(path.join(staging, name), bytes, { flag: 'wx' });
    console.error(`fetched ${name} (${size} bytes, verified)`);
  }
  verifyModelFiles(staging);
  // A corrupt existing directory is replaced only now that the new one is whole.
  fs.rmSync(destination, { recursive: true, force: true });
  fs.renameSync(staging, destination);
  console.log(JSON.stringify({
    status: 'downloaded-and-verified', model: MODEL.name, revision: MODEL.revision, dir: destination,
    bytes: MODEL.files.reduce((n, f) => n + f[1], 0)
  }));
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
