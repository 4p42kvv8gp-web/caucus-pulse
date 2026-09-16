import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as ui from '../site/ui.js';

const health = (extra = {}) => ({ status: 'blocked', reasonCode: 'provider-credits',
  lastAttemptAt: '2026-09-16T00:42:00Z', lastSuccessAt: '2026-09-15T07:23:33Z',
  capturedIn24h: 777, classifiedIn24h: 48, pendingIn24h: 729,
  coverageComplete: false, hasCurrentFailure: true, ...extra });
const data = (extra = {}) => ({ today: '2026-09-15', generatedAt: '2026-09-16T00:43:00Z',
  lastPollAt: '2026-09-16T00:41:41Z', lastPollOutcome: 'complete',
  classification: { health: health(extra) } });

test('current interpretation failures report exact partial coverage separately from successful capture', () => {
  const d = data();
  const rendered = ui.interpretationNotice(d, { dashboard: true });
  assert.match(rendered, /Interpretation blocked/);
  assert.match(rendered, /48 of 777 captured posts interpreted · 729 awaiting interpretation/);
  assert.match(rendered, /all House · last 24 hours/);
  assert.match(rendered, /insufficient credits/);
  assert.match(rendered, /Available interpretations are partial/);
  assert.match(rendered, /Empty topics or missing incidents do not establish silence/);
  assert.match(rendered, /Post capture runs separately/);
  assert.match(rendered, /data-act="capturedPosts"/);
  assert.match(ui.captureLabel(d, null, Date.parse('2026-09-16T00:43:00Z')), /Capture completed/);
  assert.equal(ui.interpretationView(d).paused, true);
});

test('ordinary pending work remains partial while recovered completed coverage returns to healthy', () => {
  const pending = data({ status: 'pending', reasonCode: null, hasCurrentFailure: false });
  assert.equal(ui.interpretationView(pending).paused, false);
  assert.match(ui.interpretationNotice(pending), /Interpretation pending/);
  assert.match(ui.interpretationNotice(pending), /partial/);
  const healthy = data({ status: 'healthy', reasonCode: null, hasCurrentFailure: false,
    pendingIn24h: 0, classifiedIn24h: 777, coverageComplete: true });
  assert.equal(ui.interpretationView(healthy).paused, false);
  assert.equal(ui.interpretationView(healthy).partial, false);
  assert.match(ui.interpretationNotice(healthy), /Interpretation current for captured posts/);
  assert.ok(!ui.interpretationNotice(healthy).includes('insufficient credits'));
  assert.ok(!ui.interpretationNotice(healthy).includes('interpretations are partial'));
  assert.match(ui.interpretationNotice(healthy), /does not establish complete account coverage/);
});

test('degraded, disabled and unknown states stay explicit without inventing success timestamps', () => {
  assert.match(ui.interpretationNotice(data({ status: 'degraded', reasonCode: 'provider-unavailable' })), /service is unavailable/);
  assert.match(ui.interpretationNotice(data({ status: 'disabled', reasonCode: null, hasCurrentFailure: false })), /Interpretation disabled/);
  const legacy = { today: '2026-09-15', generatedAt: '2026-09-16T00:43:00Z', lastPollAt: '2026-09-16T00:41:41Z',
    classification: { capturedIn24h: 10, classifiedIn24h: 3, pendingIn24h: 7 } };
  const rendered = ui.interpretationNotice(legacy);
  assert.match(rendered, /Interpretation status unavailable/);
  assert.match(rendered, /3 of 10 captured posts interpreted · 7 awaiting interpretation/);
  assert.match(rendered, /Last interpretation attempt: not recorded · Last accepted interpretation: not recorded/);
  assert.ok(!rendered.includes('8:43'));
  assert.match(ui.interpretationNotice({}), /coverage counts are unavailable/);
  assert.ok(!ui.interpretationNotice({}).includes('0 of 0'));
  const empty = data({ status: 'healthy', hasCurrentFailure: false, reasonCode: null,
    capturedIn24h: 0, classifiedIn24h: 0, pendingIn24h: 0, coverageComplete: true });
  assert.match(ui.interpretationNotice(empty), /No posts were captured.*does not establish caucus silence/);
});

test('health rendering rejects raw provider text, unsafe fields and contradictory healthy coverage', () => {
  const attack = '<img src=x onerror="alert(1)">';
  const dirty = data({ status: attack, reasonCode: attack, lastAttemptAt: attack, lastSuccessAt: attack,
    error: 'private provider request and credit diagnostics', capturedIn24h: attack, pendingIn24h: -1 });
  const rendered = ui.interpretationNotice(dirty);
  assert.ok(!rendered.includes(attack));
  assert.ok(!rendered.includes('private provider'));
  assert.ok(!rendered.includes('<img'));
  assert.match(rendered, /Interpretation status unavailable/);
  assert.match(rendered, /Last accepted interpretation: not recorded/);
  assert.match(ui.interpretationNotice(data({ reasonCode: 'constructor' })), /latest interpretation attempt did not complete successfully/);
  const contradicted = ui.interpretationView(data({ status: 'healthy', hasCurrentFailure: false, reasonCode: null }));
  assert.equal(contradicted.status, 'pending');
  assert.equal(contradicted.partial, true);
});

function renderer(file, fixture) {
  const html = fs.readFileSync(new URL(`../site/${file}`, import.meta.url), 'utf8');
  const start = html.indexOf('let D = null;');
  const end = file === 'index.html' ? html.indexOf('// ── events ──', start) : html.indexOf("document.addEventListener('click'", start);
  assert.ok(start >= 0 && end > start, 'actual page renderer located');
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', style: {},
      insertAdjacentHTML(_where, text) { this.innerHTML += text; } });
    return nodes.get(id);
  };
  const run = vm.runInNewContext(`${html.slice(start, end)}\n(value) => { D = value; render(); }`,
    { ...ui, document: { getElementById: node, querySelectorAll: () => [] }, CSS: { escape: (x) => x } });
  run(fixture);
  return nodes;
}
function fixture() {
  const metric = { n: 1, eng: 10, m: 1 };
  const scopes = Object.fromEntries(['All', ...ui.KEYS].map((key) => [key, metric]));
  const stats = { posts: 777, classified: 48, pending: 729, members: 10, accounts: 12,
    mix: [70, 10, 20], coreCounts: { Affordability: 1 }, corePosts: 1, eng: 100, perPost: 1, top10Share: 50, engDelta: 0 };
  return { ...data(), core: [{ name: 'Affordability' }], labels: { economy: 'Economy' },
    stats: { All: { t: stats, w: stats, curve48: [0, 1] } },
    topics: [{ key: 'economy', name: 'Economy', t: scopes, w: scopes, subs: [], trend: [0, 1], d: -90,
      momentum: { score: 73, volume: .1, accel: .1, adoption: .1, eff: 1, engLift: .1, drivers: ['volume'] } }],
    authorHandles: { '1': '@RepOne' }, members: { '@RepOne': ['Rep One', 'XX-01', []] },
    feedAll: [{ id: '123456', authorId: '1', text: 'Uninterpreted wording stays readable.',
      createdAt: '2026-09-15T19:00:00Z', date: '2026-09-15', type: 'tweet', topics: [], classificationStatus: 'pending', engN: 10 }],
    phrases: [], clusters: [], incidents: [] };
}

test('actual dashboard renders blocked coverage, pauses misleading momentum and preserves pending source links', () => {
  const out = renderer('index.html', fixture());
  assert.match(out.get('interpretation').innerHTML, /Interpretation blocked/);
  assert.match(out.get('cards').innerHTML, />paused</);
  assert.ok(!out.get('cards').innerHTML.includes('>73<'));
  assert.match(out.get('topics').innerHTML, /Topics · partial interpretations/);
  assert.match(out.get('topics').innerHTML, /Zero does not mean no members discussed a topic/);
  assert.ok(!out.get('topics').innerHTML.includes('>73<'));
  assert.match(out.get('feed').innerHTML, /Uninterpreted wording stays readable/);
  assert.match(out.get('feed').innerHTML, /href="https:\/\/x\.com\/i\/web\/status\/123456"/);
  assert.match(out.get('feed').innerHTML, /Classification pending/);
});

test('actual incident page keeps interpretation warning alongside an honestly scoped empty board', () => {
  const out = renderer('incidents.html', fixture());
  assert.match(out.get('interpretation').innerHTML, /Interpretation blocked/);
  assert.match(out.get('interpretation').innerHTML, /href="\.\/index\.html#feed"/);
  assert.match(out.get('detail').innerHTML, /No stored incidents/);
  assert.match(out.get('detail').innerHTML, /Missing interpretations or uncaptured posts/);
});
