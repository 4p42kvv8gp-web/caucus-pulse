import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/db.js';
import { languageData } from '../src/language.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2); const filters = {}; const options = {};
process.umask(0o077);
let store;
try {
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, ''); const value = args[i + 1];
    if (!args[i].startsWith('--') || value === undefined) throw new Error('Invalid language command option.');
    if (['since','until','query','memberId','topic','subtopic','type'].includes(key)) filters[key] = value;
    else if (['minWords','minMembers','limit','windowHours'].includes(key) && /^\d+$/.test(value)) options[key] = Number(value);
    else throw new Error('Invalid language command option.');
  }
  store = openStore(process.env.CAUCUS_DB_PATH ?? resolve(root, 'data/pulse.sqlite'));
  const result = languageData(store, filters, options);
  console.log(JSON.stringify({ version:result.version, window:result.window, coverage:result.coverage,
    returnedGroups:result.groups.length, note:'Local source analysis only. Full private evidence is available through /api/language; this command does not print source text or make requests.' }, null, 2));
} catch (error) {
  console.error(error.message.startsWith('Invalid ') ? error.message : 'Language analysis could not complete. Source data is retained.');
  process.exitCode = 1;
} finally { store?.close(); }
