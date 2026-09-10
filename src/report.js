// The daily report — v1 deliverable. One markdown file per day:
//   1. Top 3 topics overall (tweet count, distinct members, engagement —
//      engagement is as-of the 24h refresh, so it lags one day by design)
//   2. Top 3 topics per caucus (Progressive, New Dems, CBC)
//   3. Top strategic-syntax phrases with adoption info
//   4. Volume + spend stat line
//   5. Emerging clusters awaiting a taxonomy decision
import { readJSON, writeJSON, settings, daysAgoEt, p } from './util.js';
import fs from 'node:fs';
import { loadState, dailyBudget, estCost, topicsPath, syntaxPath, loadDay } from './store.js';
import { rollupsPath } from './rollup.js';

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

export function renderReport(date, { rollups, syntax, topics, tweets, usage, budget }) {
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

  const emerging = topics?.emerging || [];
  if (emerging.length) {
    lines.push('', '## Emerging clusters (taxonomy decisions needed)', '');
    for (const e of emerging.sort((a, b) => b.ids.length - a.ids.length).slice(0, 8)) {
      lines.push(`- **${e.label}** — ${e.ids.length} tweet(s). Approve by adding a subtopic to config/taxonomy.yaml.`);
    }
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
    budget: dailyBudget()
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
