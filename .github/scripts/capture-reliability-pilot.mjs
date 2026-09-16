// One fixed, finite collection experiment. This command never submits model
// requests, modifies repository data, or schedules another controller.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { REPOSITORY, initialState, createGitHubClient, tick } from '../../src/capture-dispatcher.js';

const NORMAL_STOPS = new Set(['duration_complete', 'dispatch_limit']);

// Refuse a pre-existing directory: restarting is never permission to repeat a
// dispatch whose receipt might not have been saved. Renames and fsyncs preserve
// the last complete journal on this runner; the artifact is the recovery copy.
export function createJournal(directory) {
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  fs.mkdirSync(directory);
  const journal = path.join(directory, 'journal.json');
  return (state) => {
    const temporary = path.join(directory, 'journal.tmp');
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(state, null, 2) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, journal);
    const dirFd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  };
}

export function pilotSummary(state) {
  const verified = state.completed.filter((row) => row.captureVerified);
  const gapMinutes = verified.slice(1).map((row, index) =>
    (Date.parse(row.captureAt) - Date.parse(verified[index].captureAt)) / 60_000);
  return {
    status: state.status, stopReason: state.stopReason, startedAt: state.startedAt,
    deadlineAt: state.deadlineAt, dispatches: state.dispatches,
    observedChildren: state.completed.length, verifiedCaptures: verified.length,
    maxObservedCaptureGapMinutes: gapMinutes.length ? Math.max(...gapMinutes) : null,
    pendingOutcome: state.pending?.phase || null,
    pendingRunId: state.pending?.runId || null,
    limitedToPilot: true,
    result: !NORMAL_STOPS.has(state.stopReason) ? 'stopped-for-review'
      : state.pending ? 'observation-window-ended-with-pending-outcome'
      : verified.length ? 'observations-recorded' : 'no-dispatched-capture-observed'
  };
}

export async function runPilot({ state, client, persist, now = Date.now, sleep = delay, log = () => {} }) {
  await persist(state); // Must be durable before the first network operation.
  while (state.status === 'active') {
    state = await tick({ state, client, persist, now });
    // Only closed decision codes, counts and numeric run IDs enter logs.
    log(JSON.stringify({ decision: state.decisions.at(-1)?.kind, dispatches: state.dispatches,
      verifiedCaptures: state.completed.filter((row) => row.captureVerified).length,
      pendingRunId: state.pending?.runId || null }));
    if (state.status === 'active') {
      const remaining = Date.parse(state.deadlineAt) - now();
      if (remaining > 0) await sleep(Math.min(60_000, remaining));
    }
  }
  return state;
}

export async function main(env = process.env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== REPOSITORY ||
      env.GITHUB_REF !== 'refs/heads/main' || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) ||
      !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT || '') || !path.isAbsolute(env.RUNNER_TEMP || '')) {
    throw new Error('pilot_requires_expected_main_actions_run');
  }
  const state = initialState({ controllerRunId: env.GITHUB_RUN_ID });
  const directory = path.join(env.RUNNER_TEMP, 'caucus-capture-pilot', `${state.controllerRunId}-${env.GITHUB_RUN_ATTEMPT}`);
  const persist = createJournal(directory);
  const client = createGitHubClient({ token: env.GITHUB_TOKEN, maxRequests: 400 });
  // Persistence errors escape the loop. Never reuse an older in-memory snapshot
  // after a failed intent/receipt write, even if an HTTP outcome looked successful.
  const result = await runPilot({ state, client, persist, log: console.log });
  const summary = { ...pilotSummary(result), apiRequests: client.requestCount };
  fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary));
  if (env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY,
      `### Bounded capture timing experiment\n\nVerified captures: ${summary.verifiedCaptures} of ${summary.dispatches} dispatch intents. Stop: ${summary.stopReason}. Pending outcome: ${summary.pendingOutcome || 'none'}.\n\nThis measures only this observation window. It does not establish continuous collection, full roster coverage, or interpretation accuracy. See the journal artifact for exact receipts.\n`);
  }
  return NORMAL_STOPS.has(result.stopReason) && !result.pending ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    console.error('Capture timing pilot stopped; inspect its journal artifact before any manual retry.');
    process.exitCode = 1;
  });
}
