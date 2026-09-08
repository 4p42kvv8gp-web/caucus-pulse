import { mkdirSync, lstatSync, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, renameSync, chmodSync, unlinkSync, constants } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

function validateToken(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 4096 || !/^[\x21-\x7e]+$/.test(token)) throw new Error('Invalid bearer token format. Paste only the token, without surrounding whitespace.');
  return token;
}

export function createCredentialStore(directory, { environmentToken = () => process.env.CAUCUS_X_BEARER_TOKEN } = {}) {
  const file = resolve(directory, 'x-bearer-token');
  function stat() {
    try { return lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Private credential status is unavailable.'); }
  }
  function status() {
    if (environmentToken()) return { configured: true, source: 'environment' };
    const existing = stat();
    return { configured: Boolean(existing?.isFile() && !existing.isSymbolicLink()), source: existing ? 'private-file' : 'missing' };
  }
  function load() {
    const env = environmentToken();
    if (env) return validateToken(env);
    const existing = stat();
    if (!existing) throw new Error('Configure the product bearer token through the private connection form.');
    if (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077) !== 0) throw new Error('Private credential file permissions need repair.');
    let fd;
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); return validateToken(readFileSync(fd, 'utf8')); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  function save(token) {
    validateToken(token);
    if (environmentToken()) throw new Error('Invalid setup change: a token is configured by the runtime environment. Update that private environment instead.');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink()) throw new Error('Invalid private credential directory.');
    chmodSync(directory, 0o700);
    const existing = stat();
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('Invalid private credential file.');
    const temporary = resolve(directory, `.token-${randomUUID()}`);
    let fd;
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, token); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, file);
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Private credential cleanup needs attention.'); }
    }
    return status();
  }
  return { status, load, save };
}
