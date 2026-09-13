import test from 'node:test';
import assert from 'node:assert/strict';
import { anthropicConfigured, authMode, apiKey, apiKeySource, refreshIdentityToken } from '../src/anthropic-auth.js';

const KEYS = [
  'CLASSIFIER_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID',
  'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN'
];

function withEnv(vars, fn) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  try { return fn(); } finally {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('authMode prefers an explicit key, then auth token, then federation', () => {
  withEnv({ ANTHROPIC_API_KEY: 'k' }, () => assert.equal(authMode(), 'api-key'));
  withEnv({ CLASSIFIER_ANTHROPIC_API_KEY: 'k' }, () => {
    assert.equal(authMode(), 'api-key');
    assert.equal(anthropicConfigured(), true);
  });
  withEnv({ ANTHROPIC_AUTH_TOKEN: 't' }, () => assert.equal(authMode(), 'auth-token'));
  withEnv({ ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_x', ANTHROPIC_ORGANIZATION_ID: 'org' },
    () => assert.equal(authMode(), 'federation'));
});

test('CLASSIFIER_ANTHROPIC_API_KEY is an api-key credential and wins over ANTHROPIC_API_KEY', () => {
  withEnv({ CLASSIFIER_ANTHROPIC_API_KEY: 'c' }, () => {
    assert.equal(authMode(), 'api-key');
    assert.equal(anthropicConfigured(), true);
    assert.equal(apiKey(), 'c');
    assert.equal(apiKeySource(), 'CLASSIFIER_ANTHROPIC_API_KEY');
  });
  withEnv({ CLASSIFIER_ANTHROPIC_API_KEY: 'c', ANTHROPIC_API_KEY: 'k' }, () => {
    assert.equal(apiKey(), 'c');
    assert.equal(apiKeySource(), 'CLASSIFIER_ANTHROPIC_API_KEY');
  });
  withEnv({ ANTHROPIC_API_KEY: 'k' }, () => {
    assert.equal(apiKey(), 'k');
    assert.equal(apiKeySource(), 'ANTHROPIC_API_KEY');
  });
  withEnv({}, () => {
    assert.equal(apiKey(), null);
    assert.equal(apiKeySource(), null);
  });
  // An explicit key beats federation env even when both are present.
  withEnv({ CLASSIFIER_ANTHROPIC_API_KEY: 'c', ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_x', ANTHROPIC_ORGANIZATION_ID: 'org' },
    () => assert.equal(authMode(), 'api-key'));
});

test('inside GitHub Actions the settings.json federation block counts as configured', () => {
  withEnv({ ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example/oidc', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'x' }, () => {
    assert.equal(authMode(), 'federation');
    assert.equal(anthropicConfigured(), true);
  });
});

test('outside Actions with nothing set, nothing is configured', () => {
  withEnv({}, () => {
    assert.equal(authMode(), null);
    assert.equal(anthropicConfigured(), false);
  });
});

test('refreshIdentityToken is a no-op outside Actions or with an API key', async () => {
  assert.equal(await withEnv({}, () => refreshIdentityToken()), false);
  assert.equal(await withEnv({ ANTHROPIC_API_KEY: 'k', ACTIONS_ID_TOKEN_REQUEST_URL: 'u', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't' },
    () => refreshIdentityToken()), false);
  assert.equal(await withEnv({ CLASSIFIER_ANTHROPIC_API_KEY: 'c', ACTIONS_ID_TOKEN_REQUEST_URL: 'u', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't' },
    () => refreshIdentityToken()), false);
});

test('in Actions, anthropicClient mints a fresh identity token for every client, even when the file is seconds old', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { anthropicClient } = await import('../src/anthropic-auth.js');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oidc-')), 'anthropic-oidc.jwt');
  // withEnv restores the environment as soon as its callback returns, which
  // for an async callback is before the awaits inside it run — so set and
  // restore by hand here.
  const vars = { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example/oidc', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'x', ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_x', ANTHROPIC_ORGANIZATION_ID: 'org', ANTHROPIC_IDENTITY_TOKEN_FILE: file };
  const all = [...KEYS, 'ANTHROPIC_IDENTITY_TOKEN_FILE'];
  const saved = Object.fromEntries(all.map((k) => [k, process.env[k]]));
  const savedFetch = globalThis.fetch;
  let mints = 0;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ value: `jwt-${++mints}` }) });
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    await anthropicClient();          // first process: mints jwt-1
    assert.equal(fs.readFileSync(file, 'utf8'), 'jwt-1');
    await anthropicClient();          // a second client moments later: its own jwt-2, not a reuse
    assert.equal(fs.readFileSync(file, 'utf8'), 'jwt-2');
    assert.equal(await refreshIdentityToken(), false); // the periodic refresh still respects the age window
    assert.equal(mints, 2);
  } finally {
    globalThis.fetch = savedFetch;
    for (const k of all) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});
