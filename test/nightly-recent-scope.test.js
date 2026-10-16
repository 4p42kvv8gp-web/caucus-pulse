import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { classificationDate } from '../.github/scripts/classify-date.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('npm nightly uses the same bounded, failure-tolerant runner as Actions', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.nightly, 'bash .github/scripts/nightly.sh');
});

test('manual nightly catch-up passes the date to the validating runner', () => {
  const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/nightly.yml'), 'utf8'));
  assert.equal(workflow.on.workflow_dispatch.inputs.classify_date.default, '');
  const runner = workflow.jobs.nightly.steps.find((s) => s.run === '.github/scripts/nightly.sh');
  assert.equal(runner.env.NIGHTLY_CLASSIFY_DATE, '${{ inputs.classify_date }}');
});
for (const [now, expected] of [
  ['2026-10-16T07:30:00Z', '2026-10-15'],
  ['2026-10-16T03:30:00Z', '2026-10-14'],
  ['2026-03-09T04:30:00Z', '2026-03-08'],
  ['2026-11-02T04:30:00Z', '2026-10-31'],
  ['2026-11-02T05:30:00Z', '2026-11-01'],
  ['2026-01-01T08:00:00Z', '2025-12-31'],
  ['2024-03-01T08:00:00Z', '2024-02-29']
]) test(`nightly chooses the last closed ET day at ${now}`, () => {
  assert.equal(classificationDate({ now }), expected);
});

test('explicit historical day is allowed', () => {
  assert.equal(classificationDate({ now: '2026-10-16T08:00:00Z', override: '2026-10-14' }), '2026-10-14');
});
for (const override of ['all', '2026-02-30', '2026-10-16', '2026-10-17', ' --sync', null]) {
  test(`invalid or unclosed override fails: ${String(override)}`, () => {
    assert.throws(() => classificationDate({ now: '2026-10-16T08:00:00Z', override }));
  });
}
test('invalid clock fails closed', () => assert.throws(() => classificationDate({ now: 'invalid' })));

function runNightly(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sam-nightly-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'npm'), '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$CALL_LOG"\nif [ "${FAIL_STAGE:-}" = "${2:-}" ]; then exit 9; fi\n', { mode: 0o755 });
  const log = path.join(dir, 'calls');
  const result = spawnSync('bash', ['.github/scripts/nightly.sh'], {
    cwd: root, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PATH: `${dir}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
      CALL_LOG: log, NIGHTLY_CLASSIFY_DATE: '2025-01-15', NIGHTLY_STAGES: 'classify,rollup,report,sitedata', FAIL_STAGE: '', ...extra }
  });
  assert.ifError(result.error);
  return { ...result, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [] };
}

test('nightly passes a single date and keeps deterministic publication stages', (t) => {
  const r = runNightly(t);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, ['run classify -- --date=2025-01-15', 'run rollup', 'run report', 'run sitedata']);
});
test('classification failure is red, but report and site still run', (t) => {
  const r = runNightly(t, { FAIL_STAGE: 'classify' });
  assert.equal(r.status, 1);
  assert.ok(r.calls.includes('run sitedata'));
  assert.match(r.stdout, /stage\(s\) failed: classify/);
});
test('bad date never triggers an unbounded paid request', (t) => {
  const r = runNightly(t, { NIGHTLY_CLASSIFY_DATE: 'all' });
  assert.equal(r.status, 1);
  assert.ok(!r.calls.some((c) => c.startsWith('run classify')));
  assert.ok(r.calls.includes('run report'));
});
test('unselected classify does not resolve its date or call inference', (t) => {
  const r = runNightly(t, { NIGHTLY_STAGES: 'report', NIGHTLY_CLASSIFY_DATE: 'invalid' });
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, ['run report']);
});
test('all stages still means date-scoped classification, not all history', (t) => {
  const r = runNightly(t, { NIGHTLY_STAGES: 'all' });
  assert.equal(r.status, 0);
  assert.ok(r.calls.includes('run classify -- --date=2025-01-15'));
  assert.ok(r.calls.includes('run taxonomy-learn -- --apply'));
});
