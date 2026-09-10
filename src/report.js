// The daily report — v1 deliverable. One markdown file per day:
//   1. Top 3 topics overall (tweet count, distinct members, engagement —
//      engagement is as-of the 24h refresh, so it lags one day by design)
//   2. Top 3 topics per caucus (Progressive, New Dems, CBC)
//   3. Top strategic-syntax phrases with adoption info
//   4. Volume + spend stat line
//   5. Story candidates awaiting a taxonomy decision
//   6. Stories promoted (and retired) tonight by src/stories.js, and every
//      provisional story still awaiting review with its last-7-day counts —
//      the owner prunes from here instead of approving one by one.
import { readJSON, writeJSON, settings, daysAgoEt, addDays, p } from './util.js';
import fs from 'node:fs';
import { loadState, dailyBudget, estCost, topicsPath, syntaxPath, loadDay } from './store.js';
import { rollupsPath } from './rollup.js';
import { loadTaxonomy, ymd } from './taxonomy.js';
import { storySettings } from './stories.js';

function fmt(n) { return n.toLocaleString('en-US'); }

function topTopics(rows, date, caucus, n = 3) {
  return rows
    .filter((r) => r.date === date && r.caucus === caucus && !r.sub)
    .sort((a, b) => (b.posts + b.retweets) - (a.posts + a.retweets) || b.engagement - a.engagement)
    .slice(0, n);
}

function subsUnder(rows, date, caucus, macro, n = 3) {
  return rows
    .filter((r) => r.date === date && r.caucus === caucus && r.macro === macro && r.sub)
    .sort((a, b) => (b.posts + b.retweets) - (a.posts + a.retweets))
    .slice(0, n);
}

// One subtopic's activity over the 7 days ending at `date` (caucus 'all'):
// posts and retweets summed, days with any activity, and the busiest day's
// distinct members (members cannot be summed across days from rollups).
export function weekOf(rows, date, macro, sub) {
  const from = addDays(date, -6);
  const days = rows.filter((r) => r.caucus === 'all' && r.macro === macro && r.sub === sub && r.date >= from && r.date <= date);
  return {
    posts: days.reduce((a, r) => a + r.posts, 0),
    retweets: days.reduce((a, r) => a + r.retweets, 0),
    days: days.filter((r) => r.posts + r.retweets > 0).length,
    members: days.reduce((a, r) => Math.max(a, r.members), 0)
  };
}

// Provisional (auto-promoted, unconfirmed) stories in the taxonomy, and how
// many retired entries still sit in the YAML for history.
export function provisionalStories(tax) {
  const live = [], retired = [];
  for (const [macro, m] of Object.entries(tax || {})) {
    for (const [key, sub] of Object.entries(m.subtopics || {})) {
      if (sub.retired) retired.push({ macro, key });
      else if (sub.story && sub.provisional) live.push({ macro, key, label: sub.label, since: ymd(sub.since), promoted: ymd(sub.promoted) });
    }
  }
  return { live, retired };
}

// `stories` (data/stories.json) and `tax` (config/taxonomy.yaml) are
// injectable so tests render from fixtures; main() passes the real files.
export function renderReport(date, { rollups, syntax, topics, tweets, usage, budget, stories = readJSON(p('data', 'stories.json'), null), tax = loadTaxonomy() }) {
  const rows = rollups?.rows || [];
  const labels = rollups?.labels || {};
  const label = (r) => labels[r.sub ? `${r.macro}/${r.sub}` : r.macro] || r.macro;
  const lines = [`# Caucus Pulse — ${date}`, ''];

  lines.push('## Top topics of the day', '');
  const top = topTopics(rows, date, 'all');
  if (!top.length) lines.push('_No classified tweets for this day yet._');
  for (const [i, r] of top.entries()) {
    lines.push(`${i + 1}. **${label(r)}** — ${fmt(r.posts)} posts + ${fmt(r.retweets)} RTs from ${fmt(r.members)} members, ${fmt(r.engagement)} engagement`);
    for (const s of subsUnder(rows, date, 'all', r.macro)) {
      lines.push(`   - ${label(s)}: ${fmt(s.posts)} posts, ${fmt(s.members)} members`);
    }
  }

  lines.push('', '## Per caucus', '');
  for (const [tag, name] of Object.entries(settings.caucuses)) {
    const t = topTopics(rows, date, tag);
    lines.push(`### ${name}`);
    if (!t.length) lines.push('_No activity attributed (check caucus tags in config/accounts.csv)._');
    for (const [i, r] of t.entries()) {
      lines.push(`${i + 1}. **${label(r)}** — ${fmt(r.posts)} posts + ${fmt(r.retweets)} RTs, ${fmt(r.members)} members, ${fmt(r.engagement)} engagement`);
    }
    lines.push('');
  }

  lines.push('## Strategic syntax', '');
  const phrases = (syntax?.phrases || []).slice(0, 5);
  if (!phrases.length) lines.push('_No phrases crossed the member-spread threshold._');
  for (const ph of phrases) {
    const badge = ph.isNew ? ' **[new today]**' : ` (first seen ${ph.firstSeen} by @${ph.firstAuthor})`;
    lines.push(`- "${ph.phrase}" — ${ph.members} members, ${ph.tweets} tweets${badge}`);
  }

  lines.push('', '## Volume & spend', '');
  const u = usage || { posts: 0, users: 0 };
  lines.push(`- Tweets captured: **${fmt(tweets.length)}** (${fmt(tweets.filter((t) => t.type !== 'retweet').length)} originals)`);
  lines.push(`- X reads on ${date}: ${fmt(u.posts + u.users)} / ${fmt(budget)} budget (~$${estCost(u).toFixed(2)})`);
  if (topics?.model) lines.push(`- Classifier: ${topics.model}${topics.failedChunks ? ` — ⚠ ${topics.failedChunks} failed chunk(s)` : ''}${topics.unclassified?.length ? `, ${topics.unclassified.length} unclassified` : ''}`);

  // Cross-day story candidates (src/stories.js) when built; else tonight's
  // raw clusters. Candidates already promoted into the taxonomy are not
  // repeated here — they appear under "promoted tonight" / "awaiting review".
  const cfg = storySettings();
  const promotedSet = new Set(stories?.promoted || []);
  const cands = (stories?.candidates || []).filter((c) => c.placement && c.placement.kind !== 'noise' && !promotedSet.has(`${c.placement.macro}/${c.placement.key}`));
  if (cands.length) {
    const show = (kind, title, hint) => {
      const list = cands.filter((c) => c.placement.kind === kind).slice(0, 8);
      if (!list.length) return;
      lines.push('', `## ${title}`, '');
      for (const c of list) {
        const where = c.placement.macro ? `${c.placement.macro}/${c.placement.key}` : `(no macro fits) ${c.placement.key}`;
        lines.push(`- **${c.placement.label}** — ${c.posts} posts, ${c.members} members over ${c.days} day(s) (${c.firstSeen} → ${c.lastSeen}). ${hint(c, where)}`);
      }
    };
    show('story', 'Developing stories (not yet in the taxonomy)', (c, where) => (c.placement.macro
      ? `Auto-promotes once it clears ≥${cfg.min_posts} posts, ≥${cfg.min_members} members, ≥${cfg.min_days} days; now: \`npm run stories -- --promote=${c.placement.key}\` → ${where}`
      : `No macro fits — add \`${c.placement.key}\` under a macro by hand in config/taxonomy.yaml`));
    show('gap', 'Taxonomy gaps (durable subjects with no home — never auto-promoted)', (c, where) => (c.placement.macro
      ? `Promote by hand: \`npm run stories -- --promote=${c.placement.key}\` → ${where}`
      : `No macro fits — add \`${c.placement.key}\` under a macro by hand in config/taxonomy.yaml`));
  } else {
    const emerging = topics?.emerging || [];
    if (emerging.length) {
      lines.push('', '## Emerging clusters (taxonomy decisions needed)', '');
      for (const e of emerging.sort((a, b) => b.ids.length - a.ids.length).slice(0, 8)) {
        lines.push(`- **${e.label}** — ${e.ids.length} tweet(s). Approve by adding a subtopic to config/taxonomy.yaml.`);
      }
    }
  }

  // ── Continuous promotion. The nightly for `date` runs early the next ET
  // day, so "tonight" is either date stamp.
  const night = addDays(date, 1);
  const tonight = (log, field) => (log || []).filter((e) => e[field] === date || e[field] === night);
  const promotedTonight = tonight(stories?.promotions, 'promoted');
  const retiredTonight = tonight(stories?.retirements, 'retired');
  if (promotedTonight.length || retiredTonight.length) {
    lines.push('', '## Stories promoted tonight', '');
    for (const e of promotedTonight) {
      lines.push(`- **${e.label}** → ${e.macro}/${e.key} — ${fmt(e.posts)} posts, ${fmt(e.members)} members over ${e.days} day(s), since ${e.since}${e.how === 'manual' ? ' (approved by hand)' : ' (provisional)'}`);
    }
    if (promotedTonight.length) lines.push('', '_The classifier sees these from its next run. Keep one by deleting `provisional: true`; drop one by removing its entry or setting `retired: true` in config/taxonomy.yaml._');
    if (retiredTonight.length) {
      lines.push('', `### Retired tonight (no assignments for ${retiredTonight[0].quietDays} days)`, '');
      for (const e of retiredTonight) lines.push(`- **${e.label}** (${e.macro}/${e.key}, since ${e.since}) — out of the classifier prompt; key kept for history`);
    }
  }

  const { live, retired } = provisionalStories(tax);
  if (live.length) {
    lines.push('', '## Provisional stories awaiting review', '');
    lines.push(`_${live.length} auto-promoted stor${live.length === 1 ? 'y' : 'ies'} in config/taxonomy.yaml with the last 7 days of assignments. Prune here: remove an entry or set \`retired: true\`; delete \`provisional: true\` to confirm one. Quiet ones retire on their own after ${cfg.retire_after_quiet_days} days._`, '');
    const withWeek = live.map((s) => ({ ...s, week: weekOf(rows, date, s.macro, s.key) }))
      .sort((a, b) => (b.week.posts + b.week.retweets) - (a.week.posts + a.week.retweets) || (a.key < b.key ? -1 : 1));
    for (const s of withWeek) {
      const w = s.week;
      const when = `since ${s.since || '?'}${s.promoted ? `, promoted ${s.promoted}` : ''}`;
      const activity = w.posts + w.retweets
        ? `${fmt(w.posts)} posts + ${fmt(w.retweets)} RTs on ${w.days} of the last 7 days, up to ${fmt(w.members)} members/day`
        : 'no assignments in the last 7 days';
      lines.push(`- **${s.label}** (${s.macro}/${s.key}, ${when}) — ${activity}`);
    }
    if (retired.length) lines.push('', `_${retired.length} retired entr${retired.length === 1 ? 'y' : 'ies'} remain in the YAML for history (${retired.map((r) => `${r.macro}/${r.key}`).join(', ')}); delete them whenever convenient._`);
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const dateArg = process.argv.find((a) => a.startsWith('--date='));
  const date = dateArg ? dateArg.split('=')[1] : daysAgoEt(1);
  const state = loadState();
  const md = renderReport(date, {
    rollups: readJSON(rollupsPath, null),
    syntax: readJSON(syntaxPath(date), null),
    topics: readJSON(topicsPath(date), null),
    tweets: loadDay(date),
    usage: state.usage[date],
    budget: dailyBudget(),
    stories: readJSON(p('data', 'stories.json'), null),
    tax: loadTaxonomy()
  });
  const out = p('reports', `${date}.md`);
  fs.mkdirSync(p('reports'), { recursive: true });
  fs.writeFileSync(out, md);
  fs.writeFileSync(p('reports', 'latest.md'), md);
  // Trim usage ledger so state.json doesn't grow forever (rollups keep history).
  for (const day of Object.keys(state.usage)) {
    if (day < daysAgoEt(90)) delete state.usage[day];
  }
  writeJSON(p('data', 'state.json'), state);
  console.log(`[report] wrote reports/${date}.md`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
