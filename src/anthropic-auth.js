// Anthropic credentials without a stored API key.
//
// The SDK resolves credentials on its own (first match wins): ANTHROPIC_API_KEY,
// ANTHROPIC_AUTH_TOKEN, then workload identity federation when
// ANTHROPIC_FEDERATION_RULE_ID + ANTHROPIC_ORGANIZATION_ID and an identity
// token (ANTHROPIC_IDENTITY_TOKEN_FILE) are set. In federation mode the SDK
// exchanges the identity JWT at /v1/oauth/token, caches the access token, and
// re-exchanges when it nears expiry — re-reading the identity file each time.
//
// Explicit key: CLASSIFIER_ANTHROPIC_API_KEY is read first and handed to the
// SDK directly. Hosted sandboxes (claude.ai/code) reserve the ANTHROPIC_API_KEY
// name for their own use, so the classifier's key travels under its own name
// there; plain ANTHROPIC_API_KEY still works for local development. Neither
// is expected in GitHub Actions, where federation below does the work.
//
// What this module adds, for GitHub Actions (permissions: id-token: write):
//   - fills the federation env vars from config/settings.json → anthropic.federation
//   - mints the GitHub OIDC token itself (audience https://api.anthropic.com)
//     and writes it to the identity file
//   - re-mints when the file is older than IDENTITY_MAX_AGE_MS, so a job that
//     polls a message batch for an hour keeps authenticating even though both
//     the OIDC JWT and the exchanged access token live only ~10 minutes.
//
// Nothing here is a secret: the rule/org/service-account/workspace ids are
// public identifiers; the federation rule only accepts JWTs from this repo's
// main branch.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { settings } from './util.js';

const AUDIENCE = 'https://api.anthropic.com';
const IDENTITY_MAX_AGE_MS = 4 * 60_000;

const inActions = () =>
  Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);

// The explicit API key, if any. Never logged; callers treat it as opaque.
export function apiKey() {
  return process.env.CLASSIFIER_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || null;
}

// Which env var the key came from (for diagnostics), or null.
export function apiKeySource() {
  if (process.env.CLASSIFIER_ANTHROPIC_API_KEY) return 'CLASSIFIER_ANTHROPIC_API_KEY';
  if (process.env.ANTHROPIC_API_KEY) return 'ANTHROPIC_API_KEY';
  return null;
}

const federationEnvSet = () =>
  Boolean(process.env.ANTHROPIC_FEDERATION_RULE_ID && process.env.ANTHROPIC_ORGANIZATION_ID);

// Copy config/settings.json → anthropic.federation into the env vars the SDK
// reads, without overriding anything the workflow set explicitly.
function applyFederationSettings() {
  const f = settings.anthropic?.federation;
  if (!f) return;
  const map = {
    ANTHROPIC_FEDERATION_RULE_ID: f.rule_id,
    ANTHROPIC_ORGANIZATION_ID: f.organization_id,
    ANTHROPIC_SERVICE_ACCOUNT_ID: f.service_account_id,
    ANTHROPIC_WORKSPACE_ID: f.workspace_id
  };
  for (const [k, v] of Object.entries(map)) if (v && !process.env[k]) process.env[k] = v;
  if (!process.env.ANTHROPIC_IDENTITY_TOKEN_FILE) {
    process.env.ANTHROPIC_IDENTITY_TOKEN_FILE = path.join(
      process.env.RUNNER_TEMP || os.tmpdir(), 'anthropic-oidc.jwt'
    );
  }
}

// True when some credential path exists. Cheap and synchronous so callers can
// gate optional stages ("skip live tagging when there is no way to auth").
export function anthropicConfigured() {
  if (apiKey() || process.env.ANTHROPIC_AUTH_TOKEN) return true;
  if (federationEnvSet()) return true;
  return inActions() && Boolean(settings.anthropic?.federation?.rule_id);
}

export function authMode() {
  if (apiKey()) return 'api-key';
  if (process.env.ANTHROPIC_AUTH_TOKEN) return 'auth-token';
  if (federationEnvSet() || (inActions() && settings.anthropic?.federation?.rule_id)) return 'federation';
  return null;
}

async function mintGitHubOidcToken() {
  const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
  url.searchParams.set('audience', AUDIENCE);
  const res = await fetch(url, {
    headers: { Authorization: `bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    signal: AbortSignal.timeout(30_000)
  });
  if (!res.ok) throw new Error(`GitHub OIDC token request failed: ${res.status}`);
  const body = await res.json();
  if (!body?.value) throw new Error('GitHub OIDC token response had no value');
  return body.value;
}

// Keep the identity file fresh. Safe to call often (cheap when fresh); call it
// before constructing a client and inside any loop that outlives ~5 minutes.
export async function refreshIdentityToken({ maxAgeMs = IDENTITY_MAX_AGE_MS, force = false } = {}) {
  if (apiKey() || process.env.ANTHROPIC_AUTH_TOKEN) return false;
  if (!inActions()) return false;
  applyFederationSettings();
  const file = process.env.ANTHROPIC_IDENTITY_TOKEN_FILE;
  if (!force) {
    try {
      if (Date.now() - fs.statSync(file).mtimeMs < maxAgeMs) return false;
    } catch { /* missing — mint */ }
  }
  const jwt = await mintGitHubOidcToken();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jwt, { mode: 0o600 });
  return true;
}

// The one way scripts should get a client. An explicit key is passed to the
// SDK directly (so CLASSIFIER_ANTHROPIC_API_KEY works without ever touching
// ANTHROPIC_API_KEY); otherwise federation env is applied and the identity
// token is fresh by the time the SDK reads them.
export async function anthropicClient(options = {}) {
  const key = apiKey();
  if (!key) await refreshIdentityToken();
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic(key ? { apiKey: key, ...options } : options);
}
