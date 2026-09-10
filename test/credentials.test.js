import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, chmodSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialStore } from '../src/credentials.js';
import { openStore } from '../src/db.js';
import { createServer } from '../src/server.js';

const syntheticToken = 'synthetic-test-only-token-000000';

test('private credentials save atomically with restricted permissions and never appear in status', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-credential-'));
  const credentials = createCredentialStore(dir, { environmentToken: () => undefined });
  try {
    assert.equal(credentials.status().configured, false);
    assert.deepEqual(credentials.save(syntheticToken), { configured: true, source: 'private-file' });
    assert.equal(credentials.load(), syntheticToken);
    assert.equal(statSync(join(dir, 'x-bearer-token')).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(JSON.stringify(credentials.status()).includes(syntheticToken), false);
    assert.throws(() => credentials.save(syntheticToken + '\n'), /Invalid bearer/);
    assert.equal(credentials.load(), syntheticToken, 'Rejected input cannot replace the existing credential');
    credentials.save(syntheticToken + '-replacement'); assert.equal(credentials.load(), syntheticToken + '-replacement');
    chmodSync(join(dir, 'x-bearer-token'), 0o644);
    assert.throws(() => credentials.load(), /permissions/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('symlinked credential files and runtime shadowing are rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-credential-'));
  try {
    const target = join(dir, 'unrelated'); writeFileSync(target, syntheticToken, { mode: 0o600 });
    symlinkSync(target, join(dir, 'x-bearer-token'));
    const credentials = createCredentialStore(dir, { environmentToken: () => undefined });
    assert.equal(credentials.status().configured, false);
    assert.throws(() => credentials.load(), /permissions/); assert.throws(() => credentials.save(syntheticToken), /Invalid private credential file/);
    const environment = createCredentialStore(dir, { environmentToken: () => syntheticToken });
    assert.equal(environment.status().source, 'environment');
    assert.throws(() => environment.save(syntheticToken + '-replacement'), /runtime environment/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('connection form requires a local origin, never returns a token, and starts no paid work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-credential-'));
  const credentials = createCredentialStore(dir, { environmentToken: () => undefined });
  const store = openStore(); const server = createServer(store, { credentials });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (body, origin) => fetch(`${base}/api/settings/x-credential`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
  try {
    assert.equal((await send({ bearerToken: syntheticToken })).status, 403);
    assert.equal((await send({ bearerToken: syntheticToken }, 'https://unrelated.example')).status, 403);
    assert.equal((await send({ bearerToken: syntheticToken, extra: true }, base)).status, 400);
    assert.equal(credentials.status().configured, false);
    const response = await send({ bearerToken: syntheticToken }, base); assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.collectionStarted, false); assert.equal(result.accessVerified, false);
    assert.equal(JSON.stringify(result).includes(syntheticToken), false);
    const dashboard = await (await fetch(`${base}/api/dashboard`)).json();
    assert.equal(dashboard.connection.configured, true); assert.equal(JSON.stringify(dashboard).includes(syntheticToken), false);
    assert.equal(dashboard.budget.state.requestCount, 0); assert.equal(dashboard.operations.sources.length, 0);
    assert.equal(credentials.load(), syntheticToken);
  } finally { await new Promise(resolve => server.close(resolve)); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
