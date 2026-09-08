import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openStore } from '../src/db.js';
import { createXClient } from '../src/x-client.js';
import { createCredentialStore } from '../src/credentials.js';
import { passPlan, runWorkerPass, restartPass } from '../src/worker.js';

const root = fileURLToPath(new URL('../', import.meta.url));
process.umask(0o077);
let store;
try {
  const { values } = parseArgs({ options: { mode: { type: 'string' }, execute: { type: 'boolean', default: false },
    trial: { type: 'boolean', default: false }, 'page-size': { type: 'string' }, 'max-pages': { type: 'string' },
    'field-dialect': { type: 'string' }, restart: { type: 'boolean', default: false } } });
  const settings = JSON.parse(readFileSync(resolve(root, 'config/settings.json'), 'utf8'));
  const options = { mode: values.mode, trial: values.trial, fieldDialect: values['field-dialect'],
    pageSize: values['page-size'] === undefined ? undefined : Number(values['page-size']),
    maxPages: values['max-pages'] === undefined ? undefined : Number(values['max-pages']) };
  const plan = passPlan(settings, options); // Reject invalid commands before opening storage or credentials.
  store = openStore(process.env.CAUCUS_DB_PATH ?? resolve(root, 'data/pulse.sqlite'));
  if (values.restart) {
    if (values.execute) throw new Error('Invalid command: restart is local-only; inspect it before a separate execution.');
    console.log(JSON.stringify(restartPass(store, settings, plan.mode), null, 2));
  } else {
    const client = values.execute ? createXClient({ token: createCredentialStore(resolve(root, 'data/secrets')).load(), fieldDialect: plan.fieldDialect ?? 'tweet' }) : null;
    console.log(JSON.stringify(await runWorkerPass({ store, settings, options, client, execute: values.execute }), null, 2));
  }
} catch (error) {
  console.error(/^(Invalid |Live collection is disabled|Fresh inventory|Configure the product)/.test(error.message)
    ? error.message : 'The bounded worker could not complete. Saved source data and conservative request accounting are retained. Check private access and local operation status.');
  process.exitCode = 1;
} finally { store?.close(); }
