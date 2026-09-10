import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, ngrams, minePhrases } from '../src/syntax.js';

test('tokenize strips links, mentions, and hashes but keeps slogan words', () => {
  const t = tokenize('The #TrumpCartel must answer — see https://x.com/x/1 @RepSomeone');
  assert.ok(t.includes('trumpcartel'));
  assert.ok(!t.some((w) => w.includes('http')));
  assert.ok(!t.some((w) => w.startsWith('@')));
});

test('tokenize handles curly and straight apostrophes: possessives drop, contractions collapse', () => {
  assert.deepEqual(tokenize('Trump’s tariffs'), ['trump', 'tariffs']);
  assert.deepEqual(tokenize("Trump's tariffs"), ['trump', 'tariffs']);
  assert.deepEqual(tokenize('We don’t back down'), ['we', 'do', 'not', 'back', 'down']);
  assert.deepEqual(tokenize("I'll keep fighting; we won't quit"), ['i', 'keep', 'fighting', 'we', 'will', 'not', 'quit']);
  assert.deepEqual(tokenize('the U.S. Capitol in D.C.'), ['the', 'us', 'capitol', 'in', 'dc']);
});

test('ngrams reject stopword-edged grams but allow interior stopwords', () => {
  const grams = ngrams(tokenize('state of the union address'), 2, 4);
  assert.ok(grams.includes('state of the union'));
  assert.ok(!grams.includes('of the'));
  assert.ok(!grams.includes('the union'));
});

const tw = (id, authorId, text, type = 'tweet') =>
  ({ id, authorId, text, type, createdAt: `2026-09-01T0${id}:00:00.000Z` });

test('minePhrases counts distinct members, not tweet volume', () => {
  const tweets = [
    tw('1', 'a', 'End the billionaire giveaway now'),
    tw('2', 'a', 'The billionaire giveaway hurts families'),
    tw('3', 'a', 'Again: billionaire giveaway'),
    tw('4', 'b', 'Stop the billionaire giveaway'),
    tw('5', 'c', 'This billionaire giveaway is a scam'),
    tw('6', 'd', 'RT @x: billionaire giveaway', 'retweet') // amplification ≠ adoption
  ];
  const found = minePhrases(tweets, { minMembers: 3, minNgram: 2, maxNgram: 4 });
  const hit = found.find((f) => f.phrase === 'billionaire giveaway');
  assert.ok(hit, 'phrase should cross the 3-member threshold');
  assert.equal(hit.members, 3);
  assert.equal(hit.earliest.id, '1');
});

test('minePhrases drops fragments contained in an equally-spread longer phrase', () => {
  const tweets = [
    tw('1', 'a', 'Protect the affordable care act today'),
    tw('2', 'b', 'Protect the affordable care act for families'),
    tw('3', 'c', 'We must protect the affordable care act')
  ];
  const found = minePhrases(tweets, { minMembers: 3, minNgram: 2, maxNgram: 4 });
  assert.ok(found.some((f) => f.phrase.includes('affordable care act')));
  assert.ok(!found.some((f) => f.phrase === 'care act'), 'fragment should be absorbed');
});
