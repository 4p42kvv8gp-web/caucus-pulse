// Invented fixtures isolate failure mechanisms; the explicit archive-backed
// regression below also uses saved public source records. Neither is an
// estimate of retrieval or model accuracy across the corpus.
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

test('the archived Pardon Integrity Act quote rejects unrelated Dallas and other Donald-only matches', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const readRows = (file) => fs.readFileSync(path.join(root, file), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const post = readRows('data/archive/2026-09-14.jsonl').find((row) => row.id === '2099619115103035830');
  assert.equal(post.quoted.id, '2024258861645914519');
  assert.match(post.quoted.text, /Donald Trump/);
  const history = readRows('data/news/items.jsonl');
  const ids = ['n_85c8c02756c33de6', 'n_9048ded17444c977', 'n_8bc96534ce69b582', 'n_05a9ebace433bb53'];
  // First stored versions are stable public regression inputs even if later
  // feed refreshes append another version with a different acquisition time.
  const unrelated = ids.map((id) => history.find((item) => item.id === id));
  assert.ok(unrelated.every(Boolean));
  assert.ok(unrelated.every((item) => /Donald/i.test([item.summary, ...(item.passages || [])].join(' '))));
  const query = `${post.text} ${post.quoted.text}`;
  const options = { asOf: post.createdAt, knownAt: '2026-09-15T01:00:00Z', k: 10 };
  assert.deepEqual(retrieveEvidence(query, { ...options, items: unrelated }).evidence, []);
  const positive = report('synthetic-pardon-report', { title: 'Support grows for the Pardon Integrity Act',
    passages: ['Supporters of the Pardon Integrity Act seek a constitutional amendment to limit presidential pardons and give Congress a role in blocking abuses of the pardon power.'] });
  const results = retrieveEvidence(query, { ...options, items: [...unrelated, positive] }).evidence;
  assert.deepEqual(results.map((item) => item.id), ['synthetic-pardon-report']);
  assert.equal(results[0].kind, 'report');
  assert.match(results[0].passage, /constitutional amendment.*pardons/);
});

test('common national political-name aliases cannot independently ground a story match', () => {
  for (const alias of ['Donald Trump', 'Donald J. Trump', 'Joe Biden', 'Joseph Biden', 'Kamala Harris', 'JD Vance', 'POTUS']) {
    const item = report('convention', { title: 'Convention speech',
      passages: [`A speech by ${alias} at the Dallas convention described campaign strategy and the political role of the administration.`] });
    assert.deepEqual(retrieve(`Remarks by ${alias} about the administration`, [item]), [], alias);
  }
});

test('connector words cannot satisfy subject overlap with an unrelated article about the same member', () => {
  const item = report('unrelated', { title: 'Olszewski at the convention',
    passages: ['They spoke with Olszewski about efforts to put an end to his political role at the convention.'] });
  const query = 'Olszewski put forward efforts to end abuses of pardons through constitutional amendment and disclosure requirements.';
  assert.deepEqual(retrieve(query, [item]), []);
});

test('the selected passage must carry both the actor and the specific subject, not borrow support from another paragraph', () => {
  const query = 'Olszewski seeks constitutional limits on pardons through a proposed amendment and stricter disclosure.';
  const irrelevant = 'They spoke with Olszewski about weekend travel and the annual convention.';
  const subjectWithoutActor = 'The proposal would establish constitutional limits on pardons through an amendment and stricter disclosure.';
  const article = report('interview', { title: 'Interview with Olszewski', passages: [irrelevant, subjectWithoutActor] });
  assert.deepEqual(retrieve(query, [article]), [], 'separate paragraphs do not create a supporting excerpt');
  const supporting = 'The proposal by Olszewski sets constitutional limits on pardons and requires disclosure.';
  const grounded = retrieve(query, [{ ...article, passages: [irrelevant, supporting] }]);
  assert.equal(grounded.length, 1);
  assert.equal(grounded[0].passage, supporting);
  assert.equal(grounded[0].kind, 'report');
  const lead = retrieve(query, [{ ...article, title: 'Olszewski seeks constitutional limits on pardons' }]);
  assert.equal(lead.length, 1);
  assert.equal(lead[0].kind, 'lead');
  assert.equal(lead[0].passage, 'Olszewski seeks constitutional limits on pardons');
});
