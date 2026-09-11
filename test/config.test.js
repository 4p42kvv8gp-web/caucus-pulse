// The config files are the product: config/taxonomy.yaml is the classifier's
// prompt, config/accounts.csv decides who counts as which caucus, and
// config/settings.json holds the spend ceiling. All three are hand-edited,
// and a mistake in any of them fails quietly — a mistyped caucus tag drops a
// member out of every caucus view without erroring, and a malformed taxonomy
// takes the nightly classifier down. The rest of the suite runs on synthetic
// fixtures, so these are the only tests that read what actually ships.
import test from 'node:test';
import assert from 'node:assert/strict';
import { settings, loadAccounts } from '../src/util.js';
import { loadTaxonomy } from '../src/taxonomy.js';

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

test('settings.json holds the shape the pipeline reads', () => {
  assert.ok(Number.isFinite(settings.daily_read_budget) && settings.daily_read_budget > 0,
    'daily_read_budget must be a positive number — the budget guard falls back silently otherwise');
  assert.ok(settings.timezone, 'timezone drives every ET date bucket');
  assert.ok(settings.poll?.max_pages > 0 && settings.poll?.page_size > 0);

  // Every caucus needs a display name and a dashboard key, or the site and
  // the report disagree about who exists.
  const byName = Object.keys(settings.caucuses || {});
  const byKey = Object.keys(settings.caucus_keys || {});
  assert.deepEqual(byName.sort(), byKey.sort(), 'caucuses and caucus_keys must cover the same set');
  assert.ok(byName.length, 'at least one caucus');
});

test('taxonomy.yaml parses and every entry is well formed', () => {
  const tax = loadTaxonomy();
  assert.ok(Object.keys(tax).length > 5, 'taxonomy should not be near-empty');

  for (const [macroKey, macro] of Object.entries(tax)) {
    assert.match(macroKey, KEBAB, `macro key "${macroKey}" must be kebab-case`);
    assert.ok(macro.label, `macro "${macroKey}" needs a label`);
    assert.equal(typeof macro.subtopics, 'object', `macro "${macroKey}" needs a subtopics map`);

    for (const [subKey, sub] of Object.entries(macro.subtopics || {})) {
      assert.match(subKey, KEBAB, `subtopic key "${macroKey}/${subKey}" must be kebab-case`);
      assert.ok(sub?.label, `subtopic "${macroKey}/${subKey}" needs a label`);
      if (sub.aliases !== undefined) {
        assert.ok(Array.isArray(sub.aliases), `aliases for "${macroKey}/${subKey}" must be a list`);
        for (const a of sub.aliases) {
          assert.equal(typeof a, 'string', `alias in "${macroKey}/${subKey}" must be a string`);
          assert.ok(a.trim(), `empty alias in "${macroKey}/${subKey}"`);
        }
      }
    }
  }
});

test('subtopic keys are unique across the whole taxonomy', () => {
  // Reports and rollups address a subtopic by its own key in places, so two
  // macros sharing one would silently merge their counts.
  const seen = new Map();
  for (const [macroKey, macro] of Object.entries(loadTaxonomy())) {
    for (const subKey of Object.keys(macro.subtopics || {})) {
      const prior = seen.get(subKey);
      assert.equal(prior, undefined, `subtopic "${subKey}" appears under both "${prior}" and "${macroKey}"`);
      seen.set(subKey, macroKey);
    }
  }
});

test('accounts.csv rows carry a usable handle and only known caucus tags', () => {
  const accounts = loadAccounts();
  assert.ok(accounts.length > 100, `expected the full List roster, got ${accounts.length}`);

  const known = new Set([...Object.keys(settings.caucuses || {}), settings.leadership_tag].filter(Boolean));
  const seen = new Set();
  for (const a of accounts) {
    assert.match(a.handle, /^[A-Za-z0-9_]{1,15}$/, `"${a.handle}" is not a valid X username`);
    const lower = a.handle.toLowerCase();
    assert.ok(!seen.has(lower), `duplicate handle in accounts.csv: @${a.handle}`);
    seen.add(lower);
    for (const c of a.caucuses) {
      assert.ok(known.has(c), `@${a.handle} carries unknown caucus tag "${c}" (known: ${[...known].join(', ')})`);
    }
  }
});
