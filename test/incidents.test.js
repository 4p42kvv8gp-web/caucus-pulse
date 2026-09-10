import test from 'node:test';
import assert from 'node:assert/strict';
import {
  corroborationOf, applyStatus, sortIncidents, groupIncidents, CORROBORATION_GAP,
  findEvidence, kindTerms, placeTerms, EVIDENCE_FALLBACK_CHARS,
  postFilterReason, placeFilterReason, filterFlags, canonicalKind, districtLabel, stateOf, countByStatus
} from '../src/incidents.js';

const H = 3_600_000;
const NOW = Date.parse('2026-09-10T12:00:00Z');
const iso = (hoursAgo) => new Date(NOW - hoursAgo * H).toISOString();
const entry = (who, hoursAgo) => ({ who, time: iso(hoursAgo) });

// ── provisional rule ──────────────────────────────────────────────────────

test('corroborationOf: one post from one member is provisional', () => {
  const c = corroborationOf([entry('@RepA', 1)]);
  assert.equal(c.corroborated, false);
  assert.equal(c.by, null);
  assert.match(c.note, /one post from one member/);
  assert.match(c.note, /second member|later post|nightly intel/);
});

test('corroborationOf: a second member corroborates', () => {
  const c = corroborationOf([entry('@RepA', 3), entry('@RepB', 2)]);
  assert.equal(c.corroborated, true);
  assert.equal(c.by, 'second member');
  assert.match(c.note, /@RepA, @RepB/);
});

test('corroborationOf: a same-member follow-up counts only after CORROBORATION_GAP', () => {
  assert.equal(CORROBORATION_GAP, H);
  const soon = corroborationOf([entry('@RepA', 2), entry('@RepA', 1.5)]); // 30 min apart
  assert.equal(soon.corroborated, false);
  assert.match(soon.note, /2 posts from one member within 30 min/);
  const later = corroborationOf([entry('@RepA', 1), entry('@RepA', 3)]); // unsorted input, 2h apart
  assert.equal(later.corroborated, true);
  assert.equal(later.by, 'second post');
  assert.match(later.note, /2h after the first report/);
  const exact = corroborationOf([entry('@RepA', 2), { who: '@RepA', time: new Date(NOW - 2 * H + CORROBORATION_GAP).toISOString() }]);
  assert.equal(exact.corroborated, true); // ≥, not >
});

test('corroborationOf: an intel panel with content corroborates; an empty one does not', () => {
  const one = [entry('@RepA', 1)];
  assert.equal(corroborationOf(one, { confirmed: [], unverified: [], whatsNew: [] }).corroborated, false);
  assert.equal(corroborationOf(one, null).corroborated, false);
  const c = corroborationOf(one, { confirmed: [{ text: 'x', src: 'y' }], unverified: [], whatsNew: [] });
  assert.equal(c.corroborated, true);
  assert.equal(c.by, 'intel');
  assert.match(c.note, /1 confirmed, 0 unverified/);
  assert.equal(corroborationOf(one, { confirmed: [], unverified: [], whatsNew: ['new'] }).by, 'intel');
});

test('applyStatus: provisional in front of the lifecycle; corroboration hands the lifecycle status back', () => {
  const inc = { lifecycle: 'active', timeline: [entry('@RepA', 1)], intel: null };
  applyStatus(inc);
  assert.equal(inc.status, 'provisional');
  assert.equal(inc.lifecycle, 'active');
  inc.intel = { confirmed: [{ text: 'evacuations ordered', src: 'per @RepA' }], unverified: [], whatsNew: [] };
  applyStatus(inc);
  assert.equal(inc.status, 'active');
  // a stale uncorroborated report is still provisional, never "resolved"
  const old = applyStatus({ lifecycle: 'resolved', timeline: [entry('@RepA', 40)], intel: null });
  assert.equal(old.status, 'provisional');
  assert.equal(old.lifecycle, 'resolved');
  // corroborated incidents keep the existing transitions
  for (const phase of ['active', 'monitoring', 'resolved']) {
    assert.equal(applyStatus({ lifecycle: phase, timeline: [entry('@RepA', 5), entry('@RepB', 4)], intel: null }).status, phase);
  }
});

test('sortIncidents: by lifecycle, corroborated before provisional within a phase, newest last post first', () => {
  const mk = (id, lifecycle, status, hoursAgo) => ({ id, lifecycle, status, last: iso(hoursAgo) });
  const out = sortIncidents([
    mk('res-prov', 'resolved', 'provisional', 40),
    mk('mon', 'monitoring', 'monitoring', 20),
    mk('act-prov-old', 'active', 'provisional', 6),
    mk('act', 'active', 'active', 3),
    mk('act-prov-new', 'active', 'provisional', 1),
    mk('res', 'resolved', 'resolved', 50),
    mk('mon-prov', 'monitoring', 'provisional', 15)
  ]);
  assert.deepEqual(out.map((i) => i.id), ['act', 'act-prov-new', 'act-prov-old', 'mon', 'mon-prov', 'res', 'res-prov']);
});

test('groupIncidents: a single report is provisional immediately; grouping corroborates; intel from the previous file carries over', () => {
  const flags = {
    a: { kind: 'wildfire', place: 'Napa County, CA' },
    b: { kind: 'hazmat release', place: 'La Habra, CA' },
    c: { kind: 'chemical leak', place: 'La Habra, CA' },
    d: { kind: 'flooding', place: 'Miami, FL' }
  };
  const posts = new Map([
    ['a', { id: 'a', authorId: 'u1', createdAt: iso(2), text: '#SteeleFire in Napa County: An Evacuation Warning for Zone: BER-E008. Please be ready to evacuate.', engN: 40, capturedAt: 'p2' }],
    ['b', { id: 'b', authorId: 'u2', createdAt: iso(20), text: 'LA HABRA RESIDENTS: A hazmat situation has been reported in La Habra near Cypress Street. Officials have ordered evacuations.', engN: 10, capturedAt: 'p1' }],
    ['c', { id: 'c', authorId: 'u2', createdAt: iso(17.5), text: 'RT @ocregister: Shelter-in-place order lifted following hazmat incident in La Habra', engN: 5, capturedAt: 'p1' }],
    ['d', { id: 'd', authorId: 'u3', createdAt: iso(1), text: 'Flooding across Miami this morning. My office is in contact with the county.', engN: 3, capturedAt: 'p2' }]
  ]);
  const authors = {
    u1: { handle: 'RepThompson', member: 'Mike Thompson', stateDistrict: 'CA-04' },
    u2: { handle: 'RepLindaSanchez', member: 'Linda T. Sánchez', stateDistrict: 'CA-38' },
    u3: { handle: 'RepSoto', member: 'Darren Soto', stateDistrict: 'FL-09' }
  };
  const prevById = new Map([['miami-fl--flooding', { id: 'miami-fl--flooding', intel: { confirmed: [{ text: 'county EOC activated', src: 'per @RepSoto' }], unverified: [], whatsNew: [], posts: 1 } }]]);
  const out = groupIncidents(flags, posts, authors, { now: NOW, lastPollAt: 'p2', prevById });
  assert.deepEqual(out.map((i) => i.id), ['miami-fl--flooding', 'napa-county-ca--wildfire', 'la-habra-ca--hazmat']);

  const napa = out.find((i) => i.id === 'napa-county-ca--wildfire');
  assert.equal(napa.status, 'provisional');
  assert.equal(napa.lifecycle, 'active');
  assert.equal(napa.corroboration.corroborated, false);
  assert.equal(napa.place, 'Napa County, CA · CA-04'); // state matches the lead's district
  assert.equal(napa.districtMatch, true);
  assert.equal(napa.evidence.exact, true);
  assert.equal(napa.evidence.span, '#SteeleFire in Napa County: An Evacuation Warning for Zone: BER-E008.');
  assert.equal(napa.timeline[0].isNew, true);
  assert.deepEqual(napa.timeline[0].flag, { kind: 'wildfire', place: 'Napa County, CA' });

  // kind synonyms fold into one incident; two posts 2.5h apart from one member corroborate it
  const habra = out.find((i) => i.id === 'la-habra-ca--hazmat');
  assert.equal(habra.kind, 'hazmat');
  assert.deepEqual(habra.kinds, ['hazmat release', 'chemical leak']);
  assert.equal(habra.updates, 2);
  assert.equal(habra.status, 'monitoring');
  assert.equal(habra.lifecycle, 'monitoring');
  assert.equal(habra.corroboration.by, 'second post');
  assert.deepEqual(habra.timeline[1].flag, { kind: 'chemical leak', place: 'La Habra, CA' });
  assert.equal(habra.title, 'Hazmat · La Habra, CA');

  // intel from the previous build corroborates a single report; the lead's district (FL-09) is not Miami's, so no suffix
  const miami = out.find((i) => i.id === 'miami-fl--flooding');
  assert.equal(miami.status, 'active');
  assert.equal(miami.corroboration.by, 'intel');
  assert.equal(miami.place, 'Miami, FL · FL-09'); // same state: the most the data can vouch for
  assert.equal(miami.intel.posts, 1);

  assert.deepEqual(countByStatus(out), { provisional: 1, active: 1, monitoring: 1, resolved: 0 });
});

test('districtLabel / stateOf: the suffix is withheld when the place is in another state', () => {
  assert.equal(stateOf('Kauai, HI'), 'HI');
  assert.equal(stateOf('aurora co'), null);
  assert.deepEqual(districtLabel('Miami, FL', 'MN-04'), { place: 'Miami, FL', district: 'MN-04', districtMatch: false });
  assert.deepEqual(districtLabel('Miami, FL', 'FL-24'), { place: 'Miami, FL · FL-24', district: 'FL-24', districtMatch: true });
  assert.deepEqual(districtLabel('aurora co', 'CO-06'), { place: 'aurora co', district: 'CO-06', districtMatch: null });
  assert.deepEqual(districtLabel('Detroit, MI', 'US Senate'), { place: 'Detroit, MI', district: 'US Senate', districtMatch: null });
});

// ── evidence span ─────────────────────────────────────────────────────────

test('findEvidence: the sentence naming both the event and the place, as an exact substring', () => {
  const text = '#SteeleFire in Napa County: An Evacuation Warning for Zone: BER-E008. Please be vigilante and ready to evacuate when and if needed. Learn More: https://t.co/PFGosXomu7';
  const ev = findEvidence(text, 'wildfire', 'Napa County, CA');
  assert.equal(ev.exact, true);
  assert.equal(ev.span, '#SteeleFire in Napa County: An Evacuation Warning for Zone: BER-E008.');
  assert.equal(text.slice(ev.start, ev.end), ev.span);
  assert.deepEqual(ev.matched, { kind: true, place: true });
});

test('findEvidence: kind stems and synonyms, diacritics, RT prefixes, multi-word places', () => {
  const kau = findEvidence('The destruction Hurricane Lala left behind on farms across Kaʻū is extensive. From ranch lands to coffee farms, flooding.', 'hurricane damage', 'Kaʻū, HI');
  assert.equal(kau.exact, true);
  assert.equal(kau.span, 'The destruction Hurricane Lala left behind on farms across Kaʻū is extensive.');
  const kauai = findEvidence('Thinking of all our ‘ohana recovering from devastating Lowell. Here’s the link to report storm damage, especially for Kaua’i/Ni’ihau.', 'tropical storm', 'Kauai, HI');
  assert.equal(kauai.exact, true);
  assert.match(kauai.span, /^Here’s the link to report storm damage, especially for Kaua’i\/Ni’ihau\.$/);
  const rt = findEvidence('RT @ocregister: Shelter-in-place order lifted following hazmat incident in La Habra https://t.co/Al59GKHBAi', 'chemical leak', 'La Habra, CA');
  assert.equal(rt.exact, true);
  assert.equal(rt.span, 'RT @ocregister: Shelter-in-place order lifted following hazmat incident in La Habra'); // trailing URL trimmed
  const la = findEvidence('Orange and L.A. counties are under an Extreme Heat Warning through Wednesday.', 'extreme heat', 'Orange and LA counties, CA');
  assert.equal(la.exact, true);
  const flood = findEvidence('Streets flooded across Aurora overnight. Crews are out.', 'flooding', 'Aurora, CO');
  assert.equal(flood.exact, true);
  assert.equal(flood.span, 'Streets flooded across Aurora overnight.');
  const shots = findEvidence('Shots fired near the Tucson mall. Avoid the area.', 'active shooter', 'Tucson, AZ');
  assert.equal(shots.exact, true);
  assert.equal(shots.span, 'Shots fired near the Tucson mall.');
});

test('findEvidence: spans up to three sentences when event and place sit in different sentences', () => {
  const text = 'Big night for our crews. The fire jumped the ridge around 9pm. Everyone in Banning should be ready to leave. More soon.';
  const ev = findEvidence(text, 'wildfire', 'Banning, CA');
  assert.equal(ev.exact, true);
  assert.equal(ev.span, 'The fire jumped the ridge around 9pm. Everyone in Banning should be ready to leave.');
  assert.equal(text.slice(ev.start, ev.end), ev.span);
});

test('findEvidence: not found → first 140 characters, exact:false, and which of kind/place the post names at all', () => {
  const text = 'I visited the incident command posts servicing the Austin and Narrows fires with @SenJeffMerkley to learn how to better support our firefighters this wildfire season and beyond. In Congress, I am working on legislation.';
  const ev = findEvidence(text, 'wildfire', 'Eastern Oregon, OR');
  assert.equal(ev.exact, false);
  assert.equal(ev.span, text.slice(0, EVIDENCE_FALLBACK_CHARS).trim());
  assert.equal(ev.span.length <= 140, true);
  assert.equal(text.slice(ev.start, ev.end), ev.span);
  assert.deepEqual(ev.matched, { kind: true, place: false }); // the place was invented
  const psa = findEvidence('Stay safe and stay alert, Michigan. Follow local news for the latest information.', 'severe weather', 'Michigan, MI');
  assert.equal(psa.exact, false);
  assert.deepEqual(psa.matched, { kind: false, place: true });
  const short = findEvidence('Praying for everyone.', 'plane crash', 'Miami, FL');
  assert.equal(short.span, 'Praying for everyone.');
  assert.equal(short.exact, false);
  assert.deepEqual(findEvidence('', 'wildfire', 'Napa County, CA'), { span: '', exact: false, start: 0, end: 0, matched: { kind: false, place: false } });
});

test('kindTerms / placeTerms: modifiers and generic place words drop out; specific tokens must all appear', () => {
  assert.deepEqual(kindTerms('severe storms'), ['storm']);
  assert.ok(kindTerms('wildfire').includes('fire'));
  assert.ok(kindTerms('active shooter').includes('gunfire'));
  assert.deepEqual(placeTerms('Napa County, CA'), ['napa']);
  assert.deepEqual(placeTerms('Eastern Oregon, OR'), ['oregon']);
  assert.deepEqual(placeTerms('Big Sur, CA'), ['big', 'sur']);
  assert.deepEqual(placeTerms('Kaʻū, HI'), ['kau']);
  assert.deepEqual(placeTerms('County, CA'), ['county']); // nothing specific: fall back to every token
  // "San" alone must not match San Francisco for a San Diego flag
  assert.equal(findEvidence('San Francisco is under an extreme heat advisory.', 'extreme heat', 'San Diego, CA').exact, false);
});

// ── deterministic post-filter ─────────────────────────────────────────────

test('postFilterReason: commemorations', () => {
  assert.deepEqual(postFilterReason('Today marks the anniversary of the Camp Fire.'), { reason: 'commemoration', cue: 'anniversary' });
  assert.equal(postFilterReason('Five years ago today, floods swept through our valley.').reason, 'commemoration');
  assert.equal(postFilterReason('25 years ago the tornado tore through downtown.').cue, '25 years ago');
  assert.equal(postFilterReason('Today we remember the 12 neighbors we lost in the flood.').reason, 'commemoration');
  assert.equal(postFilterReason('We will #NeverForget the victims of the wildfire.').reason, 'commemoration');
  assert.equal(postFilterReason('In loving memory of the firefighters who fell.').reason, 'commemoration');
});

test('postFilterReason: hypotheticals, drills and preparedness', () => {
  assert.deepEqual(postFilterReason('What if a Category 5 hurricane hit Tampa Bay directly?'), { reason: 'hypothetical', cue: 'What if' });
  assert.equal(postFilterReason('Imagine a wildfire sweeping through the canyon.').reason, 'hypothetical');
  assert.equal(postFilterReason('If another flood hits our county, we need FEMA ready.').reason, 'hypothetical');
  assert.equal(postFilterReason('Great to join the county tornado drill this morning.').reason, 'hypothetical');
  assert.equal(postFilterReason('Hurricane season starts today — build your go kit now.').reason, 'seasonal or preparedness');
  assert.equal(postFilterReason('Wildfire preparedness tips for the weekend.').reason, 'seasonal or preparedness');
});

test('postFilterReason: explicitly dated past events and aftermath administration', () => {
  // an explicit date cue outranks the softer aftermath wording in the same post
  assert.deepEqual(postFilterReason('If you were impacted by recent flooding in Indianapolis, federal assistance may be available. Apply by October 25.'), { reason: 'dated past', cue: 'Apply by' });
  assert.deepEqual(postFilterReason('If you were impacted by recent flooding in Indianapolis, federal assistance may be available.'), { reason: 'aftermath', cue: 'assistance may be available' });
  assert.equal(postFilterReason('Here is what you need to know to apply by October 25, 2026.').cue, 'apply by');
  assert.equal(postFilterReason('As Northwest Indiana continues to recover after the August storm, USDA help is here.').reason, 'dated past');
  assert.equal(postFilterReason('Helping our communities recover after the July and August severe storms.').cue, 'the July and August severe storms');
  assert.equal(postFilterReason('These communities spent months wondering whether help was coming.').cue, 'spent months');
  assert.equal(postFilterReason('Three weeks ago the storm hit; today the intake center opens.').reason, 'dated past');
  assert.equal(postFilterReason('As we continue in the storm recovery, here is the daily update.').reason, 'aftermath');
  assert.equal(postFilterReason('Lala is gone, but the work is just beginning.').cue, 'Lala is gone');
  assert.equal(postFilterReason('The destruction Hurricane Lala left behind on farms is extensive.').cue, 'left behind');
  assert.equal(postFilterReason('This disaster declaration is a critical step for every family affected.').cue, 'disaster declaration');
});

test('postFilterReason: reaction-only posts, but not when the post also acts', () => {
  assert.deepEqual(postFilterReason('What a tragedy. Praying for the families of those who perished at Miami Airport.'), { reason: 'reaction only', cue: 'What a tragedy' });
  assert.equal(postFilterReason('🙏 I am heartbroken by the tragic cargo plane crash at Miami International Airport.').cue, 'I am heartbroken');
  assert.equal(postFilterReason('RT @Someone: My thoughts are with the families across Detroit.').reason, 'reaction only');
  assert.equal(postFilterReason('It is devastating to see the loss of five lives.').reason, 'reaction only');
  // the same opening with a hotline is live
  assert.equal(postFilterReason('Heartbroken to see severe storms hit our community yesterday afternoon. If you need emergency shelter, call 866-313-2520.'), null);
});

test('postFilterReason: live-action cues override every text cue', () => {
  assert.equal(postFilterReason('#ScottFire in Lake County: An Evacuation Order for Zone: LAK-E054. Leave without delay.'), null);
  assert.equal(postFilterReason('Ten years ago the Valley Fire burned here. Tonight, evacuation orders are in effect for zones 1-4 again.'), null);
  assert.equal(postFilterReason('Thinking of all our ohana recovering from devastating Lowell. Here is the link to report storm damage.'), null);
  assert.equal(postFilterReason('Hundreds of my residents are experiencing DTE power outages during this heat wave. My office is working hard.'), null);
  assert.equal(postFilterReason('Severe storms have devastated Southeast Michigan. My team and I are in direct communication with local officials.'), null);
  assert.equal(postFilterReason('Highway 1 is closed at Big Sur after the slide. Use caution.'), null);
  assert.equal(postFilterReason('Shelter-in-place order lifted following hazmat incident in La Habra'), null);
  assert.equal(postFilterReason(''), null);
  assert.equal(postFilterReason('Part of Highway 1 is reopen for Big Sur businesses and residents.'), null); // no cue either way
});

test('placeFilterReason: bare states and unnamed places, but cities that share a state name stay', () => {
  assert.equal(placeFilterReason('Washington, WA'), 'place is a whole state');
  assert.equal(placeFilterReason('Illinois, IL'), 'place is a whole state');
  assert.equal(placeFilterReason('Michigan, MI'), 'place is a whole state');
  assert.equal(placeFilterReason('Michigan'), 'place is a whole state');
  assert.equal(placeFilterReason('district-unspecified'), 'no place named');
  assert.equal(placeFilterReason('Unknown, TX'), 'no place named');
  assert.equal(placeFilterReason(''), 'no place');
  assert.equal(placeFilterReason('Washington, DC'), null);
  assert.equal(placeFilterReason('New York, NY'), null);
  assert.equal(placeFilterReason('Southeast Michigan, MI'), null);
  assert.equal(placeFilterReason('Napa County, CA'), null);
  assert.equal(placeFilterReason('Kaʻū, HI'), null);
});

test('canonicalKind folds the corpus synonyms into the prompt vocabulary and passes unknown kinds through', () => {
  const cases = {
    'hazmat release': 'hazmat', 'chemical leak': 'hazmat', 'hazmat incident': 'hazmat',
    'severe storms': 'severe storm', 'severe weather': 'severe storm', 'storm damage': 'severe storm',
    'flash flooding': 'flooding', 'heavy rain flooding': 'flooding', flooding: 'flooding',
    'mass shooting': 'shooting', 'shooting attack': 'shooting', 'active shooter': 'active shooter',
    'power outage': 'power outage', 'storm power outage': 'power outage', 'water main break': 'water outage',
    'hurricane damage': 'hurricane', 'tropical storm': 'hurricane', 'hurricane landfall': 'hurricane',
    'train collision': 'train crash', 'plane crash': 'plane crash', 'extreme heat': 'extreme heat', 'heat wave': 'extreme heat',
    Wildfire: 'wildfire', 'brush fire': 'wildfire', 'house fire': 'structure fire',
    'missing hikers': 'missing persons', 'bridge collapse': 'infrastructure failure',
    'volcanic eruption': 'volcanic eruption'
  };
  for (const [raw, canon] of Object.entries(cases)) assert.equal(canonicalKind(raw), canon, raw);
});

test('filterFlags: non-House accounts, bare-state places and text cues are dropped with an audit row; the rest are kept', () => {
  const flags = {
    a: { kind: 'severe storms', place: 'Detroit, MI' },
    b: { kind: 'wildfire', place: 'Washington, WA' },
    c: { kind: 'storm damage', place: 'Gary, IN' },
    d: { kind: 'wildfire', place: 'Lake County, CA' },
    e: { kind: 'flooding', place: 'Nowhere, XX' } // not hydrated: silently skipped
  };
  const posts = new Map([
    ['a', { id: 'a', authorId: 'sen', createdAt: iso(5), text: 'Severe storms have devastated Detroit. My team is in contact with local officials.' }],
    ['b', { id: 'b', authorId: 'h1', createdAt: iso(6), text: 'Here is this week’s newsletter with another round of wildfire resources.' }],
    ['c', { id: 'c', authorId: 'h2', createdAt: iso(7), text: 'As we continue in the storm recovery, here is assistance from the City of Gary.' }],
    ['d', { id: 'd', authorId: 'h1', createdAt: iso(1), text: '#ScottFire in Lake County: An Evacuation Order for Zone: LAK-E054.' }]
  ]);
  const authors = { sen: { handle: 'SenatorX', status: 'senate' }, h1: { handle: 'RepOne', status: 'house' }, h2: { handle: 'RepTwo' } };
  const { kept, dropped } = filterFlags(flags, posts, authors);
  assert.deepEqual(Object.keys(kept), ['d']);
  assert.deepEqual(dropped.map((r) => [r.id, r.who, r.reason, r.cue]), [
    ['a', '@SenatorX', 'non-House account', null],
    ['b', '@RepOne', 'place is a whole state', 'Washington, WA'],
    ['c', '@RepTwo', 'aftermath', 'storm recovery']
  ]);
  assert.equal(dropped[0].time, iso(5));
  assert.deepEqual([dropped[0].kind, dropped[0].place], ['severe storms', 'Detroit, MI']);
});
