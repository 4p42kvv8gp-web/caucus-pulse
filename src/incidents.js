// Incident desk backend. The classifier (nightly batch + poll-time live
// pass) flags posts that respond to breaking district emergencies with
// {kind, place}; this module groups those flags into incidents with the
// lifecycle the desk shows.
//
// Status. A single member's report surfaces immediately — as
// "provisional": one post from one member with nothing else behind it.
// Corroboration is any of a second member, a second post from the same
// member at least CORROBORATION_GAP later, or an intel panel from the
// nightly pass. Once corroborated the incident carries the age-based
// lifecycle: active (posts within 12h) → monitoring (12-36h quiet) →
// resolved (36h with no member posts), dropped after 7 quiet days. The
// age-based phase is always kept in `lifecycle`, so a provisional incident
// still knows whether it is fresh or stale; an uncorroborated report is
// never called "resolved" — it stays provisional until it drops.
//
// Evidence. Every timeline entry stores the exact substring of the post
// that names the event and the place (found deterministically from the
// classifier's kind/place strings — no model). When no such substring
// exists the entry stores the first 140 characters with evidence.exact =
// false, and `matched` says which of kind/place was found at all: a place
// the post never mentions is how a hallucinated location shows up.
//
// Post-filter. Failure modes from docs/INCIDENT_AUDIT.md that need no model
// are dropped here before grouping and listed in `filtered` with the cue
// that caught them: commemorations, hypotheticals and drills, explicitly
// dated past events, seasonal/preparedness PSAs, reaction-only posts,
// bare-state or unnamed places, and non-House accounts (the roster filter
// sitedata.js already applies). Any live-action cue (evacuation, shelter,
// hotline, office in contact, ...) overrides the text cues, so a live post
// that also looks back is kept.
//
// Intel panels (confirmed / circulating-unverified / what's new) are an
// optional Claude extraction over the incident's member posts — everything
// there is attributed to the member post it came from; the pipeline only
// captures list members, so official-source rows arrive when X search is
// connected, not before. Runs with withIntel:false at poll time (grouping
// only, free) and withIntel:true in the nightly chain.
import { p, readJSON, writeJSON, daysAgoEt, settings } from './util.js';
import { anthropicConfigured } from './anthropic-auth.js';
import { loadDay, topicsPath, loadState } from './store.js';
import { liveTopicsPath } from './classify-live.js';
import { loadAuthors, isHouse } from './authors.js';

export const incidentsPath = p('data', 'incidents.json');

const HOUR = 3_600_000;
export const CORROBORATION_GAP = HOUR; // a same-member follow-up counts after this long
export const EVIDENCE_FALLBACK_CHARS = 140;

export function incidentKey(kind, place) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().replace(/\s+/g, '-');
  return `${norm(place)}--${norm(kind)}`;
}

// Age-based lifecycle phase, from the last member post.
export function statusOf(lastPostAt, now = Date.now()) {
  const quiet = now - new Date(lastPostAt).getTime();
  if (quiet <= 12 * HOUR) return 'active';
  if (quiet <= 36 * HOUR) return 'monitoring';
  return 'resolved';
}

// ── kind vocabulary ──────────────────────────────────────────────────────
// The prompt asks for a fixed vocabulary, but 41 distinct kind strings were
// in the corpus before it did ("hazmat release" / "chemical leak"; "severe
// storms" / "severe weather" / "storm damage"), and each synonym keyed a
// new incident. Fold to the vocabulary before keying; the raw string stays
// on the timeline entry. Order matters (first match wins).
const KIND_CANON = [
  [/active shooter/, 'active shooter'],
  [/shoot|gunfire|gunman|shots? fired/, 'shooting'],
  [/hazmat|chemical|toxic|gas leak|hazardous/, 'hazmat'],
  [/water (outage|main|boil|contamination)|boil[- ]water/, 'water outage'],
  [/outage|blackout/, 'power outage'],
  [/house fire|structure fire|apartment fire|building fire|residential fire/, 'structure fire'],
  [/wildfire|brush fire|forest fire|grass fire|\bfires?\b|blaze/, 'wildfire'],
  [/flood|heavy rain/, 'flooding'],
  [/tornado/, 'tornado'],
  [/hurricane|tropical storm|typhoon|cyclone/, 'hurricane'],
  [/storm|severe weather|derecho|high wind|wind damage/, 'severe storm'],
  [/heat/, 'extreme heat'],
  [/plane|aircraft|aviation|helicopter|jet crash/, 'plane crash'],
  [/train|rail|derail/, 'train crash'],
  [/explosion|blast/, 'explosion'],
  [/missing/, 'missing persons'],
  [/bridge|dam (failure|breach)|infrastructure|collapse|water main/, 'infrastructure failure'],
  [/industrial|plant|refinery|factory/, 'industrial accident'],
  [/earthquake|quake/, 'earthquake']
];

export function canonicalKind(kind) {
  const raw = String(kind || '').toLowerCase().trim();
  for (const [re, canon] of KIND_CANON) if (re.test(raw)) return canon;
  return raw;
}

// ── place / district ─────────────────────────────────────────────────────
const STATES = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut',
  DE: 'delaware', DC: 'district of columbia', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois',
  IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland',
  MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana',
  NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico', NY: 'new york',
  NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania',
  RI: 'rhode island', SC: 'south carolina', SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah',
  VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming',
  PR: 'puerto rico', GU: 'guam', VI: 'virgin islands', AS: 'american samoa', MP: 'northern mariana islands'
};

// "Napa County, CA" → "CA"; null when the place carries no state abbr.
export function stateOf(place) {
  const m = /,\s*([A-Za-z]{2})\.?\s*$/.exec(String(place || ''));
  return m ? m[1].toUpperCase() : null;
}

// The lead author's district is appended to the place only when the
// place's state is the author's state — "Miami, FL · FL-09" was wrong
// because FL-09 is Central Florida, and "Kauai, HI · HI-01" because Kauaʻi
// is HI-02; a matching state is the most the data can vouch for.
export function districtLabel(place, stateDistrict) {
  const st = stateOf(place);
  const ds = String(stateDistrict || '').split('-')[0].toUpperCase();
  const match = st && /^[A-Z]{2}$/.test(ds) ? st === ds : null;
  return { place: match ? `${place} · ${stateDistrict}` : String(place || ''), district: stateDistrict || '', districtMatch: match };
}

// A place that is a whole state, or no place at all, cannot locate an
// incident and can never match another post's key.
export function placeFilterReason(place) {
  const raw = String(place || '').trim();
  if (!raw) return 'no place';
  const head = raw.replace(/,\s*[A-Za-z]{2}\.?\s*$/, '').trim().toLowerCase();
  const norm = head.replace(/[^a-z]+/g, ' ').trim();
  if (!norm || /\b(unspecified|unknown|not specified|n\/a|tbd|unclear)\b/.test(norm) || /^(the )?(district|statewide|nationwide|national|state|country)$/.test(norm)) return 'no place named';
  const st = stateOf(raw);
  if (st && STATES[st] === norm && !(st === 'NY' && norm === 'new york')) return 'place is a whole state';
  if (!st && Object.values(STATES).includes(norm) && norm !== 'new york' && norm !== 'washington') return 'place is a whole state';
  return null;
}

// ── deterministic post-filter ────────────────────────────────────────────
const MONTH = '(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)';
const NUM = '(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|twenty-five|thirty|fifty|a hundred)';
const EVENT = '(?:storms?|floods?|flooding|fires?|wildfires?|tornado(?:es)?|hurricane|derecho|earthquake|shooting|disaster)';

const FILTER_CUES = [
  ['commemoration', [
    /\banniversar(?:y|ies)\b/i,
    new RegExp(`\\b${NUM} (?:years?|decades?) (?:ago|since|later|on)\\b`, 'i'),
    /\byears? (?:since|after) the\b/i,
    /\b(?:we|to|let'?s|always|forever|today we|as we|join me in|take a moment to) remember\b/i,
    /\bremember(?:ing)? (?:the|those|all|our|when|him|her|them|everyone|lives|victims)\b/i,
    /\bin (?:loving )?memory\b/i,
    /#neverforget\b/i,
    /\bnever forget\b/i,
    /\bmemorial (?:service|ceremony|day|for)\b/i,
    /\bhonor(?:ing)? the (?:memory|memories|victims|lives)\b/i
  ]],
  ['hypothetical', [
    /\bwhat if\b/i,
    /\bimagine\b/i,
    /\bhypothetical/i,
    /\bscenario\b/i,
    /\b(?:drill|tabletop exercise|simulation|simulated|mock)\b/i,
    new RegExp(`\\bif (?:a|an|another) [a-z' -]{0,30}(?:hits?|strikes?|happens?|were to|comes?|struck)\\b`, 'i'),
    /\bcould (?:happen|strike|hit) (?:here|anywhere|again)\b/i,
    new RegExp(`\\bwhen (?:the next|a|another) ${EVENT}\\b`, 'i')
  ]],
  ['dated past', [
    new RegExp(`\\b${NUM} (?:weeks|months) ago\\b`, 'i'),
    /\b(?:last|this past|earlier this) (?:month|year|summer|spring|winter|fall|autumn)\b/i,
    new RegExp(`\\bthe ${MONTH}\\.?(?: and ${MONTH}\\.?)? (?:severe |devastating |historic )?${EVENT}\\b`, 'i'),
    /\bspent (?:months|weeks|years)\b/i,
    /\bapply by\b/i,
    /\b(?:application|filing|registration) deadline\b/i,
    /\bdeadline to (?:apply|register|file)\b/i
  ]],
  ['aftermath', [
    new RegExp(`\\b${EVENT} recovery\\b`, 'i'),
    /\bcontinues? to recover\b/i,
    /\brecovering from\b/i,
    /\baftermath of\b/i,
    /\bleft behind\b/i,
    /\b(?:storm|hurricane|[A-Z][a-z]+) is gone\b/,
    /\bpicking up the pieces\b/i,
    /\bdisaster declaration\b/i,
    /\b(?:fema|sba|usda) (?:assistance|aid|help|application|deadline|disaster)\b/i,
    /\bassistance may be available\b/i,
    /\bintake cent(?:er|re)\b/i,
    /\bdaily (?:storm |flood |fire )?update\b/i
  ]],
  ['seasonal or preparedness', [
    /\bpreparedness\b/i,
    /\b(?:hurricane|wildfire|fire|tornado|storm|flood) season\b/i,
    /\b(?:emergency|disaster|go) kit\b/i,
    /\bprepar(?:e|ing) (?:now|early|ahead|your (?:family|home|kit))\b/i
  ]]
];

// A reaction post is one that opens on grief or prayer and carries no
// instruction, resource or office action; a live post with the same
// opening ("Heartbroken ... If you need shelter, call 866-...") is kept by
// the live-cue override below.
const REACTION_OPENER = /^(?:what a tragedy|(?:i am |i'm |we are |we're |so |absolutely |deeply |truly )?(?:heartbroken|horrified|devastated|saddened|praying|mourning)|(?:my|our) (?:thoughts|hearts?|prayers)|thoughts and prayers|sending (?:love|prayers|strength)|it is (?:devastating|heartbreaking)|rest in (?:peace|power))\b/i;

// Live-action cues: any of these keeps the post regardless of the cues
// above. The desk would rather show a live post that also looks back than
// miss an evacuation order because it mentioned last year's fire.
const LIVE_CUES = [
  /\bevacuat/i, /\bshelter/i, /\bhotline\b/i, /\bcall\s*\(?\d{3}\b/i, /\b\d{3}[-.)\s]\s?\d{3}[-.\s]\d{4}\b/,
  /\b(?:avoid|stay (?:away from|out of|clear of)) the area\b/i,
  /\b(?:road|roads|highway|hwy|bridge|street|lanes?|interstate|i-\d+|route|freeway)\b[^.!?]{0,40}\b(?:closed|closure|closures|shut)\b/i,
  /\bactive shooter\b/i, /\bshots fired\b/i, /\bmissing\b/i, /\boutages?\b/i, /\bpower (?:is )?out\b/i, /\b911\b/,
  /\brescue/i, /\bunder ?way\b/i, /\bright now\b/i, /\beffective immediately\b/i, /\ball[- ]clear\b/i,
  /\breport (?:storm |any |flood |property )?damage\b/i, /\bdamage (?:report|assessment)/i,
  /\bmy (?:office|team|staff)\b/i, /\bin (?:direct |close |constant )?(?:contact|communication|touch) with\b/i, /\bon the ground\b/i, /\bon scene\b/i,
  /\bwarning for zone\b/i, /\border for zone\b/i, /\bleave (?:now|immediately|without delay)\b/i
];

function opening(text) {
  return String(text || '').replace(/^RT @\w+:\s*/, '').replace(/^[^A-Za-z]+/, '');
}

// {reason, cue} for a post the desk should not open an incident on; null
// when nothing deterministic says so.
export function postFilterReason(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  for (const re of LIVE_CUES) if (re.test(t)) return null;
  for (const [reason, cues] of FILTER_CUES) {
    for (const re of cues) {
      const m = re.exec(t);
      if (m) return { reason, cue: m[0] };
    }
  }
  const m = REACTION_OPENER.exec(opening(t));
  if (m) return { reason: 'reaction only', cue: m[0] };
  return null;
}

// Drop the flags the desk should not open incidents on. `dropped` keeps
// enough to audit each decision (id, who, when, kind/place, cue).
export function filterFlags(flags, postsById, authorsById = {}) {
  const kept = {};
  const dropped = [];
  for (const [id, flag] of Object.entries(flags)) {
    const post = postsById.get(id);
    if (!post) continue; // outside the hydrated window
    const author = authorsById[post.authorId];
    let reason = null, cue = null;
    if (!isHouse(author)) reason = 'non-House account';
    else if ((reason = placeFilterReason(flag.place))) cue = flag.place;
    else {
      const r = postFilterReason(post.text);
      if (r) ({ reason, cue } = r);
    }
    if (reason) {
      dropped.push({
        id, kind: flag.kind, place: flag.place,
        who: author?.handle ? `@${author.handle}` : post.authorId,
        time: post.createdAt, reason, cue
      });
    } else kept[id] = flag;
  }
  return { kept, dropped };
}

// ── evidence span ────────────────────────────────────────────────────────
const KIND_MODIFIERS = new Set(['severe', 'extreme', 'major', 'active', 'mass', 'heavy', 'widespread', 'large', 'big', 'deadly', 'fatal', 'flash', 'tropical', 'multi', 'vehicle', 'damage', 'incident', 'event', 'emergency', 'disaster', 'release', 'situation', 'persons', 'person', 'people', 'failure', 'accident', 'other', 'landfall', 'recovery', 'warning', 'advisory', 'wave']);
const KIND_SYNONYMS = {
  wildfire: ['fire', 'blaze', 'burn'], fire: ['blaze', 'wildfire'], fires: ['blaze', 'wildfire'],
  flooding: ['flood', 'floodwater'], flood: ['flooding', 'floodwater'],
  shooting: ['shot', 'shots', 'gunfire', 'gunman', 'shooter'], shooter: ['shot', 'shots', 'gunfire', 'gunman', 'shooting'],
  hazmat: ['chemical', 'hazardous'], chemical: ['hazmat'],
  crash: ['collision', 'collided', 'crashed', 'overran', 'derail'], collision: ['crash', 'collided'],
  outage: ['outages', 'blackout', 'power'],
  explosion: ['blast', 'exploded'],
  earthquake: ['quake'],
  hurricane: ['storm'], heat: ['heatwave'],
  leak: ['spill'], plane: ['aircraft', 'jet', 'flight'], train: ['rail', 'derail'],
  storm: ['storms'], weather: ['storm', 'storms'], missing: ['search']
};
const PLACE_GENERIC = new Set(['county', 'counties', 'city', 'town', 'area', 'areas', 'region', 'island', 'islands', 'district', 'northwest', 'southeast', 'northeast', 'southwest', 'eastern', 'western', 'northern', 'southern', 'north', 'south', 'east', 'west', 'central', 'greater', 'metro', 'downtown', 'and', 'of', 'the', 'near', 'valley']);

// Fold diacritics and Hawaiian ʻokina so "Kaʻū" and "Kau" agree.
function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[ʻ’'`´]/g, '').toLowerCase();
}
function words(s) {
  return fold(s).replace(/\b([a-z])\.(?=[a-z]\b)/g, '$1').split(/[^a-z0-9]+/).filter(Boolean);
}
function stem(w) {
  if (w.length > 6 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1);
  return w;
}
function wordMatches(word, cand) {
  if (word === cand) return true;
  return cand.length >= 4 && (word.startsWith(cand) || word.endsWith(cand));
}

export function kindTerms(kind) {
  const out = new Set();
  for (const w of words(kind)) {
    if (KIND_MODIFIERS.has(w) || w.length < 3) continue;
    out.add(stem(w));
    for (const s of KIND_SYNONYMS[w] || KIND_SYNONYMS[stem(w)] || []) out.add(stem(s));
  }
  return [...out];
}

export function placeTerms(place) {
  const all = words(String(place || '').replace(/,\s*[A-Za-z]{2}\.?\s*$/, ''));
  const specific = all.filter((w) => !PLACE_GENERIC.has(w));
  return specific.length ? specific : all;
}

function sentenceSpans(text) {
  const spans = [];
  const re = /[.!?…]+["”’)\]]*\s+|\n+/g;
  let start = 0, m;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    if (text.slice(start, end).trim()) spans.push([start, end]);
    start = end;
  }
  if (start < text.length && text.slice(start).trim()) spans.push([start, text.length]);
  return spans;
}

function hasKind(ws, terms) {
  return terms.some((t) => ws.some((w) => wordMatches(w, t)));
}
function hasPlace(ws, terms) {
  return terms.length > 0 && terms.every((t) => ws.some((w) => w === t || (t.length >= 5 && w.startsWith(t))));
}

// Tighten a span's bounds: drop leading/trailing URLs and whitespace, keep
// it an exact substring of the post.
function tighten(text, s, e) {
  let a = s, b = e;
  for (;;) {
    const head = /^\s*(?:https?:\/\/\S+\s*)+/.exec(text.slice(a, b));
    if (head && head[0].length < b - a) a += head[0].length; else break;
  }
  for (;;) {
    const tail = /(?:\s*https?:\/\/\S+)+\s*$/.exec(text.slice(a, b));
    if (tail && tail[0].length < b - a) b -= tail[0].length; else break;
  }
  while (a < b && /\s/.test(text[a])) a++;
  while (b > a && /\s/.test(text[b - 1])) b--;
  return [a, b];
}

// The exact substring of `text` that names both the event (kind) and the
// place: the first sentence containing both, else the shortest run of up
// to three consecutive sentences that does. Not found → the first 140
// characters, exact:false. `matched` reports which of kind/place appears
// anywhere in the post, so a place the post never names is visible.
export function findEvidence(text, kind, place) {
  const t = String(text || '');
  const kt = kindTerms(kind);
  const pt = placeTerms(place);
  const spans = sentenceSpans(t).map(([s, e]) => ({ s, e, ws: words(t.slice(s, e)) }));
  const allWords = words(t);
  const matched = { kind: hasKind(allWords, kt), place: hasPlace(allWords, pt) };
  if (matched.kind && matched.place) {
    for (let width = 1; width <= 3; width++) {
      for (let i = 0; i + width <= spans.length; i++) {
        const ws = spans.slice(i, i + width).flatMap((x) => x.ws);
        if (hasKind(ws, kt) && hasPlace(ws, pt)) {
          const [a, b] = tighten(t, spans[i].s, spans[i + width - 1].e);
          return { span: t.slice(a, b), exact: true, start: a, end: b, matched };
        }
      }
    }
  }
  const [a, b] = tighten(t, 0, Math.min(t.length, EVIDENCE_FALLBACK_CHARS));
  return { span: t.slice(a, b), exact: false, start: a, end: b, matched };
}

// ── corroboration ────────────────────────────────────────────────────────
function hasIntel(intel) {
  return Boolean(intel && ((intel.confirmed || []).length || (intel.unverified || []).length || (intel.whatsNew || []).length));
}
function fmtGap(ms) {
  const h = ms / HOUR;
  return h < 1 ? `${Math.round(ms / 60000)} min` : h < 48 ? `${Math.round(h * 10) / 10}h` : `${Math.round(h / 24)}d`;
}

// Timeline entries carry {who, time}; corroborated by a second member, a
// same-member post ≥ CORROBORATION_GAP after the first, or an intel panel.
export function corroborationOf(entries, intel = null) {
  const list = (entries || []).slice().sort((a, b) => (a.time < b.time ? -1 : 1));
  const members = [...new Set(list.map((e) => e.who))];
  if (members.length >= 2) {
    return { corroborated: true, by: 'second member', note: `${members.length} members posting: ${members.slice(0, 3).join(', ')}${members.length > 3 ? ', …' : ''}` };
  }
  const span = list.length ? new Date(list[list.length - 1].time).getTime() - new Date(list[0].time).getTime() : 0;
  if (list.length >= 2 && span >= CORROBORATION_GAP) {
    return { corroborated: true, by: 'second post', note: `${members[0]} posted again ${fmtGap(span)} after the first report` };
  }
  if (hasIntel(intel)) {
    return { corroborated: true, by: 'intel', note: `nightly intel pass: ${(intel.confirmed || []).length} confirmed, ${(intel.unverified || []).length} unverified item(s)` };
  }
  const awaiting = 'awaiting a second member, a later post from the same member or the nightly intel pass';
  return {
    corroborated: false, by: null,
    note: list.length >= 2 ? `${list.length} posts from one member within ${fmtGap(span)}; ${awaiting}` : `one post from one member; ${awaiting}`
  };
}

// Set status from corroboration + lifecycle. Called again after the nightly
// intel pass, which can corroborate a single-post incident.
export function applyStatus(incident) {
  incident.corroboration = corroborationOf(incident.timeline, incident.intel);
  incident.status = incident.corroboration.corroborated ? incident.lifecycle : 'provisional';
  return incident;
}

const PHASE_RANK = { active: 0, monitoring: 1, resolved: 2 };
export function sortIncidents(list) {
  const rank = (i) => PHASE_RANK[i.lifecycle] * 2 + (i.status === 'provisional' ? 1 : 0);
  return list.sort((a, b) => rank(a) - rank(b) || (a.last < b.last ? 1 : -1));
}

// ── grouping ─────────────────────────────────────────────────────────────
// Collect {tweetId: {kind, place}} across nightly + live files for a window
// of days. Nightly wins on conflict (it re-reads the whole day).
export function collectFlags(days = 8) {
  const flags = {};
  for (let d = days - 1; d >= 0; d--) {
    const date = daysAgoEt(d);
    for (const file of [readJSON(liveTopicsPath(date), null), readJSON(topicsPath(date), null)]) {
      if (file?.incidents) Object.assign(flags, file.incidents);
    }
  }
  return flags;
}

export function groupIncidents(flags, postsById, authorsById, { now = Date.now(), lastPollAt = null, prevById = null } = {}) {
  const groups = new Map();
  for (const [tweetId, flag] of Object.entries(flags)) {
    const post = postsById.get(tweetId);
    if (!post) continue;
    const kind = canonicalKind(flag.kind);
    const key = incidentKey(kind, flag.place);
    const g = groups.get(key) || { id: key, kind, place: flag.place, kinds: new Set(), posts: [] };
    g.kinds.add(String(flag.kind).toLowerCase());
    g.posts.push({ post, flag });
    groups.set(key, g);
  }

  const incidents = [];
  for (const g of groups.values()) {
    g.posts.sort((a, b) => a.post.createdAt < b.post.createdAt ? -1 : 1);
    const posts = g.posts.map((x) => x.post);
    const lead = posts[0];
    const leadAuthor = authorsById[lead.authorId] || {};
    const last = posts[posts.length - 1];
    const lifecycle = statusOf(last.createdAt, now);
    if (lifecycle === 'resolved' && now - new Date(last.createdAt).getTime() > 7 * 24 * HOUR) continue;
    const memberHandles = [...new Set(posts.map((t) => authorsById[t.authorId]?.handle).filter(Boolean))];
    const engN = posts.reduce((a, t) => a + (t.engN || 0), 0);
    const { place, district, districtMatch } = districtLabel(g.place, leadAuthor.stateDistrict);
    const timeline = g.posts.map(({ post: t, flag }) => ({
      time: t.createdAt,
      who: authorsById[t.authorId]?.handle ? `@${authorsById[t.authorId].handle}` : t.authorId,
      tag: 'member',
      text: t.text,
      engN: t.engN || 0,
      isNew: Boolean(lastPollAt && t.capturedAt === lastPollAt),
      flag: { kind: flag.kind, place: flag.place },
      evidence: findEvidence(t.text, flag.kind, flag.place)
    }));
    const incident = {
      id: g.id,
      kind: g.kind,
      kinds: [...g.kinds],
      status: 'provisional',
      lifecycle,
      corroboration: null,
      place,
      placeRaw: g.place,
      district,
      districtMatch,
      handle: leadAuthor.handle ? `@${leadAuthor.handle}` : lead.authorId,
      member: leadAuthor.member || leadAuthor.name || '',
      since: lead.createdAt,
      last: last.createdAt,
      updates: posts.length,
      engN,
      amplifiers: posts.reduce((a, t) => a + (t.amplifiers || 0), 0),
      others: memberHandles.slice(1).map((h) => `@${h}`),
      title: `${g.kind.charAt(0).toUpperCase()}${g.kind.slice(1)} · ${g.place}`,
      evidence: timeline[0].evidence,
      timeline,
      tweetIds: posts.map((t) => t.id),
      intel: prevById?.get(g.id)?.intel || null
    };
    incidents.push(applyStatus(incident));
  }
  return sortIncidents(incidents);
}

async function extractIntel(incident, model) {
  const { anthropicClient } = await import('./anthropic-auth.js');
  const client = await anthropicClient();
  const posts = incident.timeline.map((e) => `[${e.time}] ${e.who}: ${e.text}`).join('\n');
  const res = await client.messages.create({
    model,
    max_tokens: 2000,
    system: 'You summarize a breaking district incident from a House member\'s X posts for a communications team. Only state what the posts themselves say; attribute every item to the post ("per @handle, <time>"). Facts the member states from officials (police, OEM, fire) go in "confirmed"; things the member frames as reports/claims/unconfirmed go in "unverified"; "whatsNew" is 2-4 short bullets on the latest developments, newest first. Reply with ONLY JSON: {"confirmed":[{"text":"...","src":"..."}],"unverified":[{"text":"...","src":"..."}],"whatsNew":["..."]}',
    messages: [{ role: 'user', content: `Incident: ${incident.kind} — ${incident.place}\nPosts:\n${posts}` }]
  });
  if (res.stop_reason === 'refusal') return null;
  const textBlock = res.content.find((b) => b.type === 'text');
  const { parseJsonLoose } = await import('./taxonomy.js');
  const parsed = textBlock && parseJsonLoose(textBlock.text);
  if (!parsed) return null;
  return {
    confirmed: (parsed.confirmed || []).slice(0, 5),
    unverified: (parsed.unverified || []).slice(0, 5),
    whatsNew: (parsed.whatsNew || []).slice(0, 5),
    extractedAt: new Date().toISOString(),
    posts: incident.updates
  };
}

export async function buildIncidents({ withIntel = false } = {}) {
  const authorsById = loadAuthors().byId;
  const state = loadState();
  const flags = collectFlags();

  // Hydrate flagged posts (plus amplifier counts) from the archive window.
  const postsById = new Map();
  const retweetsOf = new Map();
  for (let d = 7; d >= 0; d--) {
    for (const t of loadDay(daysAgoEt(d))) {
      if (flags[t.id]) {
        const m = t.metricsAtCapture || {};
        postsById.set(t.id, { ...t, engN: (m.likes || 0) + (m.retweets || 0) + (m.replies || 0) + (m.quotes || 0) });
      }
      if (t.type === 'retweet' && t.refId) retweetsOf.set(t.refId, (retweetsOf.get(t.refId) || 0) + 1);
    }
  }
  // Prefer refreshed 24h metrics where they exist.
  for (let d = 7; d >= 1; d--) {
    const metrics = readJSON(p('data', 'metrics', `${daysAgoEt(d)}.json`), {});
    for (const [id, m] of Object.entries(metrics)) {
      const post = postsById.get(id);
      if (post && !m.unavailable) post.engN = (m.likes || 0) + (m.retweets || 0) + (m.replies || 0) + (m.quotes || 0);
    }
  }
  for (const post of postsById.values()) post.amplifiers = retweetsOf.get(post.id) || 0;

  const prev = readJSON(incidentsPath, { incidents: [] });
  const prevById = new Map(prev.incidents.map((i) => [i.id, i]));
  const { kept, dropped } = filterFlags(flags, postsById, authorsById);
  const incidents = groupIncidents(kept, postsById, authorsById, { lastPollAt: state.lastPollAt, prevById });

  const model = process.env.CLASSIFY_MODEL || settings.classify.model;
  for (const incident of incidents) {
    const stale = !incident.intel || incident.intel.posts < incident.updates;
    if (withIntel && stale && anthropicConfigured()) {
      try {
        incident.intel = await extractIntel(incident, model) || incident.intel;
        applyStatus(incident); // a fresh intel panel corroborates a single report
      } catch (e) {
        console.warn(`[incidents] intel extraction failed for ${incident.id}: ${e.message}`);
      }
    }
  }
  sortIncidents(incidents);

  writeJSON(incidentsPath, {
    generatedAt: new Date().toISOString(),
    incidents,
    filtered: dropped.sort((a, b) => (a.time < b.time ? 1 : -1))
  });
  return incidents;
}

export function countByStatus(incidents) {
  const counts = { provisional: 0, active: 0, monitoring: 0, resolved: 0 };
  for (const i of incidents) counts[i.status] = (counts[i.status] || 0) + 1;
  return counts;
}

async function main() {
  const incidents = await buildIncidents({ withIntel: true });
  const c = countByStatus(incidents);
  const filtered = readJSON(incidentsPath, {}).filtered?.length || 0;
  console.log(`[incidents] ${incidents.length} incident(s): ${c.provisional} provisional, ${c.active} active, ${c.monitoring} monitoring, ${c.resolved} resolved; ${filtered} flag(s) filtered`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
