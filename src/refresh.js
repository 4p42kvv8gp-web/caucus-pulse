// 24-hour engagement refresh — the only deliberate re-read in the system.
// Metrics at capture time are near zero; one batched lookup per original
// tweet at ~24h old gives the daily report real engagement numbers for
// exactly one extra post read each ($0.005). Retweets are skipped: their
// engagement lives on the original. Optional +72h second pass (off by
// default, settings.refresh.second_pass_72h) sharpens weekly reporting.
import * as x from './x.js';
import { settings, daysAgoEt, readJSON, writeJSON } from './util.js';
import {
  loadState, saveState, addUsage, budgetExhausted, dailyBudget,
  loadDay, metricsPath
} from './store.js';

const REFRESHABLE = new Set(['tweet', 'quote', 'reply']);

// Which archive dates are due which pass right now.
export function duePasses() {
  const passes = [{ date: daysAgoEt(1), pass: '24h' }];
  if (settings.refresh.second_pass_72h) passes.push({ date: daysAgoEt(3), pass: '72h' });
  return passes;
}

async function refreshDate(state, date, pass) {
  const tweets = loadDay(date).filter((t) => REFRESHABLE.has(t.type));
  if (!tweets.length) return;
  const file = metricsPath(date);
  const existing = readJSON(file, {});
  const due = tweets.filter((t) => pass === '72h' ? !existing[t.id]?.pass72 : !existing[t.id]);
  if (!due.length) { console.log(`[refresh] ${date}: nothing due for ${pass} pass`); return; }

  let refreshed = 0;
  for (let i = 0; i < due.length; i += 100) {
    if (budgetExhausted(state)) {
      console.warn(`[refresh] budget reached (${dailyBudget()}) — ${due.length - i} tweets deferred to next run`);
      break;
    }
    const batch = due.slice(i, i + 100);
    const { metricsById, usage, rateLimited } = await x.lookupTweets(batch.map((t) => t.id));
    if (rateLimited) { console.warn('[refresh] rate limited — deferring the rest'); break; }
    addUsage(state, { posts: usage });
    for (const t of batch) {
      const m = metricsById.get(t.id);
      // Not returned = deleted/protected since capture; record that so we
      // don't re-bill a lookup for it on every future run.
      existing[t.id] = m
        ? { ...m, refreshedAt: new Date().toISOString(), ...(pass === '72h' ? { pass72: true } : {}) }
        : { unavailable: true, refreshedAt: new Date().toISOString(), ...(pass === '72h' ? { pass72: true } : {}) };
      if (m) refreshed++;
    }
    saveState(state);
  }
  writeJSON(file, existing);
  console.log(`[refresh] ${date} (${pass}): refreshed ${refreshed}/${due.length} originals`);
}

async function main() {
  if (!x.isConfigured()) throw new Error('X auth not configured: set X_BEARER_TOKEN, or X_PROXY_AUTH=1 where the egress proxy injects the credential');
  const state = loadState();
  for (const { date, pass } of duePasses()) {
    await refreshDate(state, date, pass);
  }
  saveState(state);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
