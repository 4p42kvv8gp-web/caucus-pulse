import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {readPrivateJson,writePrivateJson,acquirePrivateLock} from './private-files.js';
import {atomic} from './sqlite.js';

export const removalJournalPath=databasePath=>resolve(dirname(databasePath),'source-removals.json');
const digest=entries=>createHash('sha256').update(JSON.stringify(entries)).digest('hex');
export function validateRemovalIds(ids){
  if(!Array.isArray(ids)||!ids.length||ids.length>200||ids.some(id=>typeof id!=='string'||!/^\d{1,30}$/.test(id))||new Set(ids).size!==ids.length)throw new Error('Provide 1–200 distinct source post IDs.');
  return ids;
}
export function readRemovalJournal(path) {
  const journal=readPrivateJson(path,{missing:{version:1,entries:[],digest:digest([])}});
  if(!journal||journal.version!==1||!Array.isArray(journal.entries)||journal.entries.length>100000||journal.digest!==digest(journal.entries))throw new Error('Source removal journal is invalid; restore or inspect it before opening the archive.');
  let previous='';
  for(const entry of journal.entries){
    if(!entry||Object.keys(entry).length!==2||!/^\d{1,30}$/.test(entry.postId??'')||entry.postId<=previous||typeof entry.deletedAt!=='string'||!Number.isFinite(Date.parse(entry.deletedAt))||new Date(entry.deletedAt).toISOString()!==entry.deletedAt)throw new Error('Source removal journal has invalid records.');
    previous=entry.postId;
  }
  return journal;
}
export function recordRemovals(path,ids,{now=Date.now(),alreadyLocked=false}={}) {
  validateRemovalIds(ids);const release=alreadyLocked?()=>{}:acquirePrivateLock(dirname(path));
  try{
    const prior=readRemovalJournal(path),entries=new Map(prior.entries.map(e=>[e.postId,e]));
    for(const postId of ids)if(!entries.has(postId))entries.set(postId,{postId,deletedAt:new Date(now).toISOString()});
    if(entries.size>100000)throw new Error('Source removal journal reached its configured limit.');
    const ordered=[...entries.values()].sort((a,b)=>a.postId.localeCompare(b.postId,'en'));
    const result={version:1,entries:ordered,digest:digest(ordered)};writePrivateJson(path,result);return result;
  }finally{release();}
}
export function applyRemovalJournal(db,journal) {
  return atomic(db,()=>{
    let removedPosts=0,removedCaptures=0;
    for(const entry of journal.entries){
      db.prepare('INSERT OR IGNORE INTO tombstones(post_id,deleted_at) VALUES (?,?)').run(entry.postId,entry.deletedAt);
      removedPosts+=db.prepare('DELETE FROM posts WHERE id=?').run(entry.postId).changes;
      removedCaptures+=db.prepare('DELETE FROM captured_posts WHERE id=?').run(entry.postId).changes;
    }
    if(removedPosts||removedCaptures)db.prepare("INSERT INTO operation_faults(id,code,created_at,resolved_at) VALUES ('removal-cleanup-pending','removal-cleanup-pending',?,NULL) ON CONFLICT(id) DO UPDATE SET resolved_at=NULL").run(new Date().toISOString());
    return {removedPosts,removedCaptures,tombstones:journal.entries.length};
  });
}
