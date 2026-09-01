// Weekly author-table refresh. User objects bill $0.01 each, so authors are
// resolved once a week here (batched 100/request) instead of via expansions
// on every timeline pull — that single choice halves the per-tweet cost.
import * as x from './x.js';
import { p, readJSON, writeJSON, loadAccounts } from './util.js';
import { loadState, saveState, addUsage, estCost } from './store.js';

export const authorsPath = p('data', 'authors.json');

export function loadAuthors() {
  return readJSON(authorsPath, { byId: {}, fetchedAt: null });
}

async function main() {
  if (!x.isConfigured()) throw new Error('X_BEARER_TOKEN is not set');
  const accounts = loadAccounts();
  const byHandle = new Map(accounts.map((a) => [a.handle.toLowerCase(), a]));

  const { users, usage } = await x.lookupUsersByHandles(accounts.map((a) => a.handle));
  const state = loadState();
  addUsage(state, { users: usage });
  saveState(state);

  const prev = loadAuthors().byId;
  const byId = {};
  for (const u of users) {
    const meta = byHandle.get(u.username.toLowerCase()) || {};
    byId[u.id] = {
      handle: u.username,
      name: u.name,
      member: meta.member || u.name,
      accountType: meta.accountType || '',
      caucuses: meta.caucuses || [],
      stateDistrict: meta.stateDistrict || '',
      followers: u.public_metrics?.followers_count ?? 0,
      verifiedType: u.verified_type || (u.verified ? 'legacy' : '')
    };
  }
  // Keep authors that dropped out of the fetch (suspended, renamed) so old
  // archive rows still resolve; mark them stale instead of deleting.
  for (const [id, a] of Object.entries(prev)) {
    if (!byId[id]) byId[id] = { ...a, stale: true };
  }

  const missing = accounts.filter((a) => !users.some((u) => u.username.toLowerCase() === a.handle.toLowerCase()));
  for (const m of missing) console.warn(`[authors] not found on X: @${m.handle} (typo? suspended? renamed?)`);

  writeJSON(authorsPath, { byId, fetchedAt: new Date().toISOString() });
  console.log(`[authors] refreshed ${users.length}/${accounts.length} accounts (~$${estCost({ users: usage }).toFixed(2)}); ${missing.length} unresolved`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
