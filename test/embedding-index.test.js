import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIndex, load, quantiseRow, dequantiseRow, cosine, FORMAT } from '../src/embedding-index.js';
import { normalise, prepareText } from '../src/embeddings.js';

// No model, no network: vectors here are hand-made.
const unit = (...xs) => normalise(Float32Array.from(xs));
const rand = (dim, seed) => {
  let s = seed;
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; v[i] = (s / 0x7fffffff) - 0.5; }
  return normalise(v);
};

test('int8 row quantisation round-trips a unit vector within tolerance', () => {
  const v = rand(384, 7);
  const { q, scale } = quantiseRow(v);
  assert.equal(q.length, 384);
  const back = dequantiseRow(q, scale);
  let maxErr = 0;
  for (let i = 0; i < v.length; i++) maxErr = Math.max(maxErr, Math.abs(v[i] - back[i]));
  assert.ok(maxErr < scale, `component error ${maxErr} exceeds one quantisation step ${scale}`);
  assert.ok(cosine(v, back) > 0.9999, `cosine ${cosine(v, back)} after round trip`);
  // the zero vector does not divide by zero
  const z = quantiseRow(new Float32Array(4));
  assert.equal(z.scale, 1);
});

test('upsert / get / has / neighbors with exclusion and minSim', () => {
  const index = createIndex({ dim: 3, model: 'stub' });
  index.upsert(['a', 'b', 'c'], [unit(1, 0, 0), unit(0, 1, 0), unit(0.9, 0.1, 0)]);
  assert.equal(index.count, 3);
  assert.ok(index.has('a') && !index.has('zzz'));
  // get() returns a copy: mutating it must not touch the index
  const got = index.get('a');
  got[0] = 0;
  assert.equal(index.get('a')[0], 1);
  // ordering: c (0.99) then b (0) for a query along x
  const hits = index.neighbors(unit(1, 0, 0), 10, { exclude: new Set(['a']) });
  assert.deepEqual(hits.map((h) => h.id), ['c', 'b']);
  assert.ok(hits[0].sim > 0.99 && Math.abs(hits[1].sim) < 1e-6);
  // minSim drops the orthogonal row; a predicate exclude works too
  assert.deepEqual(index.neighbors(unit(1, 0, 0), 10, { minSim: 0.5 }).map((h) => h.id), ['a', 'c']);
  assert.deepEqual(index.neighbors(unit(1, 0, 0), 10, { exclude: (id) => id === 'c' }).map((h) => h.id), ['a', 'b']);
  // k caps
  assert.equal(index.neighbors(unit(1, 0, 0), 1).length, 1);
  // upsert of an existing id replaces its row, count unchanged; input is normalised
  index.upsert(['b'], [Float32Array.from([5, 0, 0])]);
  assert.equal(index.count, 3);
  assert.ok(cosine(index.get('b'), unit(1, 0, 0)) > 0.999);
  assert.throws(() => index.upsert(['d'], [unit(1, 0)]), /dims/);
  assert.throws(() => index.neighbors(unit(1, 0), 1), /dimension/);
});

test('save + load round-trips ids, model and vectors; load on empty dir is null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-index-'));
  try {
    assert.equal(load(dir), null);
    const index = createIndex({ dim: 384, model: 'stub-model@rev' });
    const ids = ['2097000000000000001', '2097000000000000002', '2097000000000000003'];
    const vectors = ids.map((_, i) => rand(384, 100 + i));
    index.upsert(ids, vectors);
    const saved = index.save(dir);
    assert.equal(saved.count, 3);
    assert.equal(fs.statSync(path.join(dir, 'index.bin')).size, 3 * 384 + 3 * 4);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    assert.equal(manifest.format, FORMAT);
    assert.deepEqual(manifest.ids, ids);

    const back = load(dir);
    assert.equal(back.count, 3);
    assert.equal(back.model, 'stub-model@rev');
    assert.deepEqual(back.ids, ids);
    for (let i = 0; i < ids.length; i++) assert.ok(cosine(back.get(ids[i]), vectors[i]) > 0.9999);
    // neighbours agree with the in-memory index
    const q = rand(384, 999);
    assert.deepEqual(back.neighbors(q, 3).map((h) => h.id), index.neighbors(q, 3).map((h) => h.id));
    // the incremental path: add one more and save again
    back.upsert(['2097000000000000004'], [rand(384, 4)]);
    back.save(dir);
    assert.equal(load(dir).count, 4);
    // a truncated bin is refused rather than misread
    fs.truncateSync(path.join(dir, 'index.bin'), 100);
    assert.throws(() => load(dir), /index\.bin/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prepareText strips t.co stubs and entities, never returns empty', () => {
  assert.equal(prepareText('S&amp;P 500 gained 600% https://t.co/Go4ZiRJ4ae https://t.co/4DOX5Ma1pO'), 'S&P 500 gained 600%');
  assert.equal(prepareText('  line\n\nbreak  '), 'line break');
  assert.equal(prepareText('https://t.co/abc'), '(no text)');
  assert.equal(prepareText(null), '(no text)');
});
