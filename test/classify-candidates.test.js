import test from 'node:test';
import assert from 'node:assert/strict';
import { classifierLine, chunkRequests, withCandidates, candidateHint, hintedCount } from '../src/classify.js';
import { systemPrompt } from '../src/taxonomy.js';
import { storyTopic, storyRow, configuredMinSim, DEFAULT_MIN_SIM } from '../src/semantic.js';

// The semantic layer is stubbed throughout: no index on disk, no model.
const tax = {
  tech: {
    label: 'Technology',
    subtopics: {
      'ai-policy': { label: 'AI policy' },
      'coxon-resignation': { label: 'Coxon resignation', story: true, since: '2026-09-09' },
      'old-story': { label: 'Old story', story: true, retired: true },
      clash: { label: 'Clash', story: true }
    }
  },
  economy: { label: 'Economy', subtopics: {} }
};

const vec = (x) => Float32Array.of(x);

// Stories the layer knows; hits keyed by the query vector's first component.
function stubSemantic({ indexed = {}, hits = {} } = {}) {
  const stories = new Map([
    ['coxon-resignation', { key: 'coxon-resignation', label: 'Coxon resignation', macro: 'tech' }],
    ['dolly-parton-tribute', { key: 'dolly-parton-tribute', label: 'Dolly Parton tribute', macro: null }],
    ['old-story', { key: 'old-story', label: 'Old story', macro: 'tech' }],
    ['tech/clash', { key: 'tech/clash', label: 'Clash', macro: 'tech' }],
    ['unlabeled', { key: 'unlabeled', label: 'unlabeled', macro: null }],
    ['gone', { key: 'gone', label: 'Gone from the YAML', macro: 'economy' }]
  ]);
  const calls = [];
  return {
    calls,
    index: { has: (id) => id in indexed, get: (id) => indexed[id] || null },
    story: (k) => stories.get(k) || null,
    async relatedStories(v, opts) {
      calls.push({ v: v[0], opts });
      return (hits[v[0]] || []).map(([story, sim]) => ({ story, sim }));
    }
  };
}

test('classifierLine is byte-identical to the pre-hint format when a post carries no extras', () => {
  const t = { id: '1', text: 'hello', authorId: 'u', type: 'tweet' };
  assert.equal(classifierLine(t), JSON.stringify({ id: '1', text: 'hello' }));
  assert.equal(classifierLine({ ...t, candidates: [] }), JSON.stringify({ id: '1', text: 'hello' }));
  assert.equal(classifierLine({ ...t, quoting: { handle: '@x', text: 'q' } }), JSON.stringify({ id: '1', text: 'hello', quoting: { handle: '@x', text: 'q' } }));
  // candidates come last, after quoting, so the prefix of every line is unchanged
  const line = classifierLine({ ...t, quoting: { handle: '@x', text: 'q' }, candidates: [{ story: 'tech/coxon-resignation', sim: 0.87 }] });
  assert.equal(line, '{"id":"1","text":"hello","quoting":{"handle":"@x","text":"q"},"candidates":[{"story":"tech/coxon-resignation","sim":0.87}]}');
});

test('candidateHint / storyTopic: live taxonomy rows become assignable ids, the rest emerging labels or nothing', () => {
  const sem = stubSemantic();
  assert.deepEqual(candidateHint(sem.story('coxon-resignation'), tax, 0.8712), { story: 'tech/coxon-resignation', sim: 0.87 });
  assert.deepEqual(candidateHint(sem.story('tech/clash'), tax, 0.81), { story: 'tech/clash', sim: 0.81 });   // "macro/sub" key
  assert.deepEqual(candidateHint(sem.story('dolly-parton-tribute'), tax, 0.9), { emerging: 'Dolly Parton tribute', sim: 0.9 });
  assert.deepEqual(candidateHint(sem.story('old-story'), tax, 0.9), null);     // retired: not in the prompt, not a hint
  assert.deepEqual(candidateHint(sem.story('gone'), tax, 0.9), { emerging: 'Gone from the YAML', sim: 0.9 });
  assert.equal(candidateHint(sem.story('unlabeled'), tax, 0.9), null);          // label == key: nothing to reuse
  assert.equal(candidateHint(null, tax, 0.9), null);
  assert.equal(storyTopic({ key: 'coxon-resignation', macro: 'tech' }, tax), 'tech/coxon-resignation');
  assert.equal(storyTopic({ key: 'ai-policy', macro: 'tech' }, tax), 'tech/ai-policy'); // any live row, story or not
  assert.equal(storyTopic({ key: 'coxon-resignation', macro: null }, tax), null);
  assert.equal(storyTopic({ key: 'nope', macro: 'tech' }, tax), null);
  assert.equal(storyTopic({ key: 'old-story', macro: 'tech' }, tax), null);
  assert.deepEqual(storyRow({ key: 'old-story', macro: 'tech' }, tax), { id: 'tech/old-story', def: tax.tech.subtopics['old-story'] });
});

test('withCandidates attaches the top-k hints, reads the index first and embeds the rest in one batch', async () => {
  const sem = stubSemantic({
    indexed: { a: vec(1), b: vec(2) },
    hits: {
      1: [['coxon-resignation', 0.91], ['old-story', 0.9], ['dolly-parton-tribute', 0.85], ['tech/clash', 0.84], ['unlabeled', 0.83]],
      2: [],
      3: [['dolly-parton-tribute', 0.88]]
    }
  });
  const items = [
    { id: 'a', text: 'AI insiders say their technology is a threat' },
    { id: 'b', text: 'nothing near' },
    { id: 'c', text: 'remembering Dolly', quoting: { handle: '@x', text: 'RIP' } },
    { id: 'd', text: 'also not indexed' }
  ];
  const embedded = [];
  const embed = async (texts) => { embedded.push(texts); return texts.map(() => vec(3)); };
  const warnings = [];
  const out = await withCandidates(items, sem, { tax, k: 3, minSim: 0.8, embed, warn: (m) => warnings.push(m) });
  assert.equal(out.length, 4);
  assert.deepEqual(out.map((t) => t.id), ['a', 'b', 'c', 'd']);           // order kept
  // a: retired row dropped, then k=3 of what is left
  assert.deepEqual(out[0].candidates, [{ story: 'tech/coxon-resignation', sim: 0.91 }, { emerging: 'Dolly Parton tribute', sim: 0.85 }, { story: 'tech/clash', sim: 0.84 }]);
  assert.equal(out[1], items[1]);                                          // no hits → the same object, untouched
  assert.deepEqual(out[2].candidates, [{ emerging: 'Dolly Parton tribute', sim: 0.88 }]);
  assert.deepEqual(out[2].quoting, { handle: '@x', text: 'RIP' });         // extras coexist
  assert.deepEqual(out[3].candidates, [{ emerging: 'Dolly Parton tribute', sim: 0.88 }]);
  // one embed call for the two unindexed posts; indexed ones never hit the model
  assert.deepEqual(embedded, [['remembering Dolly', 'also not indexed']]);
  // relatedStories asked for 2k so dropped hints can be replaced, at the caller's floor
  assert.equal(sem.calls.length, 4);
  assert.deepEqual(sem.calls[0].opts, { k: 6, minSim: 0.8 });
  assert.deepEqual(warnings, []);
  assert.equal(hintedCount(out), 3);
  // inputs are not mutated
  assert.equal(items[0].candidates, undefined);
});

test('withCandidates degrades: no layer → same array; model missing → indexed posts still hinted, one warning', async () => {
  const items = [{ id: 'a', text: 'x' }, { id: 'z', text: 'y' }];
  assert.equal(await withCandidates(items, null, { tax }), items);
  assert.equal(await withCandidates([], stubSemantic(), { tax }).then((r) => r.length), 0);
  const sem = stubSemantic({ indexed: { a: vec(1) }, hits: { 1: [['coxon-resignation', 0.9]] } });
  const warnings = [];
  const embed = async () => { throw new Error('embedding model file missing: data/models/... (run: npm run download-model)'); };
  const out = await withCandidates(items, sem, { tax, embed, warn: (m) => warnings.push(m) });
  assert.deepEqual(out[0].candidates, [{ story: 'tech/coxon-resignation', sim: 0.9 }]);
  assert.equal(out[1], items[1]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /1 unindexed post\(s\) skipped .*download-model/);
  // k = 0 switches hints off entirely without touching the layer
  assert.equal(await withCandidates(items, sem, { tax, k: 0 }), items);
});

test('chunkRequests: the request is byte-stable without hints and only the input lines change with them', () => {
  const items = [{ id: '1', text: 'a' }, { id: '2', text: 'b', quoting: { handle: '@q', text: 'quoted' } }];
  const plain = chunkRequests(items, tax, 'model-x');
  assert.equal(plain.length, 1);
  assert.equal(plain[0].params.messages[0].content, '{"id":"1","text":"a"}\n{"id":"2","text":"b","quoting":{"handle":"@q","text":"quoted"}}');
  const hinted = chunkRequests([{ ...items[0], candidates: [{ story: 'tech/coxon-resignation', sim: 0.9 }] }, items[1]], tax, 'model-x');
  assert.equal(hinted[0].params.messages[0].content, '{"id":"1","text":"a","candidates":[{"story":"tech/coxon-resignation","sim":0.9}]}\n{"id":"2","text":"b","quoting":{"handle":"@q","text":"quoted"}}');
  // the cached system block does not depend on the items at all
  assert.deepEqual(hinted[0].params.system, plain[0].params.system);
  assert.equal(plain[0].params.system[0].cache_control.type, 'ephemeral');
});

test('systemPrompt is deterministic and carries the candidates rule exactly once', () => {
  const a = systemPrompt(tax);
  assert.equal(a, systemPrompt(tax));
  assert.equal(a.split('Some inputs carry "candidates"').length, 2);
  assert.match(a, /hints, not labels/);
  assert.match(a, /Assign a candidate only when the tweet's\s+text \(or its quoted context\) supports it/);
  // the rule sits with the other input rules, before the reply contract
  assert.ok(a.indexOf('Some inputs carry "candidates"') < a.indexOf('Reply with ONLY a JSON object'));
  assert.ok(a.indexOf('Some inputs carry "quoting"') < a.indexOf('Some inputs carry "candidates"'));
  // and the prompt with correction precedents keeps the rule too
  assert.match(systemPrompt(tax, { examples: [{ text: 't', topics: [['tech', null]] }] }), /Some inputs carry "candidates"/);
});

test('configuredMinSim reads settings.semantic.min_sim and falls back to the calibrated default', () => {
  const v = configuredMinSim();
  assert.ok(v > 0 && v < 1);
  assert.equal(DEFAULT_MIN_SIM, 0.8);
});
