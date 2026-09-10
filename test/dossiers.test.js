import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeEntry, buildDossier, entriesHash, refreshSummary, summaryCurrent, diffDossiers, storyRoster,
  trimWords, quoteOf, correctionsFor, judgmentsFor, pressFor, framingFor, summaryInput,
  SUMMARY_MAX_WORDS, SUMMARY_VERSION
} from '../src/dossiers.js';
import { settings } from '../src/util.js';

// ── fixtures ────────────────────────────────────────────────────────────

const authorsById = {
  a1: { handle: 'RepA', caucuses: ['progressive'] },
  a2: { handle: 'RepB', caucuses: ['newdem', 'cbc'] },
  a3: { handle: 'RepC', caucuses: [] },
  a4: { handle: 'RepD', caucuses: ['progressive'] }
};
const post = (id, authorId, text, likes = 0, extra = {}) => ({ id, authorId, text, createdAt: `2026-09-0${id[0]}T12:00:00Z`, type: 'tweet', refId: null, metricsAtCapture: { likes, retweets: 0, replies: 0, quotes: 0 }, ...extra });

const story = {
  key: 'lake-america', label: 'Lake America renaming', macro: 'democracy', sub: 'lake-america',
  since: '2026-09-01', aliases: ['Lake America'], anchors: [], status: 'active', source: 'taxonomy', candidateKeys: []
};

// Three days of posts. Day 2 has two members sharing "lake america" and
// "lake ontario"; day 3 is one member.
const days = {
  '2026-09-01': [post('101', 'a1', 'Renaming Lake Ontario to Lake America is absurd', 50)],
  '2026-09-02': [
    post('201', 'a1', 'Lake America? Seriously. Lake Ontario stays.', 10),
    post('202', 'a2', 'Renaming Lake Ontario to Lake America is absurd and I said so on the floor', 500),
    post('203', 'a2', 'RT @RepA: Lake America? Seriously.', 0, { type: 'retweet', refId: '201' })
  ],
  '2026-09-03': [post('301', 'a4', 'Still no answer from Burgum on the Lake America order', 5)]
};
const dayData = (date) => ({ posts: days[date] || [], metrics: {} });
const dates = ['2026-09-01', '2026-09-02', '2026-09-03'];

// ── computeEntry ────────────────────────────────────────────────────────

test('computeEntry: measured fields in a fixed order, framing from shared phrases, quotes capped', () => {
  const e = computeEntry(story, '2026-09-02', { posts: days['2026-09-02'], authorsById, seenMembers: new Set(['RepA']) });
  assert.deepEqual(Object.keys(e), ['date', 'posts', 'retweets', 'members', 'byCaucus', 'newMembers', 'leaders', 'framing', 'framingSource', 'topPosts', 'ids', 'press', 'corrections', 'judgments']);
  assert.equal(e.posts, 2);
  assert.equal(e.retweets, 1);
  assert.equal(e.members, 2);
  // caucus keys come in settings order (CPC, NewDem, CBC, …) and count distinct members
  assert.deepEqual(Object.keys(e.byCaucus), [...new Set(Object.values(settings.caucus_keys))]);
  assert.equal(e.byCaucus.CPC, 1);
  assert.equal(e.byCaucus.NewDem, 1);
  assert.equal(e.byCaucus.CBC, 1);
  assert.deepEqual(e.newMembers, ['RepB']); // RepA was seen before
  assert.deepEqual(e.leaders, [{ handle: 'RepA', posts: 1 }, { handle: 'RepB', posts: 1 }]);
  assert.deepEqual(e.framing, ['lake america', 'lake ontario']);
  assert.equal(e.framingSource, 'phrases');
  assert.equal(e.topPosts[0].id, '202'); // most engaged first
  assert.equal(e.topPosts[0].eng, 500);
  assert.deepEqual(e.ids, ['201', '202']); // originals only, id order
  const long = computeEntry(story, '2026-09-09', { posts: [post('901', 'a1', 'word '.repeat(60), 1)], authorsById });
  assert.ok(long.topPosts[0].quote.length <= 120);
  assert.ok(long.topPosts[0].quote.endsWith('…'));
  assert.equal(quoteOf('short'), 'short');
});

test('framingFor prefers why-it-moved, then message families, then phrases', () => {
  const posts = days['2026-09-02'];
  assert.deepEqual(framingFor(story, posts, { why: { stories: { 'lake-america': { reason: 'Burgum memo leaked', framing: ['stunt'] } } } }), { framing: ['stunt', 'Burgum memo leaked'], source: 'why-it-moved' });
  assert.deepEqual(framingFor(story, posts, { families: { families: [{ name: 'absurd renaming', ids: ['201', '202'] }, { name: 'floor speech', ids: ['202'] }] } }), { framing: ['absurd renaming', 'floor speech'], source: 'message-families' });
  assert.deepEqual(framingFor(story, posts, {}), { framing: ['lake america', 'lake ontario'], source: 'phrases' });
  assert.deepEqual(framingFor(story, [posts[0]], {}), { framing: [], source: 'none' }); // one member shares nothing
});

// ── buildDossier: append-only, recompute today ──────────────────────────

test('buildDossier: a past day is copied verbatim even when the data behind it changed', () => {
  const first = buildDossier(story, null, { targetDate: '2026-09-02', dates, dayData, authorsById });
  assert.deepEqual(first.entries.map((e) => e.date), ['2026-09-01', '2026-09-02']);
  assert.deepEqual(first.entries[0].newMembers, ['RepA']);
  assert.deepEqual(first.entries[1].newMembers, ['RepB']);

  // The archive "changes" under day 1 (a late capture, a correction) and a
  // new day arrives: day 1 and day 2 stay byte-identical, day 3 is added.
  const altered = (date) => (date === '2026-09-01' ? { posts: [...days[date], post('102', 'a3', 'Lake America, really?', 9)], metrics: {} } : dayData(date));
  const next = buildDossier(story, first, { targetDate: '2026-09-03', dates, dayData: altered, authorsById });
  assert.deepEqual(next.entries[0], first.entries[0]);
  assert.deepEqual(next.entries[1], first.entries[1]);
  assert.equal(JSON.stringify(next.entries.slice(0, 2)), JSON.stringify(first.entries));
  assert.equal(next.entries[2].date, '2026-09-03');
  assert.deepEqual(next.entries[2].newMembers, ['RepD']);
  assert.equal(next.firstSeen, '2026-09-01');
  assert.equal(next.lastSeen, '2026-09-03');
  // the anchor is the most engaged post the ledger had seen when the dossier
  // was first built, and it survives a louder later day
  assert.deepEqual(first.anchors, ['202']);
  const dayOne = buildDossier(story, null, { targetDate: '2026-09-01', dates, dayData, authorsById });
  assert.deepEqual(dayOne.anchors, ['101']);
  const dayTwo = buildDossier(story, dayOne, { targetDate: '2026-09-02', dates, dayData, authorsById });
  assert.deepEqual(dayTwo.anchors, ['101']);
  // a taxonomy anchor always wins
  assert.deepEqual(buildDossier({ ...story, anchors: ['777'] }, dayTwo, { targetDate: '2026-09-03', dates, dayData, authorsById }).anchors, ['777']);
});

test('buildDossier: only the target day is recomputed; days after it are kept', () => {
  const full = buildDossier(story, null, { targetDate: '2026-09-03', dates, dayData, authorsById });
  // Re-run for day 2 with different day-2 data: day 2 changes, days 1 and 3 do not.
  const altered = (date) => (date === '2026-09-02' ? { posts: days[date].slice(0, 1), metrics: {} } : dayData(date));
  const rerun = buildDossier(story, full, { targetDate: '2026-09-02', dates, dayData: altered, authorsById });
  assert.deepEqual(rerun.entries.map((e) => e.date), ['2026-09-01', '2026-09-02', '2026-09-03']);
  assert.deepEqual(rerun.entries[0], full.entries[0]);
  assert.deepEqual(rerun.entries[2], full.entries[2]);
  assert.equal(rerun.entries[1].posts, 1);
  assert.equal(full.entries[1].posts, 2);
});

test('buildDossier: recomputing today is idempotent, and a change to today shows only in today', () => {
  const a = buildDossier(story, null, { targetDate: '2026-09-03', dates, dayData, authorsById });
  const b = buildDossier(story, a, { targetDate: '2026-09-03', dates, dayData, authorsById });
  assert.deepEqual(b, a);
  assert.equal(b.hash, a.hash);
  const more = (date) => (date === '2026-09-03' ? { posts: [...days[date], post('302', 'a2', 'Lake America again', 2)], metrics: {} } : dayData(date));
  const c = buildDossier(story, b, { targetDate: '2026-09-03', dates, dayData: more, authorsById });
  assert.deepEqual(c.entries.slice(0, 2), a.entries.slice(0, 2));
  assert.equal(c.entries[2].posts, 2);
  assert.notEqual(c.hash, a.hash);
  // a day with nothing to record gets no entry
  const quiet = buildDossier(story, null, { targetDate: '2026-09-05', dates: [...dates, '2026-09-04', '2026-09-05'], dayData, authorsById });
  assert.deepEqual(quiet.entries.map((e) => e.date), dates);
});

test('buildDossier: dated press/corrections land on their day when fresh, on the target day when the day is frozen, and never twice', () => {
  const press = [{ outlet: 'NYT', subject: 'Lake America, explained', date: '2026-09-01' }];
  const fresh = buildDossier(story, null, { targetDate: '2026-09-02', dates, dayData, authorsById, press });
  assert.deepEqual(fresh.entries[0].press, press);
  assert.deepEqual(fresh.entries[1].press, []);

  // The same hit discovered later, when day 1 is already frozen without it.
  const frozen = buildDossier(story, null, { targetDate: '2026-09-02', dates, dayData, authorsById });
  const late = buildDossier(story, frozen, { targetDate: '2026-09-03', dates, dayData, authorsById, press });
  assert.deepEqual(late.entries[0].press, []);
  assert.deepEqual(late.entries[2].press, press);
  const again = buildDossier(story, late, { targetDate: '2026-09-04', dates: [...dates, '2026-09-04'], dayData, authorsById, press });
  assert.equal(again.entries.flatMap((e) => e.press).length, 1);

  const corrections = [{ id: '201', on: '2026-09-03', kind: 'onto', note: 'names the lake' }];
  const judgments = [{ kind: 'merge', id: 'place-renaming', reason: 'confirmed: same order' }];
  const withLedger = buildDossier(story, frozen, { targetDate: '2026-09-03', dates, dayData, authorsById, corrections, judgments });
  assert.deepEqual(withLedger.entries[2].corrections, corrections);
  assert.deepEqual(withLedger.entries[2].judgments, judgments);
  const rerun = buildDossier(story, withLedger, { targetDate: '2026-09-04', dates: [...dates, '2026-09-04'], dayData, authorsById, corrections, judgments });
  assert.equal(rerun.entries.flatMap((e) => e.judgments).length, 1);
  assert.equal(rerun.entries.flatMap((e) => e.corrections).length, 1);
});

// ── summary cache ───────────────────────────────────────────────────────

test('entriesHash keys on the ledger and header facts, not on the summary or timestamps', () => {
  const a = buildDossier(story, null, { targetDate: '2026-09-02', dates, dayData, authorsById });
  const withSummary = { ...a, summary: { text: 'x', asOf: '2026-09-02', hash: 'zzz' }, updatedAt: 'now' };
  assert.equal(entriesHash(withSummary), a.hash);
  assert.notEqual(entriesHash({ ...a, label: 'Renamed' }), a.hash);
  assert.notEqual(entriesHash({ ...a, status: 'retired' }), a.hash);
});

test('refreshSummary: asks the model once per ledger state, caps at 120 words, honours the call cap', async () => {
  let calls = 0;
  const reply = Array.from({ length: 150 }, (_, i) => `w${i}`).join(' ');
  const client = { messages: { create: async () => { calls++; return { stop_reason: 'end_turn', content: [{ type: 'text', text: reply }] }; } } };
  const d0 = buildDossier(story, null, { targetDate: '2026-09-02', dates, dayData, authorsById });
  const budget = { calls: 0, max: 40 };

  const r1 = await refreshSummary(d0, { client, model: 'm', asOf: '2026-09-02', budget });
  assert.equal(r1.regenerated, true);
  assert.equal(calls, 1);
  assert.equal(r1.dossier.summary.hash, d0.hash);
  assert.equal(r1.dossier.summary.prompt, SUMMARY_VERSION);
  assert.equal(summaryCurrent(r1.dossier), true);
  assert.equal(r1.dossier.summary.asOf, '2026-09-02');
  assert.equal(r1.dossier.summary.text.split(' ').length, SUMMARY_MAX_WORDS);
  assert.ok(r1.dossier.summary.text.endsWith('…'));

  // Same ledger → cache hit, no call.
  const r2 = await refreshSummary(r1.dossier, { client, model: 'm', asOf: '2026-09-02', budget });
  assert.equal(r2.regenerated, false);
  assert.equal(r2.reason, 'unchanged');
  assert.equal(calls, 1);
  // A rebuild with identical inputs keeps the hash, so still no call.
  const same = buildDossier(story, r1.dossier, { targetDate: '2026-09-02', dates, dayData, authorsById });
  assert.equal(same.summary.hash, same.hash);
  assert.equal((await refreshSummary(same, { client, model: 'm', budget })).regenerated, false);
  assert.equal(calls, 1);
  // A new day → hash moves → one more call; the previous summary is shown to the model.
  const grown = buildDossier(story, same, { targetDate: '2026-09-03', dates, dayData, authorsById });
  assert.notEqual(grown.summary.hash, grown.hash);
  assert.match(summaryInput(grown), /Previous summary \(as of 2026-09-02\)/);
  const r3 = await refreshSummary(grown, { client, model: 'm', budget });
  assert.equal(r3.regenerated, true);
  assert.equal(calls, 2);
  assert.equal(budget.calls, 2);
  // Cap reached → no call, summary kept as-is.
  const r4 = await refreshSummary({ ...r3.dossier, hash: 'changed' }, { client, model: 'm', budget: { calls: 40, max: 40 } });
  assert.equal(r4.regenerated, false);
  assert.equal(r4.reason, 'call cap');
  assert.equal(calls, 2);
  // A summary written by an older prompt version regenerates once.
  const stale = { ...r3.dossier, summary: { ...r3.dossier.summary, prompt: SUMMARY_VERSION - 1 } };
  assert.equal(summaryCurrent(stale), false);
  assert.equal((await refreshSummary(stale, { client, model: 'm', budget })).regenerated, true);
  assert.equal(calls, 3);
  assert.equal(trimWords('one two three', 5), 'one two three');
  assert.match(summaryInput({ ...r3.dossier, entries: [{ ...r3.dossier.entries[1], posts: 0, members: 0, retweets: 2 }] }), /0 posts by 0 members \+ 2 retweets by members/);
});

// ── roster, sources, diffs ──────────────────────────────────────────────

test('storyRoster: taxonomy stories, promoted and provisional candidates, retirement, sorted by key', () => {
  const tax = {
    democracy: { label: 'Democracy', subtopics: { 'lake-america': { label: 'Lake America', story: true, since: new Date('2026-09-01T00:00:00Z'), aliases: ['Lake America'] }, 'voting-rights': { label: 'Voting' } } },
    immigration: { label: 'Immigration', subtopics: { 'liam-ramos': { label: 'Liam Ramos', story: true, since: '2026-08-30', retired: '2026-09-08' } } }
  };
  const stories = {
    promoted: ['immigration/liam-ramos'],
    candidates: [
      { key: 'celebrity-tribute', firstSeen: '2026-08-21', lastSeen: '2026-09-09', ids: ['1'], placement: { kind: 'story', macro: null, key: 'dolly-parton-tribute', label: 'Dolly Parton tribute', aliases: ['Dolly'] } },
      { key: 'notable-deaths', firstSeen: '2026-08-25', ids: ['2'], placement: { kind: 'story', macro: null, key: 'dolly-parton-tribute', label: 'Dolly Parton death', aliases: [] } },
      { key: 'place-renaming', firstSeen: '2026-08-28', ids: ['3'], placement: { kind: 'story', macro: 'democracy', key: 'lake-america', label: 'Lake renaming', aliases: [] } },
      { key: 'agriculture', firstSeen: '2026-08-20', ids: ['4'], placement: { kind: 'gap', macro: 'economy', key: 'agriculture', label: 'Agriculture', aliases: [] } },
      { key: 'ramos-cluster', firstSeen: '2026-08-30', ids: ['5'], placement: { kind: 'story', macro: 'immigration', key: 'liam-ramos', label: 'Liam Ramos', aliases: [] } }
    ]
  };
  const roster = storyRoster(tax, stories);
  assert.deepEqual(roster.map((r) => r.key), ['dolly-parton-tribute', 'lake-america', 'liam-ramos']);
  const lake = roster.find((r) => r.key === 'lake-america');
  assert.equal(lake.since, '2026-09-01'); // a YAML date becomes a string; the taxonomy's since wins
  assert.equal(lake.status, 'active');
  assert.deepEqual(lake.candidateKeys, ['place-renaming']); // the candidate that placed to it feeds its posts
  const dolly = roster.find((r) => r.key === 'dolly-parton-tribute');
  assert.equal(dolly.status, 'provisional');
  assert.equal(dolly.source, 'candidate');
  assert.equal(dolly.since, '2026-08-21'); // earliest across the candidates that placed to it
  assert.deepEqual(dolly.candidateKeys, ['celebrity-tribute', 'notable-deaths']);
  assert.equal(dolly.label, 'Dolly Parton tribute'); // first by candidate key
  const ramos = roster.find((r) => r.key === 'liam-ramos');
  assert.equal(ramos.status, 'retired');
  assert.equal(ramos.source, 'taxonomy');
  assert.deepEqual(storyRoster({}, null), []);
});

test('pressFor / correctionsFor / judgmentsFor read the caches by story key, placement key or label', () => {
  const s = { ...story, candidateKeys: ['place-renaming'] };
  const context = { stories: {
    'place-renaming': { key: 'lake-america', label: 'Lake America renaming', matches: [{ sender: 'NYT', subject: 'Lake America', date: '2026-09-01T12:00:00Z' }, { sender: 'NYT', subject: 'Lake America', date: '2026-09-01T13:00:00Z' }] },
    other: { key: 'other', label: 'Other', matches: [{ sender: 'Axios', subject: 'Nope', date: '2026-09-01T00:00:00Z' }] }
  } };
  assert.deepEqual(pressFor(s, context, '/nonexistent'), [{ outlet: 'NYT', subject: 'Lake America', date: '2026-09-01' }]);

  const topics = {
    '2026-09-02': { assignments: { 201: [['democracy', 'lake-america']], 777: [['economy', null]] }, corrected: { 201: { on: '2026-09-03', note: 'names the lake outright' }, 777: { on: '2026-09-03', note: 'was ours' }, 888: { on: '2026-09-03' } } }
  };
  assert.deepEqual(correctionsFor(s, topics, new Set(['777'])), [
    { id: '201', on: '2026-09-03', kind: 'onto', note: 'names the lake outright' },
    { id: '777', on: '2026-09-03', kind: 'off', note: 'was ours' }
  ]);

  const stories = {
    candidates: [{ key: 'place-renaming', mergedFrom: [{ key: 'lake-renaming-stunt', by: 'overlap', reason: '2 shared post(s)' }] }],
    confirmation: { groups: [{ keys: ['place-renaming', 'lake-renaming-stunt'], reason: 'same order' }, { keys: ['a', 'b'], reason: 'unrelated' }] }
  };
  const lookalikes = { stories: { 'lake-america': [{ id: '999', reason: 'quotes the order without naming it' }] } };
  const incidents = { merges: [{ story: 'lake-america', from: 'x', into: 'y', reason: 'same event' }], incidents: [{ id: 'i1', story: 'lake-america', corroboration: [{ id: 'i2', reason: 'same place' }] }] };
  assert.deepEqual(judgmentsFor(s, { stories, lookalikes, incidents }), [
    { kind: 'merge', id: 'lake-renaming-stunt', reason: 'overlap: 2 shared post(s)' },
    { kind: 'merge', id: 'lake-renaming-stunt', reason: 'confirmed: same order' },
    { kind: 'lookalike', id: '999', reason: 'quotes the order without naming it' },
    { kind: 'corroboration', id: 'x→y', reason: 'same event' },
    { kind: 'corroboration', id: 'i2', reason: 'same place' }
  ]);
  assert.deepEqual(judgmentsFor(s, {}), []);
});

test('diffDossiers: new members, framing shift, press, and stories gone quiet', () => {
  const press = [{ outlet: 'NYT', subject: 'Lake America', date: '2026-09-02' }];
  const d = buildDossier(story, null, { targetDate: '2026-09-03', dates, dayData, authorsById, press });
  const other = buildDossier({ ...story, key: 'other', label: 'Other' }, null, { targetDate: '2026-09-02', dates: dates.slice(0, 2), dayData, authorsById });
  const { changed, quiet } = diffDossiers(new Map([['other', other], ['lake-america', d]]), '2026-09-03');
  assert.equal(changed.length, 1);
  assert.equal(changed[0].key, 'lake-america');
  assert.equal(changed[0].prev.date, '2026-09-02');
  assert.deepEqual(changed[0].newMembers, ['RepD']);
  assert.equal(changed[0].framingShift, false); // day 3 has no shared phrase
  const day2 = diffDossiers([d], '2026-09-02');
  assert.equal(day2.changed[0].framingShift, true); // day 1 had none, day 2 has two
  assert.deepEqual(day2.changed[0].press, press);
  assert.deepEqual(quiet.map((q) => q.key), ['other']);
});
