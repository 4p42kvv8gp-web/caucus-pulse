import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseCorrections, resolveIds, applyCorrections, correctionExamples, latestPerId, snowflakeDates,
  loadCorrections, correctionsPath
} from '../src/corrections.js';
import { systemPrompt, renderExamples } from '../src/taxonomy.js';

const tax = {
  immigration: { label: 'Immigration', subtopics: { 'dilley-detention': { label: 'Dilley' }, 'ice-enforcement': { label: 'ICE' } } },
  'public-safety': { label: 'Guns & public safety', subtopics: { 'gun-violence': { label: 'Gun violence' } } },
  economy: { label: 'Economy', subtopics: {} }
};

const authorsById = { u1: { handle: 'RepBarragan' }, u2: { handle: 'BettyMcCollum04' }, u3: { handle: 'Other' } };
const ORIG = '2095338461855191088'; // real snowflake: 2026-09-03T02:29Z = 2026-09-02 ET
const archive = {
  '2026-09-02': [
    { id: ORIG, authorId: 'u2', type: 'tweet', refId: null, text: 'My thoughts are with the families of the two victims who were killed by senseless gun violence today in Minneapolis. I’m also praying for a full recovery.' },
    { id: '2095338461855191089', authorId: 'u2', type: 'tweet', refId: null, text: 'Join us for a town hall &amp; coffee in Minneapolis on Friday' },
    { id: '2095338461855191090', authorId: 'u3', type: 'tweet', refId: null, text: 'senseless gun violence today in Minneapolis — echoing my colleague' },
    { id: '2095338461855191091', authorId: 'u1', type: 'retweet', refId: ORIG, text: 'RT @BettyMcCollum04: My thoughts are with the families' }
  ],
  '2026-09-03': [
    { id: '2095700000000000000', authorId: 'u3', type: 'retweet', refId: ORIG, text: 'RT @BettyMcCollum04: My thoughts' },
    { id: '999', authorId: 'u3', type: 'tweet', refId: null, text: 'an id whose snowflake date is nowhere near the archive' }
  ]
};
const deps = { loadDay: (d) => archive[d] || [], authorsById, archiveDates: () => Object.keys(archive).sort() };

test('parseCorrections keeps ids/dates as strings, normalizes topic forms, validates against the taxonomy', () => {
  const [e] = parseCorrections(`
- id: 2095338461855191088
  topics: [[public-safety, gun-violence], [immigration], "economy", [immigration, ~], [immigration, null]]
  note: why
  by: me
  on: 2026-09-10
`, tax);
  assert.equal(e.id, '2095338461855191088'); // an unquoted 19-digit id must not round through a Number
  assert.equal(e.on, '2026-09-10');           // and a bare date must not become a Date
  assert.deepEqual(e.topics, [['public-safety', 'gun-violence'], ['immigration', null], ['economy', null], ['immigration', null], ['immigration', null]]);
  assert.equal(e.note, 'why');

  const [h] = parseCorrections('- handle: "@BettyMcCollum04"\n  date: 2026-09-02\n  match: "x"\n  topics: []\n  on: 2026-09-10\n', tax);
  assert.equal(h.handle, 'BettyMcCollum04');
  assert.deepEqual(h.topics, []);

  assert.throws(() => parseCorrections('- id: "1"\n  topics: [[immigration, bogus]]\n  on: 2026-09-10\n', tax), /entry #1: unknown subtopic "immigration\/bogus"/);
  assert.throws(() => parseCorrections('- id: "1"\n  topics: [[nope, null]]\n  on: 2026-09-10\n', tax), /unknown macro "nope"/);
  assert.throws(() => parseCorrections('- handle: x\n  date: 2026-09-02\n  topics: []\n  on: 2026-09-10\n', tax), /give an id, or handle \+ date \+ match/);
  assert.throws(() => parseCorrections('- id: "1"\n  topics: []\n  on: yesterday\n', tax), /"on" must be/);
  assert.throws(() => parseCorrections('- id: "1"\n  topics: []\n  on: 2026-09-10\n  date: 9/2\n', tax), /date "9\/2" must be YYYY-MM-DD/);
  assert.deepEqual(parseCorrections('', tax), []);
});

test('resolveIds: handle + date + match → id via the archive and authors', () => {
  const base = { topics: [], note: '', by: '', on: '2026-09-10' };
  const { resolved, unresolved } = resolveIds([
    { ...base, handle: 'bettymccollum04', date: '2026-09-02', match: 'senseless gun violence today in Minneapolis' }, // case-insensitive handle; other members' posts and retweets don't count
    { ...base, handle: 'BettyMcCollum04', date: '2026-09-02', match: 'town hall & coffee' },                            // &amp; in the archive
    { ...base, handle: 'BettyMcCollum04', date: '2026-09-02', match: "I'm also praying" },                              // curly apostrophe in the archive
    { ...base, handle: 'BettyMcCollum04', date: '2026-09-02', match: 'Minneapolis' },                                   // ambiguous
    { ...base, handle: 'BettyMcCollum04', date: '2026-09-02', match: 'not in any post' },
    { ...base, handle: 'Nobody', date: '2026-09-02', match: 'x' },
    { ...base, id: ORIG },                     // date found from the snowflake timestamp
    { ...base, id: '999' },                    // snowflake miss → full archive scan
    { ...base, id: '999', date: '2026-09-02' } // explicit date is trusted
  ], deps);
  assert.deepEqual(resolved.map((r) => [r.id, r.date]), [
    [ORIG, '2026-09-02'], ['2095338461855191089', '2026-09-02'], [ORIG, '2026-09-02'], [ORIG, '2026-09-02'], ['999', '2026-09-03']
  ]);
  assert.equal(resolved[0].text, archive['2026-09-02'][0].text);
  assert.match(unresolved[0].reason, /matches 2 posts by @BettyMcCollum04 on 2026-09-02/);
  assert.match(unresolved[1].reason, /no original post by @BettyMcCollum04 on 2026-09-02 containing "not in any post"/);
  assert.match(unresolved[2].reason, /@Nobody is not in data\/authors.json/);
  assert.match(unresolved[3].reason, /id 999 is not in data\/archive for 2026-09-02/);
  assert.ok(snowflakeDates(ORIG).includes('2026-09-02'));
});

test('applyCorrections rewrites a temp copy of the topics file, follows retweets, and is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corrections-'));
  const topicsPathFor = (date) => path.join(dir, `${date}.json`);
  const write = (date, data) => fs.writeFileSync(topicsPathFor(date), JSON.stringify(data));
  const read = (date) => JSON.parse(fs.readFileSync(topicsPathFor(date), 'utf8'));
  write('2026-09-02', {
    date: '2026-09-02', model: 'm',
    assignments: { [ORIG]: [], '2095338461855191089': [['economy', null]], '2095338461855191091': [] },
    incidents: {}, emerging: [{ label: 'Minneapolis shooting', ids: [ORIG, 'x'] }, { label: 'Only this one', ids: [ORIG] }],
    unclassified: [ORIG, 'y'], failedChunks: 0
  });
  write('2026-09-03', { date: '2026-09-03', model: 'm', assignments: { '2095700000000000000': [] }, incidents: {}, emerging: [], unclassified: [], failedChunks: 0 });

  const fix = { id: ORIG, date: '2026-09-02', topics: [['public-safety', 'gun-violence']], note: 'condolence still counts', by: 'ed', on: '2026-09-10' };
  const opts = { loadDay: deps.loadDay, topicsPathFor };

  const dry = applyCorrections([fix], { ...opts, dryRun: true });
  assert.equal(dry.changes.length, 3); // the post + a same-day retweet + a next-day retweet
  assert.deepEqual(dry.written, ['2026-09-02', '2026-09-03']);
  assert.deepEqual(read('2026-09-02').assignments[ORIG], []); // dry run wrote nothing

  const r = applyCorrections([fix], opts);
  assert.deepEqual(r.changes.map((c) => [c.date, c.id, c.via]), [
    ['2026-09-02', ORIG, null], ['2026-09-02', '2095338461855191091', ORIG], ['2026-09-03', '2095700000000000000', ORIG]
  ]);
  assert.deepEqual(r.changes[0].from, []);
  const day = read('2026-09-02');
  assert.deepEqual(day.assignments[ORIG], [['public-safety', 'gun-violence']]);
  assert.deepEqual(day.assignments['2095338461855191091'], [['public-safety', 'gun-violence']]);
  assert.deepEqual(day.assignments['2095338461855191089'], [['economy', null]]); // untouched
  assert.deepEqual(day.corrected[ORIG], { note: 'condolence still counts', by: 'ed', on: '2026-09-10' });
  assert.deepEqual(day.corrected['2095338461855191091'], { note: 'condolence still counts', by: 'ed', on: '2026-09-10', via: ORIG });
  assert.deepEqual(day.unclassified, ['y']);
  assert.deepEqual(day.emerging, [{ label: 'Minneapolis shooting', ids: ['x'] }]); // the empty cluster is dropped
  assert.deepEqual(read('2026-09-03').assignments['2095700000000000000'], [['public-safety', 'gun-violence']]);
  assert.equal(day.model, 'm'); // the rest of the file is preserved

  const again = applyCorrections([fix], opts);
  assert.deepEqual({ changes: again.changes.length, unchanged: again.unchanged, written: again.written }, { changes: 0, unchanged: 3, written: [] });

  // A day the nightly hasn't classified yet is reported, not created.
  const pend = applyCorrections([{ ...fix, id: '1', date: '2026-09-09' }], opts);
  assert.deepEqual(pend.pending, [{ id: '1', date: '2026-09-09' }]);
  assert.ok(!fs.existsSync(topicsPathFor('2026-09-09')));

  // Two entries for one post: the most recently filed wins.
  const later = { ...fix, topics: [['economy', null]], on: '2026-09-11' };
  assert.deepEqual(latestPerId([later, fix]).map((c) => c.on), ['2026-09-11']);
  assert.deepEqual(latestPerId([fix, later]).map((c) => c.on), ['2026-09-11']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('correctionExamples takes the most recent N and renders a byte-stable prompt block', () => {
  const mk = (id, on, note) => ({ id, topics: [['public-safety', 'gun-violence']], note, by: 'ed', on });
  const entries = [mk(ORIG, '2026-09-08', 'oldest'), mk('2095338461855191090', '2026-09-10', 'newest'), mk('2095338461855191089', '2026-09-09', 'middle')];
  const ex = correctionExamples(2, { ...deps, entries });
  assert.deepEqual(ex.map((e) => e.why), ['middle', 'newest']); // the two most recent, then in id order
  assert.equal(ex[0].text, archive['2026-09-02'][1].text);
  assert.deepEqual(ex[0].topics, [['public-safety', 'gun-violence']]);
  // Same set in a different file order → identical block (prompt cache prefix).
  const shuffled = correctionExamples(2, { ...deps, entries: [entries[2], entries[1], entries[0]] });
  assert.equal(renderExamples(shuffled), renderExamples(ex));
  assert.deepEqual(correctionExamples(0, { ...deps, entries }), []);
  assert.equal(correctionExamples(10, { ...deps, entries }).length, 3);

  const block = renderExamples(ex);
  assert.equal(block, [
    JSON.stringify({ text: archive['2026-09-02'][1].text, topics: [['public-safety', 'gun-violence']], why: 'middle' }),
    JSON.stringify({ text: archive['2026-09-02'][2].text, topics: [['public-safety', 'gun-violence']], why: 'newest' })
  ].join('\n'));
  assert.doesNotMatch(block, /\d{4}-\d{2}-\d{2}T/); // no timestamps anywhere in the block

  const plain = systemPrompt(tax);
  const withEx = systemPrompt(tax, { examples: ex });
  assert.equal(withEx, systemPrompt(tax, { examples: ex }));
  assert.equal(plain, systemPrompt(tax, { examples: [] }));
  assert.doesNotMatch(plain, /Corrections from the editors/);
  assert.match(withEx, /Corrections from the editors \(follow these precedents\)/);
  assert.ok(withEx.includes(block));
  assert.ok(withEx.indexOf('Corrections from the editors') < withEx.indexOf('Reply with ONLY a JSON object'));
});

// The checked-in file must load against the checked-in taxonomy and resolve
// against the archive (a typo here would otherwise surface only at run time).
test('config/corrections.yaml is valid and every entry resolves', { skip: !fs.existsSync(correctionsPath) || !fs.existsSync(path.join(path.dirname(correctionsPath), '..', 'data', 'authors.json')) }, () => {
  const entries = loadCorrections();
  assert.ok(entries.length >= 1);
  const { unresolved } = resolveIds(entries);
  assert.deepEqual(unresolved.map((u) => u.reason), []);
});
