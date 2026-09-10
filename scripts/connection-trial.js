import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openStore} from '../src/db.js';
import {createCredentialStore} from '../src/credentials.js';
import {createXClient} from '../src/x-client.js';
import {runConnectionTrial} from '../src/connection-trial.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const [mode,expiresAt,...flags]=process.argv.slice(2);
if(!['inventory','posts'].includes(mode)||!expiresAt||flags.some(f=>!['--execute','--post-fields'].includes(f)))throw new Error('Choose inventory or posts, an explicit trial expiry, and optional --execute / --post-fields.');
process.umask(0o077);
const store=openStore(process.env.CAUCUS_DB_PATH??resolve(root,'data/pulse.sqlite'));
try{
  const execute=flags.includes('--execute'),fieldDialect=flags.includes('--post-fields')?'post':'tweet';
  const settings=JSON.parse(readFileSync(resolve(root,'config/settings.json'),'utf8'));
  const client=execute?createXClient({token:createCredentialStore(resolve(root,'data/secrets')).load(),fieldDialect}):null;
  const result=await runConnectionTrial({store,settings,mode,fieldDialect,expiresAt,execute,client});
  if(execute){mkdirSync(resolve(root,'data/operations'),{recursive:true,mode:0o700});writeFileSync(resolve(root,`data/operations/connection-trial-${mode}.json`),JSON.stringify({checkedAt:new Date().toISOString(),...result},null,2)+'\n',{mode:0o600});}
  console.log(JSON.stringify(result,null,2));
}catch(error){console.error(JSON.stringify({status:'not-completed',code:/^[a-z-]+$/.test(error.code??'')?error.code:'local-connection-trial-error',note:'Any uncertain paid request keeps its reservation.'}));process.exitCode=1;}
finally{store.close();}
