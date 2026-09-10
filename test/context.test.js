import test from 'node:test';
import assert from 'node:assert/strict';
import { contextKeyFor } from '../src/sitedata.js';

// data/context.json is keyed by the story candidate's key; the dashboard
// cluster carries the placement key (`suggest`) and the display label.
const entries = {
  'celebrity-tribute': { key: 'dolly-parton-tribute', label: 'Dolly Parton tribute', matches: [] },
  'data-centers': { key: 'data-centers', label: 'Data centers & energy costs', matches: [] },
  'place-renaming': { key: 'lake-ontario-renaming', label: 'Trump renaming of Lake Ontario', matches: [] }
};

test('contextKeyFor matches a cluster by placement key, candidate key or label', () => {
  assert.equal(contextKeyFor({ suggest: 'dolly-parton-tribute', label: 'Dolly Parton tribute' }, entries), 'celebrity-tribute');
  assert.equal(contextKeyFor({ suggest: 'celebrity-tribute' }, entries), 'celebrity-tribute');
  // a raw nightly cluster has no placement key: the label alone still finds it
  assert.equal(contextKeyFor({ suggest: 'data_centers_energy_costs', label: 'Data centers & energy costs' }, entries), 'data-centers');
  // punctuation and case are normalised on both sides
  assert.equal(contextKeyFor({ label: 'DATA CENTERS & ENERGY COSTS' }, entries), 'data-centers');
});

test('contextKeyFor does not cross-match similar stories or empty clusters', () => {
  assert.equal(contextKeyFor({ suggest: 'lake-america-renaming', label: "Trump 'Lake America' renaming" }, entries), null);
  assert.equal(contextKeyFor({ suggest: 'agriculture-farmers', label: 'Agriculture & farmers' }, entries), null);
  assert.equal(contextKeyFor({}, entries), null);
  assert.equal(contextKeyFor({ suggest: 'data-centers' }, null), null);
});
