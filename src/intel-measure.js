// The MEASURED half of a narrative record (docs/NARRATIVE_INTELLIGENCE.md
// §2.3, §8, §12.1). Pure: rows in, numbers out, every leaf `{value, source,
// units}` so the dashboard can name where a number came from and what it
// cost. Status and flags are decided here BY RULE over measured values —
// never by the model.
import { settings } from './util.js';
import { caucusKeysOf, KEYS } from './intel-corpus.js';
import { officialSet, isOfficial } from './intel-lists.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const L = (value, source, units = 0) => ({ value, source, units });
export const v = (leaf) => (leaf && typeof leaf === 'object' && 'value' in leaf ? leaf.value : leaf);

// ── counts bucket arithmetic ─────────────────────────────────────────────
// X day buckets are UTC-midnight aligned: the first and last are partial.
// `today` is the last bucket (so far); the baseline is the mean of the six
// full buckets before it. Fewer than three full prior buckets → total7d/7
// and the `baseline-thin` flag. lift is today ÷ baseline; the control query
// gets the same treatment, which cancels most of the partial-day bias.
export function bucketStats(buckets = [], { now = Date.now() } = {}) {
  const sorted = (buckets || []).slice().sort((a, b) => String(a.start).localeCompare(String(b.start)));
  const total7d = sorted.reduce((a, b) => a + (b.count || 0), 0);
  if (!sorted.length) return { countsToday: null, todayHours: null, mean6d: null, lift: null, total7d: 0, buckets7d: [], baselineThin: true, priorDays: 0, fadingDays: 0 };
  const last = sorted.at(-1);
  const todayHours = Math.max(0.1, (Math.min(now, new Date(last.end).getTime()) - new Date(last.start).getTime()) / HOUR);
  const isFull = (b) => new Date(b.end).getTime() - new Date(b.start).getTime() >= 23.5 * HOUR;
  const prior = sorted.slice(0, -1).filter(isFull).slice(-6);
  const baselineThin = prior.length < 3;
  const mean6d = baselineThin ? total7d / 7 : prior.reduce((a, b) => a + b.count, 0) / prior.length;
  const countsToday = last.count || 0;
  const lift = mean6d > 0 ? countsToday / mean6d : (countsToday > 0 ? countsToday : 1);
  let fadingDays = 0;
  for (const b of prior.slice().reverse()) { if ((b.count || 0) < mean6d) fadingDays++; else break; }
  return {
    countsToday, todayHours: Math.round(todayHours * 10) / 10, mean6d: Math.round(mean6d * 100) / 100,
    lift: Math.round(lift * 100) / 100, total7d, buckets7d: sorted.slice(-8).map((b) => b.count || 0),
    baselineThin, priorDays: prior.length, fadingDays
  };
}

// 72 hourly buckets → acceleration: last 6h against the prior 18h (per-6h rate).
export function hourlyStats(buckets = []) {
  const counts = (buckets || []).slice().sort((a, b) => String(a.start).localeCompare(String(b.start))).map((b) => b.count || 0);
  if (!counts.length) return { hourly72: [], hourAccel: null, last24h: null };
  const last6 = counts.slice(-6).reduce((a, b) => a + b, 0);
  const prior18 = counts.slice(-24, -6).reduce((a, b) => a + b, 0);
  const last24h = counts.slice(-24).reduce((a, b) => a + b, 0);
  return { hourly72: counts.slice(-72), hourAccel: prior18 > 0 ? Math.round(100 * last6 / (prior18 / 3)) / 100 : (last6 > 0 ? last6 : null), last24h };
}

// ── per-voice block ──────────────────────────────────────────────────────
const isOriginal = (r) => r.type === 'tweet' || r.type === 'quote';
const byTime = (a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);

export function voiceBlock(rows, { source, units = 0, now = Date.now() } = {}) {
  const byAuthor = new Map();
  for (const r of rows) {
    const c = byAuthor.get(r.authorId) || {
      id: r.authorId, handle: r.author?.handle || null, posts: 0, originals: 0, engN: 0,
      followers: r.author?.followers ?? null,
      roster: r.author?.roster?.[0] || r.sources.find((s) => s.kind === 'list')?.key || (r.author?.status === 'house' ? 'caucus' : null)
    };
    c.posts++;
    if (isOriginal(r)) c.originals++;
    c.engN += r.engN || 0;
    byAuthor.set(r.authorId, c);
  }
  const carriers = [...byAuthor.values()].sort((a, b) => b.engN - a.engN || b.posts - a.posts).slice(0, 10);
  const nonRt = rows.filter((r) => r.type !== 'retweet').sort((a, b) => (b.engN || 0) - (a.engN || 0));
  const top = nonRt[0] || null;
  const first = rows.slice().sort(byTime)[0] || null;
  const cut48 = now - 48 * HOUR;
  const in48 = rows.filter((r) => new Date(r.createdAt).getTime() >= cut48);
  return {
    posts: L(rows.length, source, units),
    originals: L(rows.filter(isOriginal).length, source, units),
    reposts: L(rows.filter((r) => r.type === 'retweet').length, source, units),
    quotes: L(rows.filter((r) => r.type === 'quote').length, source, units),
    replies: L(rows.filter((r) => r.type === 'reply').length, source, units),
    accounts: L(byAuthor.size, source, units),
    originals48h: L(in48.filter(isOriginal).length, source, units),
    accounts48h: L(new Set(in48.map((r) => r.authorId)).size, source, units),
    carriers: L(carriers, source, units),
    topPost: L(top ? { id: top.id, handle: top.author?.handle || null, engN: top.engN || 0 } : null, source, units),
    samples: L(nonRt.slice(0, 3).map((r) => ({ id: r.id, handle: r.author?.handle || null, at: r.createdAt, text: String(r.text).slice(0, 200) })), source, units),
    first: L(first ? { id: first.id, handle: first.author?.handle || null, at: first.createdAt } : null, source, units)
  };
}

// ── the whole story ──────────────────────────────────────────────────────
// opts: { rows (story rows with .voice), gopWindowRows, gopComplete, pressComplete,
//         counts: { organic, originals, hourly, control } (bucket arrays from the
//         evidence file), evidence, context, now, windows, activeHouseAccounts,
//         excludeFrom }
export function measureStory(story, {
  rows = [], gopWindowRows = [], gopComplete = null, pressComplete = null, counts = {}, evidence = null, context = null,
  now = Date.now(), windows = {}, activeHouseAccounts = null, excludeFrom = settings.intel?.exclude_from || [], authorsById = {}
} = {}) {
  const byVoice = (voice) => rows.filter((r) => r.voice === voice);
  const caucusRows = byVoice('caucus');
  const gopRows = byVoice('gop');
  const pressRows = byVoice('press');
  const organicRows = byVoice('organic');
  const delegationRows = byVoice('delegation');
  const searchUnits = (evidence?.pages || []).reduce((a, p) => a + (p.units || 0), 0);
  const listSource = (keys) => `lists capture (${keys.join(', ') || 'none'})`;

  // caucus
  const caucus = voiceBlock(caucusRows, { source: 'archive (paid at capture)', now });
  const members = new Set(caucusRows.map((r) => r.authorId));
  const today = new Date(now).toISOString().slice(0, 10);
  const dayOf = (r) => String(r.createdAt).slice(0, 10);
  const yesterday = new Date(now - DAY).toISOString().slice(0, 10);
  const todayN = caucusRows.filter((r) => dayOf(r) === today).length;
  const yestN = caucusRows.filter((r) => dayOf(r) === yesterday).length;
  const members48 = new Set(caucusRows.filter((r) => now - new Date(r.createdAt).getTime() < 48 * HOUR).map((r) => r.authorId));
  Object.assign(caucus, {
    members: L(members.size, 'archive + authors.json'),
    members48h: L(members48.size, 'archive + authors.json'),
    cm: L(KEYS.map((k) => [...members].filter((a) => caucusKeysOf(authorsById[a]).includes(k)).length), 'archive + authors.json'),
    leadership: L(caucusRows.filter((r) => (authorsById[r.authorId]?.caucuses || []).includes(settings.leadership_tag)).length, 'archive + authors.json'),
    unity: L({ spread: members.size, reach: activeHouseAccounts ? Math.round(1000 * members.size / activeHouseAccounts) / 1000 : null, activeAccounts: activeHouseAccounts }, 'archive (members using a story alias ÷ active accounts in window)'),
    dayOverDay: L(todayN - yestN, 'archive (UTC days)')
  });

  // gop
  const gopKeys = [...new Set(gopRows.flatMap((r) => r.sources.filter((s) => s.kind === 'list').map((s) => s.key)))];
  const gop = voiceBlock(gopRows, { source: listSource(gopKeys.length ? gopKeys : ['house-gop']), now });
  const firstCaucusAt = v(caucus.first)?.at || null;
  const firstGopAt = v(gop.first)?.at || null;
  const quoteRows = rows.filter((r) => r.sources.some((s) => s.kind === 'quotes'));
  Object.assign(gop, {
    sampleSize: L(gopWindowRows.length, 'house-gop capture (all posts in window, any wording)'),
    complete: L(gopComplete, 'data/lists/cursors.json'),
    lagHours: L(firstCaucusAt && firstGopAt ? Math.round(10 * (new Date(firstGopAt) - new Date(firstCaucusAt)) / HOUR) / 10 : null, 'first alias-matched GOP post − first caucus post'),
    silent: L(gopRows.length === 0, `no alias match in ${gopWindowRows.length} captured GOP posts (sample complete: ${gopComplete === true ? 'yes' : gopComplete === false ? 'no' : 'unknown'})`),
    quotesOfTop: L({ posts: quoteRows.length, accounts: new Set(quoteRows.map((r) => r.authorId)).size, ofId: evidence?.quotes?.ofId || null }, evidence?.quotes ? `quotes of ${evidence.quotes.ofId} via ${evidence.quotes.via}` : 'quotes not fetched', evidence?.quotes?.units || 0)
  });

  // press
  const pressLists = {};
  for (const r of pressRows) for (const s of r.sources) if (s.kind === 'list') pressLists[s.key] = (pressLists[s.key] || 0) + 1;
  const press = voiceBlock(pressRows, { source: listSource(Object.keys(pressLists)), now });
  Object.assign(press, {
    lists: L(pressLists, 'lists capture'),
    complete: L(pressComplete, 'data/lists/cursors.json'),
    newsletterHits: L(context?.available ? (context.matches || []).map(({ sender, subject, date, why, threadId }) => ({ sender, subject, date, why, threadId })) : null, context?.available ? `data/context.json (${context.generatedAt}${context.stale ? ', stale' : ''})` : 'data/context.json absent'),
    articles: L([], 'web_fetch (filled by the assess step)')
  });

  // organic
  const st = bucketStats(counts.originals?.buckets, { now });
  const stOrganic = bucketStats(counts.organic?.buckets, { now });
  const ctrl = bucketStats(counts.control?.buckets, { now });
  const hr = hourlyStats(counts.hourly?.buckets);
  const organic = voiceBlock(organicRows, { source: 'search sample (relevancy + recency pages, originals only)', units: searchUnits, now });
  const sampledOriginals = organicRows.filter(isOriginal);
  const topAuthors = [...organicRows.reduce((m, r) => m.set(r.authorId, (m.get(r.authorId) || 0) + 1), new Map()).entries()].sort((a, b) => b[1] - a[1]);
  const top5 = topAuthors.slice(0, 5).reduce((a, [, n]) => a + n, 0);
  const assistants = new Set((excludeFrom || []).map((h) => h.toLowerCase()));
  const assistantPosts = organicRows.filter((r) => r.author?.handle && assistants.has(r.author.handle.toLowerCase())).length;
  const resolved = organicRows.filter((r) => r.author?.handle);
  const cUnits = (k) => counts[k]?.units ?? (counts[k] ? 1 : 0);
  Object.assign(organic, {
    countsToday: L(st.countsToday, 'counts:originals:day', cUnits('originals')),
    todayHours: L(st.todayHours, 'counts:originals:day (hours into the UTC day)', cUnits('originals')),
    mean6d: L(st.mean6d, `counts:originals:day (mean of ${st.priorDays} full prior days${st.baselineThin ? ', thin: total7d/7' : ''})`, cUnits('originals')),
    lift: L(st.lift, 'counts:originals:day today ÷ mean6d', cUnits('originals')),
    controlLift: L(ctrl.lift, 'counts:control:day today ÷ mean6d', cUnits('control')),
    total7d: L(st.total7d, 'counts:originals:day', cUnits('originals')),
    organicTotal7d: L(stOrganic.total7d, 'counts:organic:day (retweets included)', cUnits('organic')),
    buckets7d: L(st.buckets7d, 'counts:originals:day', cUnits('originals')),
    hourly72: L(hr.hourly72, 'counts:originals:hour (72h)', cUnits('hourly')),
    hourAccel: L(hr.hourAccel, 'counts:originals:hour last 6h ÷ prior 18h per-6h rate', cUnits('hourly')),
    fadingDays: L(st.fadingDays, 'counts:originals:day consecutive full days below mean6d', cUnits('originals')),
    originalsShare: L(stOrganic.total7d > 0 ? Math.round(1000 * st.total7d / stOrganic.total7d) / 1000 : null, 'counts originals ÷ organic (7d)', cUnits('organic') + cUnits('originals')),
    concentrationTop5: L(organicRows.length ? Math.round(1000 * top5 / organicRows.length) / 1000 : null, 'search sample: top-5 accounts’ share of sampled posts', searchUnits),
    assistantShare: L(organicRows.length ? Math.round(1000 * assistantPosts / organicRows.length) / 1000 : null, `search sample (${(excludeFrom || []).map((h) => '@' + h).join(', ') || 'no'} accounts excluded by query, so normally 0)`, searchUnits),
    sampledOriginals: L(sampledOriginals.length, 'search sample', searchUnits),
    carriersOffList: L(v(organic.carriers).filter((c) => !c.roster).length, 'search sample carriers with no roster', searchUnits),
    unresolvedAccounts: L(organicRows.length - resolved.length, 'search sample rows whose author no roster or lookup resolved', evidence?.resolution?.units || 0),
    sampleWindows: L((evidence?.pages || []).map(({ sort, oldest, newest, n }) => ({ sort, oldest, newest, n })), 'search sample page spans', searchUnits)
  });

  const delegation = { posts: L(delegationRows.length, listSource(['ny-members', 'overlapping-electeds'])), accounts: L(new Set(delegationRows.map((r) => r.authorId)).size, listSource(['ny-members', 'overlapping-electeds'])), samples: voiceBlock(delegationRows, { source: 'lists capture', now }).samples };

  // origin: earliest row by voice inside each voice's window
  const firsts = [['caucus', caucus.first], ['gop', gop.first], ['press', press.first], ['organic', organic.first], ['delegation', voiceBlock(delegationRows, { source: 'lists', now }).first]]
    .map(([voice, leaf]) => ({ voice, ...(v(leaf) || {}) })).filter((f) => f.at).sort((a, b) => (a.at < b.at ? -1 : 1));
  const earliestNewsletter = (context?.matches || []).map((m) => m.date).filter(Boolean).sort()[0] || null;
  const origin = L({
    voice: firsts[0]?.voice || null, at: firsts[0]?.at || null, id: firsts[0]?.id || null, handle: firsts[0]?.handle || null,
    byVoice: Object.fromEntries(firsts.map((f) => [f.voice, { at: f.at, id: f.id, handle: f.handle }])),
    newsletterBeforeFirstMember: Boolean(earliestNewsletter && firstCaucusAt && earliestNewsletter < firstCaucusAt),
    earliestNewsletter
  }, 'earliest row per voice inside that voice’s window (windows differ: archive 3 weeks, Lists ~800 posts, search 7 days)');

  return { caucus, gop, press, organic, delegation, origin, windows };
}

// ── §2.3 status, by rule ─────────────────────────────────────────────────
export function statusOf(m, { kind = 'story' } = {}) {
  const caucusPosts = v(m.caucus.posts) || 0, gopPosts = v(m.gop.posts) || 0, pressPosts = v(m.press.posts) || 0;
  const organicToday = v(m.organic.countsToday);
  const lift = v(m.organic.lift), controlLift = v(m.organic.controlLift);
  const newsletterHits = (v(m.press.newsletterHits) || []).length;
  const articles = (v(m.press.articles) || []).length;
  const voicesPresent = [gopPosts > 0, pressPosts > 0, organicToday > 0].filter(Boolean).length;
  const organicAbove = lift != null && lift > 1 && (controlLift == null || lift > controlLift);
  const otherVoices = gopPosts > 0 || pressPosts > 0 || organicAbove;
  if (voicesPresent >= 2 && lift != null && controlLift != null && lift >= 1.5 * controlLift && (pressPosts >= 3 || newsletterHits >= 1 || articles >= 1)) return 'breaking-through';
  const g48 = v(m.gop.originals48h) || 0, c48 = v(m.caucus.originals48h) || 0;
  if (c48 > 0 && g48 > 0 && g48 >= 0.5 * c48 && g48 <= 2 * c48) return 'contested';
  if ((v(m.organic.fadingDays) || 0) >= 2 && (v(m.caucus.dayOverDay) || 0) < 0) return 'fading';
  if (caucusPosts > 0 && gopPosts === 0 && pressPosts === 0 && !(organicToday > 0)) return 'caucus-only';
  if (caucusPosts > 0 && !otherVoices && ((v(m.caucus.members48h) || 0) >= 3 || kind === 'story')) return 'emerging';
  return 'steady';
}

// ── §2.3 flags, independent of status ────────────────────────────────────
export function flagsOf(m, { context = null, story = null, now = Date.now(), excludeFrom = settings.intel?.exclude_from || [], webToolsUnavailable = false } = {}) {
  const flags = [];
  const top5 = v(m.organic.concentrationTop5), share = v(m.organic.originalsShare);
  const assistants = new Set((excludeFrom || []).map((h) => h.toLowerCase()));
  const top3 = (v(m.organic.carriers) || []).slice(0, 3);
  if ((top5 != null && top5 >= 0.5) || (share != null && share < 0.25) || top3.some((c) => c.handle && assistants.has(c.handle.toLowerCase()))) flags.push('manufactured?');
  if (v(m.gop.complete) === false) flags.push('gop-sample-incomplete');
  if (v(m.press.complete) === false) flags.push('press-sample-incomplete');
  if (context?.stale) flags.push('newsletter-context-stale');
  if (story?.firstSeen && new Date(`${story.firstSeen}T12:00:00Z`).getTime() < now - 7 * DAY) flags.push('origin-beyond-window');
  if (/thin/.test(v(m.organic.mean6d) == null ? '' : m.organic.mean6d.source)) flags.push('baseline-thin');
  if (webToolsUnavailable) flags.push('web-tools-unavailable');
  return flags;
}

// ── §9.2 evidence pack ───────────────────────────────────────────────────
// ≤25 attributed rows with ids, ≤15 GOP posts of the day regardless of alias
// match, newsletter matches, caucus assertions. Every id the model may cite
// is in `ids`; `officialIds`, `pressIds`, `caucusIds` drive the validator.
export function buildEvidencePack(story, measured, { rows = [], gopRowsOfDay = [], context = null, official = officialSet(), limits = { rows: 25, gop: 15 }, date = null } = {}) {
  const byEng = (a, b) => (b.engN || 0) - (a.engN || 0);
  const pick = (voice, n, originalsFirst = true) => rows.filter((r) => r.voice === voice && (!originalsFirst || r.type !== 'retweet')).sort(byEng).slice(0, n);
  const chosen = new Map();
  for (const r of [...pick('caucus', 8), ...pick('press', 6), ...pick('gop', 5), ...pick('organic', 6), ...pick('delegation', 2)]) chosen.set(r.id, r);
  for (const r of rows.filter((r) => r.type !== 'retweet').sort(byEng)) { if (chosen.size >= limits.rows) break; chosen.set(r.id, r); }
  const attributed = [...chosen.values()].slice(0, limits.rows);
  const gopOfDay = gopRowsOfDay.filter((r) => !chosen.has(r.id)).sort(byEng).slice(0, limits.gop);
  const tag = (r) => ({ id: r.id, voice: r.voice, handle: r.author?.handle || null, official: isOfficial(r.author ? { handle: r.author.handle, verifiedType: r.author.verifiedType } : null, official), roster: r.author?.roster?.[0] || r.sources.find((s) => s.kind === 'list')?.key || null, followers: r.author?.followers ?? null, at: r.createdAt, type: r.type, engN: r.engN || 0, text: String(r.text).slice(0, 280) });
  const packRows = attributed.map(tag);
  const gopRows = gopOfDay.map(tag);
  const all = [...packRows, ...gopRows];
  const ids = new Set(all.map((r) => r.id));
  const caucusAssertions = packRows.filter((r) => r.voice === 'caucus' && r.type !== 'retweet').slice(0, 8);
  const newsletter = context?.available ? (context.matches || []).slice(0, 8) : [];
  const text = renderPackText(story, measured, { packRows, gopRows, newsletter, caucusAssertions, date });
  return {
    ids, rows: packRows, gopOfDay: gopRows, newsletter, caucusAssertions,
    caucusIds: new Set(all.filter((r) => r.voice === 'caucus').map((r) => r.id)),
    pressIds: new Set(all.filter((r) => r.voice === 'press').map((r) => r.id)),
    gopIds: new Set(all.filter((r) => r.voice === 'gop').map((r) => r.id)),
    officialIds: new Set(all.filter((r) => r.official).map((r) => r.id)),
    hasNewsletter: newsletter.length > 0,
    text
  };
}

const fmtRow = (r) => `id=${r.id} [${r.voice}${r.official ? ', official' : ''}${r.roster ? `, ${r.roster}` : ''}] ${r.handle ? '@' + r.handle : 'unresolved account'}${r.followers != null ? ` (${r.followers} followers)` : ''} ${r.type} at ${r.at}, engagement ${r.engN}: ${JSON.stringify(r.text)}`;

export function renderPackText(story, m, { packRows, gopRows, newsletter, caucusAssertions, date }) {
  const g = m.gop, c = m.caucus, p = m.press, o = m.organic;
  const lines = [];
  lines.push(`STORY: ${story.label} (key: ${story.key}${story.macro ? `, macro: ${story.macro}` : ''})${date ? `\nDATE: ${date} (ET)` : ''}`);
  lines.push(`ALIASES: ${(story.aliases || []).join(' | ')}`);
  lines.push('', 'MEASURED (computed by code; authoritative — interpret, do not restate as your own figures):');
  lines.push(`- caucus: ${v(c.posts)} posts (${v(c.originals)} originals) from ${v(c.members)} members; leadership posts: ${v(c.leadership)}; first: ${v(c.first) ? `@${v(c.first).handle || '?'} at ${v(c.first).at}` : 'none'}`);
  lines.push(`- gop: ${v(g.posts)} alias-matched posts of ${v(g.sampleSize)} captured (sample complete: ${v(g.complete) === true ? 'yes' : v(g.complete) === false ? 'no' : 'unknown'}); lag: ${v(g.lagHours) == null ? 'n/a' : v(g.lagHours) + 'h'}; quotes of our top post: ${v(g.quotesOfTop)?.posts ?? 0}`);
  lines.push(`- press: ${v(p.posts)} posts from ${v(p.accounts)} accounts (${Object.entries(v(p.lists) || {}).map(([k, n]) => `${k} ${n}`).join(', ') || 'no List rows'}); newsletter matches: ${(v(p.newsletterHits) || []).length}`);
  lines.push(`- organic (X counts, originals): today ${v(o.countsToday) ?? 'n/a'} (${v(o.todayHours) ?? '?'}h into the UTC day) vs 7-day mean ${v(o.mean6d) ?? 'n/a'} → lift ${v(o.lift) ?? 'n/a'}; control lift ${v(o.controlLift) ?? 'n/a'}; 7-day total ${v(o.total7d)}; originals share ${v(o.originalsShare) ?? 'n/a'}; sampled posts ${v(o.posts)}; top-5 account share ${v(o.concentrationTop5) ?? 'n/a'}; unresolved accounts ${v(o.unresolvedAccounts)}`);
  lines.push(`- origin: earliest voice ${v(m.origin)?.voice || 'none'} at ${v(m.origin)?.at || 'n/a'}; newsletter before first member post: ${v(m.origin)?.newsletterBeforeFirstMember ? 'yes' : 'no'}`);
  lines.push('', `ATTRIBUTED POSTS (${packRows.length}; cite by id only, never invent one):`);
  for (const r of packRows) lines.push(fmtRow(r));
  lines.push('', `GOP POSTS OF THE DAY regardless of wording (${gopRows.length}; say which of these answer a caucus line, if any):`);
  if (!gopRows.length) lines.push('(none captured)');
  for (const r of gopRows) lines.push(fmtRow(r));
  lines.push('', `NEWSLETTER MATCHES from the owner's inbox (${newsletter.length}; no URLs — reported-grade at most):`);
  if (!newsletter.length) lines.push('(none)');
  for (const n of newsletter) lines.push(`- ${n.sender || n.from || '?'} — ${JSON.stringify(n.subject || '')} (${n.date || '?'}): ${n.snippet || ''}${n.why ? ` [why: ${n.why}]` : ''}`);
  lines.push('', `CAUCUS ASSERTIONS (${caucusAssertions.length}; extract the factual claims these posts make):`);
  if (!caucusAssertions.length) lines.push('(none)');
  for (const r of caucusAssertions) lines.push(`id=${r.id} @${r.handle || '?'}: ${JSON.stringify(r.text)}`);
  return lines.join('\n');
}
