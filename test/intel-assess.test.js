import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUBRIC, webToolDefs, collectToolResults, validateAssessment, assessStory, stripNumbers, normalizeUrl } from '../src/intel-assess.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'intel');
const reply = JSON.parse(fs.readFileSync(path.join(FIX, 'assess-reply.json'), 'utf8'));
const parsedReply = JSON.parse(reply.content.at(-1).text);
const caucusId = parsedReply.suggestedLine ? parsedReply.claims[3].source.postId : null;
const pressId = parsedReply.suggestedLine.postId;

const pack = {
  ids: new Set([caucusId, pressId, '777']), caucusIds: new Set([caucusId]), pressIds: new Set([pressId]), gopIds: new Set(['777']), officialIds: new Set(), hasNewsletter: true,
  text: 'STORY: fixture'
};

test('rubric is byte-stable and carries no dates, budgets or digits; web tool definitions match the docs shape', () => {
  assert.ok(RUBRIC.length > 1000);
  assert.ok(!/\d/.test(RUBRIC), 'no digits in the cached rubric');
  assert.equal(RUBRIC, RUBRIC.trim());
  const tools = webToolDefs({ search: 3, fetch: 4 });
  assert.deepEqual(tools[0], { type: 'web_search_20260209', name: 'web_search', max_uses: 3, blocked_domains: ['x.com', 'twitter.com'] });
  assert.deepEqual(tools[1], { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 4, max_content_tokens: 8000, citations: { enabled: true } });
});

test('collectToolResults: fetched URLs from success blocks, searched URLs, uses counted, error objects recorded (never thrown)', () => {
  const t = collectToolResults(reply.content);
  assert.deepEqual(t.webUses, { search: 1, fetch: 2 });
  assert.ok(t.fetchedUrls.has(normalizeUrl('https://www.congress.gov/bill/119th-congress/house-bill/4405')));
  assert.ok(!t.fetchedUrls.has(normalizeUrl('https://www.politico.com/news/2026/09/05/epstein-files-discharge-petition')), 'a failed fetch is not a fetched URL');
  assert.ok(t.searchUrls.has(normalizeUrl('https://www.politico.com/news/2026/09/05/epstein-files-discharge-petition')));
  assert.deepEqual(t.errors, [{ tool: 'web_fetch', code: 'url_not_accessible' }]);
  assert.equal(t.fetched[0].title, 'H.R.4405 - Epstein Files Transparency Act');
  // nested (dynamic filtering) shape: results inside a code-execution block's content
  const nested = collectToolResults([{ type: 'bash_code_execution_tool_result', content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://example.org/a' }] }] }]);
  assert.ok(nested.searchUrls.has('https://example.org/a'));
  assert.deepEqual(collectToolResults([{ type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } }]).errors, [{ tool: 'web_search', code: 'max_uses_exceeded' }]);
});

test('validator: unknown ids dropped (confidence capped), confirmed needs a fetched URL or official post, press post → reported, non-caucus suggested line → null, numbers stripped', () => {
  const tools = collectToolResults(reply.content);
  const out = validateAssessment(parsedReply, pack, { fetchedUrls: tools.fetchedUrls, searchUrls: tools.searchUrls, fetched: tools.fetched });
  // 1. unknown ids
  assert.ok(out.dropped.some((d) => /citedIds: 31337/.test(d)));
  assert.ok(out.dropped.some((d) => /gopAnswering.id: 999999/.test(d)));
  assert.deepEqual(out.judged.gopAnswering, []);
  assert.equal(out.judged.confidence, 'medium');
  // 2. confirmed only with a fetched primary source
  assert.equal(out.claims.confirmed.length, 1);
  assert.equal(out.claims.confirmed[0].source.url, 'https://www.congress.gov/bill/119th-congress/house-bill/4405');
  assert.equal(out.claims.confirmed[0].source.fetched, true);
  const searchedOnly = out.claims.reported.find((c) => /218 signatures/.test(c.text));
  assert.ok(searchedOnly, 'an article that was searched but not fetched is reported, not confirmed');
  assert.ok(out.couldNotVerify.some((s) => /218 signatures.*from confirmed to reported/.test(s)));
  const pressPost = out.claims.reported.find((c) => /leadership is whipping/.test(c.text));
  assert.ok(pressPost, 'a press post makes a claim reported, never confirmed');
  assert.equal(pressPost.source.postId, pressId);
  // 3. reported needs a press post, newsletter, or searched article
  const memberOnly = out.claims.unverified.find((c) => /released this month/.test(c.text));
  assert.ok(memberOnly, 'a member post cannot make a claim reported');
  assert.equal(memberOnly.status, 'circulating-unverified');
  const fakeId = out.claims.unverified.find((c) => /made-up id/.test(c.text));
  assert.equal(fakeId.source.postId, null);
  // 4. suggested line must be a caucus post
  assert.equal(out.judged.suggestedLine, null);
  assert.ok(out.dropped.some((d) => /suggestedLine.postId: .* is not a caucus post/.test(d)));
  // 5. numbers stripped, enums enforced, strings truncated
  assert.equal('score' in out.judged, false);
  assert.ok(!JSON.stringify(out.judged).includes('"count":45'));
  assert.equal(out.judged.oneLiner.length <= 200, true);
  // 6. provenance
  assert.deepEqual(out.provenance.urls, ['https://www.congress.gov/bill/119th-congress/house-bill/4405', 'https://www.politico.com/news/2026/09/05/epstein-files-discharge-petition']);
  assert.ok(out.provenance.ids.includes(caucusId) && out.provenance.ids.includes(pressId));
  assert.ok(!out.provenance.ids.includes('31337'));
  assert.deepEqual(stripNumbers({ a: 1, b: [2, 'x', { c: 3, d: 'y' }], e: 'z' }), { b: ['x', { d: 'y' }], e: 'z' });
});

test('validator: official-account post confirms; garbage input yields an empty but well-formed judgment', () => {
  const officialPack = { ...pack, officialIds: new Set(['777']) };
  const out = validateAssessment({ claims: [{ text: 'NWS issued a heat advisory.', status: 'confirmed', source: { kind: 'official-post', postId: '777' }, assertedBy: ['NWS'] }] }, officialPack);
  assert.equal(out.claims.confirmed.length, 1);
  assert.deepEqual(out.claims.confirmed[0].assertedBy, ['@NWS']);
  const empty = validateAssessment(null, pack);
  assert.deepEqual(empty.judged.frames, { ours: null, theirs: null, third: null });
  assert.deepEqual(empty.claims, { confirmed: [], reported: [], unverified: [], false: [] });
  assert.equal(empty.judged.confidence, 'medium');
});

test('assessStory: cached rubric + server tools in the request, pause_turn resumed, cache/usage summed, validator applied; refusal → judged null; 400 on tools degrades to search-free', async () => {
  const calls = [];
  const client = { messages: { create: async (params) => { calls.push(params); return calls.length === 1 ? { ...reply, stop_reason: 'pause_turn', content: reply.content.slice(0, 3) } : reply; } } };
  const out = await assessStory({ key: 'epstein-files' }, pack, { client, model: 'claude-opus-5', webTools: true, log: () => {} });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, 'claude-opus-5');
  assert.equal(calls[0].max_tokens, 12000);
  assert.deepEqual(calls[0].output_config, { effort: 'medium' });
  assert.equal(calls[0].system[0].text, RUBRIC);
  assert.deepEqual(calls[0].system[0].cache_control, { type: 'ephemeral' });
  assert.equal(calls[0].tools.length, 2);
  assert.equal(calls[0].messages[0].role, 'user');
  assert.equal(calls[1].messages.length, 2);
  assert.equal(calls[1].messages[1].role, 'assistant');
  assert.equal(out.assessmentSkipped, null);
  assert.equal(out.usage.calls, 2);
  assert.equal(out.usage.cacheRead, 4200);
  assert.equal(out.claims.confirmed.length, 1);
  assert.equal(out.judged.oneLiner.length > 0, true);
  assert.equal(out.webUses.fetch, 2);
  assert.ok(!('thinking' in calls[0]), 'adaptive thinking is the default on claude-opus-5: never send a thinking param');

  const refusing = { messages: { create: async () => ({ ...reply, stop_reason: 'refusal', content: [] }) } };
  const r = await assessStory({ key: 'k' }, pack, { client: refusing, webTools: false, log: () => {} });
  assert.equal(r.judged, null);
  assert.equal(r.assessmentSkipped, 'refusal');

  let n = 0;
  const noTools = { messages: { create: async (params) => { n++; if (params.tools.length) { const e = new Error('web_search is not enabled for this organization'); e.status = 400; throw e; } return { ...reply, content: [reply.content.at(-1)] }; } } };
  const d = await assessStory({ key: 'k' }, pack, { client: noTools, webTools: true, log: () => {} });
  assert.equal(n, 2);
  assert.equal(d.webToolsUsed, false);
  assert.match(d.webToolsUnavailable, /not enabled/);
  assert.equal(d.claims.confirmed.length, 0, 'without web tools nothing is confirmed by URL');
  assert.ok(d.claims.reported.length >= 1);

  const unparseable = { messages: { create: async () => ({ ...reply, stop_reason: 'max_tokens', content: [{ type: 'text', text: 'not json' }] }) } };
  const u = await assessStory({ key: 'k' }, pack, { client: unparseable, webTools: false, log: () => {} });
  assert.equal(u.assessmentSkipped, 'unparseable (max_tokens)');

  // a 400 that is not about tools (credits exhausted — seen live 2026-09-10) is not a reason to drop the tools and retry:
  // one call, judged null, the reason recorded, nothing thrown
  let m = 0;
  const broke = { messages: { create: async () => { m++; const e = new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'); e.status = 400; throw e; } } };
  const b = await assessStory({ key: 'k' }, pack, { client: broke, webTools: true, log: () => {} });
  assert.equal(m, 1);
  assert.equal(b.judged, null);
  assert.match(b.assessmentSkipped, /^api-error-400: Your credit balance is too low/);
  assert.equal(b.webToolsUnavailable, null);
  const down = { messages: { create: async () => { const e = new Error('529 overloaded'); e.status = 529; throw e; } } };
  assert.match((await assessStory({ key: 'k' }, pack, { client: down, webTools: false, log: () => {} })).assessmentSkipped, /^api-error-529/);
});
