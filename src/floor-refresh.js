// Two bounded public requests; no X or model credentials are required.
import { refreshFloor } from './floor-context.js';

const dryRun = process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run');
if (process.env.DRY_RUN && !['true', 'false'].includes(process.env.DRY_RUN)) throw new Error('DRY_RUN must be true or false');
const result = await refreshFloor({ dryRun });
console.log(JSON.stringify({ source: 'House weekly floor agenda', ok: result.status.ok,
  weekStart: result.weekStart, items: result.items.length, current: result.current,
  lastAttemptAt: result.status.lastAttemptAt, lastSuccessAt: result.status.lastSuccessAt,
  error: result.status.error, dryRun }));
if (!result.status.ok) process.exitCode = 1;
