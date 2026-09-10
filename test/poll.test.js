import test from 'node:test';
import assert from 'node:assert/strict';
import { newerThan, adaptivePageSize } from '../src/poll.js';
import { validAssignments, renderTaxonomy } from '../src/classify.js';
import { rollupDay } from '../src/rollup.js';

test('newerThan keeps only tweets past the cursor', () => {
  const tweets = [{ id: '300' }, { id: '200' }, { id: '100' }];
  assert.deepEqual(newerThan(tweets, '200').map((t) => t.id), ['300']);
  assert.equal(newerThan(tweets, null).length, 3);
});

test('adaptivePageSize tracks recent volume within [5, 100]', () => {
  assert.equal(adaptivePageSize([]), 100);          // no history → full page
  assert.equal(adaptivePageSize([1, 2, 1]), 5);     // quiet list → endpoint minimum
  assert.equal(adaptivePageSize([2, 4, 3]), 6);     // ~2× average
  assert.equal(adaptivePageSize([30, 40, 35]), 70); // ~2× average
  assert.equal(adaptivePageSize([90, 90, 90]), 100);
  assert.equal(adaptivePageSize([465, 0, 0, 0, 0, 0, 0]), 5); // old burst ages out of the window
});

test('validAssignments drops unknown macros and unknown subs', () => {
  const tax = { immigration: { label: 'x', subtopics: { 'ice-enforcement': { label: 'y' } } } };
  assert.deepEqual(
    validAssignments([['immigration', 'ice-enforcement'], ['immigration', 'bogus'], ['bogus', null]], tax),
    [['immigration', 'ice-enforcement'], ['immigration', null]]
  );
});

test('renderTaxonomy is deterministic (stable prompt cache prefix)', () => {
  const tax = { b: { label: 'B', subtopics: {} }, a: { label: 'A', subtopics: { z: { label: 'Z' }, y: { label: 'Y' } } } };
  assert.equal(renderTaxonomy(tax), renderTaxonomy(tax));
  assert.match(renderTaxonomy(tax), /^- a: A\n {2}- a\/y: Y\n {2}- a\/z: Z\n- b: B$/);
});

test('rollupDay counts a subtopic tweet toward macro and sub without double-counting the macro', () => {
  const tweets = [
    { id: '1', authorId: 'u1', type: 'tweet' },
    { id: '2', authorId: 'u2', type: 'retweet', refId: '1' }
  ];
  const assignments = {
    '1': [['immigration', 'dilley-detention'], ['immigration', 'ice-enforcement']],
    '2': [['immigration', 'dilley-detention'], ['immigration', 'ice-enforcement']]
  };
  const metrics = { '1': { likes: 10, retweets: 5, replies: 0, quotes: 0 } };
  const authors = { u1: { member: 'A', caucuses: ['progressive'] }, u2: { member: 'B', caucuses: [] } };

  const rows = rollupDay('2026-09-01', tweets, assignments, metrics, authors);
  const macroAll = rows.find((r) => r.macro === 'immigration' && !r.sub && r.caucus === 'all');
  // two subtopics on one tweet must not double the macro row
  assert.equal(macroAll.posts, 1);
  assert.equal(macroAll.retweets, 1);
  assert.equal(macroAll.members, 2);
  assert.equal(macroAll.engagement, 15);

  const dilleyAll = rows.find((r) => r.sub === 'dilley-detention' && r.caucus === 'all');
  assert.equal(dilleyAll.posts, 1);

  const prog = rows.find((r) => r.macro === 'immigration' && !r.sub && r.caucus === 'progressive');
  assert.equal(prog.posts, 1);
  assert.equal(prog.retweets, 0); // the RT author has no caucus tag
});
