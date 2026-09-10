import test from 'node:test';
import assert from 'node:assert/strict';
import {
  storyQueries, storyAliases, phraseQuery, quotesQuery, listQuery, incidentQuery, fromSetQueries, validate, assertValid, MAX_QUERY
} from '../src/intel-queries.js';

const control = '(Congress OR "House Democrats") -is:retweet lang:en';

test('storyQueries: quoted OR-ed aliases plus label, lang:en, -is:retweet on originals, -from:grok on samples', () => {
  const q = storyQueries(
    { key: 'dolly-parton-tribute', label: 'Dolly Parton tribute', aliases: ['Dolly Parton', 'Imagination Library', 'RIP Dolly', 'country music icon'] },
    { control, excludeFrom: ['grok'] }
  );
  assert.equal(q.organic, '("Dolly Parton" OR "Imagination Library" OR "RIP Dolly" OR "Dolly Parton tribute") lang:en');
  assert.equal(q.originals, `${q.organic} -is:retweet`);
  assert.equal(q.sample, `${q.originals} -from:grok`);
  assert.equal(q.control, control);
  assert.deepEqual(q.dropped, []);
  // generic aliases and short ones never reach X
  assert.deepEqual(storyAliases({ label: 'Epstein files transparency', aliases: ['Epstein files', 'Trump', 'ICE', 'epstein FILES', 'Massie'] }), ['Epstein files', 'Massie', 'Epstein files transparency']);
});

test('storyQueries trims the weakest alias first until the sample query fits the plan length', () => {
  const aliases = Array.from({ length: 40 }, (_, i) => `alias number ${String(i).padStart(2, '0')} of the story`);
  aliases.push('tiny4');
  const q = storyQueries({ key: 'k', label: 'A long running story label', aliases }, { control, excludeFrom: ['grok'] });
  assert.ok(q.sample.length <= 480, `sample is ${q.sample.length} chars`);
  assert.ok(q.dropped.includes('tiny4'), 'shortest alias dropped first');
  assert.ok(q.aliases.length >= 2);
  for (const s of [q.organic, q.originals, q.sample]) assert.equal(validate(s).ok, true);
  assert.throws(() => storyQueries({ key: 'k', label: 'Trump', aliases: ['ICE'] }), /no usable alias/);
});

test('phraseQuery, quotesQuery, listQuery, incidentQuery shapes', () => {
  assert.equal(phraseQuery('tax breaks for billionaires'), '"tax breaks for billionaires" -is:retweet lang:en');
  assert.equal(quotesQuery('2097685220442923030'), 'quotes_of_tweet_id:2097685220442923030 -is:retweet');
  assert.throws(() => quotesQuery('abc'));
  assert.equal(listQuery('1844074661119717599'), 'list:1844074661119717599 -is:retweet');
  assert.equal(
    incidentQuery({ id: 'san-diego-ca--extreme-heat', kind: 'extreme heat', place: 'San Diego, CA · CA-50' }),
    '("San Diego") (heat OR "heat wave" OR "cooling center" OR "excessive heat") -is:retweet lang:en'
  );
  assert.equal(incidentQuery({ kind: 'wildfire', place: 'Napa County, CA · CA-04' }), '("Napa County") (wildfire OR "brush fire" OR fire OR evacuation OR evacuations OR containment) -is:retweet lang:en');
  // an unknown kind is spelled out as a phrase plus its words — never a wildcard
  const q = incidentQuery({ kind: 'chemical spill', place: 'East Palestine, OH' });
  assert.equal(q, '("East Palestine") ("chemical spill" OR chemical OR spill) -is:retweet lang:en');
  assert.throws(() => incidentQuery({ kind: 'flood', place: '' }), /no place/);
});

test('fromSetQueries chunks ≤28 handles per query, each ≤512 chars, with the topic clause', () => {
  // long handles: the 512-char limit bites before the 28-handle cap (19 per query → 4 queries)
  const handles = Array.from({ length: 60 }, (_, i) => `Rep_${i}_abcdefgh`);
  const out = fromSetQueries(handles, '("Epstein files") -is:retweet lang:en');
  assert.equal(out.length, 4);
  for (const q of out) {
    assert.ok(q.length <= MAX_QUERY);
    assert.ok((q.match(/from:/g) || []).length <= 28);
    assert.ok(q.endsWith(' ("Epstein files") -is:retweet lang:en'));
    assert.equal(validate(q).ok, true);
  }
  // short handles: the 28-handle cap decides (28 + 28 + 4)
  const short = fromSetQueries(Array.from({ length: 60 }, (_, i) => `r${i}`), 'Epstein');
  assert.deepEqual(short.map((q) => (q.match(/from:/g) || []).length), [28, 28, 4]);
  assert.deepEqual(fromSetQueries(['SpeakerJohnson', 'not a handle', 'SpeakerJohnson']), ['(from:SpeakerJohnson)']);
});

test('validate rejects the desk pseudo-operator, unbalanced quotes/parens, wildcards, expansions, and gates list:/quotes_of_tweet_id: on probes.json', () => {
  assert.equal(validate('from:list -is:retweet').ok, false);
  assert.equal(validate('"Epstein files').ok, false);
  assert.equal(validate('(Epstein files').ok, false);
  assert.equal(validate('evacuat* lang:en').ok, false);
  assert.equal(validate('Epstein expansions=author_id').ok, false);
  assert.equal(validate('x'.repeat(513)).ok, false);
  assert.equal(validate('').ok, false);
  assert.equal(validate('list:1844074661119717599 -is:retweet').ok, false);
  assert.equal(validate('list:1844074661119717599 -is:retweet', { probes: { listOperator: true } }).ok, true);
  assert.equal(validate('list:1844074661119717599 -is:retweet', { probes: { listOperator: false } }).ok, false);
  assert.equal(validate('list:1844074661119717599 -is:retweet', { allowProbe: true }).ok, true);
  assert.equal(validate('quotes_of_tweet_id:2097685220442923030 -is:retweet').ok, false);
  assert.equal(validate('quotes_of_tweet_id:2097685220442923030 -is:retweet', { probes: { quotesOperator: true } }).ok, true);
  assert.equal(validate('("Epstein files" OR Massie) -is:retweet lang:en').ok, true);
  assert.throws(() => assertValid('from:list'), /pseudo-operator/);
});
