import test from 'node:test';
import assert from 'node:assert/strict';
import {
  corroborationOf, applyStatus, sortIncidents, groupIncidents, CORROBORATION_GAP,
  findEvidence, kindTerms, placeTerms, EVIDENCE_FALLBACK_CHARS,
  postFilterReason, placeFilterReason, filterFlags, canonicalKind, districtLabel, stateOf, countByStatus,
  supportedEventName, validateIntel, incidentInputHash
} from '../src/incidents.js';

const H = 3_600_000;
const NOW = Date.parse('2026-09-10T12:00:00Z');
const iso = (hoursAgo) => new Date(NOW - hoursAgo * H).toISOString();
const entry = (who, hoursAgo) => ({ who, time: iso(hoursAgo) });

// Source statements establish what was said, not independent verification.
test('repetition, follow-ups, and model summaries never corroborate a source statement', () => {
  const cases = [
    [entry('@AccountA', 1)],
    [entry('@AccountA', 3), entry('@AccountB', 2)],
    [entry('@AccountA', 3), entry('@AccountA', 1)]
  ];
  assert.equal(CORROBORATION_GAP, H); // legacy compatibility only
  for (const timeline of cases) {
    for (const intel of [null, { confirmed: [{ text: 'model claim' }], whatsNew: ['model update'] }]) {
      const c = corroborationOf(timeline, intel);
      assert.equal(c.corroborated, false);
      assert.equal(c.independentSourceCount, 0);
      assert.equal(c.by, null);
      assert.match(c.note, /independent verification has not been established/);
    }
  }
});

test('account aliases and common repost parents stay distinct from independent sources', () => {
  const c = corroborationOf([
    { sourceId: '101', authorId: 'a', personId: 'member-one', referenceIds: ['99'] },
    { sourceId: '102', authorId: 'b', personId: 'member-one', referenceIds: ['99'] },
    { sourceId: '103', authorId: 'c', referenceIds: [] }
  ]);
  assert.equal(c.accounts, 3);
  assert.equal(c.resolvedPeople, 1);
  assert.equal(c.unresolvedAccounts, 1);
  assert.equal(c.independentSourceCount, 0);
  assert.deepEqual(c.repeatedSourceGroups, [{ sourceId: '99', url: 'https://x.com/i/web/status/99', repeatedBy: ['101', '102'] }]);
});

test('posting lifecycle never overrides unverified evidence status', () => {
  for (const lifecycle of ['active', 'monitoring', 'resolved']) {
    const inc = applyStatus({ lifecycle, timeline: [entry('@AccountA', 5), entry('@AccountB', 4)], intel: { confirmed: [{ text: 'generated claim' }] } });
    assert.equal(inc.status, 'provisional');
    assert.equal(inc.lifecycle, lifecycle);
    assert.equal(inc.verification.status, 'unverified');
    assert.equal(inc.verification.independentSourceCount, 0);
  }
});

test('sortIncidents retains activity ordering for provisional reports', () => {
  const mk = (id, lifecycle, hoursAgo) => ({ id, lifecycle, status: 'provisional', last: iso(hoursAgo) });
  const out = sortIncidents([mk('quiet', 'resolved', 40), mk('older', 'active', 6), mk('monitor', 'monitoring', 20), mk('new', 'active', 1)]);
  assert.deepEqual(out.map((i) => i.id), ['new', 'older', 'monitor', 'quiet']);
});

const AUTHORS = {
  a: { handle: 'AccountA', member: 'Member One', stateDistrict: 'CA-04' },
  b: { handle: 'AccountB', member: 'Member Two', stateDistrict: 'CA-05' }
};
const namedFixture = () => {
  const flags = {
    '101': { kind: 'wildfire', place: 'Example County, CA', name: 'Cedar Fire' },
    '102': { kind: 'brush fire', place: 'Example County, CA', name: 'Cedar Fire' },
    '103': { kind: 'wildfire', place: 'Example County, CA', name: 'Pine Fire' }
  };
  const posts = new Map([
    ['101', { id: '101', authorId: 'a', createdAt: iso(3), text: 'Cedar Fire in Example County. No evacuations ordered.', engN: 10 }],
    ['102', { id: '102', authorId: 'b', createdAt: iso(1), text: 'Cedar Fire in Example County: a shelter is open.', engN: 5, capturedAt: 'p2' }],
    ['103', { id: '103', authorId: 'a', createdAt: iso(2), text: 'Pine Fire in Example County. My office is in contact.', engN: 3 }]
  ]);
  return { flags, posts };
};

test('named events in the same county stay separate; every timeline item cites its source', () => {
  const { flags, posts } = namedFixture();
  const out = groupIncidents(flags, posts, AUTHORS, { now: NOW, lastPollAt: 'p2' });
  assert.equal(out.length, 2);
  const cedar = out.find((i) => i.name === 'Cedar Fire');
  assert.equal(cedar.updates, 2);
  assert.equal(cedar.kind, 'wildfire');
  assert.deepEqual(cedar.kinds, ['wildfire', 'brush fire']);
  assert.equal(cedar.status, 'provisional');
  assert.equal(cedar.eventIdentity, 'named-source-supported');
  assert.match(cedar.title, /^Cedar Fire/);
  assert.equal(cedar.timeline[1].isNew, true);
  for (const source of cedar.timeline) {
    assert.equal(source.url, `https://x.com/i/web/status/${source.sourceId}`);
    assert.equal(source.evidence.sourceId, source.sourceId);
    assert.equal(source.evidence.url, source.url);
    assert.equal(source.text.slice(source.evidence.start, source.evidence.end), source.evidence.span);
  }
  assert.deepEqual(countByStatus(out), { provisional: 2, active: 0, monitoring: 0, resolved: 0 });
  assert.deepEqual(groupIncidents(Object.fromEntries(Object.entries(flags).reverse()), posts, AUTHORS, { now: NOW }).map((i) => i.id), out.map((i) => i.id));
});

test('invented names cannot link unrelated unnamed events and named episodes separate after 48h', () => {
  const { flags, posts } = namedFixture();
  flags['101'].name = 'Invented Fire';
  flags['102'].name = null;
  assert.equal(supportedEventName(flags['101'], posts.get('101')), null);
  assert.equal(supportedEventName({ kind: 'wildfire' }, { text: '#CedarFire in Example County' }), 'CedarFire');
  const unlinked = groupIncidents(flags, posts, AUTHORS, { now: NOW });
  assert.equal(unlinked.length, 3);
  assert.equal(unlinked.filter((i) => i.eventIdentity === 'unresolved-source-specific').length, 2);
  flags['101'].name = flags['102'].name = 'Cedar Fire';
  posts.get('101').createdAt = iso(55);
  assert.equal(groupIncidents(flags, posts, AUTHORS, { now: NOW }).length, 3);
});

test('a hashtag and spaced event name link when both are supported by their sources', () => {
  const { flags, posts } = namedFixture();
  flags['102'].name = null;
  posts.get('102').text = '#CedarFire in Example County: shelter is open.';
  const out = groupIncidents(flags, posts, AUTHORS, { now: NOW });
  assert.equal(out.length, 2);
  assert.equal(out.find((i) => i.name === 'Cedar Fire').updates, 2);
});

test('intel rejects invented or truncated quotes and reconstructs attribution and URLs', () => {
  const { flags, posts } = namedFixture();
  const incident = groupIncidents(flags, posts, AUTHORS, { now: NOW }).find((i) => i.name === 'Cedar Fire');
  const good = { sourceId: '101', evidenceQuote: 'No evacuations ordered.', text: 'EVACUATE NOW', url: 'https://untrusted.example', src: 'made up' };
  const intel = validateIntel({
    confirmed: [{ text: 'unsupported fact' }],
    reported: [good, good, { sourceId: '999', evidenceQuote: 'No evacuations ordered.' }, { sourceId: '101', evidenceQuote: 'evacuations ordered.' }, { sourceId: '101', evidenceQuote: 'An invented statement.' }],
    updates: [{ sourceId: '102', evidenceQuote: posts.get('102').text }],
    whatsNew: ['unsupported development']
  }, incident);
  assert.deepEqual(intel.confirmed, []);
  assert.deepEqual(intel.whatsNew, []);
  assert.equal(intel.reported.length, 1);
  assert.equal(intel.reported[0].text, 'No evacuations ordered.');
  assert.equal(intel.reported[0].url, 'https://x.com/i/web/status/101');
  assert.equal(intel.reported[0].src, `@AccountA, ${iso(3)}`);
  assert.equal(intel.updates[0].sourceId, '102');
  assert.equal(intel.rejectedItems, 3);
  assert.equal(intel.verification, 'source-statements-only');
  assert.equal(applyStatus({ ...incident, intel }).status, 'provisional');
});

test('cached intel is reused only when its source contents match; legacy model facts are discarded', () => {
  const { flags, posts } = namedFixture();
  const incident = groupIncidents(flags, posts, AUTHORS, { now: NOW }).find((i) => i.name === 'Cedar Fire');
  const intel = validateIntel({ reported: [{ sourceId: '101', evidenceQuote: 'No evacuations ordered.' }] }, incident);
  const prevById = new Map([[incident.id, { ...incident, intel }]]);
  const rebuilt = () => groupIncidents(flags, posts, AUTHORS, { now: NOW, prevById }).find((i) => i.name === 'Cedar Fire');
  assert.equal(rebuilt().intel.reported[0].sourceId, '101');
  assert.equal(rebuilt().intel.extractedAt, intel.extractedAt);
  posts.get('101').text = 'Cedar Fire in Example County. Evacuations now ordered.';
  assert.notEqual(incidentInputHash(rebuilt()), intel.inputHash);
  assert.equal(rebuilt().intel, null);
  prevById.set(incident.id, { intel: { confirmed: [{ text: 'legacy fabricated claim' }], posts: 2 } });
  assert.equal(rebuilt().intel, null);
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
