import test from 'node:test';
import assert from 'node:assert/strict';
import { storyContext, allStoryContexts, nearbyStoryContext, renderMemory, memoryForClassifier, memoryForStories, aliasScore } from '../src/memory.js';
import { systemBlocks } from '../src/classify-live.js';
import { confirmDuplicates } from '../src/stories.js';
import { renderStoryChanges } from '../src/report.js';

const entry = (date, { posts = 1, leaders = [], framing = [], newMembers = [] } = {}) => ({
  date, posts, retweets: 0, members: leaders.length, byCaucus: {}, newMembers, leaders, framing, framingSource: framing.length ? 'phrases' : 'none',
  topPosts: [], ids: [], press: [], corrections: [], judgments: []
});

const lake = {
  key: 'lake-america', label: 'Lake America renaming', macro: 'democracy', status: 'active', since: '2026-09-01', aliases: ['Lake America', 'Lake Ontario'],
  anchors: ['101'], firstSeen: '2026-09-01', lastSeen: '2026-09-04',
  summary: { text: 'Members reacted to the order renaming Lake Ontario. It spread on day two.', asOf: '2026-09-04', hash: 'h' },
  entries: [
    entry('2026-09-01', { leaders: [{ handle: 'RepA', posts: 1 }], newMembers: ['RepA'], framing: ['lake ontario'] }),
    entry('2026-09-02', { posts: 3, leaders: [{ handle: 'RepB', posts: 2 }, { handle: 'RepA', posts: 1 }], newMembers: ['RepB'], framing: ['lake america', 'lake ontario'] }),
    entry('2026-09-03', { posts: 0 }),
    entry('2026-09-04', { posts: 2, leaders: [{ handle: 'RepC', posts: 1 }, { handle: 'RepA', posts: 1 }], newMembers: ['RepC'], framing: ['absurd stunt'] })
  ]
};
const dolly = {
  key: 'dolly-parton-tribute', label: 'Dolly Parton tribute', macro: null, status: 'provisional', since: '2026-08-21', aliases: ['Dolly Parton', 'Imagination Library'],
  anchors: [], firstSeen: '2026-08-21', lastSeen: '2026-09-09', summary: null,
  entries: [entry('2026-08-21', { leaders: [{ handle: 'RepZ', posts: 4 }], newMembers: ['RepZ'], framing: ['imagination library'] })]
};
const retired = { ...dolly, key: 'old-story', label: 'Old story', status: 'retired', aliases: ['Old story'], lastSeen: '2026-08-01' };
const dossiers = new Map([['lake-america', lake], ['dolly-parton-tribute', dolly], ['old-story', retired]]);
const reversed = new Map([...dossiers.entries()].reverse());

test('storyContext: leaders aggregate across the ledger, framings from the last three posting days, in a fixed order', () => {
  const c = storyContext('lake-america', { dossiers });
  assert.deepEqual(c.leaders, [{ handle: 'RepA', posts: 3 }, { handle: 'RepB', posts: 2 }, { handle: 'RepC', posts: 1 }]);
  assert.deepEqual(c.recentFramings, ['lake ontario', 'lake america', 'absurd stunt']); // oldest first, deduped
  assert.equal(c.summary, lake.summary.text);
  assert.equal(c.since, '2026-09-01');
  assert.deepEqual(c.anchors, ['101']);
  assert.equal(storyContext('nope', { dossiers }), null);
  assert.deepEqual(allStoryContexts({ dossiers: reversed }).map((x) => x.key), ['dolly-parton-tribute', 'lake-america', 'old-story']);
  assert.deepEqual(allStoryContexts({ dossiers, statuses: ['provisional'] }).map((x) => x.key), ['dolly-parton-tribute']);
});

test('renderMemory is byte-stable whatever order the dossiers were loaded in, and dates come from the ledger', () => {
  const a = memoryForClassifier({ dossiers });
  const b = memoryForClassifier({ dossiers: reversed });
  assert.equal(a, b);
  assert.match(a, /^Memory — story dossiers \(long-term; as of 2026-09-09\)\./);
  assert.match(a, /provisional/); // the rule about provisional stories
  assert.match(a, /- Dolly Parton tribute \[dolly-parton-tribute; provisional; since 2026-08-21; last 2026-09-09; leads @RepZ; aliases: Dolly Parton, Imagination Library\]\n  Summary: \(no summary yet — ledger only\)\n  Framing lately: "imagination library"/);
  assert.match(a, /- Lake America renaming \[lake-america; active; since 2026-09-01; last 2026-09-04; leads @RepA @RepB @RepC; aliases: Lake America, Lake Ontario\]\n  Summary: Members reacted/);
  assert.ok(!a.includes('Old story')); // retired stories stay out of the classifier's memory
  assert.equal(memoryForClassifier({ dossiers, limit: 1 }).includes('Lake America'), false); // most recently seen wins the cap
  assert.equal(renderMemory([]), '');
  // a judging step asks for exactly the stories it holds, any status
  const m = memoryForStories(['old-story', 'lake-america', 'missing'], { dossiers });
  assert.ok(m.includes('Old story') && m.includes('Lake America renaming') && !m.includes('Dolly'));
  assert.equal(m, memoryForStories(['lake-america', 'old-story'], { dossiers }));
});

test('nearbyStoryContext: alias match by text or by post id, k-capped, explainable', async () => {
  const hits = await nearbyStoryContext('Trump wants to call Lake Ontario "Lake America" — absurd', 2, { dossiers, semantic: null });
  assert.deepEqual(hits.map((h) => h.key), ['lake-america']);
  assert.deepEqual(hits[0].match, { by: 'alias', score: 2, terms: ['lake america', 'lake ontario'] });
  const byId = await nearbyStoryContext('2097000000000000001', 2, { dossiers, semantic: null, loadDay: () => [{ id: '2097000000000000001', text: 'Dolly Parton gave my district the Imagination Library' }] });
  assert.deepEqual(byId.map((h) => h.key), ['dolly-parton-tribute']);
  assert.deepEqual(await nearbyStoryContext('2097000000000000009', 2, { dossiers, semantic: null, loadDay: () => [] }), []);
  assert.deepEqual(await nearbyStoryContext('nothing here', 2, { dossiers, semantic: null }), []);
  const both = await nearbyStoryContext('Dolly Parton and Lake America in one post', 1, { dossiers, semantic: null });
  assert.equal(both.length, 1);
  assert.equal(both[0].key, 'dolly-parton-tribute'); // equal scores → key order
  // the semantic hook, when present, is preferred and keeps its reason
  const semantic = { nearestStories: async () => [{ key: 'lake-america', score: 0.91, reason: 'same order, no alias' }] };
  const sem = await nearbyStoryContext('an order about a great lake', 2, { dossiers, semantic });
  assert.deepEqual(sem[0].match, { by: 'semantic', score: 0.91, reason: 'same order, no alias' });
  assert.deepEqual(aliasScore('no match', { label: 'Lake America renaming', aliases: [] }), { score: 0, terms: [] });
});

test('the memory block is wired in: a second cached system block for the live classifier, a section of the confirmation prompt', async () => {
  const tax = { democracy: { label: 'Democracy', subtopics: {} } };
  const blocks = systemBlocks(tax, { memoryText: memoryForClassifier({ dossiers }) });
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[1].cache_control, { type: 'ephemeral' });
  assert.match(blocks[1].text, /^Memory — story dossiers/);
  assert.equal(systemBlocks(tax).length, 1);

  let request;
  const client = { messages: { create: async (req) => { request = req; return { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"groups": []}' }] }; } } };
  const stories = [{ key: 'a', label: 'a', samples: [] }, { key: 'b', label: 'b', samples: [] }];
  await confirmDuplicates(stories, { client, model: 'm', memory: memoryForStories(['lake-america'], { dossiers }) });
  assert.match(request.messages[0].content, /When in doubt, do not group\.\n\nMemory — story dossiers[\s\S]*Lake America renaming[\s\S]*\nClusters:\n1\. "a"/);
  await confirmDuplicates(stories, { client, model: 'm' });
  assert.ok(!request.messages[0].content.includes('Memory —'));
});

test('report: "what changed since yesterday" reads the dossier diffs', () => {
  const lines = renderStoryChanges('2026-09-04', dossiers).join('\n');
  assert.match(lines, /## Stories: what changed since yesterday/);
  assert.match(lines, /\*\*Lake America renaming\*\* _\(active\)_ — 2 posts, 2 members \(↓ from 3 on 2026-09-02\) · new: @RepC · framing: "absurd stunt" \(was "lake america", "lake ontario"\)/);
  assert.match(lines, /Memory: Members reacted to the order renaming Lake Ontario\./);
  assert.deepEqual(renderStoryChanges('2026-09-04', new Map()), []);
  assert.match(renderStoryChanges('2026-09-05', dossiers).join('\n'), /Quiet today after posting yesterday: Lake America renaming \(2 posts\)/);
});
