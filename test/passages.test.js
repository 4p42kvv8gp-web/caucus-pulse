import test from 'node:test';
import assert from 'node:assert/strict';
import { coveredPassages, semanticPassages } from '../src/passages.js';
import { embeddingModel, modelFileDigest } from '../src/embedding-models.js';
import { cosine } from '../src/local-embeddings.js';

const model = { maxCharacters: 10000, maxPassages: 200, maxTokens: 32, overlapTokens: 5 };
const counter = text => [...text].length + 2;
test('passages cover every UTF-16 position, preserve wording and keep Unicode pairs intact', () => {
  const text = 'Do NOT assume agreement. “Do not evacuate” is a quotation. 🧑🏽‍🚒 Café\n'.repeat(14) + 'Final gas leak report.';
  const passages = coveredPassages(text, counter, model);
  const positions = new Set();
  for (const p of passages) {
    assert.equal(text.slice(p.start,p.end),p.text);
    assert.ok(counter(p.text) <= model.maxTokens);
    assert.equal(p.text.isWellFormed(),true);
    for (let i=p.start;i<p.end;i++) positions.add(i);
  }
  assert.equal(positions.size,text.length);
  assert.ok(passages.some(p => p.text.endsWith('Final gas leak report.')));
  assert.ok(passages.length > 2);
});
test('single-token long words and punctuation cannot evade size limits or stall overlap', () => {
  const text = 'x'.repeat(6000);
  const p = coveredPassages(text, () => 3, model);
  assert.equal(p.at(-1).end,text.length);
  assert.ok(p.length > 1);
  assert.throws(() => coveredPassages(text, counter, { ...model,maxPassages:2 }),/passage limit/);
  assert.throws(() => coveredPassages(text,counter,{...model,maxCharacters:100}),/character limit/);
  assert.throws(() => coveredPassages('  ',counter,model),/contain text/);
});
test('non-monotonic token counts are rechecked after choosing a source boundary', () => {
  const odd = text => text.length === 27 ? 80 : text.length + 2;
  const passages = coveredPassages('An unusually long statement. Another statement. '.repeat(5),odd,model);
  assert.ok(passages.every(p => odd(p.text) <= model.maxTokens));
});
test('model identity, digests and cosine reject incompatible or meaningless vectors', () => {
  assert.equal(embeddingModel().fingerprint,embeddingModel().fingerprint);
  assert.notEqual(embeddingModel().fingerprint,embeddingModel('bge').fingerprint);
  assert.equal(embeddingModel('bge').pooling,'cls');
  assert.throws(() => embeddingModel('../escape'),/Unknown/);
  assert.equal(modelFileDigest(Buffer.from('hello'), '0'.repeat(40)), 'b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0');
  assert.equal(cosine([1,0],[-1,0]),-1);
  assert.equal(cosine([1,1],[2,2]),1);
  assert.throws(() => cosine([0],[0]),/zero vector/);
  assert.throws(() => cosine([1],[1,2]),/Incompatible/);
  assert.throws(() => cosine([NaN],[1]),/Invalid/);
});

test('sentence detail exposes a late subject independently while retaining context and disclosed caps', () => {
  const text = 'Regular office updates. '.repeat(10) + 'A gas leak closed the school.';
  const result = semanticPassages(text, counter, { ...model,maxTokens:128 });
  assert.ok(result.passages.some(p => p.kind === 'sentence' && p.text === 'A gas leak closed the school.'));
  assert.ok(result.passages.some(p => p.kind === 'context-window'));
  const bounded = semanticPassages(text,counter,{...model,maxTokens:128,maxPassages:4});
  assert.equal(bounded.passages.length,4);
  assert.ok(bounded.detailOmitted > 0);
  assert.equal(Math.max(...bounded.passages.map(p => p.end)),text.length);
});
