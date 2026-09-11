import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTaxonomy, validAssignments, systemPrompt, ymd } from '../src/taxonomy.js';

test('ymd normalises the Date js-yaml makes of an unquoted since: to YYYY-MM-DD', () => {
  assert.equal(ymd(new Date('2026-09-01T00:00:00Z')), '2026-09-01');
  assert.equal(ymd('2026-09-01'), '2026-09-01');
  assert.equal(ymd(null), null);
  assert.equal(ymd(undefined), null);
});

test('renderTaxonomy skips retired subtopics and renders provisional stories exactly like confirmed ones', () => {
  const tax = {
    democracy: {
      label: 'Democracy',
      subtopics: {
        'lake-america': { label: 'Lake America', aliases: ['Lake America'], story: true, since: new Date('2026-08-25T00:00:00Z'), provisional: true, promoted: '2026-08-30' },
        'epstein-files': { label: 'Epstein files', story: true, since: '2026-08-31' },
        'old-story': { label: 'Old story', story: true, since: '2026-07-01', provisional: true, retired: true },
        'courts-doj': { label: 'Courts' }
      }
    },
    tech: { label: 'Tech', subtopics: {} }
  };
  const out = renderTaxonomy(tax);
  assert.equal(out, [
    '- democracy: Democracy',
    '  - democracy/courts-doj: Courts',
    '  - democracy/epstein-files: Epstein files [developing story since 2026-08-31]',
    '  - democracy/lake-america: Lake America [developing story since 2026-08-25] (also: Lake America)',
    '- tech: Tech'
  ].join('\n'));
  assert.ok(!out.includes('old-story'));
  assert.ok(!out.includes('provisional'));
  // the retired key still validates: rollups and re-classified history keep it
  assert.deepEqual(validAssignments([['democracy', 'old-story']], tax), [['democracy', 'old-story']]);
});

// The 2026-09-10 eval found the shipped classifier assigning a subtopic on 9%
// of the corpus, with three days at exactly zero across 219, 585 and 273 posts
// and failedChunks 0 — a shape a per-post rate cannot produce. The suspect is
// this: renderTaxonomy prints subtopics as `macro/sub`, the response schema
// asks for a bare `sub-id`, and the lookup is by bare key. A response echoing
// what it was shown therefore loses every subtopic in the chunk, silently.
// These pin the collapse (which must stay — a bad sub key must not cost the
// macro) while making it countable.
test('validAssignments reports a subtopic key it could not resolve', () => {
  const tax = { economy: { label: 'Economy', subtopics: { jobs: { label: 'Jobs' } } } };
  const dropped = [];
  assert.deepEqual(validAssignments([['economy', 'jobs']], tax, dropped), [['economy', 'jobs']]);
  assert.deepEqual(dropped, [], 'a resolvable subtopic is not a drop');

  // a genuinely unknown key is still collapsed to the macro, and counted
  assert.deepEqual(validAssignments([['economy', 'bogus']], tax, dropped), [['economy', null]]);
  assert.deepEqual(dropped, ['economy\u2192bogus']);
});

test('validAssignments resolves the rendered macro/sub form instead of dropping it, and counts the echo', () => {
  const tax = { economy: { label: 'Economy', subtopics: { jobs: { label: 'Jobs' } } } };
  const dropped = [];
  const echoed = [];
  assert.deepEqual(validAssignments([['economy', 'economy/jobs']], tax, dropped, echoed), [['economy', 'jobs']]);
  assert.deepEqual(dropped, [], 'a resolvable echo is not a drop');
  assert.deepEqual(echoed, ['economy\u2192economy/jobs']);
  // dedupes against the bare form of the same subtopic
  assert.deepEqual(validAssignments([['economy', 'jobs'], ['economy', 'economy/jobs']], tax), [['economy', 'jobs']]);
  // a slash key that is not this macro's is still unknown
  assert.deepEqual(validAssignments([['economy', 'health/jobs']], tax, dropped, echoed), [['economy', null]]);
  assert.deepEqual(dropped, ['economy\u2192health/jobs']);
  // works without collectors (classify-live)
  assert.deepEqual(validAssignments([['economy', 'economy/jobs']], tax), [['economy', 'jobs']]);
});

test('systemPrompt tells the model to check the subtopic list before answering null', () => {
  const tax = { economy: { label: 'Economy', subtopics: { jobs: { label: 'Jobs' } } } };
  const prompt = systemPrompt(tax);
  assert.match(prompt, /do not default to null/);
  assert.match(prompt, /bare id/);
});

test('validAssignments does not count a deliberate macro-only answer as a drop', () => {
  const tax = { economy: { label: 'Economy', subtopics: { jobs: { label: 'Jobs' } } } };
  const dropped = [];
  validAssignments([['economy', null]], tax, dropped);
  assert.deepEqual(dropped, [], 'macro-only is a judgement, not a parse failure');
});

test('validAssignments still works with no collector (existing callers)', () => {
  const tax = { economy: { label: 'Economy', subtopics: { jobs: { label: 'Jobs' } } } };
  assert.deepEqual(validAssignments([['economy', 'bogus']], tax), [['economy', null]]);
});
