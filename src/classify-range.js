// Classify a range of archived days in one Message Batch — the companion to
// backfill-members.js. The nightly job does one day at a time; after a
// historical backfill that would take a night per day, so this submits every
// unclassified day in [from, to] as a single batch (custom_ids carry the date)
// and writes the days chronologically so retweets inherit across days.
//
// Resumable: the in-flight batch id is stored in data/backfill-progress.json
// (gitignored), separate from state.pendingBatch so the nightly job and this
// run never trip over each other.
//
//   node --use-env-proxy src/classify-range.js [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--dry-run]
//
// Defaults: from = earliest archive date, to = yesterday (ET). Days already
// classified are skipped; today is never included (still being captured).
import fs from 'node:fs';
import { anthropicClient, refreshIdentityToken } from './anthropic-auth.js';
import { settings, daysAgoEt, p, readJSON, writeJSON } from './util.js';
import { topicsPath } from './store.js';
import { loadTaxonomy, chunkRequests, collectResults, planDay, writeDay, summarize, withCandidates, hintedCount } from './classify.js';
import { loadSemanticOrNull } from './semantic.js';
import { progressPath } from './backfill-members.js';

const arg = (name, dflt) => {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : dflt;
};

export function archiveDates() {
  const dir = p('data', 'archive');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6)).sort();
}

async function main() {
  const dates = archiveDates();
  const from = arg('from', dates[0]);
  const to = arg('to', daysAgoEt(1));
  const dryRun = process.argv.includes('--dry-run');
  const model = process.env.CLASSIFY_MODEL || settings.classify.model;
  const tax = loadTaxonomy();

  const todo = dates.filter((d) => d >= from && d <= to && d < daysAgoEt(0) && !readJSON(topicsPath(d), null));
  if (!todo.length) { console.log(`[classify-range] nothing to classify in ${from}..${to}`); return; }

  const progress = readJSON(progressPath, {});
  let pending = progress.classify;
  if (pending && (pending.from !== from || pending.to !== to)) pending = null;

  const client = await anthropicClient();
  let plans;
  let batchId;
  if (pending?.batchId) {
    batchId = pending.batchId;
    plans = todo.map((d) => planDay(d, { deferInCorpus: true, tax }));
    console.log(`[classify-range] resuming batch ${batchId} for ${todo.length} day(s)`);
  } else {
    plans = todo.map((d) => planDay(d, { deferInCorpus: true, tax }));
    // Similarity hints: posts already in the index use their stored vector,
    // the rest are embedded once here (or skipped when the model is absent).
    const semantic = loadSemanticOrNull({ warn: (m) => console.warn(`[classify-range] ${m}`) });
    for (const pl of plans) pl.toClassify = await withCandidates(pl.toClassify, semantic, { tax });
    const requests = plans.flatMap((pl) => chunkRequests(pl.toClassify, tax, model, `${pl.date}_`));
    const sent = plans.reduce((n, pl) => n + pl.toClassify.length, 0);
    const quoting = plans.reduce((n, pl) => n + pl.toClassify.filter((t) => t.quoting).length, 0);
    const hinted = plans.reduce((n, pl) => n + hintedCount(pl.toClassify), 0);
    const held = plans.reduce((n, pl) => n + Object.keys(pl.inherited).length + pl.deferred.length, 0);
    const anchored = plans.reduce((n, pl) => n + Object.keys(pl.anchored).length, 0);
    console.log(`[classify-range] ${todo.length} day(s) ${todo[0]}..${todo.at(-1)}: ${sent} tweets in ${requests.length} requests (${quoting} with quoted context, ${hinted} with similarity hints, ${held} retweets inherit, ${anchored} anchored), model ${model}`);
    if (dryRun) { for (const pl of plans) console.log(`  ${pl.date}: ${pl.tweets.length} archived, ${pl.toClassify.length} to model (${pl.toClassify.filter((t) => t.quoting).length} with quoted context, ${hintedCount(pl.toClassify)} with similarity hints), ${Object.keys(pl.inherited).length} inherit, ${pl.deferred.length} deferred, ${Object.keys(pl.anchored).length} anchored`); return; }
    if (!requests.length) { for (const pl of plans) writeDay(pl, { assignments: {}, incidents: {}, emerging: [], failedChunks: 0 }, model); return; }
    const batch = await client.messages.batches.create({ requests });
    batchId = batch.id;
    progress.classify = { batchId, from, to, submittedAt: new Date().toISOString() };
    writeJSON(progressPath, progress);
    console.log(`[classify-range] submitted batch ${batchId}`);
  }

  const started = Date.now();
  let batch;
  while (true) {
    await refreshIdentityToken();
    batch = await client.messages.batches.retrieve(batchId);
    const c = batch.request_counts || {};
    if (batch.processing_status === 'ended') break;
    console.log(`[classify-range] ${batch.processing_status}: ${c.succeeded || 0} done, ${c.processing || 0} processing, ${c.errored || 0} errored (${Math.round((Date.now() - started) / 60_000)} min)`);
    await new Promise((r) => setTimeout(r, 30_000));
  }

  const results = await collectResults(client, batchId, tax);
  const empty = { assignments: {}, incidents: {}, emerging: [], failedChunks: 0 };
  for (const pl of plans) { // chronological: writeDay re-reads prior days for deferred retweets
    const stats = writeDay(pl, results.get(`${pl.date}_`) || empty, model);
    console.log(summarize(pl.date, stats));
  }
  delete progress.classify;
  writeJSON(progressPath, progress);
  const c = batch.request_counts || {};
  console.log(`[classify-range] batch ${batchId}: ${c.succeeded || 0} succeeded, ${c.errored || 0} errored, ${c.expired || 0} expired, ${c.canceled || 0} canceled`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
