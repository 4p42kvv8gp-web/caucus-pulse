// Shared UI helpers for both pages — faithful ports of the design handoff's
// runtime helpers (fmt, spark, seg, dot, chevron, segmented control, badge).
// Vanilla: everything returns an HTML string; pages own state + render().

// Fill tier: green / navy / red / orange / purple — orange (CHC) carries ink
// text, the others white. Text tier ≥4.5:1 on white; no legible orange
// exists, so CHC words are ink and take orange only as a fill behind ink.
export const C = { CPC: '#00af50', NewDem: '#194292', CBC: '#d70015', CHC: '#ea580c', CAPAC: '#6f42c1' };
export const CT = { CPC: '#00823a', NewDem: '#194292', CBC: '#d70015', CHC: '#1d1d1f', CAPAC: '#6f42c1' };
export const KEYS = ['CPC', 'NewDem', 'CBC', 'CHC', 'CAPAC']; // ideological pair first (matrix columns), then identity caucuses (filters only)
export const MATRIX = ['CPC', 'NewDem'];
export const SHORT = { CPC: 'CPC', NewDem: 'New Dem', CBC: 'CBC', CHC: 'CHC', CAPAC: 'CAPAC' };
export const MOMENTUM_FILL = 'linear-gradient(90deg, #194292, #a9c3ee)';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmt(n) {
  n = Number(n) || 0;
  return n >= 1e7 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e5 ? Math.round(n / 1e3) + 'K' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'K' : Math.round(n).toLocaleString();
}

export function arrow(d) { return (d >= 0 ? '▲ ' : '▼ ') + Math.abs(Math.round(d)) + '%'; }

const ET = 'America/New_York';
const etClock = new Intl.DateTimeFormat('en-US', { timeZone: ET, hour: 'numeric', minute: '2-digit' });
const etCalendarDay = new Intl.DateTimeFormat('en-CA', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit' });
const etShortDay = new Intl.DateTimeFormat('en-US', { timeZone: ET, month: 'short', day: 'numeric' });
export function etTime(iso) {
  return etClock.format(new Date(iso));
}
export function etDay(iso) {
  return etShortDay.format(new Date(iso + (iso.length === 10 ? 'T12:00:00' : '')));
}
// "2:31 PM" if today (ET), else "Sep 6, 7:30 PM"
export function etWhen(iso, today) {
  const d = etCalendarDay.format(new Date(iso));
  return d === today ? etTime(iso) : `${etDay(iso)}, ${etTime(iso)}`;
}
export function headerDate(today) {
  return new Intl.DateTimeFormat('en-US', { timeZone: ET, weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(today + 'T12:00:00'));
}

export function dot(color, size = 7) {
  return `<span style="width:${size}px;height:${size}px;border-radius:50%;background:${color};display:inline-block;flex:none"></span>`;
}

export function fill(pct, color) {
  return `<div style="height:100%;width:${Math.max(0, Math.min(100, pct))}%;background:${color};border-radius:2px"></div>`;
}

// Segmented composition bar: list of [widthPct, color]
export function seg(list) {
  return `<div style="display:flex;width:100%;gap:1px">${list.map(([w, c]) => `<div style="width:${w}%;background:${c}"></div>`).join('')}</div>`;
}

// Catmull-Rom → cubic Bézier sparkline, stroke ink 1.25, 1.8 end dot.
// fromZero scales from the baseline (plateaus read flat, new lines climb).
export function spark(arr, W = 64, H = 18, fromZero = false) {
  if (!arr || arr.length < 2) return '';
  const P = 2;
  const max = Math.max(...arr), min = fromZero ? 0 : Math.min(...arr), span = max - min || 1;
  const pts = arr.map((v, i) => [P + i * (W - 2 * P) / (arr.length - 1), P + (H - 2 * P) * (1 - (v - min) / span)]);
  const last = pts[pts.length - 1];
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;flex:none" aria-hidden="true"><path d="${d}" fill="none" stroke="#1d1d1f" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${last[0]}" cy="${last[1]}" r="1.8" fill="#1d1d1f"/></svg>`;
}

export function chevron(hasSub, open) {
  return `<span aria-hidden="true" style="width:14px;height:14px;flex:none;display:inline-flex;align-items:center;justify-content:center;color:#8e8e93;transform:${open ? 'rotate(90deg)' : 'none'};transition:transform .15s ease;opacity:${hasSub ? 1 : 0}"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M3.5 1.5 L7 5 L3.5 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
}

// Segmented control: list of [value, label, dotColor|null] — a null entry
// renders a 1px group divider. data-set/data-val handled by the page's
// event delegation.
export function control(list, key, current) {
  return `<div role="group" style="display:inline-flex;background:#e8e8ed;border-radius:10px;padding:2px">${list.map((item, i) => {
    if (!item) return `<span aria-hidden="true" style="width:1px;align-self:stretch;margin:4px 3px;background:#d2d2d7"></span>`;
    const [val, lab, color] = item;
    const on = current === val;
    return `<button class="seg" data-set="${esc(key)}" data-val="${esc(val)}" aria-pressed="${on}" style="border:0;cursor:pointer;font:inherit;font-size:12px;font-weight:600;padding:5px 12px;border-radius:8px;transition:background .12s ease,color .12s ease;display:inline-flex;align-items:center;gap:6px;background:${on ? '#fff' : 'transparent'};color:${on ? '#1d1d1f' : '#6e6e73'};box-shadow:${on ? '0 1px 3px rgba(0,0,0,.14)' : 'none'}">${color ? dot(color) : ''}${esc(lab)}</button>`;
  }).join('')}</div>`;
}

const SELECT_CSS = `font:inherit;font-size:12px;font-weight:500;color:#1d1d1f;background:#f5f5f7;border:1px solid #e0e0e4;border-radius:9px;padding:5px 28px 5px 10px;cursor:pointer;appearance:none;-webkit-appearance:none;background-image:linear-gradient(45deg,transparent 50%,#6e6e73 50%),linear-gradient(135deg,#6e6e73 50%,transparent 50%);background-position:calc(100% - 14px) 12px,calc(100% - 9px) 12px;background-size:5px 5px;background-repeat:no-repeat;flex:1;min-width:0`;

export function select(list, key, value) {
  return `<select data-sel="${esc(key)}" aria-label="${esc(key)}" style="${SELECT_CSS}">${list.map(([k, name, n]) => `<option value="${esc(k)}"${k === value ? ' selected' : ''}>${esc(name)}${n != null ? ` (${n})` : ''}</option>`).join('')}</select>`;
}

// Ideological axis only: CPC green, New Dem navy, everyone else gray
// (CPC wins a tie); identity caucuses show only as dot tags beside the handle.
export function avatar(name, caucuses = []) {
  const bg = caucuses.includes('CPC') ? CT.CPC : caucuses.includes('NewDem') ? CT.NewDem : '#8e8e93';
  const ini = String(name || '?').split(' · ')[0].replace(/^(Rep\.|Sen\.|Del\.|Leader)\s+/, '').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return `<div style="width:30px;height:30px;border-radius:50%;background:${bg};color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:1px">${esc(ini)}</div>`;
}

export function tag(text) {
  return `<span style="font-size:11px;background:#f2f2f4;color:#3a3a3c;padding:1px 7px;border-radius:6px;white-space:nowrap">${esc(text)}</span>`;
}

export function badge(kind) {
  const map = { official: ['official', '#00823a', '#e6f7ea'], member: ['member', '#194292', '#e8eefb'], unverified: ['unverified', '#d70015', '#ffebe9'], press: ['press', '#3a3a3c', '#f2f2f4'] };
  const [t, c, bg] = map[kind] || map.press;
  return `<span style="color:${c};background:${bg};padding:1px 6px;border-radius:5px;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase">${t}</span>`;
}

export function statusDot(s) {
  return dot(s === 'active' ? '#d70015' : s === 'monitoring' ? '#ea580c' : s === 'provisional' ? '#194292' : '#8e8e93');
}

// Provisional = one member's report with nothing else behind it yet
// (src/incidents.js corroborationOf). Dashed navy so it never reads as the
// red alert tag; the title carries what would corroborate it.
export function provisionalBadge(note) {
  return `<span title="${esc(note || 'One post from one member — not yet corroborated')}" style="font-size:10px;font-weight:700;color:#194292;background:#e8eefb;border:1px dashed #194292;padding:1px 7px;border-radius:6px;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap">Provisional</span>`;
}

// The stored evidence span, quoted. An inexact span is the post's first 140
// characters, so it ends with an ellipsis and says what was not found.
export function evidenceQuote(ev, fallbackText = '', source = ev) {
  const span = ev?.span || String(fallbackText || '').slice(0, 140);
  const exact = ev?.exact === true;
  const missing = ev?.matched ? ['kind', 'place'].filter((k) => !ev.matched[k]) : [];
  const caption = exact
    ? 'evidence · exact span naming the event and the place'
    : `evidence · first 140 chars — post does not name the ${missing.length ? missing.join(' or ') : 'event and place'} verbatim`;
  return `<p style="margin:0;font-size:13px;line-height:1.4;color:#3a3a3c">${sourceLink(source, `“${span}${exact ? '' : '…'}”`)}</p><div style="font-size:10px;color:${exact ? '#6e6e73' : '#a35d00'}">${esc(caption)}</div>`;
}

// The full post text with the exact evidence span highlighted in place.
export function markEvidence(text, ev) {
  const t = String(text || '');
  if (ev?.exact && Number.isInteger(ev.start) && Number.isInteger(ev.end) && t.slice(ev.start, ev.end) === ev.span) {
    return `${esc(t.slice(0, ev.start))}<mark style="background:#fff3c4;color:inherit;padding:0 1px;border-radius:2px">${esc(ev.span)}</mark>${esc(t.slice(ev.end))}`;
  }
  return esc(t);
}

export function copyText(text, done) {
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, done);
  else {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch { /* best effort */ }
    ta.remove(); done();
  }
}

// ── Story drill-down (Feed "row mode") ──
// A Topics row — macro ('immigration') or subtopic ('immigration/liam-ramos')
// — opens to every post on it. Rows carry `postIds: {t, w}` (newest first);
// posts live in `feedAll` (compact: authorId, resolved here through
// `authorHandles` → `members`). Pure functions: no DOM, so they are testable.

export function splitRowKey(key) {
  const [macro, ...rest] = String(key || '').split('/');
  return { macro: macro || null, sub: rest.length ? rest.join('/') : null };
}

// Resolve a row key to its row object, parent macro, and display label.
export function findRow(data, key) {
  const { macro, sub } = splitRowKey(key);
  if (!macro) return null;
  const topic = (data?.topics || []).find((t) => t.key === macro);
  if (!topic) return null;
  const labelOf = (k) => data.labels?.[k] || String(k).split('/').pop().split(/[_-]+/).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  if (sub == null) return { key: macro, row: topic, topic, sub: null, label: topic.name || labelOf(macro) };
  const subRow = (topic.subs || []).find((s) => s.key === sub);
  if (!subRow) return null;
  return { key: `${macro}/${sub}`, row: subRow, topic, sub: subRow, label: labelOf(`${macro}/${sub}`) };
}

const KIND = { tweet: 'original', retweet: 'repost', reply: 'reply', quote: 'quote' };

// A feedAll row → the shape the post card renders (same as `feed` entries).
export function decoratePost(data, post) {
  const handle = data?.authorHandles?.[post.authorId] || post.handle || post.authorId;
  const m = data?.members?.[handle];
  return {
    ...post,
    handle,
    member: m?.[0] || '',
    district: m?.[1] || '',
    caucus: m?.[2] || [],
    kind: KIND[post.type] || post.kind || 'original',
    date: post.date || (post.createdAt ? etCalendarDay.format(new Date(post.createdAt)) : null),
    time: post.createdAt || post.time
  };
}

const feedIndex = new WeakMap();
function indexFeedAll(data) {
  const list = data?.feedAll || [];
  let idx = feedIndex.get(list);
  if (!idx) { idx = new Map(list.map((x) => [x.id, x])); feedIndex.set(list, idx); }
  return idx;
}

const newest = (a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? 1 : -1);

// Every post on a row in the window ('t' today / 'w' 7 days) and caucus
// scope, sorted 'Newest' (default) or 'Top' (engagement, then newest).
// Ids missing from feedAll (a truncated file) are skipped, never faked.
export function rowPosts(data, key, win = 'w', scope = 'All', sort = 'Newest') {
  const hit = findRow(data, key);
  if (!hit) return [];
  const ids = hit.row.postIds?.[win === 't' ? 't' : 'w'] || [];
  const idx = indexFeedAll(data);
  const posts = [];
  for (const id of ids) {
    const p = idx.get(id);
    if (!p) continue;
    const d = decoratePost(data, p);
    if (scope !== 'All' && !d.caucus.includes(scope)) continue;
    posts.push(d);
  }
  posts.sort(sort === 'Top' ? (a, b) => (b.engN || 0) - (a.engN || 0) || newest(a, b) : newest);
  return posts;
}

// "Liam Ramos / Dilley · 15 posts · 9 members"
export function rowHeader(label, n, m) {
  const posts = `${Number(n) || 0} ${n === 1 ? 'post' : 'posts'}`;
  const members = `${Number(m) || 0} ${m === 1 ? 'member' : 'members'}`;
  return `${label} · ${posts} · ${members}`;
}

// URL hash ↔ selection. '#row=immigration/liam-ramos' opens straight to the
// row; win / caucus ride along only when they differ from the defaults.
export function parseRowHash(hash) {
  const q = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const row = q.get('row');
  const win = q.get('win');
  const caucus = q.get('caucus');
  return { row: row || null, win: win === 't' || win === 'w' ? win : null, caucus: caucus || null };
}

export function rowHash({ row, win, caucus } = {}) {
  if (!row) return '';
  const q = new URLSearchParams();
  q.set('row', row);
  if (win && win !== 't') q.set('win', win);
  if (caucus && caucus !== 'All') q.set('caucus', caucus);
  return '#' + q.toString().replace(/%2F/gi, '/');
}

export function dataBaseUrl(location = globalThis.location) {
  // Scheduled GITHUB_TOKEN commits do not rebuild Pages. Read the public
  // repository data directly so capture freshness is independent of a build.
  const host = location?.hostname || '';
  const repo = (location?.pathname || '').split('/').filter(Boolean)[0];
  const owner = host.match(/^([a-z0-9-]+)\.github\.io$/i)?.[1];
  return owner && repo && /^[A-Za-z0-9_.-]+$/.test(repo)
    ? `https://raw.githubusercontent.com/${owner}/${repo}/main/site/data/`
    : './data/';
}
export async function loadRollups() {
  const base = dataBaseUrl();
  const res = await fetch(`${base}rollups.json`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Dashboard fetch failed (${res.status})`);
  const data = await res.json();
  if (data.feedAllFiles?.length) {
    const pages = await Promise.all(data.feedAllFiles.map(async (name) => {
      if (!/^feed-\d+(?:-[a-f0-9]{16})?\.json$/.test(name)) throw new Error('Invalid archive page');
      const response = await fetch(`${base}${name}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('Archive page could not be loaded');
      return response.json();
    }));
    const posts = pages.flat();
    if (posts.length !== data.feedAllTotal || new Set(posts.map((p) => p.id)).size !== posts.length) throw new Error('Archive pages do not match the published coverage');
    data.feedAll = posts; data.feedAllTruncated = false;
  }
  return data;
}

// Source URLs are built from validated identifiers, never from model prose.
export function postUrl(record) {
  const id = typeof record === 'string' ? record : record?.sourceId || record?.id;
  return typeof id === 'string' && /^\d{1,30}$/.test(id) ? `https://x.com/i/web/status/${id}` : null;
}
export function profileUrl(handle) {
  const h = String(handle || '').replace(/^@/, '');
  if (/^[A-Za-z0-9_]{1,15}$/.test(h) && !/^\d+$/.test(h)) return `https://x.com/${h}`;
  return /^\d{1,30}$/.test(h) ? `https://x.com/i/user/${h}` : null;
}
export function publicUrl(url) {
  try { const u = new URL(url); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
}
export function sourceAnchor(record, safeHtml) {
  const url = postUrl(record);
  return url ? `<a class="source-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="Open original post on X">${safeHtml}</a>` : safeHtml;
}
export function sourceLink(record, text) { return sourceAnchor(record, esc(text)); }
export function handleLink(handle, record = null) {
  const url = postUrl(record) || profileUrl(handle);
  return url ? `<a class="source-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(handle)}</a>` : esc(handle);
}
export function newsEvidence(list, { used = [], title = 'Public reporting · retrieved context' } = {}) {
  const rows = (list || []).filter((e) => publicUrl(e.url)).map((e) => {
    const date = e.publishedAt || e.date;
    const when = date && Number.isFinite(Date.parse(date)) ? etDay(date) : 'date unknown';
    const use = used.includes(e.id) ? ' · used by classifier' : '';
    const later = e.publishedAfterPost ? ' · published after post' : e.acquiredAfterPost ? ' · retrieved after post' : '';
    const kind = e.kind === 'report' ? 'article passage' : 'headline lead';
    const details = [e.fetchedAt && `Retrieved ${e.fetchedAt}`, e.publishedAt && `Published ${e.publishedAt}`].filter(Boolean).join(' · ');
    return `<div style="font-size:11px;line-height:1.4" title="${esc(details)}"><a href="${esc(publicUrl(e.url))}" target="_blank" rel="noopener noreferrer"><strong>${esc(e.publisher || 'Source')}</strong> · ${esc(when)} · ${kind}${use}${later}<br>“${esc(e.text || e.passage || e.title || '')}”</a></div>`;
  });
  return rows.length ? `<div style="display:flex;flex-direction:column;gap:5px;padding-top:5px"><span style="font-size:10px;color:#6e6e73">${esc(title)} · read the linked source</span>${rows.join('')}</div>` : '';
}
export function captureLabel(data, error = null, now = Date.now()) {
  if (error) return 'Refresh failed · showing last loaded data';
  const done = data?.lastPollAt;
  if (!done) return 'No completed capture yet';
  const stale = now - Date.parse(done) > 45 * 60_000;
  const incomplete = data.captureInProgress || (data.lastPollOutcome && data.lastPollOutcome !== 'complete');
  return `Capture completed ${etWhen(done, data.today)}${stale ? ' · stale' : ''}${incomplete ? ' · newer attempt incomplete' : ''}`;
}

// A failed background refresh never replaces the last successful data. The
// caller owns rendering so filters, selection and drafts can remain intact.
export function startRefresh({ load = loadRollups, onData, onError, intervalMs = 120_000, setIntervalFn = setInterval } = {}) {
  let running = false;
  const refresh = async () => {
    if (running) return;
    running = true;
    try { const data = await load(); if (!data) throw new Error('No published data available'); onData(data); }
    catch (error) { onError(error); }
    finally { running = false; }
  };
  const timer = setIntervalFn(refresh, intervalMs);
  refresh();
  return { refresh, timer };
}
