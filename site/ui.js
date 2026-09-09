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
export function etTime(iso) {
  return new Intl.DateTimeFormat('en-US', { timeZone: ET, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}
export function etDay(iso) {
  return new Intl.DateTimeFormat('en-US', { timeZone: ET, month: 'short', day: 'numeric' }).format(new Date(iso + (iso.length === 10 ? 'T12:00:00' : '')));
}
// "2:31 PM" if today (ET), else "Sep 6, 7:30 PM"
export function etWhen(iso, today) {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
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
    return `<button data-set="${esc(key)}" data-val="${esc(val)}" aria-pressed="${on}" style="border:0;cursor:pointer;font:inherit;font-size:12px;font-weight:600;padding:5px 12px;border-radius:8px;transition:background .12s ease,color .12s ease;display:inline-flex;align-items:center;gap:6px;background:${on ? '#fff' : 'transparent'};color:${on ? '#1d1d1f' : '#6e6e73'};box-shadow:${on ? '0 1px 3px rgba(0,0,0,.14)' : 'none'}">${color ? dot(color) : ''}${esc(lab)}</button>`;
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
  return dot(s === 'active' ? '#d70015' : s === 'monitoring' ? '#ea580c' : '#8e8e93');
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

export async function loadRollups() {
  const res = await fetch('./data/rollups.json', { cache: 'no-store' });
  if (!res.ok) return null;
  return res.json();
}
