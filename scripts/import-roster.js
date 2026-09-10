import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/db.js';
import { importRoster } from '../src/roster.js';

const input = process.argv[2];
if (!input) throw new Error('Provide the path to the fetched House roster JSON.');
const root = fileURLToPath(new URL('../', import.meta.url));
process.umask(0o077);
const store = openStore(process.env.CAUCUS_DB_PATH ?? resolve(root, 'data/pulse.sqlite'));
try { console.log(JSON.stringify(importRoster(store.db, JSON.parse(readFileSync(resolve(input), 'utf8'))))); }
finally { store.close(); }
