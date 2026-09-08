import {constants,openSync,closeSync,writeFileSync,readFileSync,fsyncSync,lstatSync,fstatSync,mkdirSync,renameSync,unlinkSync} from 'node:fs';
import {resolve,dirname,basename} from 'node:path';
import {randomUUID} from 'node:crypto';

export function privateDirectory(path) {
  path=resolve(path);mkdirSync(path,{recursive:true,mode:0o700});
  const stat=lstatSync(path);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077))throw new Error('Private storage directory must be an owner-only real directory.');
  return path;
}
export function regularFile(path,{privateOnly=true,maxBytes=Infinity,missing=false}={}) {
  let stat;try{stat=lstatSync(path);}catch(e){if(missing&&e.code==='ENOENT')return null;throw e;}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(privateOnly&&(stat.mode&0o077))||stat.size>maxBytes)throw new Error('Storage file is unsafe, oversized, or has unsafe permissions.');
  return stat;
}
export function syncDirectory(path){const fd=openSync(path,constants.O_RDONLY);try{fsyncSync(fd);}finally{closeSync(fd);}}
export function writePrivateJson(path,value) {
  const directory=privateDirectory(dirname(path));regularFile(path,{missing:true});
  const temp=resolve(directory,`.${basename(path)}-${randomUUID()}.tmp`);
  const fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}catch(e){closeSync(fd);unlinkSync(temp);throw e;}
  closeSync(fd);
  try{renameSync(temp,path);syncDirectory(directory);}catch(e){try{unlinkSync(temp);}catch{}throw e;}
}
export function readPrivateJson(path,{missing=null,maxBytes=16000000}={}) {
  const before=regularFile(path,{missing:true,maxBytes});if(!before)return missing;
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const opened=fstatSync(fd);if(opened.ino!==before.ino||opened.size>maxBytes)throw new Error('Storage file changed during access.');return JSON.parse(readFileSync(fd,'utf8'));}
  finally{closeSync(fd);}
}
export function acquirePrivateLock(directory,name='maintenance.lock') {
  directory=privateDirectory(directory);const path=resolve(directory,name);
  let fd;try{fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}
  catch(e){if(e.code==='EEXIST')throw new Error('A maintenance lock already exists. Inspect the active operation before removing an unfinished lock.');throw e;}
  const inode=fstatSync(fd).ino;
  try{writeFileSync(fd,JSON.stringify({pid:process.pid,createdAt:new Date().toISOString(),nonce:randomUUID()}));fsyncSync(fd);}catch(e){closeSync(fd);unlinkSync(path);throw e;}
  closeSync(fd);syncDirectory(directory);let released=false;
  return ()=>{if(released)return;const current=lstatSync(path);if(current.ino!==inode||!current.isFile())throw new Error('Maintenance lock ownership changed.');unlinkSync(path);syncDirectory(directory);released=true;};
}
