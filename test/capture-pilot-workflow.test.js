import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { createJournal, runPilot, pilotSummary, decisionDiagnostics, main } from '../.github/scripts/capture-reliability-pilot.mjs';
import { initialState, REPOSITORY } from '../src/capture-dispatcher.js';

const root = path.resolve(import.meta.dirname, '..');
const clock = Date.parse('2026-09-16T03:00:00Z');
const oldCapture = { lastPollAt: '2026-09-16T02:00:00Z', lastPollAttemptAt: '2026-09-16T02:00:00Z' };
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-pilot-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const readWorkflow = (name) => yaml.load(fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8'));

test('capture-only poll skips live and existing-batch interpretation but publishes partial results', (t) => {
  const directory = temporary(t), bin = path.join(directory, 'bin'), log = path.join(directory, 'calls');
  fs.mkdirSync(bin);
  for (const command of ['npm', 'node']) {
    const file = path.join(bin, command);
    fs.writeFileSync(file, `#!/bin/bash\nprintf '%s\\n' '${command}'" $* CLASSIFY_LIVE=$CLASSIFY_LIVE" >> "$CALL_LOG"\nif [ "$1 $2" = 'run poll' ]; then exit 2; fi\n`);
    fs.chmodSync(file, 0o755);
  }
  const result = spawnSync('bash', ['.github/scripts/poll.sh'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: log, CAPTURE_ONLY: 'true', CLASSIFY_LIVE: 'true' }
  });
  assert.equal(result.status, 2);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), [
    'npm run poll CLASSIFY_LIVE=false',
    'node .github/scripts/validate-publication.mjs CLASSIFY_LIVE=false',
    'npm run sitedata CLASSIFY_LIVE=false'
  ]);
});

test('pilot is finite, isolated from writer lock and secrets, and cannot schedule itself', () => {
  const workflow = readWorkflow('capture-reliability-pilot.yml');
  assert.equal(workflow.on.schedule, undefined);
  assert.deepEqual(workflow.on.push, { branches: ['main'], paths: ['.github/workflows/capture-reliability-pilot.yml'] });
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'write' });
  assert.equal(workflow.concurrency.group, 'capture-reliability-pilot');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.equal(workflow.jobs.pilot['timeout-minutes'], 55);
  assert.match(workflow.jobs.pilot.if, /refs\/heads\/main/);
  const steps = workflow.jobs.pilot.steps;
  assert.equal(steps.find((s) => s.uses?.startsWith('actions/checkout')).with['persist-credentials'], false);
  const command = steps.find((s) => s.run);
  assert.equal(command.run, 'node --use-env-proxy .github/scripts/capture-reliability-pilot.mjs');
  assert.deepEqual(command.env, { GITHUB_TOKEN: '${{ github.token }}' });
  assert.equal(steps.find((s) => s.uses?.startsWith('actions/upload-artifact')).if, 'always()');
  const poll = readWorkflow('poll.yml');
  assert.equal(poll.on.workflow_dispatch.inputs.capture_only.type, 'boolean');
  assert.equal(poll.on.workflow_dispatch.inputs.capture_only.default, false);
  const acquire = poll.jobs.poll.steps.find((s) => s.id === 'repost_sources');
  assert.match(acquire.if, /!inputs.capture_only/);
  assert.equal(poll.jobs.poll.steps.find((s) => s.id === 'pipeline').env.CAPTURE_ONLY,
    "${{ inputs.capture_only && 'true' || 'false' }}");
});

test('journal saves complete snapshots and refuses existing run directory instead of restarting', (t) => {
  const directory = path.join(temporary(t), 'run');
  const persist = createJournal(directory), state = initialState({ controllerRunId: 123, now: clock });
  persist(state);
  state.pending = { phase: 'intent', dispatchKey: 'capture-pilot-123-1' };
  persist(state);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'journal.json'))), state);
  assert.throws(() => createJournal(directory), /EEXIST/);
  assert.equal(fs.existsSync(path.join(directory, 'journal.tmp')), false);
});

test('controller stops at its deadline with explicit pending outcome and does not dispatch again', async () => {
  let now = clock, dispatches = 0, sleeps = 0;
  const state = initialState({ controllerRunId: 123, now, durationMs: 90_000 });
  const client = {
    listActiveWriters: async () => ({ complete: true, runs: [] }), getCaptureState: async () => oldCapture,
    dispatch: async () => { dispatches++; return { status: 200, data: { workflow_run_id: 456,
      run_url: `https://api.github.com/repos/${REPOSITORY}/actions/runs/456`, html_url: `https://github.com/${REPOSITORY}/actions/runs/456` } }; },
    getRun: async () => ({ id: 456, path: '.github/workflows/poll.yml', branch: 'main', event: 'workflow_dispatch', status: 'in_progress' })
  };
  const result = await runPilot({ state, client, persist: async () => {}, now: () => now,
    sleep: async (ms) => { assert.ok(ms <= 60_000); now += ms; sleeps++; } });
  assert.equal(dispatches, 1); assert.equal(sleeps, 2);
  assert.equal(result.stopReason, 'duration_complete');
  const summary = pilotSummary(result);
  assert.equal(summary.result, 'observation-window-ended-with-pending-outcome');
  assert.equal(summary.verifiedCaptures, 0);
  assert.equal(summary.pendingRunId, 456);
});

test('failed receipt persistence escapes the controller without another dispatch or sleep', async () => {
  let dispatches = 0, sleeps = 0;
  const state = initialState({ controllerRunId: 123, now: clock });
  const client = { listActiveWriters: async () => ({ complete: true, runs: [] }), getCaptureState: async () => oldCapture,
    dispatch: async () => { dispatches++; return { status: 200, data: { workflow_run_id: 456,
      run_url: `https://api.github.com/repos/${REPOSITORY}/actions/runs/456`, html_url: `https://github.com/${REPOSITORY}/actions/runs/456` } }; } };
  await assert.rejects(runPilot({ state, client, now: () => clock,
    persist: async (snapshot) => { if (snapshot.pending?.phase === 'accepted') throw new Error('synthetic disk failure'); },
    sleep: async () => { sleeps++; } }), /journal_write_failed/);
  assert.equal(dispatches, 1); assert.equal(sleeps, 0);
});

test('CLI refuses local or wrong repository execution before network access', async () => {
  for (const env of [{}, { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'someone/else' },
    { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: REPOSITORY, GITHUB_REF: 'refs/heads/other' }]) {
    await assert.rejects(main(env), /pilot_requires_expected_main_actions_run/);
  }
});

test('failed evidence logs its closed reason without leaking arbitrary response or error text', async () => {
  const logs = [], state = initialState({ controllerRunId: 123, now: clock });
  const client = { listActiveWriters: async () => {
    throw Object.assign(new Error('private response body must never appear'), { code: 'incomplete_run_list' });
  } };
  const result = await runPilot({ state, client, persist: async () => {}, now: () => clock,
    sleep: async () => { throw new Error('must stop'); }, log: (line) => logs.push(JSON.parse(line)) });
  assert.equal(result.dispatches, 0);
  assert.equal(logs[0].evidenceCode, 'incomplete_run_list');
  assert.equal(pilotSummary(result).evidenceCode, 'incomplete_run_list');
  assert.ok(!JSON.stringify(logs).includes('private'));
  assert.deepEqual(decisionDiagnostics({ code: 'arbitrary secret', httpStatus: 403, message: 'private' }), { evidenceHttpStatus: 403 });
});
