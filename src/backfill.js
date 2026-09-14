// Manual List backfill. Checkpoint every archived page and resume the saved
// token across bounded runs. This job never advances the normal poll cursor.
import * as x from './x.js';
import { listId, collectListPages } from './poll.js';
import { loadState, saveState } from './store.js';

export async function backfill({
  maxPages = Number(process.env.X_BACKFILL_PAGES || 30), state = loadState(),
  restartPagination = process.argv.includes('--restart-pagination'),
  configured = x.isConfigured(), id = listId(), ...deps
} = {}) {
  if (!configured) throw new Error('X auth not configured');
  if (!id) throw new Error('No X List id configured');
  const result = await collectListPages(state, {
    id, maxPages, progressKey: 'listBackfillProgress', baseSinceId: null,
    advanceCursor: false, includeReferences: false, restartPagination,
    persist: saveState, ...deps
  });
  console.log(`[backfill] ${result.pages} page(s), ${result.records.length} new post(s); ${result.complete ? 'returned List window complete' : `unfinished: ${result.reason}`}`);
  return {
    pages: result.pages, reads: result.postsRead + result.usersRead,
    captured: result.records.length, dates: result.dates,
    complete: result.complete, reason: result.reason
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  backfill().then((r) => { if (!r.complete) process.exitCode = 2; }).catch((e) => { console.error(e); process.exitCode = 1; });
}
