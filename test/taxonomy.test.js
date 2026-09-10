import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTaxonomy, validAssignments, ymd } from '../src/taxonomy.js';

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
