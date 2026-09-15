import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FLOOR_URL, parseFloorXML, discoverFloorXML, normalizeFloorBill, refreshFloor, loadFloor, floorEvidenceForPost } from '../src/floor-context.js';

const XML = fs.readFileSync(new URL('./fixtures/house-floor-20260914.xml', import.meta.url), 'utf8');
const HTML = '<html><a class="downloadXML" href="Download.aspx?file=/billsthisweek/20260914/20260914.xml">XML</a></html>';
const NOW = '2026-09-14T22:00:00Z';
const XML_URL = 'https://docs.house.gov/billsthisweek/20260914/20260914.xml';
const snapshot = (xml = XML) => parseFloorXML(xml, { observedAt: NOW, xmlUrl: XML_URL, expectedWeek: '2026-09-14' });
const temp = (t) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floor-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return path.join(dir, 'floor.json'); };
const fetchFixture = (xml = XML, html = HTML) => async (url) => new Response(url === FLOOR_URL ? html : xml, { status: 200 });
const agenda = (xml = XML) => ({ available: true, current: true, stale: false, status: { ok: true }, ...snapshot(xml) });
const post = (text = 'Today I am discussing H.R. 9576.') => ({ id: '123', text, createdAt: '2026-09-14T21:00:00Z' });
const retrieve = (p = post(), a = agenda(), now = NOW) => floorEvidenceForPost(p, { agenda: a, now });

test('real official fixture preserves 77 floor items, 2 subordinate document rows, all 83 documents and tentative procedures', () => {
  const s = snapshot();
  assert.equal(s.items.length, 77);
  assert.equal(s.items.filter((x) => x.procedure.includes('suspension')).length, 71);
  assert.equal(s.items.filter((x) => x.procedure.includes('pursuant')).length, 5);
  assert.ok(s.items.every((x) => x.billId));
  const parent = s.items.find((x) => x.billId === '119-hr9576');
  assert.equal(parent.subitems.length, 2);
  assert.ok(parent.subitems.every((x) => x.billId === null && x.designation === '' && x.parentId === parent.sourceItemId));
  assert.equal(s.items.reduce((n, x) => n + x.documents.length + x.subitems.reduce((a, b) => a + b.documents.length, 0), 0), 83);
  assert.equal(s.items.find((x) => x.designation.startsWith('Senate')).billId, '119-hr5334');
  assert.equal(s.sourceUpdatedAtRaw, '2026-09-14T09:35:22.687');
  assert.equal(s.rawXml, XML);
  assert.equal(s.weekEnd, '2026-09-20');
  assert.match(s.items.find((x) => x.billId === '119-hr3276').title, /Communities & Bird/);
});

test('typed normalization distinguishes bills and resolution types; empty labels never invent a bill', () => {
  for (const [label, expected] of [['H.R.9576','119-hr9576'],['HR 9576','119-hr9576'],['S.790','119-s790'],['H.J. Res. 210','119-hjres210'],['H. Con. Res. 93','119-hconres93'],['S.J.Res.8','119-sjres8'],['S. Con. Res. 8','119-sconres8'],['H.Res.8','119-hres8'],['Senate amendments to H.R. 5334','119-hr5334']]) assert.equal(normalizeFloorBill(label, 119), expected);
  for (const bad of ['', '9576', 'HR 9576x', 'bill 9576', 'H.R. 1 and H.R. 2']) assert.equal(normalizeFloorBill(bad, 119), null);
});

test('only the official downloadXML link is discovered; unrelated/duplicate/unsafe links fail closed', () => {
  assert.deepEqual(discoverFloorXML(HTML), { xmlUrl: XML_URL, weekStart: '2026-09-14' });
  assert.deepEqual(discoverFloorXML(`<script>${HTML}</script>${HTML}`), { xmlUrl: XML_URL, weekStart: '2026-09-14' });
  for (const html of ['', HTML + HTML, HTML.replace('Download.aspx?file=', 'https://evil.test/?file='), HTML.replace('20260914.xml', '20260915.xml'), HTML.replace('/billsthisweek/', '/private/'), HTML.replace('href=', 'href="x" href=')]) assert.throws(() => discoverFloorXML(html));
});

test('truncated, malformed, entity-bearing, structurally unknown, duplicate and empty XML are rejected wholly', () => {
  const bad = [XML.slice(0, -20), XML + '<floorschedule/>', XML.replace('</files>', '</floor-item>'), '<!DOCTYPE floorschedule [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + XML,
    XML.replace('Modernizing Access', '&undeclared; Access'), XML.replace('<language>', '<unknown>'), XML.replace('congress-num="119"', 'congress-num="119" congress-num="118"'),
    XML.replace('id="409735"', 'id="409734"'), XML.replace('<floorschedule ', '<floorschedule xmlns="urn:other" '), XML.replace('week-date="2026-09-14"', 'week-date="2026-02-30"'),
    '<floorschedule congress-num="119" week-date="2026-09-14"><current-status>R</current-status><language>en-us</language></floorschedule>'];
  for (const xml of bad) assert.throws(() => snapshot(xml));
  assert.throws(() => parseFloorXML(XML, { observedAt: NOW, expectedWeek: '2026-09-21' }), /week mismatch/);
});

test('last good snapshot survives failed fetch, partial XML, and invalid source links; dry run writes nothing', async (t) => {
  const file = temp(t);
  assert.equal(loadFloor({ file, now: NOW }).available, false);
  const fresh = await refreshFloor({ file, fetchImpl: fetchFixture(), now: NOW });
  assert.equal(fresh.items.length, 77); assert.equal(fresh.status.ok, true); assert.equal(fresh.current, true); assert.equal(fresh.rawXml, undefined);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.snapshot.rawXml, XML);
  const later = '2026-09-14T23:00:00Z';
  for (const fetchImpl of [async () => new Response('', { status: 503 }), fetchFixture(XML.slice(0, -30)), fetchFixture(XML.replace('http://docs.house.gov/billsthisweek/20260914/S283_SUS_xml.pdf', 'https://evil.test/a.pdf'))]) {
    const failed = await refreshFloor({ file, fetchImpl, now: later });
    assert.equal(failed.status.ok, false); assert.equal(failed.observedAt, NOW); assert.equal(failed.status.lastAttemptAt, later); assert.equal(failed.status.lastSuccessAt, NOW);
    assert.equal(failed.snapshotHash, fresh.snapshotHash); assert.equal(failed.items.length, 77); assert.deepEqual(retrieve(post(), failed, later), []);
  }
  const before = fs.readFileSync(file, 'utf8');
  assert.equal((await refreshFloor({ file, fetchImpl: fetchFixture(), now: later, dryRun: true })).status.ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('snapshot observation and attempt clocks are separate; stale/gap/future observations never become current inference', async (t) => {
  const file = temp(t); await refreshFloor({ file, fetchImpl: fetchFixture(), now: NOW });
  for (const now of ['2026-09-16T22:00:01Z', '2026-09-21T12:00:00Z', '2026-09-14T21:00:00Z']) {
    const v = loadFloor({ file, now }); assert.equal(v.available, true); assert.equal(v.current, false); assert.equal(v.stale, true); assert.equal(v.items.length, 77); assert.deepEqual(retrieve(post(), v, now), []);
  }
  const state = JSON.parse(fs.readFileSync(file, 'utf8')); state.snapshot.rawXml = state.snapshot.rawXml.replace('PROOF Act', 'Changed Act'); fs.writeFileSync(file, JSON.stringify(state));
  assert.equal(loadFloor({ file, now: NOW }).available, false);
});

test('explicit typed identifiers match exactly with source dates and weekly-possibility wording', () => {
  const matches = retrieve(post('HR9576, H.R. 9576 and H. J. Res. 210 are on my mind.'));
  assert.deepEqual(matches.map((x) => x.billId).sort(), ['119-hjres210', '119-hr9576']);
  assert.ok(matches.every((x) => x.kind === 'floor-agenda' && x.url === XML_URL && x.publishedAt === null && x.fetchedAt === NOW && x.observedAt === NOW));
  assert.match(matches[0].text, /May be considered during the week/); assert.match(matches[0].text, /not evidence of a vote, passage/);
  for (const text of ['9576', 'H.R. 95760', 'S.9576', 'H.Res.210', 'PROOF Act is important', 'https://example.test/HR9576', 'H.R. 9576 in the 118th Congress']) assert.deepEqual(retrieve(post(text)), []);
});

test('withdrawn bills and unlabeled supporting documents remain visible but never become evidence', () => {
  const a = agenda();
  a.items.find((x) => x.billId === '119-hr9576').withdrawn = true;
  assert.deepEqual(retrieve(post(), a), []);
  const withdrawnXml = XML.replace(/(<floor-item id="409798"[^>]*remove-date=")"/, '$12026-09-14T10:00:00"');
  const parsed = snapshot(withdrawnXml); assert.equal(parsed.items.find((x) => x.billId === '119-hr9576').withdrawn, true);
  assert.equal(retrieve(post('Rules Committee Print 119-41')).length, 0);
});

test('current retweet wrappers never promote old or unresolved bill numbers into this Congress', () => {
  const wrapper = { ...post('RT @Member: H.R. 9576 must pass.'), type: 'retweet', refId: '888' };
  assert.deepEqual(retrieve(wrapper), []);
  assert.deepEqual(retrieve({ ...wrapper, reposted: { id: '888', text: 'H.R.9576 must pass.', createdAt: '2024-09-10T12:00:00Z' } }), []);
  assert.equal(retrieve({ ...wrapper, reposted: { id: '888', text: 'H.R.9576 must pass.', createdAt: '2025-09-10T12:00:00Z' } }).length, 1);
  assert.deepEqual(retrieve({ ...wrapper, refId: null, reposted: { id: '888', text: 'H.R.9576 must pass.', createdAt: NOW } }), []);
  assert.throws(() => snapshot(XML.replace('congress-num="119"', 'congress-num="118"')), /congress does not match/);
});

test('typed subordinate legislation is retrievable, but withdrawn parent removes its whole subtree', () => {
  const a = agenda(XML.replace('<legis-num />', '<legis-num>H.R. 99999</legis-num>'));
  const matches = retrieve(post('H.R.99999'), a);
  assert.equal(matches.length, 1); assert.equal(matches[0].billId, '119-hr99999');
  a.items.find((x) => x.billId === '119-hr9576').withdrawn = true;
  assert.deepEqual(retrieve(post('H.R.99999'), a), []);
});

test('invalid/future/outside-week posts and explicit wrong Congress cannot borrow the current agenda', () => {
  for (const createdAt of [null, 'bad', '2026-09-14T21:00:00', '2026-09-13T23:00:00Z', '2026-09-15T12:00:00Z', '2025-09-14T21:00:00Z']) assert.deepEqual(retrieve({ ...post(), createdAt }), []);
  assert.deepEqual(retrieve({ ...post(), congress: 118 }), []);
  assert.deepEqual(retrieve(post(), { ...agenda(), status: { ok: false } }), []);
  assert.deepEqual(retrieve(post(), { ...agenda(), current: false }), []);
  assert.deepEqual(retrieve(post(), { ...agenda(), stale: true }), []);
});

test('a Congress transition within one week cannot relabel an earlier member statement', () => {
  const xml = XML.replace('week-date="2026-09-14"', 'week-date="2024-12-30"');
  const s = parseFloorXML(xml, { observedAt: '2025-01-03T18:00:00Z' });
  const a = { ...s, available: true, current: true, stale: false, status: { ok: true } };
  assert.deepEqual(retrieve({ ...post(), createdAt: '2025-01-03T16:59:00Z' }, a, '2025-01-03T19:00:00Z'), []);
  assert.equal(retrieve({ ...post(), createdAt: '2025-01-03T17:01:00Z' }, a, '2025-01-03T19:00:00Z').length, 1);
});

test('full same-Congress original may identify a bill; prior-Congress/unknown/future/mismatched originals cannot', () => {
  const wrapper = { ...post('This matters.'), refId: '888' };
  for (const field of ['quoted', 'quoting', 'reposted', 'reposting']) {
    const original = { id: '888', text: 'An account of H.R.9576', createdAt: '2025-09-10T12:00:00Z' };
    assert.equal(retrieve({ ...wrapper, [field]: original })[0].billId, '119-hr9576');
    for (const changed of [{ createdAt: '2024-09-10T12:00:00Z' }, { createdAt: null }, { createdAt: '2026-09-15T12:00:00Z' }, { id: '999' }, { text: 'H.R.9576 of the 118th Congress' }, { congress: 118 }]) assert.deepEqual(retrieve({ ...wrapper, [field]: { ...original, ...changed } }), []);
  }
});

test('bounded acquisition rejects oversized bodies and never follows nonofficial redirects', async (t) => {
  const file = temp(t), seen = [];
  const redirected = await refreshFloor({ file, now: NOW, fetchImpl: async (url) => { seen.push(url); return new Response('', { status: 302, headers: { location: 'https://evil.test/schedule' } }); } });
  assert.deepEqual(seen, [FLOOR_URL]); assert.equal(redirected.available, false); assert.equal(redirected.status.ok, false);
  const oversized = await refreshFloor({ file, now: NOW, fetchImpl: async () => new Response('x'.repeat(1_000_001)) });
  assert.equal(oversized.status.ok, false); assert.match(oversized.status.error, /byte limit/);
});
