// Does the pipeline actually still work? Run as the last nightly step, after
// the commit, so a night that produced nothing turns the Actions run red
// instead of green.
//
// The failure this exists for: on 2026-09-10 the Anthropic org ran out of
// credit. Every Claude stage caught its own error and carried on — live
// tagging "skipped", story placement "continuing with cached placements" —
// so the nightly reported success while the intelligence layer was dead.
// Each check below answers one question with data already on disk; nothing
// here costs an API call.
//
//   npm run health            report and exit 1 if any check fails
//   npm run health -- --json  same, as JSON for the dashboard or a bot
import { readJSON, etDate, daysAgoEt } from './util.js';
import { loadState, archiveDates, topicsPath, loadDay, dailyBudget, estCost } from './store.js';
import { authMode as anthropicAuthMode } from './anthropic-auth.js';
import { budgetStatus as anthropicBudget } from './anthropic-usage.js';
import { authMode as xAuthMode } from './x.js';

const HOURS = 60 * 60 * 1000;

// How long capture may be silent before something is wrong. The poll cron is
// every 20 min, but GitHub's scheduler is best-effort and has skipped hours
// on this repo, so "late" and "broken" are deliberately far apart.
export const CAPTURE_WARN_HOURS = 2;
export const CAPTURE_FAIL_HOURS = 8;

export function checkCapture(state, now = Date.now()) {
  const last = state.lastPollAt ? Date.parse(state.lastPollAt) : NaN;
  if (!Number.isFinite(last)) {
    return { name: 'capture', status: 'fail', detail: 'the poller has never recorded a run (data/state.json has no lastPollAt)' };
  }
  const hours = (now - last) / HOURS;
  const ago = `${hours.toFixed(1)}h ago`;
  if (hours >= CAPTURE_FAIL_HOURS) {
    return { name: 'capture', status: 'fail', detail: `last poll ${ago} — past the ${CAPTURE_FAIL_HOURS}h limit; the X List endpoint only serves its newest ~800 posts, so a longer silence loses them` };
  }
  if (hours >= CAPTURE_WARN_HOURS) {
    return { name: 'capture', status: 'warn', detail: `last poll ${ago} — GitHub's cron is running behind the 20-minute schedule` };
  }
  return { name: 'capture', status: 'ok', detail: `last poll ${ago}` };
}

// Every archive day that has closed should have been classified. Today is
// excluded (the nightly classifies yesterday), and so is any day older than
// the window we would still act on.
export function checkClassification({ dates, hasTopics, today = etDate(), lookbackDays = 7 }) {
  const closed = dates.filter((d) => d < today).slice(-lookbackDays);
  if (!closed.length) return { name: 'classification', status: 'warn', detail: 'no closed archive day yet — nothing to classify' };
  const missing = closed.filter((d) => !hasTopics(d));
  if (!missing.length) {
    return { name: 'classification', status: 'ok', detail: `all ${closed.length} closed day(s) classified through ${closed.at(-1)}` };
  }
  const newest = closed.at(-1);
  const status = missing.includes(newest) ? 'fail' : 'warn';
  return {
    name: 'classification',
    status,
    detail: `${missing.length} of the last ${closed.length} closed day(s) unclassified: ${missing.join(', ')}${status === 'fail' ? ' — including the most recent, so the nightly classifier is not getting through' : ''}`
  };
}

// A day can have a topics file and still be empty inside — a batch that came
// back all-errors writes one. Catch that separately from a missing file.
// `ran` is whether a topics file exists for the day at all. Without it this
// check told a 7am reader "the classifier ran but most requests failed" for a
// day the classifier never started — which sends them hunting through batch
// responses for a failure that is really an upstream stage that died (no
// credit, no credential, a killed run). Same status either way; only the
// diagnosis changes, because the diagnosis is what the reader acts on.
export function checkAssignments({ date, postCount, assignmentCount, ran = true }) {
  if (!postCount) return { name: 'assignments', status: 'ok', detail: `${date}: no posts archived` };
  const share = assignmentCount / postCount;
  const pct = `${(share * 100).toFixed(0)}%`;
  if (!ran) {
    return { name: 'assignments', status: 'fail', detail: `${date}: none of ${postCount} archived post(s) carry a topic — no topics file exists, so the classifier never produced output for this day (check the classify stage, not the batch responses)` };
  }
  if (share < 0.5) {
    return { name: 'assignments', status: 'fail', detail: `${date}: only ${assignmentCount} of ${postCount} posts carry a topic (${pct}) — the classifier ran but most requests failed` };
  }
  if (share < 0.9) {
    return { name: 'assignments', status: 'warn', detail: `${date}: ${assignmentCount} of ${postCount} posts carry a topic (${pct})` };
  }
  return { name: 'assignments', status: 'ok', detail: `${date}: ${assignmentCount} of ${postCount} posts carry a topic (${pct})` };
}

export function checkCredentials({ x, anthropic }) {
  const missing = [];
  if (!x) missing.push('X (set X_BEARER_TOKEN, or X_PROXY_AUTH=1 in a cloud session)');
  if (!anthropic) missing.push('Anthropic (workload identity federation in Actions, or CLASSIFIER_ANTHROPIC_API_KEY outside it)');
  return missing.length
    ? { name: 'credentials', status: 'fail', detail: `no credential resolves for: ${missing.join('; ')}` }
    : { name: 'credentials', status: 'ok', detail: `X: ${x}, Anthropic: ${anthropic}` };
}

export function checkBudget(state, { budget = dailyBudget(), today = etDate() } = {}) {
  const u = state.usage?.[today] || { posts: 0, users: 0 };
  const used = (u.posts || 0) + (u.users || 0);
  const detail = `${used}/${budget} X reads today (~$${estCost(u).toFixed(2)})`;
  if (used >= budget) return { name: 'budget', status: 'fail', detail: `${detail} — the guard has stopped capture until tomorrow` };
  if (used >= budget * 0.85) return { name: 'budget', status: 'warn', detail };
  return { name: 'budget', status: 'ok', detail };
}

// Claude spend against the daily ceiling (data/anthropic-usage.json, priced
// by config/settings.json anthropic.pricing). Without a ceiling the line is
// informational; with one, reaching it is a fail because every Claude stage
// has stopped for the day and someone should know before the nightly.
export function checkAnthropicSpend({ spent = 0, budget = null, calls = 0, byStage = {} }) {
  const stages = Object.entries(byStage).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} $${v.toFixed(2)}`).join(', ');
  const detail = `$${spent.toFixed(2)} Claude spend today across ${calls} call(s)${budget != null ? ` of $${budget} daily budget` : ' (no daily budget set)'}${stages ? ` — ${stages}` : ''}`;
  if (budget != null && spent >= budget) return { name: 'anthropic-spend', status: 'fail', detail: `${detail} — Claude stages are stopped until tomorrow ET` };
  if (budget != null && spent >= budget * 0.85) return { name: 'anthropic-spend', status: 'warn', detail };
  return { name: 'anthropic-spend', status: 'ok', detail };
}

export function runChecks({ now = Date.now(), today = etDate() } = {}) {
  const state = loadState();
  const dates = archiveDates();
  const yesterday = daysAgoEt(1);
  const topics = readJSON(topicsPath(yesterday), null);

  return [
    checkCredentials({ x: xAuthMode(), anthropic: anthropicAuthMode() }),
    checkCapture(state, now),
    checkClassification({ dates, hasTopics: (d) => Boolean(readJSON(topicsPath(d), null)), today }),
    checkAssignments({
      date: yesterday,
      postCount: dates.includes(yesterday) ? loadDay(yesterday).length : 0,
      assignmentCount: Object.keys(topics?.assignments || {}).length,
      ran: Boolean(topics)
    }),
    checkBudget(state, { today }),
    checkAnthropicSpend(anthropicBudget({ day: today }))
  ];
}

export function worstStatus(checks) {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'ok';
}

function main() {
  const checks = runChecks();
  const overall = worstStatus(checks);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), overall, checks }, null, 2));
  } else {
    const mark = { ok: 'ok  ', warn: 'WARN', fail: 'FAIL' };
    for (const c of checks) console.log(`[health] ${mark[c.status]} ${c.name}: ${c.detail}`);
    console.log(`[health] overall: ${overall}`);
  }
  if (overall === 'fail') process.exit(1);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main();
}
