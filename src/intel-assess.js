// The MODEL half of a narrative record (docs/NARRATIVE_INTELLIGENCE.md §9):
// one messages.create per sampled story with the static rubric cached and
// the web_search / web_fetch server tools on (Anthropic-billed, never the X
// ledger), then the validator — the code guarantee that no claim is
// `confirmed` without a fetched primary source or an official-account post
// in the pack, that every cited id exists in the pack, and that the model
// never emits a number.
//
// `client` is injectable (the stories.confirmDuplicates precedent) so the
// parse/validate path runs against canned replies in tests.
import { settings } from './util.js';
import { anthropicClient } from './anthropic-auth.js';
import { parseJsonLoose } from './taxonomy.js';

export const CLAIM_STATUSES = ['confirmed', 'reported', 'circulating-unverified', 'disputed', 'false'];
export const SOURCE_KINDS = ['document', 'article', 'official-post', 'press-post', 'newsletter', 'member-post', 'none'];

// Byte-stable: no dates, budgets, newsletter text or numbers in here — all of
// that travels in the user turn so the prompt cache survives across stories.
export const RUBRIC = `You are a research analyst in the House Democratic Leader's research and writing shop, writing for staff who have thirty seconds.

You receive one developing story with four voices — caucus (House Democrats), gop (House Republicans), press (reporters and newsletters), organic (everyone else on X) — as MEASURED numbers computed by code, plus attributed posts with ids. The numbers are authoritative; you interpret them. Your job is only what code cannot do: name the frames, extract the claims being made and grade their sourcing, mark which GOP posts answer which caucus line even when they avoid our words, find the hole, and draft one line the Leader could use.

Evidence rules, in order:
- Cite posts by id only, and only ids that appear in the pack. Never invent an id, a handle, a quote, or a URL.
- A claim is "confirmed" only by a primary source you actually fetched with web_fetch (an official statement, a filing, a court document, an article body) or by a post from an account marked official in the pack. A press post or a newsletter item makes a claim "reported" — a named outlet says it, no primary source read. Same-side posts never confirm each other: members repeating a line is adoption, not evidence. A claim is "false" only when a fetched primary source contradicts it. Default every claim to "circulating-unverified".
- "Verified" on X means paid, not authority. X volume is not audience reach.
- Silence from the GOP is a finding only if the pack says the sample was complete.
- Say when a handful of accounts produce most of the volume.
- Use web_search to find articles and web_fetch to read primary sources when a claim's status turns on it. Stop when you are confident; do not search for its own sake.
- Never output numbers of your own: no counts, percentages, or estimates. The measured figures are already in the record; refer to them in words if needed.

Reply with ONLY a JSON object, no prose before or after, in exactly this shape:
{"oneLiner": "one sentence, at most two hundred characters, for a staffer with thirty seconds",
 "frames": {"ours": "the caucus frame in one sentence", "theirs": "the GOP frame or null", "third": "the press/organic frame or null"},
 "gopAnswering": [{"id": "gop post id from the pack", "answersCaucusPostId": "caucus post id from the pack or null", "why": "one sentence"}],
 "claims": [{"text": "the claim in one sentence", "status": "confirmed|reported|circulating-unverified|disputed|false",
             "source": {"kind": "document|article|official-post|press-post|newsletter|member-post|none", "url": "fetched or searched URL or null", "postId": "pack id or null", "quote": "short supporting quote or null"},
             "assertedBy": ["@handle"]}],
 "hole": {"unansweredGopClaim": "one sentence or null", "unaddressedPressQuestion": "one sentence or null"},
 "suggestedLine": {"postId": "the caucus post id it comes from", "handle": "@handle", "text": "at most two hundred characters"},
 "whatsNew": ["short bullet"],
 "couldNotVerify": ["what you tried to verify and could not"],
 "citedIds": ["every pack id you relied on"],
 "confidence": "high|medium|low"}`;

export function webToolDefs({ search = 3, fetch = 4 } = settings.intel?.web_uses || {}) {
  return [
    { type: 'web_search_20260209', name: 'web_search', max_uses: search, blocked_domains: ['x.com', 'twitter.com'] },
    { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: fetch, max_content_tokens: 8000, citations: { enabled: true } }
  ];
}

export const normalizeUrl = (u) => {
  try {
    const url = new URL(String(u).trim());
    url.hash = '';
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch { return null; }
};

// Walk every content block (server tools nest results under code-execution
// blocks with dynamic filtering) and collect what was fetched and searched.
// Success content is a list (search) or an object with type web_fetch_result;
// error content is an object with error_code — nothing is thrown.
export function collectToolResults(content) {
  const out = { fetchedUrls: new Set(), searchUrls: new Set(), fetched: [], webUses: { search: 0, fetch: 0 }, errors: [] };
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    if (node.type === 'server_tool_use') {
      if (node.name === 'web_search') out.webUses.search++;
      if (node.name === 'web_fetch') out.webUses.fetch++;
    }
    if (node.type === 'web_search_tool_result') {
      if (Array.isArray(node.content)) {
        for (const r of node.content) if (r?.url) out.searchUrls.add(normalizeUrl(r.url));
      } else if (node.content?.error_code) {
        out.errors.push({ tool: 'web_search', code: node.content.error_code });
      }
    }
    if (node.type === 'web_fetch_tool_result') {
      const c = node.content;
      if (c?.type === 'web_fetch_result' && c.url) {
        out.fetchedUrls.add(normalizeUrl(c.url));
        out.fetched.push({ url: c.url, title: c.content?.title || null, retrievedAt: c.retrieved_at || null });
      } else if (c?.error_code) out.errors.push({ tool: 'web_fetch', code: c.error_code });
    }
    for (const k of ['content', 'input']) if (k in node && typeof node[k] === 'object') walk(node[k]);
  };
  walk(content);
  out.fetchedUrls.delete(null);
  out.searchUrls.delete(null);
  return out;
}

const str = (x, n) => (x == null ? null : String(x).replace(/\s+/g, ' ').trim().slice(0, n) || null);
const handleStr = (h) => { const m = String(h || '').match(/@?([A-Za-z0-9_]{1,15})/); return m ? `@${m[1]}` : null; };

// Recursively drop numeric values: the model never emits a number.
export function stripNumbers(x) {
  if (typeof x === 'number') return undefined;
  if (Array.isArray(x)) return x.map(stripNumbers).filter((y) => y !== undefined);
  if (x && typeof x === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(x)) { const s = stripNumbers(val); if (s !== undefined) out[k] = s; }
    return out;
  }
  return x;
}

// §9.4 — the guarantee. pack: { ids, caucusIds, pressIds, officialIds, hasNewsletter }.
export function validateAssessment(parsed, pack, { fetchedUrls = new Set(), searchUrls = new Set(), fetched = [] } = {}) {
  const p = stripNumbers(parsed && typeof parsed === 'object' ? parsed : {});
  const couldNotVerify = (Array.isArray(p.couldNotVerify) ? p.couldNotVerify : []).map((s) => str(s, 240)).filter(Boolean);
  const dropped = [];
  const known = (id) => id != null && pack.ids.has(String(id));
  const keepId = (id, where) => { if (known(id)) return String(id); if (id != null) dropped.push(`${where}: ${String(id).slice(0, 30)}`); return null; };
  const urls = new Set();
  const ids = new Set();

  const citedIds = [...new Set((Array.isArray(p.citedIds) ? p.citedIds : []).map((id) => keepId(id, 'citedIds')).filter(Boolean))];
  citedIds.forEach((id) => ids.add(id));

  const frames = p.frames && typeof p.frames === 'object' ? { ours: str(p.frames.ours, 300), theirs: str(p.frames.theirs, 300), third: str(p.frames.third, 300) } : { ours: null, theirs: null, third: null };

  const gopAnswering = [];
  for (const g of Array.isArray(p.gopAnswering) ? p.gopAnswering : []) {
    const id = keepId(g?.id, 'gopAnswering.id');
    if (!id) continue;
    const answers = g.answersCaucusPostId == null ? null : keepId(g.answersCaucusPostId, 'gopAnswering.answersCaucusPostId');
    ids.add(id); if (answers) ids.add(answers);
    gopAnswering.push({ id, answersCaucusPostId: answers && pack.caucusIds.has(answers) ? answers : null, why: str(g.why, 240) });
  }

  const claims = { confirmed: [], reported: [], unverified: [], false: [] };
  for (const c of Array.isArray(p.claims) ? p.claims : []) {
    const text = str(c?.text, 300);
    if (!text) continue;
    let status = CLAIM_STATUSES.includes(c.status) ? c.status : 'circulating-unverified';
    const src = c.source && typeof c.source === 'object' ? c.source : {};
    let kind = SOURCE_KINDS.includes(src.kind) ? src.kind : 'none';
    const url = src.url ? String(src.url).trim() : null;
    const nurl = url ? normalizeUrl(url) : null;
    const postId = src.postId == null ? null : keepId(src.postId, 'claims.source.postId');
    const fetchedOk = Boolean(nurl && fetchedUrls.has(nurl));
    const searchedOk = Boolean(nurl && (searchUrls.has(nurl) || fetchedOk));
    const officialOk = Boolean(postId && pack.officialIds.has(postId));
    const pressOk = Boolean(postId && pack.pressIds.has(postId));
    const newsletterOk = kind === 'newsletter' && pack.hasNewsletter;
    const demote = (why) => {
      const to = pressOk || newsletterOk || searchedOk || kind === 'press-post' && pressOk ? 'reported' : 'circulating-unverified';
      couldNotVerify.push(`demoted "${text.slice(0, 120)}" from ${status} to ${to}: ${why}`);
      status = to;
    };
    if (status === 'confirmed' || status === 'false') {
      const primary = ['document', 'article', 'official-post'].includes(kind) && (fetchedOk || officialOk);
      if (!primary) demote(officialOk ? 'source kind is not document/article/official-post' : url ? 'URL was not fetched with web_fetch in this run' : postId ? 'the cited post is not from an official account' : 'no fetched source and no official post');
    }
    if (status === 'reported' && !(pressOk || newsletterOk || searchedOk)) {
      couldNotVerify.push(`demoted "${text.slice(0, 120)}" from reported to circulating-unverified: no press-roster post, newsletter match or searched article behind it`);
      status = 'circulating-unverified';
    }
    if (status === 'disputed' && !(pressOk || newsletterOk || searchedOk || officialOk || fetchedOk)) status = 'circulating-unverified';
    if (kind !== 'none' && !(fetchedOk || searchedOk || postId)) kind = postId ? kind : (kind === 'newsletter' && newsletterOk ? 'newsletter' : 'none');
    const keptUrl = nurl && (fetchedOk || searchedOk) ? url : null;
    if (keptUrl) urls.add(keptUrl);
    if (postId) ids.add(postId);
    const claim = {
      text, status, source: { kind, url: keptUrl, postId, quote: str(src.quote, 200), fetched: fetchedOk, outlet: fetched.find((f) => normalizeUrl(f.url) === nurl)?.title || null },
      assertedBy: (Array.isArray(c.assertedBy) ? c.assertedBy : []).map(handleStr).filter(Boolean).slice(0, 8)
    };
    if (status === 'confirmed') claims.confirmed.push(claim);
    else if (status === 'reported') claims.reported.push(claim);
    else if (status === 'false') claims.false.push(claim);
    else claims.unverified.push(claim);
  }

  let suggestedLine = null;
  if (p.suggestedLine && typeof p.suggestedLine === 'object') {
    const postId = keepId(p.suggestedLine.postId, 'suggestedLine.postId');
    if (postId && pack.caucusIds.has(postId)) { suggestedLine = { postId, handle: handleStr(p.suggestedLine.handle), text: str(p.suggestedLine.text, 200) }; ids.add(postId); }
    else if (postId) dropped.push(`suggestedLine.postId: ${postId} is not a caucus post`);
  }

  const hole = p.hole && typeof p.hole === 'object' ? { unansweredGopClaim: str(p.hole.unansweredGopClaim, 300), unaddressedPressQuestion: str(p.hole.unaddressedPressQuestion, 300) } : { unansweredGopClaim: null, unaddressedPressQuestion: null };
  let confidence = ['high', 'medium', 'low'].includes(p.confidence) ? p.confidence : 'medium';
  if (dropped.length && confidence === 'high') confidence = 'medium';

  const judged = {
    oneLiner: str(p.oneLiner, 200),
    frames, gopAnswering, hole, suggestedLine,
    whatsNew: (Array.isArray(p.whatsNew) ? p.whatsNew : []).map((s) => str(s, 240)).filter(Boolean).slice(0, 8),
    confidence
  };
  return { judged, claims, couldNotVerify, provenance: { ids: [...ids].sort(), urls: [...urls].sort() }, dropped };
}

const lastText = (content) => {
  const texts = (content || []).filter((b) => b.type === 'text' && b.text);
  return { last: texts.at(-1)?.text || '', all: texts.map((b) => b.text).join('\n') };
};

const sumUsage = (acc, u) => {
  if (!u) return acc;
  acc.input += u.input_tokens || 0;
  acc.cacheRead += u.cache_read_input_tokens || 0;
  acc.cacheWrite += u.cache_creation_input_tokens || 0;
  acc.output += u.output_tokens || 0;
  acc.searchRequests += u.server_tool_use?.web_search_requests || 0;
  acc.fetchRequests += u.server_tool_use?.web_fetch_requests || 0;
  return acc;
};

// One assess call (plus ≤ maxContinuations pause_turn resumes).
// → { judged, claims, couldNotVerify, provenance, assessmentSkipped, usage, webUses, webToolsUsed, fetched, dropped, model, stopReason, raw }
export async function assessStory(record, pack, {
  client = null, model = process.env.INTEL_MODEL || process.env.CLASSIFY_MODEL || settings.classify?.model, webTools = settings.intel?.web_tools !== false,
  webUses = settings.intel?.web_uses, effort = 'medium', question = null, maxContinuations = 3, log = console.log, timeoutMs = 6 * 60_000
} = {}) {
  client ||= await anthropicClient();
  const userText = question ? `${pack.text}\n\nSTAFF QUESTION (answer it in "oneLiner" and "whatsNew"; the rest of the JSON still applies): ${question}` : pack.text;
  const messages = [{ role: 'user', content: userText }];
  const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, searchRequests: 0, fetchRequests: 0, calls: 0 };
  const out = { judged: null, claims: { confirmed: [], reported: [], unverified: [], false: [] }, couldNotVerify: [], provenance: { ids: [], urls: [] }, assessmentSkipped: null, usage, webUses: { search: 0, fetch: 0 }, webToolsUsed: Boolean(webTools), webToolsUnavailable: null, fetched: [], dropped: [], model, stopReason: null, raw: null };
  const allContent = [];
  const deadline = Date.now() + timeoutMs;
  let useTools = Boolean(webTools);
  let res = null;
  for (let turn = 0; turn <= maxContinuations; turn++) {
    const params = {
      model, max_tokens: 12000,
      output_config: { effort },
      system: [{ type: 'text', text: RUBRIC, cache_control: { type: 'ephemeral' } }],
      tools: useTools ? webToolDefs(webUses) : [],
      messages
    };
    try {
      res = await client.messages.create(params, { timeout: Math.max(30_000, deadline - Date.now()) });
    } catch (e) {
      const msg = String(e?.message || e);
      if (useTools && e?.status === 400 && /web_search|web_fetch|tool/i.test(msg)) {
        // web tools not enabled on this key / org: degrade to search-free mode; claims stay reported/unverified
        out.webToolsUnavailable = msg.slice(0, 200);
        out.webToolsUsed = false;
        useTools = false;
        log(`[intel] web tools unavailable on this credential (${out.webToolsUnavailable}) — assessing without web_search/web_fetch; claims can be reported or unverified only`);
        turn--;
        if (Date.now() > deadline) { out.assessmentSkipped = 'timeout'; return out; }
        continue;
      }
      // Any other API failure (credits exhausted, auth, 429, 5xx, network): the
      // MEASURED half is still published; judged stays null with the reason.
      const short = (msg.match(/"message":"([^"]{0,140})/)?.[1] || msg).slice(0, 160);
      out.assessmentSkipped = `api-error${e?.status ? `-${e.status}` : ''}: ${short}`;
      log(`[intel] assess call failed${e?.status ? ` (${e.status})` : ''}: ${short}`);
      return out;
    }
    usage.calls++;
    sumUsage(usage, res.usage);
    allContent.push(...(res.content || []));
    out.stopReason = res.stop_reason;
    if (res.stop_reason === 'pause_turn' && turn < maxContinuations && Date.now() < deadline) {
      messages.push({ role: 'assistant', content: res.content });
      continue;
    }
    break;
  }
  if (!res) { out.assessmentSkipped = 'no-response'; return out; }
  const tools = collectToolResults(allContent);
  out.webUses = tools.webUses;
  out.fetched = tools.fetched;
  out.toolErrors = tools.errors;
  if (res.stop_reason === 'refusal') { out.assessmentSkipped = 'refusal'; return out; }
  if (res.stop_reason === 'pause_turn') { out.assessmentSkipped = 'timeout'; return out; }
  const { last, all } = lastText(res.content);
  const parsed = parseJsonLoose(last) || parseJsonLoose(all);
  if (!parsed) { out.assessmentSkipped = res.stop_reason === 'max_tokens' ? 'unparseable (max_tokens)' : 'unparseable'; out.raw = all.slice(0, 2000); return out; }
  out.raw = parsed;
  const validated = validateAssessment(parsed, pack, { fetchedUrls: tools.fetchedUrls, searchUrls: tools.searchUrls, fetched: tools.fetched });
  Object.assign(out, validated);
  return out;
}
