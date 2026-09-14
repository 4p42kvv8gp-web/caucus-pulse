import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReport, weekOf, provisionalStories } from '../src/report.js';

const row = (date, macro, sub, posts, members = 1, retweets = 0) => ({ date, macro, sub, caucus: 'all', posts, retweets, members, engagement: 0 });
const base = { syntax: null, topics: null, tweets: [], usage: null, budget: 1000 };

test('weekOf sums a subtopic over the 7 days ending at the date (busiest day for members)', () => {
  const rows = [
    row('2026-09-02', 'democracy', 'lake-america', 9, 9),      // outside the window
    row('2026-09-03', 'democracy', 'lake-america', 2, 2, 1),
    row('2026-09-09', 'democracy', 'lake-america', 3, 3),
    { ...row('2026-09-09', 'democracy', 'lake-america', 5, 5), caucus: 'cpc' }, // other caucus rows never count
    row('2026-09-09', 'democracy', null, 40, 30)
  ];
  assert.deepEqual(weekOf(rows, '2026-09-09', 'democracy', 'lake-america'), { posts: 5, retweets: 1, days: 2, members: 3 });
  assert.deepEqual(weekOf(rows, '2026-09-09', 'democracy', 'nothing'), { posts: 0, retweets: 0, days: 0, members: 0 });
});

test('provisionalStories lists live provisional stories and counts retired entries', () => {
  const tax = { d: { label: 'D', subtopics: { a: { label: 'A', story: true, provisional: true, since: new Date('2026-09-01T00:00:00Z') }, b: { label: 'B', story: true }, c: { label: 'C', story: true, provisional: true, retired: true } } } };
  assert.deepEqual(provisionalStories(tax), { live: [{ macro: 'd', key: 'a', label: 'A', since: '2026-09-01', promoted: null }], retired: [{ macro: 'd', key: 'c' }] });
});

test('report shows stories promoted/retired tonight and the provisional stories awaiting review; promoted candidates leave the candidate list', () => {
  const date = '2026-09-09';
  const stories = {
    promoted: ['democracy/epstein-files'],
    promotions: [
      { macro: 'democracy', key: 'epstein-files', label: 'Epstein files', posts: 12, members: 6, days: 4, since: '2026-08-31', promoted: '2026-09-10', how: 'auto' },
      { macro: 'democracy', key: 'older', label: 'Older', posts: 5, members: 3, days: 2, since: '2026-08-01', promoted: '2026-09-01', how: 'auto' }
    ],
    retirements: [{ macro: 'tech', key: 'seaglider', label: 'Seaglider', since: '2026-08-10', quietDays: 21, retired: '2026-09-10' }],
    candidates: [
      { key: 'epstein', posts: 12, members: 6, days: 4, firstSeen: '2026-08-31', lastSeen: '2026-09-08', placement: { kind: 'story', macro: 'democracy', key: 'epstein-files', label: 'Epstein files' } },
      { key: 'lake', posts: 3, members: 2, days: 1, firstSeen: '2026-09-08', lastSeen: '2026-09-08', placement: { kind: 'story', macro: 'democracy', key: 'lake-america', label: 'Lake America' } },
      { key: 'farm', posts: 30, members: 12, days: 9, firstSeen: '2026-08-20', lastSeen: '2026-09-08', placement: { kind: 'gap', macro: 'economy', key: 'agriculture', label: 'Agriculture' } }
    ]
  };
  const tax = {
    democracy: { label: 'Democracy', subtopics: {
      'epstein-files': { label: 'Epstein files', story: true, since: '2026-08-31', provisional: true, promoted: '2026-09-10' },
      'lake-ontario': { label: 'Lake Ontario', story: true, since: new Date('2026-08-25T00:00:00Z'), provisional: true, promoted: '2026-08-30' },
      confirmed: { label: 'Confirmed', story: true, since: '2026-08-01' }
    } },
    tech: { label: 'Tech', subtopics: { seaglider: { label: 'Seaglider', story: true, since: '2026-08-10', provisional: true, retired: true } } }
  };
  const rollups = { labels: {}, rows: [row('2026-09-08', 'democracy', 'lake-ontario', 4, 3, 2), row('2026-09-09', 'democracy', 'lake-ontario', 2, 2)] };
  const md = renderReport(date, { ...base, rollups, stories, tax });

  assert.match(md, /## Stories promoted tonight\n\n- \*\*Epstein files\*\* → democracy\/epstein-files — 12 posts, 6 members over 4 day\(s\), since 2026-08-31 \(provisional\)/);
  assert.ok(!md.includes('**Older**'));
  assert.match(md, /### Retired tonight \(no assignments for 21 days\)\n\n- \*\*Seaglider\*\* \(tech\/seaglider, since 2026-08-10\)/);
  assert.match(md, /## Provisional stories awaiting review\n\n_2 auto-promoted stories/);
  assert.match(md, /- \*\*Lake Ontario\*\* \(democracy\/lake-ontario, since 2026-08-25, promoted 2026-08-30\) — 6 posts \+ 2 RTs on 2 of the last 7 days, up to 3 members\/day/);
  assert.match(md, /- \*\*Epstein files\*\* \(democracy\/epstein-files, since 2026-08-31, promoted 2026-09-10\) — no assignments in the last 7 days/);
  assert.ok(md.indexOf('**Lake Ontario**') < md.indexOf('**Epstein files** (democracy'), 'busiest provisional story first');
  assert.ok(!md.includes('**Confirmed**'));
  assert.match(md, /_1 retired entry remain.*tech\/seaglider/);
  // candidates: the promoted one is gone, the small story shows the auto-promote hint, the gap says a human decides
  assert.match(md, /## Developing stories \(not yet in the taxonomy\)\n\n- \*\*Lake America\*\* — 3 posts, 2 members over 1 day\(s\).*Auto-promotes once it clears/);
  assert.ok(!/Developing stories[\s\S]*\*\*Epstein files\*\* — 12 posts/.test(md));
  assert.match(md, /## Taxonomy gaps \(durable subjects with no home — never auto-promoted\)\n\n- \*\*Agriculture\*\*.*Promote by hand/);
});

test('report without promotions, provisional stories or candidates has none of the story sections', () => {
  const md = renderReport('2026-09-09', { ...base, rollups: null, stories: null, tax: { d: { label: 'D', subtopics: { x: { label: 'X', story: true } } } } });
  assert.ok(!md.includes('promoted tonight'));
  assert.ok(!md.includes('awaiting review'));
  assert.ok(!md.includes('Developing stories'));
});

test('report links archived evidence across topics, phrases and stories without inventing IDs', async () => {
  const { reportEvidence, reportHandle } = await import('../src/report.js');
  const date='2026-09-13';
  const sourceTweets=[
    {id:'2099000000000000001',authorId:'u1',date,createdAt:'2026-09-13T12:00:00Z',type:'tweet',text:'Liam Ramos at Dilley: read [the record](javascript:bad).'},
    {id:'2098000000000000001',authorId:'u1',date:'2026-09-12',createdAt:'2026-09-12T12:00:00Z',type:'tweet',text:'Liam Ramos needs answers.'}
  ];
  const authorsById={u1:{handle:'RepOne',member:'Member One',caucuses:['progressive']}};
  const stories={candidates:[{ids:[sourceTweets[0].id,'2099999999999999999','invented'],posts:3,members:2,days:1,firstSeen:date,lastSeen:date,placement:{kind:'story',macro:'immigration',key:'liam',label:'Liam Ramos'}}]};
  const md=renderReport(date,{...base,learned:null,tax:{},stories,sourceTweets,authorsById,tweets:[sourceTweets[0]],
    topics:{assignments:{[sourceTweets[0].id]:[['immigration','liam']]}},
    syntax:{phrases:[{phrase:'Liam Ramos',firstSeen:'2026-09-12',firstAuthor:'RepOne',members:1,tweets:1,isNew:false}]},
    rollups:{labels:{immigration:'Immigration','immigration/liam':'Liam Ramos'},rows:[row(date,'immigration',null,1),row(date,'immigration','liam',1)]}});
  assert.match(md,/\["Liam Ramos"\]\(https:\/\/x\.com\/i\/web\/status\/2099000000000000001\)/);
  assert.match(md,/first seen 2026-09-12 by \[@RepOne\]\(https:\/\/x\.com\/i\/web\/status\/2098000000000000001\)/);
  assert.match(md,/Source posts \(up to 3 archived examples\): \[@RepOne\]\(https:\/\/x\.com\/i\/web\/status\/2099000000000000001\)/);
  assert.ok(!md.includes('status/2099999999999999999'));
  assert.ok(!md.includes('status/invented'));
  assert.ok(md.includes('\\[the record\\]\\(javascript:bad\\)'));
  assert.equal(reportEvidence(['2099999999999999999'],{sourceTweets}).length,0);
  assert.equal(reportHandle('RepOne'), '[@RepOne](https://x.com/RepOne)');
  assert.equal(reportEvidence([sourceTweets[0].id],{sourceTweets:[...sourceTweets,sourceTweets[0]],authorsById}).length,1);
});
