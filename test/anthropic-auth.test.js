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
