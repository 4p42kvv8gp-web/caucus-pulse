import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/db.js';
import { createBudget } from '../src/budget.js';
import { collectionState } from '../src/collect.js';
import { createXClient } from '../src/x-client.js';
import { createCredentialStore } from '../src/credentials.js';
import { inventoryState } from '../src/list-inventory.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const settings = JSON.parse(readFileSync(resolve(root, 'config/settings.json'), 'utf8'));
process.umask(0o077);
const store = openStore(process.env.CAUCUS_DB_PATH ?? resolve(root, 'data/pulse.sqlite'));
try {
  const budget = createBudget(store.db, settings.budget);
  const credentials = createCredentialStore(resolve(root, 'data/secrets'));
  if (process.argv.includes('--refresh-balance')) {
    const client = createXClient({ token: credentials.load() });
    const readStartedAt = new Date().toISOString();
    const observation = await client.creditBalance();
    budget.recordBalance({ ...observation, readStartedAt });
  }
  console.log(JSON.stringify({ connection: credentials.status(), inventory: inventoryState(store.db, settings.listId),
    collectionEnabled: settings.collectionEnabled, budget: budget.state(), sources: collectionState(store.db),
    note: 'Status makes no network request unless --refresh-balance is explicitly supplied. This command never collects posts.' }, null, 2));
} catch {
  console.error('The collection status check could not complete. Check private credential configuration and API access. No posts were requested.');
  process.exitCode = 1;
} finally { store.close(); }
