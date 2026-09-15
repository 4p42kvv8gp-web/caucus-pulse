// Official weekly House floor context. Acquisition is independent of posts;
// retrieval requires a typed bill identifier and never implies passage.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { p, writeJSON } from './util.js';

export const FLOOR_FILE = p('data', 'news', 'floor.json');
export const FLOOR_URL = 'https://docs.house.gov/floor/';
export const FLOOR_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 1_000_000;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const todayEt = (value) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const dateValid = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const clockValid = (value) => typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const plusDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const congressAt = (time) => {
  const year = Number(todayEt(time).slice(0, 4));
  let congress = Math.floor((year - 1789) / 2) + 1;
  if (year % 2 === 1 && Date.parse(time) < Date.parse(`${year}-01-03T17:00:00Z`)) congress--;
  return congress;
};

// Explicit hosts, including redirects, so feed content cannot authorize a
// request elsewhere. Linked documents are retained but never fetched here.
function officialUrl(value, base = FLOOR_URL, documents = false) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Missing official floor URL');
  const u = new URL(value, base);
  const hosts = documents ? ['docs.house.gov', 'congress.gov', 'www.congress.gov', 'govinfo.gov', 'www.govinfo.gov'] : ['docs.house.gov'];
  if (!['https:', 'http:'].includes(u.protocol) || !hosts.includes(u.hostname.toLowerCase()) || u.username || u.password || u.port) throw new Error('Floor URL is outside allowed official hosts');
  if (!documents && u.protocol !== 'https:') throw new Error('Floor acquisition requires HTTPS');
  u.hash = '';
  return u.href;
}

// Unlike an excerpt fetch, a schedule must never be silently cut at a cap.
async function fetchComplete(url, fetchImpl) {
  let current = officialUrl(url);
  const signal = AbortSignal.timeout(15000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const res = await fetchImpl(current, { redirect: 'manual', signal, headers: { 'User-Agent': 'caucus-pulse/0.1 official-floor-context', Accept: 'application/xml,text/xml,text/html;q=0.9' } });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers?.get('location');
      await res.body?.cancel?.();
      if (!location || redirects === 3) throw new Error('Invalid or excessive floor redirects');
      current = officialUrl(location, current);
      continue;
    }
    if (!res.ok) { const error = new Error(`Floor source HTTP ${res.status}`); error.httpStatus = res.status; throw error; }
    if (Number(res.headers?.get('content-length') || 0) > MAX_BYTES) throw new Error('Floor response exceeds byte limit');
    let body;
    if (res.body?.getReader) {
      const reader = res.body.getReader(), chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Floor response exceeds byte limit'); }
        chunks.push(Buffer.from(value));
      }
      body = Buffer.concat(chunks);
    } else body = Buffer.from(String(await res.text()));
    if (body.byteLength > MAX_BYTES) throw new Error('Floor response exceeds byte limit');
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), url: officialUrl(res.url || current), status: res.status };
  }
  throw new Error('Floor fetch did not complete');
}

function entities(value) {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(value)) throw new Error('Unknown or incomplete XML entity');
  return value.replace(/&([^;]+);/g, (_, name) => {
    const known = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(known, name)) return known[name];
    const code = name.startsWith('#x') ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    if (!(code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff))) || code === 0xfffe || code === 0xffff) throw new Error('Invalid XML character reference');
    return String.fromCodePoint(code);
  });
}

function attributes(raw) {
  const out = Object.create(null);
  let rest = raw;
  while (rest.trim()) {
    const m = rest.match(/^\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*("[^"<]*"|'[^'<]*')/);
    if (!m || Object.hasOwn(out, m[1])) throw new Error('Malformed or duplicate XML attribute');
    out[m[1]] = entities(m[2].slice(1, -1));
    rest = rest.slice(m[0].length);
  }
  return out;
}

// Small strict XML subset used by the Clerk. No DTD, entities, namespaces,
// arbitrary processing instructions or recovery from malformed markup.
function parseXml(xml) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > MAX_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(xml)) throw new Error('Invalid floor XML input');
  let rest = xml.replace(/^\uFEFF/, '');
  if (rest.startsWith('<?xml')) {
    const declaration = rest.match(/^<\?xml\s+version=(?:"1\.0"|'1\.0')(?:\s+encoding=(?:"UTF-8"|'UTF-8'|"utf-8"|'utf-8'))?(?:\s+standalone=(?:"yes"|'yes'|"no"|'no'))?\s*\?>/);
    if (!declaration) throw new Error('Unsupported XML declaration');
    rest = rest.slice(declaration[0].length);
  }
  const stack = [], roots = [];
  let count = 0;
  while (rest.length) {
    if (rest.startsWith('<!--')) {
      const end = rest.indexOf('-->');
      if (end < 0 || rest.slice(4, end).includes('--')) throw new Error('Malformed XML comment');
      rest = rest.slice(end + 3); continue;
    }
    if (rest.startsWith('<![CDATA[')) {
      const end = rest.indexOf(']]>');
      if (end < 0 || !stack.length) throw new Error('Malformed XML CDATA');
      stack.at(-1).text += rest.slice(9, end); rest = rest.slice(end + 3); continue;
    }
    if (rest[0] !== '<') {
      const end = rest.indexOf('<'), raw = end < 0 ? rest : rest.slice(0, end);
      if (raw.includes(']]>')) throw new Error('Invalid XML text');
      const value = entities(raw);
      if (stack.length) stack.at(-1).text += value;
      else if (value.trim()) throw new Error('Text outside XML root');
      rest = end < 0 ? '' : rest.slice(end); continue;
    }
    if (rest.startsWith('</')) {
      const m = rest.match(/^<\/([A-Za-z_][A-Za-z0-9_.-]*)\s*>/);
      if (!m || !stack.length || stack.at(-1).name !== m[1]) throw new Error('Mismatched or malformed XML closing tag');
      stack.pop(); rest = rest.slice(m[0].length); continue;
    }
    const m = rest.match(/^<([A-Za-z_][A-Za-z0-9_.-]*)((?:\s+[A-Za-z_][A-Za-z0-9_.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/);
    if (!m) throw new Error('Unsupported or malformed XML markup');
    const node = { name: m[1], attrs: attributes(m[2]), children: [], text: '' };
    if (++count > 10000 || stack.length > 12) throw new Error('Floor XML complexity limit exceeded');
    if (stack.length) stack.at(-1).children.push(node); else roots.push(node);
    if (!m[3]) stack.push(node);
    rest = rest.slice(m[0].length);
  }
  if (stack.length || roots.length !== 1 || roots[0].name !== 'floorschedule') throw new Error('Incomplete XML or unknown floor root');
  return roots[0];
}

const CHILDREN = {
  floorschedule: ['current-status', 'language', 'copyright', 'publish-dates', 'category'],
  'publish-dates': ['publish-date'], category: ['floor-items'], 'floor-items': ['floor-item'],
  'floor-item': ['legis-num', 'floor-text', 'updates', 'files', 'floor-subitems'],
  'floor-subitems': ['floor-subitem'], 'floor-subitem': ['legis-num', 'floor-text', 'updates', 'files'],
  updates: ['update-date'], 'update-date': ['explanatory-notes'], files: ['file'],
};
const LEAVES = new Set(['current-status', 'language', 'copyright', 'legis-num', 'floor-text', 'explanatory-notes', 'file', 'publish-date']);
function validateTree(node) {
  if (Object.keys(node.attrs).some((key) => key.includes(':') || key === 'xmlns')) throw new Error('Unsupported XML namespace');
  const permitted = CHILDREN[node.name];
  if (!permitted && !LEAVES.has(node.name)) throw new Error(`Unknown floor XML element ${node.name}`);
  if (permitted && node.text.trim()) throw new Error(`Unexpected floor XML text in ${node.name}`);
  for (const child of node.children) {
    if (!permitted?.includes(child.name)) throw new Error(`Unexpected floor XML child ${child.name}`);
    validateTree(child);
  }
}
function one(node, name, required = false) {
  const matches = node.children.filter((c) => c.name === name);
  if (matches.length > 1 || (required && matches.length !== 1)) throw new Error(`Expected one ${name}`);
  return matches[0] || null;
}
const rawTime = (value) => value || null; // Publisher timestamps are naive: never attach Z or infer a zone.

const BILL_TYPE = '(?:H\\s*\\.?\\s*(?:Con\\s*\\.?\\s*Res|J\\s*\\.?\\s*Res|Res|R)|S\\s*\\.?\\s*(?:Con\\s*\\.?\\s*Res|J\\s*\\.?\\s*Res|Res)?)\\.?';
const BILL_FULL = new RegExp(`^(?:Senate amendments? to\\s+)?(${BILL_TYPE})\\s*([1-9][0-9]{0,5})$`, 'i');
const BILL_SCAN = new RegExp(`(?<![A-Za-z0-9])(${BILL_TYPE})\\s*([1-9][0-9]{0,5})(?![A-Za-z0-9])`, 'gi');
const billKey = (type, number) => `${type.replace(/[.\s]/g, '').toLowerCase()}${Number(number)}`;

export function normalizeFloorBill(designation, congress) {
  const m = clean(designation).match(BILL_FULL);
  if (!m || !Number.isInteger(congress) || congress < 1) return null;
  return `${congress}-${billKey(m[1], m[2])}`;
}

export function discoverFloorXML(html, sourceUrl = FLOOR_URL) {
  officialUrl(sourceUrl);
  const links = [];
  // Ignore comments/scripts so a sample or embedded script is not a source link.
  const body = String(html).replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  for (const m of body.matchAll(/<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const attrs = Object.create(null);
    for (const a of m[1].matchAll(/([\w:-]+)\s*=\s*("[^"]*"|'[^']*')/g)) {
      const key = a[1].toLowerCase();
      if (Object.hasOwn(attrs, key)) throw new Error('Duplicate floor HTML link attribute');
      attrs[key] = entities(a[2].slice(1, -1));
    }
    if (!(attrs.class || '').split(/\s+/).includes('downloadXML')) continue;
    const link = new URL(officialUrl(attrs.href || '', sourceUrl));
    let path;
    if (link.pathname.toLowerCase() === '/floor/download.aspx') {
      if ([...link.searchParams.keys()].some((key) => key !== 'file') || link.searchParams.getAll('file').length !== 1) throw new Error('Unexpected floor XML download query');
      path = link.searchParams.get('file');
    } else if (!link.search) path = link.pathname;
    const date = path?.match(/^\/billsthisweek\/(\d{8})\/\1\.xml$/);
    if (!date) throw new Error('Unexpected floor XML download path');
    links.push({ xmlUrl: officialUrl(path, sourceUrl), weekStart: `${date[1].slice(0, 4)}-${date[1].slice(4, 6)}-${date[1].slice(6)}` });
  }
  if (links.length !== 1) throw new Error('Expected exactly one official current floor XML link');
  return links[0];
}

export function parseFloorXML(xml, { sourceUrl = FLOOR_URL, xmlUrl, observedAt = new Date().toISOString(), expectedWeek } = {}) {
  if (!clockValid(observedAt)) throw new Error('Floor observation needs an explicit timezone');
  const root = parseXml(xml); validateTree(root);
  const congress = Number(root.attrs['congress-num']), weekStart = root.attrs['week-date'];
  if (!/^[1-9]\d{0,2}$/.test(root.attrs['congress-num'] || '') || !dateValid(weekStart) || new Date(`${weekStart}T00:00:00Z`).getUTCDay() !== 1) throw new Error('Invalid floor congress or week');
  if (expectedWeek && weekStart !== expectedWeek) throw new Error('Floor HTML/XML week mismatch');
  sourceUrl = officialUrl(sourceUrl);
  xmlUrl = officialUrl(xmlUrl || `/billsthisweek/${weekStart.replaceAll('-', '')}/${weekStart.replaceAll('-', '')}.xml`);
  const expectedPath = `/billsthisweek/${weekStart.replaceAll('-', '')}/${weekStart.replaceAll('-', '')}.xml`;
  if (new URL(xmlUrl).pathname !== expectedPath || new URL(xmlUrl).search) throw new Error('Floor XML URL/week mismatch');
  const snapshotHash = digest(xml), ids = new Set();
  const weekEnd = plusDays(weekStart, 6);
  if (![congressAt(`${weekStart}T05:00:00Z`), congressAt(`${weekEnd}T23:59:59Z`)].includes(congress)) throw new Error('Floor congress does not match schedule week');
  function row(node, procedure, parentId = null) {
    const sourceItemId = node.attrs.id;
    if (!/^[1-9]\d*$/.test(sourceItemId || '') || ids.has(sourceItemId)) throw new Error('Invalid or duplicate floor item id');
    ids.add(sourceItemId);
    const designation = clean(one(node, 'legis-num', true).text);
    const title = clean(one(node, 'floor-text', true).text);
    if (!title) throw new Error('Floor item has no description');
    const files = one(node, 'files', true).children.map((f) => ({ url: officialUrl(f.attrs['doc-url'], xmlUrl, true), type: f.attrs['doc-type'] || null, sourceAddedAtRaw: rawTime(f.attrs['add-date']), sourcePublishedAtRaw: rawTime(f.attrs['publish-date']) }));
    const withdrawn = Boolean(clean(node.attrs['remove-date']));
    const item = { id: `floor_${congress}_${weekStart.replaceAll('-', '')}_${sourceItemId}_${snapshotHash.slice(0, 16)}`, sourceItemId, parentId,
      congress, billId: normalizeFloorBill(designation, congress), designation, title, procedure, withdrawn,
      sourceAddedAtRaw: rawTime(node.attrs['add-date']), sourcePublishedAtRaw: rawTime(node.attrs['publish-date']), sourceRemovedAtRaw: rawTime(node.attrs['remove-date']),
      sourceUpdatesRaw: (one(node, 'updates')?.children || []).map((u) => ({ date: rawTime(u.attrs.date), publishedAt: rawTime(u.attrs['publish-date']), notes: u.children.map((n) => ({ text: clean(n.text), documentModified: n.attrs['doc-modified'] || null })) })),
      sourceUrl, xmlUrl, url: files[0]?.url || xmlUrl, weekStart, weekEnd, observedAt, fetchedAt: observedAt, documents: files, subitems: [] };
    const subs = one(node, 'floor-subitems');
    if (subs) item.subitems = subs.children.map((s) => row(s, procedure, sourceItemId));
    return item;
  }
  const items = [];
  for (const category of root.children.filter((c) => c.name === 'category')) {
    const procedure = clean(category.attrs.type);
    if (!procedure) throw new Error('Floor category has no procedure label');
    for (const item of one(category, 'floor-items', true).children) items.push(row(item, procedure));
  }
  if (!items.length) throw new Error('Empty floor XML does not establish an authoritative empty schedule');
  one(root, 'current-status', true); one(root, 'language', true); one(root, 'copyright'); one(root, 'publish-dates');
  return { congress, weekStart, weekEnd, sourceUrl, xmlUrl, observedAt, fetchedAt: observedAt, snapshotHash,
    sourceStatusRaw: clean(one(root, 'current-status').text), sourceCreatedAtRaw: rawTime(root.attrs['create-date']), sourcePublishedAtRaw: rawTime(root.attrs['orig-publish-date']), sourceUpdatedAtRaw: rawTime(root.attrs['update-date']),
    sourcePublicationTimesRaw: (one(root, 'publish-dates')?.children || []).map((x) => rawTime(x.attrs.date)), items, rawXml: xml };
}

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { return { schemaVersion: 1, status: { ok: false, lastAttemptAt: null, lastSuccessAt: null, error: error.code === 'ENOENT' ? 'Official floor schedule not yet fetched' : 'Stored floor schedule is unreadable', httpStatus: null }, snapshot: null }; }
}
function publicView(state, now) {
  let snapshot = state?.snapshot || null;
  const status = { ok: false, lastAttemptAt: null, lastSuccessAt: null, error: null, httpStatus: null, ...state?.status };
  if (snapshot) {
    try {
      const checked = parseFloorXML(snapshot.rawXml, { sourceUrl: snapshot.sourceUrl, xmlUrl: snapshot.xmlUrl, observedAt: snapshot.observedAt, expectedWeek: snapshot.weekStart });
      if (checked.snapshotHash !== snapshot.snapshotHash) throw new Error('Floor snapshot hash mismatch');
      snapshot = checked;
    } catch { snapshot = null; status.ok = false; status.error = 'Stored floor snapshot failed validation'; }
  }
  const date = clockValid(now) ? todayEt(now) : null;
  const available = Boolean(snapshot);
  const withinWeek = Boolean(date && snapshot && date >= snapshot.weekStart && date <= snapshot.weekEnd);
  const age = snapshot && clockValid(now) ? Date.parse(now) - Date.parse(snapshot.observedAt) : Infinity;
  const stale = !snapshot || !withinWeek || age < 0 || age > FLOOR_MAX_AGE_MS || (clockValid(now) && congressAt(now) !== snapshot?.congress);
  const { rawXml, ...visible } = snapshot || {};
  return { schemaVersion: 1, status, available, current: available && withinWeek && !stale, stale,
    congress: null, weekStart: null, weekEnd: null, observedAt: null, sourceUrl: FLOOR_URL, xmlUrl: null, sourceUpdatedAtRaw: null, snapshotHash: null, items: [], ...visible };
}

export function loadFloor({ file = FLOOR_FILE, now = new Date().toISOString() } = {}) {
  return publicView(readState(file), now);
}

export async function refreshFloor({ file = FLOOR_FILE, fetchImpl = fetch, now = new Date().toISOString(), dryRun = false } = {}) {
  if (!clockValid(now)) throw new Error('Floor refresh needs a timestamp with timezone');
  const state = readState(file);
  let next;
  try {
    const html = await fetchComplete(FLOOR_URL, fetchImpl);
    const discovered = discoverFloorXML(html.text, html.url);
    const xml = await fetchComplete(discovered.xmlUrl, fetchImpl);
    const snapshot = parseFloorXML(xml.text, { sourceUrl: html.url, xmlUrl: xml.url, observedAt: now, expectedWeek: discovered.weekStart });
    next = { schemaVersion: 1, status: { ok: true, lastAttemptAt: now, lastSuccessAt: now, error: null, httpStatus: xml.status }, snapshot };
  } catch (error) {
    next = { schemaVersion: 1, status: { ok: false, lastAttemptAt: now, lastSuccessAt: state.status?.lastSuccessAt || null, error: String(error.message || error).slice(0, 220), httpStatus: error.httpStatus ?? null }, snapshot: state.snapshot || null };
  }
  if (!dryRun) writeJSON(file, next);
  return publicView(next, now);
}

function referencesIn(text, congress) {
  const explicit = [...String(text).matchAll(/\b(\d{2,3})(?:st|nd|rd|th)?\s+Congress\b/gi)].map((m) => Number(m[1]));
  if (explicit.some((n) => n !== congress)) return new Set();
  const cleanText = String(text).replace(/https?:\/\/\S+/g, ' ');
  return new Set([...cleanText.matchAll(BILL_SCAN)].map((m) => `${congress}-${billKey(m[1], m[2])}`));
}

export function floorEvidenceForPost(post, { agenda, now = new Date().toISOString() } = {}) {
  if (!agenda?.available || !agenda.status?.ok || !agenda.current || agenda.stale || !clockValid(now) || !clockValid(post?.createdAt)) return [];
  if (congressAt(now) !== agenda.congress || congressAt(post.createdAt) !== agenda.congress) return [];
  const date = todayEt(now), postDate = todayEt(post.createdAt), observed = Date.parse(agenda.observedAt);
  if (date < agenda.weekStart || date > agenda.weekEnd || postDate < agenda.weekStart || postDate > agenda.weekEnd || Date.parse(post.createdAt) > Date.parse(now)
    || !Number.isFinite(observed) || observed > Date.parse(now) || Date.parse(now) - observed > FLOOR_MAX_AGE_MS || (post.congress != null && Number(post.congress) !== agenda.congress)) return [];
  // A repost wrapper copies somebody else's words; its new capture date
  // cannot give a prior-Congress bill number a current-Congress identity.
  const texts = post.type === 'retweet' ? [] : [post.text];
  for (const original of [post.quoting, post.quoted, post.reposting, post.reposted]) {
    if (!original || typeof original.text !== 'string' || !/^\d+$/.test(String(original.id || ''))) continue;
    // A current member post may renew attention to an older source in the
    // same Congress. Unknown dates and another Congress are not bill identity.
    const congressStartYear = 1789 + (agenda.congress - 1) * 2;
    if (!clockValid(original.createdAt) || Date.parse(original.createdAt) < Date.parse(`${congressStartYear}-01-03T17:00:00Z`)
      || Date.parse(original.createdAt) >= Date.parse(`${congressStartYear + 2}-01-03T17:00:00Z`) || Date.parse(original.createdAt) > Date.parse(now)) continue;
    if (post.refId && original.id && String(post.refId) !== String(original.id)) continue;
    if (post.type === 'retweet' && (!/^\d+$/.test(String(post.refId || '')) || String(original.id || '') !== String(post.refId))) continue;
    if (original.congress != null && Number(original.congress) !== agenda.congress) continue;
    texts.push(original.text);
  }
  const mentioned = new Set(texts.filter((x) => typeof x === 'string').flatMap((x) => [...referencesIn(x, agenda.congress)]));
  const active = (rows) => rows.flatMap((item) => item.withdrawn ? [] : [item, ...active(item.subitems || [])]);
  return active(agenda.items || []).filter((item) => item.billId && mentioned.has(item.billId)).map((item) => ({
    id: item.id, kind: 'floor-agenda', publisher: 'Office of the Clerk', url: agenda.xmlUrl, sourceUrl: agenda.sourceUrl, xmlUrl: agenda.xmlUrl, documents: item.documents,
    title: item.title, billId: item.billId, designation: item.designation, congress: agenda.congress, procedure: item.procedure,
    weekStart: agenda.weekStart, weekEnd: agenda.weekEnd, fetchedAt: agenda.observedAt, observedAt: agenda.observedAt,
    publishedAt: null, sourceUpdatedAtRaw: agenda.sourceUpdatedAtRaw, publishedAfterPost: false, acquiredAfterPost: observed > Date.parse(post.createdAt),
    text: `May be considered during the week ${agenda.weekStart} through ${agenda.weekEnd}: ${item.designation} — ${item.title}. ${item.procedure}. This is a tentative weekly agenda, not evidence of a vote, passage, enactment, or a specific floor time.`,
  }));
}
