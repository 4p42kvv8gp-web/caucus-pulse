// Minimal invented fixtures reproduce failure mechanisms found in the public
// production store. They are not article quotations or model-quality scores.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadNews, retrieveEvidence, newsSourceIssue, storeItems, evidenceForPosts, reconsiderCandidates } from '../src/news-context.js';

const now = '2026-09-14T17:00:00Z';
const report = (id, fields = {}) => ({ id, url: `https://wire.example.test/${id}`, publisher: 'Synthetic Wire', title: 'An article', publishedAt: '2026-09-14T14:00:00Z', fetchedAt: '2026-09-14T15:00:00Z', extract: 'body', passages: [], summary: '', ...fields });
const retrieve = (query, items) => retrieveEvidence(query, { items, asOf: now, knownAt: now, k: 10 }).evidence;

test('fresh acquisition cannot turn an undated landing page or old article into current news', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'news-quality-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const opts = { file: path.join(dir, 'items.jsonl'), statusFile: path.join(dir, 'status.json') };
  const items = [
    report('dated', { title: 'Current dated article' }),
    report('landing', { title: 'Political podcast series', publishedAt: null, fetchedAt: '2026-09-14T16:59:00Z' }),
    report('old', { title: 'Old event fetched today', publishedAt: '2023-01-01T00:00:00Z', fetchedAt: now }),
    report('future', { title: 'Not yet published', publishedAt: '2026-09-15T00:00:00Z' })
  ];
  storeItems(items, { ...opts, now });
  const current = loadNews({ ...opts, days: 10, now: Date.parse(now) });
  assert.deepEqual(current.items.map((item) => item.id), ['dated']);
  assert.deepEqual(current.excluded.map((item) => item.reason).sort(), ['future-publication', 'undated']);
  assert.equal(loadNews(opts).items.length, 4, 'raw acquired history is preserved');
});

test('undated pages do not become reports just because their text shares a name', () => {
  const item = report('podcast', { title: 'Interviews with David Axelrod', publishedAt: null, passages: ['Listen to David Axelrod discuss political events every week.'] });
  assert.deepEqual(retrieve('A discussion with David Axelrod about political events', [item]), []);
});

test('legacy external advertisements cannot inherit the feed publisher attribution, including dated records', (t) => {
  const sources = [{ id: 'cnn-politics', url: 'https://rss.cnn.com/politics', allowed_hosts: ['cnn.com'] }];
  const ad = report('ad', { sourceId: 'cnn-politics', publisher: 'CNN', feedUrl: 'https://rss.cnn.com/politics', url: 'https://comparecards.example.test/credit', title: 'Detention report from Dilley', passages: ['Officials in Dilley reported detention expansion for families.'] });
  const article = { ...ad, id: 'article', url: 'https://www.cnn.com/2026/09/14/dilley' };
  assert.equal(newsSourceIssue(ad, sources), 'publisher-host-mismatch');
  assert.equal(newsSourceIssue(article, sources), null);
  const args = { items: [ad, article], sources, asOf: now, knownAt: now };
  assert.deepEqual(retrieveEvidence('Families detained in Dilley after the detention expansion', args).evidence.map((item) => item.id), ['article']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'news-publisher-quality-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const opts = { file: path.join(dir, 'items.jsonl'), statusFile: path.join(dir, 'status.json') };
  storeItems([ad, article], { ...opts, now });
  const recent = loadNews({ ...opts, sources, days: 10, now: Date.parse(now) });
  assert.deepEqual(recent.items.map((item) => item.id), ['article']);
  assert.deepEqual(recent.excluded, [{ id: 'ad', reason: 'publisher-host-mismatch' }]);
});

test('ordinary words cannot connect a named hack or detention investigation to campaign reporting', () => {
  const newsletter = report('dallas', { title: 'Campaign newsletter from Dallas', passages: ['Welcome to the newsletter! DALLAS — Recent polls show voters like the campaign events.'] });
  const ratings = report('ratings', { title: 'Campaign ratings change', passages: ['Inside Elections changed its general election ratings after a complete review.'] });
  const convention = report('convention', { title: 'Convention closes', passages: ['They gathered inside the arena with Attorney General Ken Paxton.'] });
  const hack = 'Hugging Face AI platform hack. Recent incidents like the Hugging Face hack warn of risks from emerging technologies.';
  const detention = 'Alligator Alcatraz detention conditions. A DHS inspector general report describes immigrants held inside cramped cages and complete inhumanity.';
  assert.deepEqual(retrieve(hack, [newsletter]), []);
  assert.deepEqual(retrieve(detention, [ratings, convention]), []);
  const relevant = report('hack', { title: 'Hugging Face investigates hack', passages: ['Officials at Hugging Face described the hack and risks to emerging technologies.'] });
  assert.deepEqual(retrieve(hack, [newsletter, relevant]).map((item) => item.id), ['hack']);
});

test('a specific voting query needs subject overlap as well as the Jeffries surname', () => {
  const impeachment = report('impeachment', { title: 'Jeffries discusses impeachment', extract: 'headline-only', summary: 'A statement by Jeffries described Trump and the November election.' });
  const ai = report('ai', { title: 'Jeffries discusses AI oversight', extract: 'headline-only', summary: 'Comments by Jeffries said lawmakers should make AI oversight a priority.' });
  const voting = report('voting', { title: 'Jeffries voting case blocks mail restrictions', extract: 'headline-only', summary: 'A court in the Jeffries case blocked restrictions on voting by mail.' });
  const query = 'Jeffries v. Trump ruling blocking mail-in voting restrictions. A federal court in the Jeffries v. Trump case blocked the administration from restricting mail-in voting.';
  const evidence = retrieve(query, [impeachment, ai, voting]);
  assert.deepEqual(evidence.map((item) => item.id), ['voting']);
  assert.equal(evidence[0].kind, 'lead', 'a matching headline is still a lead');
});

test('a short ambiguous alias still returns competing leads instead of assuming event identity', () => {
  const detention = report('detention', { title: 'Dilley facility update', extract: 'headline-only', summary: 'Officials in Dilley discussed families at the detention facility.' });
  const coach = report('coach', { title: 'Coach Dilley wins award', extract: 'headline-only', summary: 'The team honored Coach Dilley at the ceremony.' });
  const evidence = retrieve('Back to Dilley again', [detention, coach]);
  assert.deepEqual(new Set(evidence.map((item) => item.id)), new Set(['detention', 'coach']));
  assert.ok(evidence.every((item) => item.kind === 'lead'));
});

test('captured repost originals supply retrieval context when the wrapper is truncated', () => {
  const item = report('detention', { title: 'Dilley detention expansion for families', version: 2, passages: ['Officials in Dilley described detention expansion for families.'] });
  for (const field of ['reposted', 'reposting']) {
    const post = { id: '1', text: 'RT @Source:', createdAt: now, [field]: { text: 'Families are being sent to Dilley detention after the expansion.' } };
    const evidence = evidenceForPosts([post], { items: [item], version: 2, knownAt: now });
    assert.deepEqual(evidence.byPost['1'].map((e) => e.id), ['detention']);
    assert.deepEqual(reconsiderCandidates({ assignments: { 1: [] } }, [post], { items: [item], sinceVersion: 1 }).map((entry) => entry.id), ['1']);
  }
});
