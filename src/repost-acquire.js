// Runs only after capture publication inside poll's serialized Actions job.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { p, etDate, addDays, writeJSON } from './util.js';
import { loadDay, loadState, saveState, remainingReads } from './store.js';
import { saveQuoted, quotedPath, archiveLookup } from './quoted.js';
import { lookupTweets, isConfigured } from './x.js';
import { selectRepostReferences } from './repost-acquisition-contract.js';
import { runRepostAcquisition, validateAcquisitionState } from './repost-acquisition-runner.js';

export const acquisitionPath = p('data', 'repost-acquisition.json');
function strictJSON(file, fallback) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid acquisition store: ${path.basename(file)}`);
  return value;
}

export async function repostAcquireMain(args = process.argv.slice(2)) {
  if (args.some((arg) => arg !== '--plan')) throw new Error('Supported argument: --plan');
  const planning = args.includes('--plan');
  if (!planning && process.env.GITHUB_ACTIONS !== 'true') throw new Error('Execute in the serialized poll Actions job; --plan is read-only');
  const state = strictJSON(acquisitionPath, { version: 1, receipts: {} });
  const attemptedIds = validateAcquisitionState(state);
  const usage = loadState();
  for (const key of Object.keys(usage.repostAcquisitionUsage || {})) {
    if (!Object.hasOwn(state.receipts, key)) throw new Error('Acquisition ledger is missing an accounted receipt; refusing to reset attempts');
  }
  const now = new Date();
  const day = etDate(now);
  const posts = [...loadDay(addDays(day, -1)), ...loadDay(day)];
  const archive = archiveLookup();
  const loadQuoted = () => strictJSON(quotedPath, {});
  if (planning) {
    const todo = selectRepostReferences(posts, { quoted: loadQuoted(), archive, attemptedIds, now: now.getTime(), limit: 25 });
    console.log(`[repost-acquire] plan: ${todo.length} distinct missing recent originals; no requests`);
    return { ids: todo.map((row) => row.id) };
  }
  const result = await runRepostAcquisition(posts, { state, loadQuoted, saveQuoted,
    loadUsage: loadState, saveUsage: saveState, save: (value) => writeJSON(acquisitionPath, value),
    checkpoint: async () => execFileSync('bash', ['.github/scripts/commit-data.sh',
      'sources: durable repost acquisition checkpoint', 'data/repost-acquisition.json', 'data/quoted.json', 'data/state.json'],
    { cwd: p(), stdio: 'inherit' }),
    beforeLookup: async () => {
      if (!isConfigured()) throw new Error('X acquisition credentials are unavailable');
    }, lookup: lookupTweets, archive, remainingReads, usageDay: etDate, runId: process.env.GITHUB_RUN_ID || 'actions' });
  console.log(`[repost-acquire] ${result.calls} lookup; ${result.requested} requested; ${result.fetched} recovered; ${result.localRecovered} reused from captured originals; ${result.unavailable} explicitly unavailable; ${result.unresolved} unresolved; ${result.replayed} saved responses replayed; ${result.uncertain} new uncertain submissions; ${result.rateLimited} rate-limited; ${result.outstanding} originals awaiting review`);
  if (result.deferredUntil) console.log(`[repost-acquire] endpoint cooldown until ${result.deferredUntil}`);
  if (result.uncertain || result.unresolved) throw new Error('New source acquisition gaps require review; automatic resubmission disabled');
  if (result.rateLimited) throw new Error('Source acquisition was rate-limited; a later bounded attempt may run after the recorded reset');
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  repostAcquireMain().catch((error) => { console.error(`[repost-acquire] ${error.message}`); process.exitCode = 1; });
}
