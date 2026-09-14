import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const root = path.resolve(import.meta.dirname, '..');
const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/poll.yml'), 'utf8'));
const job = workflow.jobs.poll;
const steps = job.steps;
const indexOf = (id) => steps.findIndex((step) => step.id === id);
const stepById = (id) => steps.find((step) => step.id === id);

test('repost lookup runs only after successful capture publication inside the shared writer lock', () => {
  assert.equal(workflow.concurrency.group, 'data-writes');
  assert.equal(workflow.concurrency.queue, 'max');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, '${{ github.ref_name }}');
  const capture = stepById('capture_commit');
  const acquire = stepById('repost_sources');
  assert.ok(indexOf('capture_commit') > indexOf('pipeline'));
  assert.ok(indexOf('repost_sources') > indexOf('capture_commit'));
  assert.match(capture.run, /commit-data\.sh/);
  assert.match(capture.if, /steps\.pipeline\.outcome == 'failure'/, 'failed capture still saves its validated progress');
  assert.equal(acquire.if, "${{ success() && steps.pipeline.outcome == 'success' && steps.capture_commit.outcome == 'success' }}", 'lookup must not run after a failed pipeline, failed push, skipped capture or cancellation');
  assert.equal(acquire.run, 'node --use-env-proxy src/repost-acquire.js');
  assert.deepEqual(acquire.env, { X_BEARER_TOKEN: '${{ secrets.X_BEARER_TOKEN }}' });
  assert.equal(acquire['continue-on-error'], true, 'failure must allow cache publication and explicit reporting');
  assert.equal(acquire['timeout-minutes'], 4);
  assert.ok(job['timeout-minutes'] >= stepById('pipeline')['timeout-minutes'] + acquire['timeout-minutes'] + 5, 'leave time for setup, publication and recovery artifacts');
});

test('accepted cached originals are displayed and published after either acquisition outcome without another inference pass', () => {
  const display = stepById('repost_display');
  const publishIndex = steps.findIndex((step) => step.name === 'Commit recovered sources + site data');
  const publish = steps[publishIndex];
  assert.ok(indexOf('repost_display') > indexOf('repost_sources'));
  assert.ok(publishIndex > indexOf('repost_display'));
  for (const step of [display, publish]) {
    assert.match(step.if, /!cancelled\(\)/);
    assert.match(step.if, /steps\.capture_commit\.outcome == 'success'/);
    assert.match(step.if, /steps\.repost_sources\.outcome == 'success'/);
    assert.match(step.if, /steps\.repost_sources\.outcome == 'failure'/);
  }
  assert.equal(display.run, 'npm run sitedata');
  assert.equal(display['timeout-minutes'], 2);
  assert.match(publish.run.trim(), /data site\/data$/);
  assert.ok(!steps.slice(indexOf('repost_sources')).some((step) => /classify|poll\.sh|npm run poll/.test(step.run || '')), 'recovery must wait for the next ordinary inference pass');
});

test('explicit failure reporting precedes recovery artifact retention, including pipeline and acquisition failures', () => {
  const pipelineReport = steps.findIndex((step) => step.name === 'Report incomplete pipeline after saving its work');
  const sourceReport = steps.findIndex((step) => step.name === 'Report incomplete source acquisition after saving its work');
  const publish = steps.findIndex((step) => step.name === 'Commit recovered sources + site data');
  const uploadIndex = steps.findIndex((step) => step.uses?.startsWith('actions/upload-artifact@'));
  const upload = steps[uploadIndex];
  assert.ok(pipelineReport > publish && sourceReport > publish);
  assert.match(steps[pipelineReport].if, /!cancelled\(\).*steps\.pipeline\.outcome == 'failure'/);
  assert.match(steps[sourceReport].if, /!cancelled\(\).*steps\.repost_sources\.outcome == 'failure'/);
  assert.equal(steps[pipelineReport].run, 'exit 1');
  assert.equal(steps[sourceReport].run, 'exit 1');
  assert.equal(uploadIndex, steps.length - 1, 'artifact retention must observe failures from every publication and report path');
  assert.match(upload.if, /failure\(\)/);
  for (const file of ['validated-data.bundle', 'data/repost-acquisition.json', 'data/quoted.json', 'data/state.json']) assert.ok(upload.with.path.includes(file));
  assert.equal(upload.with['retention-days'], 7);
});

test('bounded source acquisition adds no independent or nightly job and data publication cannot trigger a loop', () => {
  const directory = path.join(root, '.github/workflows');
  const owners = [];
  for (const name of fs.readdirSync(directory).filter((name) => name.endsWith('.yml'))) {
    const document = yaml.load(fs.readFileSync(path.join(directory, name), 'utf8'));
    for (const [jobName, current] of Object.entries(document.jobs || {})) {
      for (const step of current.steps || []) if (step.run?.includes('src/repost-acquire.js')) owners.push(`${name}/${jobName}`);
    }
  }
  assert.deepEqual(owners, ['poll.yml/poll']);
  assert.deepEqual(Object.keys(workflow.jobs), ['poll']);
  assert.ok(workflow.on.push.paths.every((pattern) => !pattern.startsWith('data/') && !pattern.startsWith('site/data/') && pattern !== '**'));
});
