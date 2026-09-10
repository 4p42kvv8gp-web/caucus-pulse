import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openStore} from '../src/db.js';
import {prepareVoiceSession} from '../src/voice-session.js';
import {writePrivateJson} from '../src/private-files.js';

process.umask(0o077);
const root=fileURLToPath(new URL('../',import.meta.url)),ids=process.argv.slice(2);
const store=openStore(process.env.CAUCUS_DB_PATH??resolve(root,'data/pulse.sqlite'));
try{
  const session=prepareVoiceSession(store,{postIds:ids.length?ids:null,limit:8});
  const path=resolve(root,`data/reports/voice-session-${Date.now()}.json`);
  writePrivateJson(path,session);
  console.log(JSON.stringify({report:path,sources:session.cards.length,changesMade:session.changesMade,note:session.note},null,2));
}catch(error){console.error(/^Invalid /.test(error.message)?error.message:'Voice session preparation failed; saved sources and judgments remain intact.');process.exitCode=1;}
finally{store.close();}
