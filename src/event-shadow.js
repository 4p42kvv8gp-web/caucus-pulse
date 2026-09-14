// Fixed public-source evaluation only. Event proposals are saved separately
// from ordinary classifications and are never imported into the dashboard.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { p, settings, writeJSON } from './util.js';
import { anthropicClient, refreshIdentityToken } from './anthropic-auth.js';
import { loadEventPilot } from './event-pilot.js';
import { buildEventRequest, validateEventResponse, EVENT_VALIDATOR_VERSION } from './event-contract.js';
import { runEventShadow } from './event-runner.js';

export const EVENT_POLICY_VERSION = 'event-v1';
export const EVENT_SHADOW_PATH = p('data', 'events', 'shadow.json');

export function readShadowState(file = EVENT_SHADOW_PATH) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { version: 1, receipts: {}, events: [] };
    throw error;
  }
  const value = JSON.parse(text);
  if (value?.version !== 1 || !value.receipts || typeof value.receipts !== 'object'
      || Array.isArray(value.receipts) || !Array.isArray(value.events)) {
    throw new Error('Invalid shadow event state; refusing to reset paid work');
  }
  return value;
}

export function prepareShadowPlans(pilot, { model = settings.classify.model, policyVersion = EVENT_POLICY_VERSION } = {}) {
  if (!Array.isArray(pilot?.plans) || !pilot.plans.length) throw new Error('Event pilot has no fixed evaluation bundles');
  const incomplete = pilot.plans.filter((plan) => plan.ready !== true);
  if (incomplete.length) throw new Error(`Event pilot incomplete; refusing reduced evaluation bundles: ${incomplete.map((plan) => `${plan.caseId} (${(plan.diagnostics || []).map((d) => `${d.id}: ${d.reason}`).join(', ')})`).join('; ')}`);
  return pilot.plans.map((plan) => {
    const key = createHash('sha256').update(JSON.stringify({
      caseId: plan.caseId, model, policyVersion, mode: plan.mode,
      sourceHash: plan.sourceHash, correctionHash: plan.correctionHash
    })).digest('hex');
    const request = buildEventRequest(plan.posts, {
      model, policyVersion, runAsOf: plan.runAsOf, mode: plan.mode,
      requestId: `event-${key.slice(0, 24)}`
    });
    // Expected memberships are evaluation answers, never model inputs.
    return { key, request, posts: plan.posts, sourceHash: plan.sourceHash,
      correctionHash: plan.correctionHash, runAsOf: plan.runAsOf,
      mode: plan.mode, policyVersion, caseId: plan.caseId };
  });
}

export async function eventShadowMain(args = process.argv.slice(2), deps = {}) {
  if (args.some((arg) => !['--execute', '--publish', '--plan'].includes(arg))) {
    throw new Error('Supported arguments: --plan, --execute, --publish');
  }
  const execute = args.includes('--execute');
  const publish = args.includes('--publish');
  if (publish && (!execute || process.env.GITHUB_ACTIONS !== 'true')) {
    throw new Error('Publication requires explicit execution inside the serialized Actions job');
  }
  const file = deps.file || EVENT_SHADOW_PATH;
  const load = deps.load || loadEventPilot;
  const state = readShadowState(file);
  // Freeze this fixed pilot's review clock across restarts. Its historical
  // sources must not age out just because an interrupted review resumes later.
  const runAsOf = state.runAsOf || (deps.now || (() => new Date().toISOString()))();
  const pilot = await load({ runAsOf, mode: 'retrospective' });
  const plans = prepareShadowPlans(pilot, deps);
  const log = deps.log || console.log;
  log(`[event-shadow] ${plans.length} fixed public evaluation bundles; ${pilot.diagnostics?.length || 0} coverage diagnostics; dashboard publication disabled`);
  if (!execute) return { status: 'planned', plans: plans.length, diagnostics: pilot.diagnostics };

  state.runAsOf = runAsOf;
  const save = async (value) => writeJSON(file, value);
  const checkpoint = publish ? async () => {
    execFileSync('bash', ['.github/scripts/commit-data.sh', 'events: durable shadow review checkpoint',
      'data/events', 'data/anthropic-usage.json'], { cwd: p(), stdio: 'inherit' });
  } : undefined;
  // Construct lazily: a saved response can be revalidated without credentials
  // or another request. Both SDK and accounting wrapper disable API retries.
  let client;
  const lazyClient = { messages: { create: async (params) => {
    client ||= await (deps.clientFactory || anthropicClient)({ timeout: 120_000, maxRetries: 0 });
    return client.messages.create(params);
  } } };
  const result = await runEventShadow(plans, {
    state, save, checkpoint, client: deps.client || lazyClient,
    refresh: deps.refresh || refreshIdentityToken, validate: validateEventResponse,
    maxCalls: 2, validatorVersion: EVENT_VALIDATOR_VERSION,
    currentSnapshot: async (plan) => {
      const current = (await load({ runAsOf: plan.runAsOf, mode: plan.mode })).plans.find((item) => item.caseId === plan.caseId);
      return current?.ready ? { sourceHash: current.sourceHash, correctionHash: current.correctionHash }
        : { sourceHash: 'missing', correctionHash: 'missing' };
    }
  });
  log(`[event-shadow] ${result.calls} calls; ${result.accepted} accepted; ${result.partial} partial; ${result.unknown} uncertain; all proposals remain shadow-only`);
  if (plans.some((plan) => result.state.receipts[plan.key]?.status !== 'accepted')) {
    throw new Error('Event pilot remains incomplete; saved receipts require review before any further evaluation');
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  eventShadowMain().catch((error) => { console.error(`[event-shadow] ${error.message}`); process.exitCode = 1; });
}
