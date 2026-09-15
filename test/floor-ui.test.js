import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { esc, publicUrl, sourceLink, etWhen } from '../site/ui.js';

// Run the actual page renderer without its network/refresh entry points.
const html = fs.readFileSync(new URL('../site/floor.html', import.meta.url), 'utf8');
const begin = html.indexOf('let data = null, refreshError = null;');
const end = html.indexOf("\n$('search').addEventListener", begin);
assert.ok(begin >= 0 && end > begin, 'floor page renderer is present');
function render(floor, { query = '', refreshError = null } = {}) {
  const nodes = Object.fromEntries(['status', 'updated', 'search', 'agenda'].map((id) => [id, {
    innerHTML: '', textContent: '', className: '', value: '',
    replaceChildren() { this.innerHTML = ''; this.textContent = ''; }
  }]));
  nodes.search.value = query;
  const run = vm.runInNewContext(`${html.slice(begin, end)}\n(value, error) => { data = value; refreshError = error; render(); }`,
    { document: { getElementById: (id) => nodes[id] }, esc, publicUrl, sourceLink, etWhen });
  run({ floor, today: '2026-09-14', generatedAt: '2026-09-14T23:00:00Z' }, refreshError);
  return Object.fromEntries(Object.entries(nodes).map(([id, node]) => [id, node.innerHTML || node.textContent]));
}
const agenda = (extra = {}) => ({ available: true, current: true, stale: false, referencesAvailable: true,
  weekStart: '2026-09-14', observedAt: '2026-09-14T22:30:00Z', status: { ok: true },
  sourceUrl: 'https://docs.house.gov/floor/', items: [{ billId: '119-hr9576', designation: 'H.R. 9576',
    title: 'National Fraud Enforcement Division Act of 2026', procedure: 'Pursuant to a rule',
    documents: [{ type: 'Bill text', url: 'https://docs.house.gov/bill.pdf' }],
    membersReferencing: 0, references: [] }], ...extra });

test('floor page keeps weekly uncertainty and links both member wording and complete referenced originals', () => {
  const floor = agenda();
  const fullText = 'A quoted account describes its concerns. '.repeat(15) + 'H.R. 9576 is the specific bill referenced at the end.';
  floor.items[0].membersReferencing = 1;
  floor.items[0].references = [
    { id: '111', handle: 'MemberOfficial', text: 'I agree with these concerns.', createdAt: '2026-09-14T19:00:00Z',
      referencedSources: [{ id: '333', handle: 'QuotedSource', text: fullText, createdAt: '2026-09-14T18:00:00Z' }] },
    { id: '222', handle: 'MemberCampaign', text: 'H.R. 9576 is listed this week.', createdAt: '2026-09-14T20:00:00Z' }
  ];
  const out = render(floor);
  assert.match(html, /may be considered/);
  assert.match(html, /does not establish a vote date, passage or a member’s position/);
  assert.match(out.agenda, /1 distinct members · 2 captured references/);
  for (const id of ['111', '222', '333']) assert.ok(out.agenda.includes(`href="https://x.com/i/web/status/${id}"`));
  assert.ok(out.agenda.includes(esc(fullText)));
  assert.match(out.agenda, /Referenced original/);
  assert.match(out.agenda, /https:\/\/docs\.house\.gov\/bill\.pdf/);
  assert.match(out.status, /Counts show references, not agreement/);
});

test('unavailable matching cannot appear as zero references, while a current observed zero stays explicit', () => {
  const observed = render(agenda());
  assert.match(observed.agenda, /0 distinct members · 0 captured references/);
  assert.match(observed.agenda, /No exact bill-number reference found in the captured current-week material/);
  const retained = render(agenda({ current: false, stale: true, referencesAvailable: false, status: { ok: false } }), { refreshError: new Error('offline') });
  assert.match(retained.status, /latest official-source refresh failed; the previous agenda is retained/);
  assert.match(retained.status, /not been verified within the last 24 hours/);
  assert.match(retained.status, /outside the current legislative week/);
  assert.match(retained.agenda, /Reference matching unavailable/);
  assert.ok(!retained.agenda.includes('0 captured references'));
  assert.match(retained.updated, /Refresh failed; showing saved data/);
  const absent = render(undefined);
  assert.match(absent.status, /No usable official agenda has been acquired yet/);
  assert.equal(absent.agenda, '');
});

test('floor rendering escapes source wording and labels, and never links unsafe URLs or invented post IDs', () => {
  const floor = agenda({ sourceUrl: 'javascript:alert(1)' });
  const attack = '<img src=x onerror="alert(1)">';
  Object.assign(floor.items[0], { title: attack, procedure: attack, sourceUrl: 'https://secret:password@example.com/',
    documents: [{ type: attack, url: 'data:text/html,<script>alert(1)</script>' }],
    references: [{ id: '111', text: attack, handle: attack, createdAt: attack,
      referencedSources: [{ id: 'javascript:alert(1)', text: attack, createdAt: null }] }] });
  const out = render(floor);
  assert.ok(!out.agenda.includes('<img'));
  assert.ok(!out.agenda.includes('<script'));
  assert.ok(out.agenda.includes(esc(attack)));
  assert.ok(!out.agenda.includes('href="data:'));
  assert.ok(!out.agenda.includes('secret:password'));
  assert.ok(!out.agenda.includes('href="javascript:'));
  assert.ok(!out.status.includes('href="javascript:'));
  assert.equal((out.agenda.match(/href="https:\/\/x\.com\/i\/web\/status\//g) || []).length, 2);
  assert.match(out.agenda, /not observed/);
});

test('floor search limits the displayed bill list without changing source coverage status', () => {
  const floor = agenda();
  assert.match(render(floor, { query: 'fraud' }).agenda, /H\.R\. 9576/);
  const noMatch = render(floor, { query: 'unlisted bill' });
  assert.match(noMatch.agenda, /No listed bills match this search/);
  assert.match(noMatch.status, /1 listed items/);
});

test('withdrawn bills do not appear in the active weekly list, its counts or search results', () => {
  const floor = agenda();
  floor.items.push({ ...floor.items[0], id: 'removed-item', billId: '119-hr9999', designation: 'H.R. 9999',
    title: 'Withdrawn bill title', withdrawn: true, membersReferencing: 2,
    references: [{ id: '444', text: 'An older captured reference.', createdAt: '2026-09-14T19:00:00Z' }] });
  const out = render(floor);
  assert.match(out.agenda, /H\.R\. 9576/);
  assert.ok(!out.agenda.includes('H.R. 9999'));
  assert.ok(!out.agenda.includes('Withdrawn bill title'));
  assert.ok(!out.agenda.includes('/status/444'));
  assert.match(out.status, /1 listed items/);
  assert.match(render(floor, { query: '9999' }).agenda, /No listed bills match this search/);
});
