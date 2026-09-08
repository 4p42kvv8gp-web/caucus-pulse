import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {openStore} from '../src/db.js';
import {createBudget} from '../src/budget.js';
import {createCredentialStore} from '../src/credentials.js';
import {createXClient} from '../src/x-client.js';
import {checkXAccess} from '../src/x-access-check.js';
import {writePrivateJson} from '../src/private-files.js';

const root=fileURLToPath(new URL('../',import.meta.url));
process.umask(0o077);
let store;
try {
  const {values}=parseArgs({options:{execute:{type:'boolean',default:false}}});
  if(!values.execute) {
    console.log(JSON.stringify({status:'preview',endpoints:['GET /2/usage/credits','GET /2/usage/tweets?days=1'],paidReads:0,collectionStarted:false}));
  } else {
    const settings=JSON.parse(readFileSync(resolve(root,'config/settings.json'),'utf8'));
    const client=createXClient({token:createCredentialStore(resolve(root,'data/secrets')).load()});
    store=openStore(process.env.CAUCUS_DB_PATH??resolve(root,'data/pulse.sqlite'));
    const report=await checkXAccess({client,budget:createBudget(store.db,settings.budget)});
    writePrivateJson(resolve(root,'data/operations/x-access-check.json'),report);
    console.log(JSON.stringify(report));
    if(report.credit.state!=='verified'||report.usage.state!=='available')process.exitCode=2;
  }
} catch {
  console.error('X access could not be checked. Inspect private configuration; no credential or provider response is printed.');
  process.exitCode=1;
} finally {store?.close();}
