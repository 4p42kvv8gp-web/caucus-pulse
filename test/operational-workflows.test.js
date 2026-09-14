import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { validatePublication } from '../.github/scripts/validate-publication.mjs';
import { captureNewsBase, packNews, applyNews } from '../.github/scripts/news-snapshot.mjs';
const ROOT = path.resolve(import.meta.dirname, '..');
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function write(dir, name, value) { const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); }
const state = { sinceId: '100', usage: {}, lastPollAt: '2026-09-13T11:00:00Z', lastPollOutcome: 'page-cap', pollProgress: { listId: 'list', baseSinceId: '100', newestId: '300', pages: 1, nextToken: 'p2' } };
const post = { id: '300', createdAt: '2026-09-13T12:00:00Z', text: 'synthetic' };

test('valid incomplete captures can publish, but an unchanged corrupt archive prevents publication', (t) => {
  const dir = temp(t);
  write(dir, 'data/state.json', state);
  write(dir, 'data/archive/2026-09-13.jsonl', `${JSON.stringify(post)}\n`);
  assert.doesNotThrow(() => validatePublication({ root: dir, files: ['data/state.json'] }));
  write(dir, 'data/archive/2026-09-12.jsonl', '{torn');
  assert.throws(() => validatePublication({ root: dir, files: ['data/state.json'] }), /Invalid JSONL/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'data/state.json'))).sinceId, '100');
});
test('invalid source identity and staged JSON cannot be published', (t) => {
  const dir = temp(t);
  write(dir, 'data/archive/2026-09-13.jsonl', JSON.stringify({ ...post, id: 'invented' }));
  assert.throws(() => validatePublication({ root: dir }), /Invalid archive record/);
  fs.rmSync(path.join(dir, 'data/archive/2026-09-13.jsonl'));
  write(dir, 'data/topics/day.json', '{torn');
  assert.throws(() => validatePublication({ root: dir, files: ['data/topics/day.json'] }), SyntaxError);
});
test('poll wrapper resumes existing classifications after exit 2 and preserves that incomplete result', (t) => {
  const dir = temp(t), bin = path.join(dir, 'bin'), log = path.join(dir, 'log');
  fs.mkdirSync(bin);
  for (const command of ['node', 'npm']) {
    const file = path.join(bin, command);
    fs.writeFileSync(file, `#!/bin/bash\nprintf '%s\\n' '${command}'" $*" >> "$CALL_LOG"\nif [ "$1 $2" = 'run poll' ]; then exit 2; fi\n`);
    fs.chmodSync(file, 0o755);
  }
  const r = spawnSync('bash', ['.github/scripts/poll.sh'], { cwd: ROOT, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: log }, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['npm run poll', 'node .github/scripts/validate-publication.mjs', 'npm run classify -- --resume-only', 'npm run sitedata']);
});
test('malicious or impossible workflow dates are rejected before any fetch', (t) => {
  const dir = temp(t), bin = path.join(dir, 'bin'), marker = path.join(dir, 'injected');
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  for (const value of [`2026-09-13;touch ${marker}`, '2026-02-30', '2026-13-01']) {
    const r = spawnSync('bash', ['.github/scripts/refresh-news.sh'], { cwd: ROOT, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RECONSIDER: value }, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /valid YYYY-MM-DD/);
  }
  assert.equal(fs.existsSync(marker), false);
});
test('news snapshot publishes unchanged-base results and refuses to overwrite concurrently newer news', (t) => {
  const dir = temp(t), publisher = path.join(dir, 'publisher'), collector = path.join(dir, 'collector'), snapshot = path.join(dir, 'snapshot');
  for (const root of [publisher, collector]) { write(root, 'data/news/status.json', { contextVersion: 1 }); write(root, 'data/news/items.jsonl', '{"id":"old"}\n'); }
  captureNewsBase(collector, snapshot);
  write(collector, 'data/news/status.json', { contextVersion: 2 });
  write(collector, 'data/news/items.jsonl', '{"id":"old"}\n{"id":"new"}\n');
  packNews(collector, snapshot);
  applyNews(publisher, snapshot);
  assert.equal(JSON.parse(fs.readFileSync(path.join(publisher, 'data/news/status.json'))).contextVersion, 2);
  assert.throws(() => applyNews(publisher, snapshot), /News base changed/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(publisher, 'data/news/status.json'))).contextVersion, 2);
});
test('news artifact corruption is detected before any destination file is changed', (t) => {
  const dir = temp(t), root = path.join(dir, 'source'), snapshot = path.join(dir, 'snapshot');
  write(root, 'data/news/status.json', { contextVersion: 1 });
  captureNewsBase(root, snapshot); packNews(root, snapshot);
  write(snapshot, 'status.json', { contextVersion: 999 });
  assert.throws(() => applyNews(root, snapshot), /Invalid news snapshot digest/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data/news/status.json'))).contextVersion, 1);
});
test('only news publication holds the capture writer lock; partial poll publication follows the pipeline even on failure', () => {
  const workflows = Object.fromEntries(['poll', 'nightly', 'news-context', 'authors'].map((name) => [name, yaml.load(fs.readFileSync(path.join(ROOT, '.github/workflows', `${name}.yml`), 'utf8'))]));
  for (const name of ['poll', 'nightly', 'authors']) {
    assert.equal(workflows[name].concurrency.group, 'data-writes');
    assert.equal(workflows[name].concurrency.queue, 'max');
  }
  assert.equal(workflows['news-context'].jobs.refresh.concurrency, undefined);
  assert.equal(workflows['news-context'].jobs.publish.concurrency.group, 'data-writes');
  assert.equal(workflows['news-context'].jobs.publish.concurrency.queue, 'max');
  const steps = workflows.poll.jobs.poll.steps;
  assert.match(steps.find((s) => s.name === 'Commit archive + site data').if, /steps.pipeline.outcome == 'failure'/);
  assert.ok(steps.findIndex((s) => s.name === 'Report incomplete pipeline after saving its work') > steps.findIndex((s) => s.name === 'Commit archive + site data'));
  assert.equal(workflows.nightly.jobs.nightly.steps.find((s) => s.run === '.github/scripts/nightly.sh').env.CLASSIFY_MAX_WAIT_MINUTES, "${{ inputs.classify_wait_minutes || '0' }}");
});

test('data publication pushes validated partial capture and refuses a subsequent torn archive', (t) => {
  const dir = temp(t), repo = path.join(dir, 'checkout'), remote = path.join(dir, 'remote.git'), runner = path.join(dir, 'runner');
  fs.mkdirSync(repo);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(dir, 'init', '--bare', remote); git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'synthetic'); git(repo, 'config', 'user.email', 'synthetic@example.invalid');
  git(repo, 'remote', 'add', 'origin', remote);
  for (const name of ['src/store.js', 'src/util.js', 'src/merge-state.js', 'src/merge-anthropic-usage.js', '.github/scripts/commit-data.sh', '.github/scripts/validate-publication.mjs']) write(repo, name, fs.readFileSync(path.join(ROOT, name), 'utf8'));
  write(repo, 'package.json', { type: 'module' }); write(repo, 'config/settings.json', {}); write(repo, 'data/state.json', { sinceId: '100', usage: {} });
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'synthetic baseline'); git(repo, 'push', '-u', 'origin', 'main');
  write(repo, 'data/state.json', state); write(repo, 'data/archive/2026-09-13.jsonl', `${JSON.stringify(post)}\n`);
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`, RUNNER_TEMP: runner };
  const published = spawnSync('bash', ['.github/scripts/commit-data.sh', 'synthetic partial', 'data'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(published.status, 0, published.stderr + published.stdout);
  assert.equal(JSON.parse(git(dir, '--git-dir', remote, 'show', 'main:data/state.json')).sinceId, '100');
  assert.ok(fs.existsSync(path.join(runner, 'caucus-pulse-recovery/validated-data.bundle')));
  const before = git(dir, '--git-dir', remote, 'rev-parse', 'main');
  fs.appendFileSync(path.join(repo, 'data/archive/2026-09-13.jsonl'), '{torn');
  const refused = spawnSync('bash', ['.github/scripts/commit-data.sh', 'must not publish', 'data'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.equal(git(dir, '--git-dir', remote, 'rev-parse', 'main'), before);
});

test('nightly defaults preserve core interpretation and opt in to longer taxonomy maintenance', (t) => {
  const dir = temp(t), bin = path.join(dir, 'bin'), log = path.join(dir, 'log');
  fs.mkdirSync(bin);
  write(bin, 'npm', '#!/bin/bash\nprintf "%s\\n" "$*" >> "$CALL_LOG"\n');
  fs.chmodSync(path.join(bin, 'npm'), 0o755);
  const run = (stages) => {
    fs.writeFileSync(log, '');
    const r = spawnSync('bash', ['.github/scripts/nightly.sh'], { cwd: ROOT, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, NIGHTLY_STAGES: stages, CALL_LOG: log }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return fs.readFileSync(log, 'utf8').trim().split('\n');
  };
  assert.deepEqual(run(''), ['run refresh', 'run embed', 'run classify', 'run corrections', 'run syntax', 'run incidents', 'run rollup', 'run report', 'run sitedata']);
  assert.deepEqual(run('stories,taxonomy-learn'), ['run stories', 'run taxonomy-learn -- --apply']);
  assert.ok(run('all').includes('run stories -- --auto-promote --retire'));
});

test('code integration triggers live smoke jobs while generated data pushes do not loop', () => {
  const poll = yaml.load(fs.readFileSync(path.join(ROOT, '.github/workflows/poll.yml'), 'utf8'));
  const news = yaml.load(fs.readFileSync(path.join(ROOT, '.github/workflows/news-context.yml'), 'utf8'));
  for (const workflow of [poll, news]) {
    assert.deepEqual(workflow.on.push.branches, ['main']);
    assert.ok(workflow.on.push.paths.every((p) => !p.startsWith('data/') && !p.startsWith('site/data/') && p !== '**'));
  }
  assert.ok(poll.on.push.paths.includes('src/**'));
  assert.ok(news.on.push.paths.includes('src/context-refresh.js'));
});

test('publication refuses missing feed shards, coverage mismatch, and corrupt incident output', (t) => {
  const dir = temp(t);
  write(dir, 'site/data/rollups.json', { feedAllFiles: ['feed-0.json'], feedAllTotal: 1 });
  assert.throws(() => validatePublication({ root: dir }), /ENOENT/);
  write(dir, 'site/data/feed-0.json', [post]);
  assert.doesNotThrow(() => validatePublication({ root: dir }));
  write(dir, 'site/data/feed-0.json', [post, post]);
  assert.throws(() => validatePublication({ root: dir }), /published coverage/);
  write(dir, 'site/data/feed-0.json', [post]);
  write(dir, 'data/incidents.json', '{broken');
  assert.throws(() => validatePublication({ root: dir }), SyntaxError);
});

test('every queued data writer checks out the current dispatched branch instead of an old event commit', () => {
  const directory = path.join(ROOT, '.github/workflows');
  const writers = [];
  for (const name of fs.readdirSync(directory).filter((name) => name.endsWith('.yml'))) {
    const workflow = yaml.load(fs.readFileSync(path.join(directory, name), 'utf8'));
    for (const [jobName, job] of Object.entries(workflow.jobs || {})) {
      if (!job.steps?.some((step) => String(step.run || '').includes('commit-data.sh'))) continue;
      writers.push(`${name}/${jobName}`);
      const checkout = job.steps.find((step) => /^actions\/checkout@/.test(step.uses || ''));
      assert.equal(checkout?.with?.ref, '${{ github.ref_name }}', `${name}/${jobName}: a queued writer must resolve the selected branch when it starts, not use the triggering event SHA`);
      assert.equal((job.concurrency || workflow.concurrency)?.group, 'data-writes', `${name}/${jobName}: branch resolution must happen inside the shared writer lock`);
    }
  }
  assert.deepEqual(writers.sort(), ['authors.yml/authors', 'news-context.yml/publish', 'nightly.yml/nightly', 'poll.yml/poll']);
});

test('news publication refreshes the dashboard without waiting for another capture', () => {
  const workflow = yaml.load(fs.readFileSync(path.join(ROOT, '.github/workflows/news-context.yml'), 'utf8'));
  const steps = workflow.jobs.publish.steps;
  const apply = steps.findIndex((s) => s.run?.includes('news-snapshot.mjs apply'));
  const saveNews = steps.findIndex((s) => s.run?.includes('commit-data.sh') && s.run?.includes('data/news'));
  const rebuild = steps.findIndex((s) => s.run === 'npm run sitedata');
  const saveDisplay = steps.findIndex((s) => s.run?.includes('commit-data.sh') && s.run?.includes('site/data'));
  assert.ok(apply >= 0 && saveNews > apply, 'save acquired reporting before deriving its display');
  assert.ok(rebuild > saveNews, 'a failed derived build must not discard the fetched news');
  assert.ok(saveDisplay > rebuild, 'fresh news must reach the dashboard in this workflow');
  assert.equal(workflow.jobs.publish.concurrency.group, 'data-writes');
});
