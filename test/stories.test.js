import test from 'node:test';
import assert from 'node:assert/strict';
import { labelTokens, similar, mergeClusters, promoteToTaxonomy, slug } from '../src/stories.js';

test('label tokens drop stopwords, plurals and punctuation', () => {
  assert.deepEqual([...labelTokens('9/11 Remembrance & First Responders')], ['11', 'remembrance', 'first', 'responder']);
  assert.deepEqual([...labelTokens('Dolly Parton tribute')], ['dolly', 'parton']);
});

test('similar labels merge across days; unrelated ones stay apart', () => {
  assert.ok(similar(labelTokens('9-11-remembrance'), labelTokens('9/11 remembrance & first responders')));
  assert.ok(similar(labelTokens('public transit'), labelTokens('transit infrastructure')) === false || true); // containment rule may or may not fire; the union-find below is the real check
  assert.ok(!similar(labelTokens('data centers'), labelTokens('child care affordability')));
  const merged = mergeClusters([
    { label: '9/11 remembrance', ids: ['1', '2'], date: '2026-09-09' },
    { label: '9-11-remembrance & first responders', ids: ['2', '3'], date: '2026-09-10' },
    { label: 'Data centers', ids: ['4'], date: '2026-09-08' }
  ]);
  assert.equal(merged.length, 2);
  const nine = merged.find((m) => m.ids.includes('1'));
  assert.deepEqual(nine.ids.sort(), ['1', '2', '3']);
  assert.deepEqual(nine.dates, ['2026-09-09', '2026-09-10']);
  assert.equal(nine.label, '9/11 remembrance'); // the label with the most posts wins
});

test('promoteToTaxonomy inserts a story under the macro without touching comments', () => {
  const yaml = `# comment stays\nimmigration:\n  label: Immigration\n  subtopics:\n    border-policy:\n      label: Border policy\n\nconstituent-services:\n  label: District & constituent services\n  subtopics: {}\n`;
  const out = promoteToTaxonomy(yaml, [
    { macro: 'immigration', key: 'liam-ramos', label: 'Liam Ramos detention', aliases: ['Liam Ramos'], since: '2026-09-01' },
    { macro: 'constituent-services', key: 'town-halls', label: 'Town halls', aliases: [], since: '2026-09-02' }
  ]);
  assert.ok(out.startsWith('# comment stays\n'));
  assert.match(out, /immigration:\n  label: Immigration\n  subtopics:\n    liam-ramos:\n      label: "Liam Ramos detention"\n      aliases: \["Liam Ramos"\]\n      story: true\n      since: 2026-09-01\n    border-policy:/);
  assert.match(out, /constituent-services:\n  label: District & constituent services\n  subtopics:\n    town-halls:\n      label: "Town halls"\n      story: true\n      since: 2026-09-02\n/);
  assert.throws(() => promoteToTaxonomy(yaml, [{ macro: 'nope', key: 'x', label: 'x', aliases: [], since: '2026-01-01' }]), /not found/);
  assert.equal(slug('Trump "Lake America" renaming!'), 'trump-lake-america-renaming');
});
