import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, inputsHash, buildRecord } from '../src/intel.js';
import { toRow, unifyRows, voiceOf } from '../src/intel-corpus.js';
import { contextFor } from '../src/intel-context.js';
import { v } from '../src/intel-measure.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'intel');
const load = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const NOW = new Date('2026-09-10T07:30:00Z');

test('parseArgs covers every documented flag', () => {
  const o = parseArgs(['--dry-run', '--mode=counts', '--stories=a,b', '--story=c', '--phrase=tax breaks', '--ask=what moved?', '--max-reads=120', '--no-lists', '--no-llm', '--replay', '--force', '--rosters=house-gop', '--incidents', '--phrases']);
  assert.equal(o.dryRun, true);
  assert.equal(o.mode, 'counts');
  assert.deepEqual(o.stories, ['a', 'b', 'c']);
  assert.equal(o.phrase, 'tax breaks');
  assert.equal(o.ask, 'what moved?');
  assert.equal(o.maxReads, 120);
  assert.deepEqual([o.noLists, o.noLlm, o.replay, o.force, o.incidents, o.phrases], [true, true, true, true, true, true]);
  assert.deepEqual(o.rosters, ['house-gop']);
  assert.equal(parseArgs([]).maxReads, null);
});

test('inputsHash: stable under alias/id/thread reordering, changes with content or date', () => {
  const ctx = { matches: [{ threadId: 't2' }, { threadId: 't1' }] };
  const a = inputsHash({ ids: ['2', '1'], aliases: ['Epstein files', 'massie'] }, ctx, '2026-09-10');
  const b = inputsHash({ ids: ['1', '2'], aliases: ['Massie', 'epstein files'] }, { matches: [{ threadId: 't1' }, { threadId: 't2' }] }, '2026-09-10');
  assert.equal(a, b);
  assert.notEqual(a, inputsHash({ ids: ['1', '2', '3'], aliases: ['Massie', 'epstein files'] }, ctx, '2026-09-10'));
  assert.notEqual(a, inputsHash({ ids: ['1', '2'], aliases: ['Massie', 'epstein files'] }, ctx, '2026-09-11'));
  assert.notEqual(a, inputsHash({ ids: ['1', '2'], aliases: ['Massie', 'epstein files'] }, { matches: [] }, '2026-09-10'));
});

function fixtureCorpus() {
  const authorsById = load('authors.json').byId;
  const rosterFile = load('rosters/cap-hill-reporters.json');
  const rosters = { byId: new Map(rosterFile.members.map((m) => [String(m.id), { id: String(m.id), handle: m.username, name: m.name, followers: m.followers, rosters: ['cap-hill-reporters'] }])) };
  const archive = fs.readFileSync(path.join(FIX, 'archive.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const rows = unifyRows([
    ...archive.map((t) => toRow(t, { kind: 'archive', key: t.createdAt.slice(0, 10) }, { authorsById, rosters })),
    ...load('list-page.json').data.map((t) => toRow(t, { kind: 'list', key: 'cap-hill-reporters' }, { authorsById, rosters })),
    ...load('search-relevancy.json').data.map((t) => toRow(t, { kind: 'search', key: 'epstein-files', sort: 'relevancy' }, { authorsById, rosters }))
  ]).map((r) => ({ ...r, voice: voiceOf(r) }));
  return { rows, dates: ['2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10'], authorsById, archive };
}

test('buildRecord (--replay path) is byte-identical for identical inputs and follows the §12.1 shape', () => {
  const corpus = fixtureCorpus();
  const story = { key: 'epstein-files', label: 'Epstein files transparency', macro: 'democracy', kind: 'story', candidateKeys: ['epstein-files', 'epstein-investigation'], aliases: ['Epstein files', 'Massie', 'Anthropic', 'Coxon'], ids: corpus.archive.slice(0, 10).map((t) => t.id), firstSeen: '2026-08-31' };
  const bucketsOf = (f) => load(f).data.map((b) => ({ start: b.start, end: b.end, count: b.tweet_count }));
  const evidence = {
    story: 'epstein-files', date: '2026-09-10', queries: { organic: 'q', originals: 'q -is:retweet', sample: 'q -is:retweet -from:grok', control: 'c' },
    counts: [{ kind: 'organic', buckets: bucketsOf('counts-day.json'), units: 1 }, { kind: 'originals', buckets: bucketsOf('counts-day.json'), units: 1 }, { kind: 'hourly', buckets: bucketsOf('counts-hour.json'), units: 1 }],
    control: { kind: 'control', buckets: bucketsOf('counts-control.json'), units: 1 },
    pages: [{ sort: 'relevancy', oldest: '2026-09-08T22:00:00Z', newest: '2026-09-10T06:59:35Z', n: 20, units: 20 }], quotes: null, resolution: { resolved: 2, units: 4 }, posts: load('search-relevancy.json').data, units: 27, cacheHits: 0
  };
  const context = contextFor(story, load('context.json'), { now: NOW.getTime() });
  const cursors = { lists: { 'house-gop': { complete: true }, 'cap-hill-reporters': { complete: false } } };
  const opts = { evidence, control: evidence.control, corpus, context, cursors, now: NOW, date: '2026-09-10', mode: 'replay', hash: inputsHash(story, context, '2026-09-10'), authorsById: corpus.authorsById, activeHouseAccounts: 200 };
  const one = buildRecord(story, opts);
  const two = buildRecord(story, opts);
  assert.equal(JSON.stringify(one.record), JSON.stringify(two.record));
  const r = one.record;
  for (const k of ['key', 'label', 'macro', 'kind', 'candidateKey', 'aliases', 'queries', 'generatedAt', 'date', 'mode', 'inputsHash', 'status', 'flags', 'windows', 'measured', 'judged', 'assessmentSkipped', 'claims', 'couldNotVerify', 'provenance']) assert.ok(k in r, `record has ${k}`);
  assert.equal(r.candidateKey, 'epstein-files');
  assert.equal(r.judged, null);
  assert.equal(r.assessmentSkipped, 'no-llm');
  assert.deepEqual(Object.keys(r.measured), ['caucus', 'gop', 'press', 'organic', 'delegation', 'origin', 'windows']);
  assert.equal(r.provenance.evidenceFile, 'data/narratives/epstein-files/2026-09-10.json');
  assert.deepEqual(r.provenance.spend, { posts: 20, users: 2, requests: 3, units: 27, usd: 0.135 });
  assert.equal(v(r.measured.gop.complete), true);
  assert.ok(r.flags.includes('press-sample-incomplete'));
  assert.deepEqual(r.windows.search, ['2026-09-03', '2026-09-10']);
  assert.equal(r.windows.newsletter, load('context.json').generatedAt);
  assert.equal(typeof r.status, 'string');
  // the judged half attaches without disturbing the measured half
  const assess = { judged: { oneLiner: 'x', frames: {}, gopAnswering: [], hole: {}, suggestedLine: null, whatsNew: [], confidence: 'low' }, model: 'claude-opus-5', webToolsUsed: true, webUses: { search: 1, fetch: 0 }, claims: { confirmed: [], reported: [], unverified: [], false: [] }, couldNotVerify: [], provenance: { ids: [], urls: [] }, assessmentSkipped: null, usage: { input: 1, cacheRead: 2, cacheWrite: 0, output: 3, calls: 1 }, fetched: [{ url: 'https://example.org/a', title: 'A' }], dropped: [] };
  const three = buildRecord(story, { ...opts, assess });
  assert.equal(JSON.stringify(three.record.measured.caucus), JSON.stringify(one.record.measured.caucus));
  assert.equal(three.record.judged.model, 'claude-opus-5');
  assert.deepEqual(three.record.judged.webUses, { search: 1, fetch: 0 });
  assert.equal(v(three.record.measured.press.articles)[0].url, 'https://example.org/a');
  assert.deepEqual(three.record.provenance.claude, { input: 1, cacheRead: 2, cacheWrite: 0, output: 3, calls: 1 });
  assert.equal(buildRecord(story, { ...opts, noAssessReason: 'no-credential' }).record.assessmentSkipped, 'no-credential');
});
