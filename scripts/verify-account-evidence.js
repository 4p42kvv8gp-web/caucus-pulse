import {readFileSync,statSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openStore} from '../src/db.js';
import {accountEvidenceCandidates,applyAccountEvidence} from '../src/account-evidence.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const [input,flag]=process.argv.slice(2);
if(!input||(flag&&flag!=='--apply')||process.argv.length>4)throw new Error('Provide a fetched official account evidence report and optional --apply.');
process.umask(0o077);
const reportPath=resolve(input);
if(statSync(reportPath).size>2_000_000)throw new Error('The evidence report is too large.');
const store=openStore(process.env.CAUCUS_DB_PATH??resolve(root,'data/pulse.sqlite'));
try{
  const settings=JSON.parse(readFileSync(resolve(root,'config/settings.json'),'utf8'));
  const candidates=accountEvidenceCandidates(store,JSON.parse(readFileSync(reportPath,'utf8')),{listId:settings.listId,loadSource:name=>{
    const path=resolve(dirname(reportPath),name);
    if(statSync(path).size>3_000_000)throw new Error('The source evidence is too large.');
    return readFileSync(path);
  }});
  const result={checkedAt:candidates.checkedAt,counts:candidates.counts,items:candidates.items.map(({binding,bindings,...item})=>item),note:candidates.note};
  if(flag==='--apply')result.applied=applyAccountEvidence(store,candidates);
  const output=reportPath.replace(/\.json$/,`-${flag?'applied':'preview'}.json`);
  if(output===reportPath)throw new Error('Use a JSON report filename.');
  writeFileSync(output,JSON.stringify(result,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({output,counts:result.counts,applied:result.applied??null}));
}finally{store.close();}
