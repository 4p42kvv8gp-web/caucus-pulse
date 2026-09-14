import test from 'node:test';
import assert from 'node:assert/strict';
import { projectPostForSite, classificationCoverage } from '../src/sitedata.js';
import { createRepostResolver } from '../src/source-context.js';
import { decoratePost, sourceLink } from '../site/ui.js';

// The selected New Haven Line miss had an accepted empty interpretation,
// but only this truncated wrapper was captured. No source words are filled in.
const repost = Object.freeze({
  id: '2099500624953889071', authorId: '140519774',
  createdAt: '2026-09-14T14:08:50.000Z', type: 'retweet', refId: '2099167548684087801',
  text: 'RT @GovNedLamont: Metro North and Amtrak New Haven Line service is currently suspended between Norwalk and Bridgeport due to track conditio…',
  capturedAt: '2026-09-14T14:19:10.841Z'
});
const date = '2026-09-14';
const acceptedEmpty = { assignments: { [repost.id]: [] }, needsContext: { [repost.id]: false } };

test('accepted empty legacy repost gets a source warning without becoming classification pending', () => {
  const before = JSON.stringify(acceptedEmpty);
  const row = projectPostForSite(repost, { interpretation: acceptedEmpty, date });
  assert.equal(row.needsContext, true);
  assert.equal(row.sourceIncomplete, true);
  assert.equal(row.sourceReferenceId, repost.refId);
  assert.ok(row.sourceContextReason);
  assert.equal(row.classificationStatus, 'complete');
  assert.deepEqual(row.topics, []);
  assert.equal(row.text, repost.text);
  assert.equal(JSON.stringify(acceptedEmpty), before, 'derived warning does not alter historical interpretation');
  const coverage = classificationCoverage([row], [date], Date.parse('2026-09-14T20:00:00Z'));
  assert.equal(coverage.classifiedIn24h, 1);
  assert.equal(coverage.pendingIn24h, 0);
});

test('matching complete original clears the derived warning while retaining independent context uncertainty', () => {
  const original = { id: repost.refId, text: 'Complete fixture source wording.' };
  for (const resolve of [
    createRepostResolver({ quoted: { [repost.refId]: original } }),
    createRepostResolver({ archive: (id) => id === repost.refId ? original : null }),
    createRepostResolver()
  ]) {
    const sourcePost = resolve(repost) ? repost : { ...repost, reposted: original };
    const row = projectPostForSite(sourcePost, { interpretation: acceptedEmpty, original: resolve(sourcePost) });
    assert.equal(row.sourceIncomplete, false);
    assert.equal(row.sourceContextReason, null);
    assert.equal(row.needsContext, false);
    assert.equal(row.text, repost.text);
  }
  const row = projectPostForSite(repost, {
    original,
    interpretation: { ...acceptedEmpty, needsContext: { [repost.id]: true } }
  });
  assert.equal(row.sourceIncomplete, false);
  assert.equal(row.needsContext, true, 'separate model uncertainty remains visible');
});

test('human correction remains complete and retains its labels despite missing source', () => {
  const topics = Object.freeze([Object.freeze(['transportation', 'rail-service'])]);
  const interpretation = {
    assignments: { [repost.id]: topics }, corrected: { [repost.id]: 'human-review' },
    pendingIds: [repost.id], needsContext: { [repost.id]: false },
    provenance: { [repost.id]: { kind: 'human', evidenceUsed: [] } }
  };
  const before = JSON.stringify(interpretation);
  const row = projectPostForSite(repost, { interpretation, date });
  assert.equal(row.classificationStatus, 'complete');
  assert.deepEqual(row.topics, topics);
  assert.deepEqual(row.provenance, interpretation.provenance[repost.id]);
  assert.equal(row.needsContext, false);
  assert.equal(row.sourceIncomplete, true);
  assert.equal(JSON.stringify(interpretation), before);
  const decorated = decoratePost({ authorHandles: { [repost.authorId]: '@RepFixture' } }, row);
  assert.equal(decorated.sourceIncomplete, true);
  assert.equal(decorated.needsContext, false);
  assert.equal(decorated.text, repost.text);
  assert.ok(sourceLink(decorated, decorated.text).includes(`/status/${repost.id}`));
  const withoutExplicitContext = projectPostForSite(repost, {
    interpretation: { ...interpretation, needsContext: {} }, date
  });
  assert.equal(withoutExplicitContext.classificationStatus, 'complete');
  assert.deepEqual(withoutExplicitContext.topics, topics);
  assert.equal(withoutExplicitContext.needsContext, true);
  assert.equal(withoutExplicitContext.sourceIncomplete, true);
});

test('unrelated or empty originals never remove missing-source warnings; ordinary posts stay unaffected', () => {
  for (const original of [
    { id: '99', text: 'A different original.' },
    { id: repost.refId, text: ' ' },
    { id: repost.refId, text: 'Unavailable text.', unavailable: true }
  ]) {
    const row = projectPostForSite(repost, { interpretation: acceptedEmpty, original });
    assert.equal(row.sourceIncomplete, true);
    assert.equal(row.needsContext, true);
  }
  const ordinary = projectPostForSite({ ...repost, type: 'tweet', refId: null }, { interpretation: acceptedEmpty });
  assert.equal(ordinary.sourceIncomplete, false);
  assert.equal(ordinary.needsContext, false);
  assert.equal(ordinary.classificationStatus, 'complete');
});
