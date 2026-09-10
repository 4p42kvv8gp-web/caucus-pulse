// Weekly author-table refresh. User objects bill $0.01 each, so authors are
// resolved once a week here instead of via expansions on every timeline
// pull — that single choice halves the per-tweet cost.
//
// Source of truth is the X List itself (/2/lists/:id/members): whoever is on
// it is whose posts we capture, so that is the roster. config/accounts.csv is
// the overlay that adds what X doesn't know — member name, official/personal,
// caucus tags, district — matched by handle. Rows in the CSV that aren't on
// the List are still resolved (one users/by lookup) so a handle typo shows up
// as a warning rather than silently dropping a member from the caucus views.
import * as x from './x.js';
import { p, readJSON, writeJSON, loadAccounts, settings } from './util.js';
import { loadState, saveState, addUsage, estCost } from './store.js';

export const authorsPath = p('data', 'authors.json');

export function loadAuthors() {
  return readJSON(authorsPath, { byId: {}, fetchedAt: null });
}

function listId() {
  return process.env.X_LIST_ID || settings.list_id;
}

export function mergeAuthors({ users, accounts, prev = {} }) {
  const byHandle = new Map(accounts.map((a) => [a.handle.toLowerCase(), a]));
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
      status: meta.status || 'house',
      followers: u.public_metrics?.followers_count ?? 0,
      verifiedType: u.verified_type || (u.verified ? 'legacy' : ''),
      onList: u.onList !== false
    };
  }
  // Keep authors that dropped out of the fetch (suspended, renamed, removed
  // from the List) so old archive rows still resolve; mark them stale.
  for (const [id, a] of Object.entries(prev)) {
    if (!byId[id]) byId[id] = { ...a, stale: true };
  }
  const seen = new Set(users.map((u) => u.username.toLowerCase()));
  const untagged = users.filter((u) => !byHandle.has(u.username.toLowerCase()));
  const missing = accounts.filter((a) => !seen.has(a.handle.toLowerCase()));
  return { byId, untagged, missing };
}

// Only sitting House members count toward the numbers. Senators, former
// members and stray non-member accounts stay on the List (their posts are
// still captured and archived) but leave every stat, topic, phrase and
// feed. An author the table doesn't know counts as House: the List is a
// House Democrats list, so that is the safe default — and so are author
// tables written before the status column existed.
export function isHouse(author) {
  return (author?.status || 'house') === 'house';
}

export function splitByRoster(posts, authorsById) {
  const house = [], excluded = [];
  for (const t of posts) (isHouse(authorsById[t.authorId]) ? house : excluded).push(t);
  return { house, excluded };
}

// `npm run authors -- --overlay`: re-apply config/accounts.csv to the saved
// author table without touching X (free). Use after editing caucus tags;
// the weekly refresh still re-reads the List for membership changes.
function overlayOnly() {
  const accounts = loadAccounts();
  const prev = loadAuthors();
  const users = Object.entries(prev.byId).map(([id, a]) => ({
    id, username: a.handle, name: a.name, onList: a.onList !== false && !a.stale,
    public_metrics: { followers_count: a.followers }, verified_type: a.verifiedType
  }));
  const { byId, untagged, missing } = mergeAuthors({ users, accounts, prev: {} });
  for (const [id, a] of Object.entries(prev.byId)) if (a.stale) byId[id] = { ...byId[id], stale: true };
  writeJSON(authorsPath, { ...prev, byId, overlayAt: new Date().toISOString() });
  const nonHouse = Object.values(byId).filter((a) => !isHouse(a)).length;
  console.log(`[authors] overlay applied to ${users.length} saved authors: ${Object.values(byId).filter((a) => a.caucuses.length).length} tagged, ${untagged.length} untagged, ${nonHouse} non-House (senate/former/org), ${missing.length} CSV handle(s) not in the saved table`);
}

async function main() {
  if (process.argv.includes('--overlay')) return overlayOnly();
  if (!x.isConfigured()) throw new Error('X auth not configured: set X_BEARER_TOKEN, or X_PROXY_AUTH=1 where the egress proxy injects the credential');
  const accounts = loadAccounts();
  const state = loadState();

  let users = [];
  let usage = 0;
  if (listId()) {
    const r = await x.listMembers(listId());
    if (r.rateLimited) console.warn('[authors] rate limited while paging list members — partial roster this run');
    users = r.users;
    usage += r.usage;
    console.log(`[authors] list ${listId()}: ${users.length} member account(s)`);
  }

  // CSV handles the List doesn't carry: resolve them anyway so the caucus
  // overlay still applies (and typos surface as "not found").
  const onList = new Set(users.map((u) => u.username.toLowerCase()));
  const extra = accounts.map((a) => a.handle).filter((h) => !onList.has(h.toLowerCase()));
  if (extra.length) {
    const r = await x.lookupUsersByHandles(extra);
    users.push(...r.users.map((u) => ({ ...u, onList: false })));
    usage += r.usage;
    for (const u of r.users) console.warn(`[authors] @${u.username} is in accounts.csv but not on the List — its posts are not captured`);
  }
  addUsage(state, { users: usage });
  saveState(state);

  const { byId, untagged, missing } = mergeAuthors({ users, accounts, prev: loadAuthors().byId });
  for (const m of missing) console.warn(`[authors] not found on X: @${m.handle} (typo? suspended? renamed?)`);
  if (untagged.length) {
    console.warn(`[authors] ${untagged.length} List member(s) have no accounts.csv row (no caucus tags): ${untagged.slice(0, 12).map((u) => '@' + u.username).join(' ')}${untagged.length > 12 ? ' …' : ''}`);
  }

  writeJSON(authorsPath, { byId, fetchedAt: new Date().toISOString(), listId: listId() || null });
  console.log(`[authors] ${Object.keys(byId).length} authors (${users.length} live, ~$${estCost({ users: usage }).toFixed(2)}); ${untagged.length} untagged, ${missing.length} unresolved`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
