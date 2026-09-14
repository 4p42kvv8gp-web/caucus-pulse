// Range and nightly classification use the same durable queue. An existing
// batch is always drained before another range/date can submit paid work.
import { daysAgoEt, readJSON, writeJSON } from './util.js';
import { archiveDates } from './store.js';
import { runClassification, planDay } from './classify.js';
import { progressPath } from './backfill-members.js';

export { archiveDates } from './store.js';
const arg = (name, dflt) => process.argv.find((s) => s.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt;

async function main() {
  const available = archiveDates();
  const from = arg('from', available[0]);
  const to = arg('to', daysAgoEt(1));
  const dates = available.filter((d) => d >= from && d <= to && d < daysAgoEt(0));
  const old = readJSON(progressPath, {}).classify;
  const result = await runClassification({
    dates, source: 'range',
    sync: process.argv.includes('--sync'), dryRun: process.argv.includes('--dry-run'),
    plan: (date, tax) => planDay(date, { deferInCorpus: true, tax }),
    legacy: old?.batchId ? { batchId: old.batchId, dates: available.filter((d) => d >= old.from && d <= old.to), prefixDates: true } : null,
    onLegacyComplete: (id) => {
      const progress = readJSON(progressPath, {});
      if (progress.classify?.batchId === id) { delete progress.classify; writeJSON(progressPath, progress); }
    }
  });
  console.log(`[classify-range] ${result.status}${result.batchId ? ` batch=${result.batchId}` : ''}; dates=${result.dates.join(', ') || 'none'}`);
}
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
