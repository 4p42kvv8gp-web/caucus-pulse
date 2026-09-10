import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {openStore} from '../src/db.js';
import {acquirePrivateLock} from '../src/private-files.js';
import {readRemovalJournal,removalJournalPath} from '../src/removal-journal.js';
import {inspectDatabase,createDatabaseBackup,verifyDatabaseBackup,stageDatabaseRestore,previewSourceRemoval,removeSources,compactDatabase} from '../src/archive-operations.js';

process.umask(0o077);
const root=fileURLToPath(new URL('../',import.meta.url));
const [command='status',...args]=process.argv.slice(2);const options={};
try{
  for(let i=0;i<args.length;i++){
    const key=args[i];if(!['--database','--backup','--output','--ids','--execute'].includes(key)||Object.hasOwn(options,key))throw new Error('Invalid or repeated archive option.');
    if(key==='--execute')options[key]=true;else{if(!args[i+1]||args[i+1].startsWith('--'))throw new Error('An archive option is missing its value.');options[key]=args[++i];}
  }
  const allowed={status:['--database'],backup:['--database'],verify:['--backup'],restore:['--database','--backup','--output'],remove:['--database','--ids','--execute'],compact:['--database']}[command];
  if(!allowed||Object.keys(options).some(k=>!allowed.includes(k)))throw new Error('Use archive status, backup, verify, restore, remove, or compact with its documented options.');
  const database=resolve(options['--database']??process.env.CAUCUS_DB_PATH??resolve(root,'data/pulse.sqlite'));
  let result;
  if(command==='status')result={database,...inspectDatabase(database),removalJournalEntries:readRemovalJournal(removalJournalPath(database)).entries.length,maintenanceLockPresent:existsSync(resolve(dirname(database),'maintenance.lock'))};
  if(command==='backup')result=await createDatabaseBackup(database);
  if(command==='verify'){if(!options['--backup'])throw new Error('Provide --backup for verification.');result=await verifyDatabaseBackup(options['--backup']);}
  if(command==='restore'){
    if(!options['--backup'])throw new Error('Provide --backup to stage a restore.');
    const outputPath=options['--output']??resolve(dirname(database),'restores',`restore-${Date.now()}-${randomUUID()}.sqlite`);
    result=await stageDatabaseRestore(options['--backup'],{currentPath:database,outputPath});
  }
  if(command==='remove'){
    const ids=options['--ids']?.split(',')??[];result=options['--execute']?removeSources(database,ids):previewSourceRemoval(database,ids);
  }
  if(command==='compact'){
    const release=acquirePrivateLock(dirname(database));let store;
    try{store=openStore(database);result=compactDatabase(store.db);}finally{store?.close();release();}
  }
  console.log(JSON.stringify(result,null,2));
}catch(error){console.error(error.message);process.exitCode=1;}
