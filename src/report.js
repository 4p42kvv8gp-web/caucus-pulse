// The daily report — v1 deliverable. One markdown file per day:
//   1. Top 3 topics overall (tweet count, distinct members, engagement —
//      engagement is as-of the 24h refresh, so it lags one day by design)
//   2. Top 3 topics per caucus (Progressive, New Dems, CBC)
//   3. Top strategic-syntax phrases with adoption info
//   4. Volume + spend stat line
//   5. Emerging clusters awaiting a taxonomy decision
//   plus, right after the top topics: "Stories: what changed since
//   yesterday", read from the story dossiers' ledgers (src/dossiers.js).
import { readJSON, writeJSON, settings, daysAgoEt, p } from './util.js';
import fs from 'node:fs';
import { loadState, dailyBudget, estCost, topicsPath, syntaxPath, loadDay } from './store.js';
import { rollupsPath } from './rollup.js';
import { loadDossiers, diffDossiers } from './dossiers.js';

function fmt(n) { return n.toLocaleString('en-US'); }

const firstSentence = (s) => String(s || '').split(/(?<=[.!?])\s+/)[0];
const quoted = (list) => list.map((f) => `"${f}"`).join(', ');

// Story dossier diffs: what each tracked story did on `date` against its
// previous posting day — new members, a framing shift, press — and which
// stories went quiet. Numbers are measured; the one-line memory is Claude's
// rolling summary (regenerated only when the ledger changed).
export function renderStoryChanges(date, dossiers, n = 10) {
  const lines = [];
  if (!dossiers || !(dossiers instanceof Map ? dossiers.size : dossiers.length)) return lines;
  const { changed, quiet } = diffDossiers(dossiers, date);
  lines.push('', '## Stories: what changed since yesterday', '');
  if (!changed.length && !quiet.length) {
    lines.push('_No tracked story posted (data/dossiers)._');
    return lines;
  }
  for (const c of changed.slice(0, n)) {
    const e = c.entry, pv = c.prev;
    const delta = pv ? ` (${e.posts > pv.posts ? '↑ from' : e.posts < pv.posts ? '↓ from' : 'same as'} ${fmt(pv.posts)} on ${pv.date})` : ' (first day on record)';
    const bits = [`${fmt(e.posts)} posts, ${fmt(e.members)} members${delta}`];
    if (c.newMembers.length) bits.push(`new: ${c.newMembers.slice(0, 6).map((h) => '@' + h).join(' ')}${c.newMembers.length > 6 ? ` +${c.newMembers.length - 6}` : ''}`);
    if (e.framing.length) bits.push(`framing: ${quoted(e.framing)}${c.framingShift ? ` (was ${pv.framing.length ? quoted(pv.framing) : 'none'})` : ''}`);
    if (c.press.length) bits.push(`press: ${c.press.slice(0, 2).map((x) => `${x.outlet} — "${x.subject}"`).join('; ')}`);
    if (e.corrections.length) bits.push(`${e.corrections.length} correction(s)`);
    if (e.judgments.length) bits.push(`${e.judgments.length} judgment(s)`);
    lines.push(`- **${c.label}** _(${c.status})_ — ${bits.join(' · ')}`);
    if (c.summary) lines.push(`  - Memory: ${firstSentence(c.summary)}`);
  }
  if (changed.length > n) lines.push(`- …and ${changed.length - n} more in docs/dossiers/`);
  if (quiet.length) lines.push(`- Quiet today after posting yesterday: ${quiet.map((q) => `${q.label} (${fmt(q.last.posts)} post${q.last.posts === 1 ? '' : 's'})`).join(', ')}`);
  lines.push('', '_From data/dossiers (docs/dossiers/ for the full ledgers). Counts are measured; the memory line is a judgment._');
  return lines;
}

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

export function renderReport(date, { rollups, syntax, topics, tweets, usage, budget, dossiers = null }) {
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

  lines.push(...renderStoryChanges(date, dossiers));

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

  // Cross-day story candidates (src/stories.js) when built; else tonight's raw clusters.
  const stories = readJSON(p('data', 'stories.json'), null);
  const cands = (stories?.candidates || []).filter((c) => c.placement && c.placement.kind !== 'noise');
  if (cands.length) {
    const show = (kind, title) => {
      const list = cands.filter((c) => c.placement.kind === kind).slice(0, 8);
      if (!list.length) return;
      lines.push('', `## ${title}`, '');
      for (const c of list) {
        const where = c.placement.macro ? `${c.placement.macro}/${c.placement.key}` : `(no macro fits) ${c.placement.key}`;
        lines.push(`- **${c.placement.label}** — ${c.posts} posts, ${c.members} members over ${c.days} day(s) (${c.firstSeen} → ${c.lastSeen}). Promote: \`npm run stories -- --promote=${c.placement.key}\` → ${where}`);
      }
    };
    show('story', 'Developing stories (not yet in the taxonomy)');
    show('gap', 'Taxonomy gaps (durable subjects with no home)');
  } else {
    const emerging = topics?.emerging || [];
    if (emerging.length) {
      lines.push('', '## Emerging clusters (taxonomy decisions needed)', '');
      for (const e of emerging.sort((a, b) => b.ids.length - a.ids.length).slice(0, 8)) {
        lines.push(`- **${e.label}** — ${e.ids.length} tweet(s). Approve by adding a subtopic to config/taxonomy.yaml.`);
      }
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
    budget: dailyBudget(),
    dossiers: loadDossiers()
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
