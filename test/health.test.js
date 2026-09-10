import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkCapture, checkClassification, checkAssignments, checkCredentials, checkBudget,
  worstStatus, CAPTURE_WARN_HOURS, CAPTURE_FAIL_HOURS
} from '../src/health.js';

const HOURS = 60 * 60 * 1000;
const now = Date.parse('2026-09-10T12:00:00Z');
const hoursAgo = (h) => new Date(now - h * HOURS).toISOString();

test('capture is ok on cadence, warns when late, fails when the window is at risk', () => {
  assert.equal(checkCapture({ lastPollAt: hoursAgo(0.3) }, now).status, 'ok');
  assert.equal(checkCapture({ lastPollAt: hoursAgo(CAPTURE_WARN_HOURS + 0.5) }, now).status, 'warn');
  assert.equal(checkCapture({ lastPollAt: hoursAgo(CAPTURE_FAIL_HOURS + 1) }, now).status, 'fail');
  assert.equal(checkCapture({}, now).status, 'fail'); // never ran
});

test('classification fails when the most recent closed day is unclassified', () => {
  const dates = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10'];
  const today = '2026-09-10';
  const all = new Set(['2026-09-07', '2026-09-08', '2026-09-09']);

  assert.equal(checkClassification({ dates, today, hasTopics: (d) => all.has(d) }).status, 'ok');
  // today is never expected to be classified yet
  assert.equal(checkClassification({ dates, today, hasTopics: (d) => all.has(d) }).detail.includes('2026-09-10'), false);
  // the night the classifier could not authenticate
  assert.equal(checkClassification({ dates, today, hasTopics: (d) => d !== '2026-09-09' }).status, 'fail');
  // an older hole is worth flagging but is not tonight's problem
  assert.equal(checkClassification({ dates, today, hasTopics: (d) => d !== '2026-09-07' }).status, 'warn');
});

test('assignments catch a topics file that came back empty', () => {
  const d = '2026-09-09';
  assert.equal(checkAssignments({ date: d, postCount: 100, assignmentCount: 98 }).status, 'ok');
  assert.equal(checkAssignments({ date: d, postCount: 100, assignmentCount: 70 }).status, 'warn');
  assert.equal(checkAssignments({ date: d, postCount: 100, assignmentCount: 0 }).status, 'fail');
  assert.equal(checkAssignments({ date: d, postCount: 0, assignmentCount: 0 }).status, 'ok');
});

test('credentials fail closed when either side is unresolvable', () => {
  assert.equal(checkCredentials({ x: 'proxy', anthropic: 'federation' }).status, 'ok');
  assert.equal(checkCredentials({ x: null, anthropic: 'federation' }).status, 'fail');
  assert.equal(checkCredentials({ x: 'token', anthropic: null }).status, 'fail');
});

test('budget warns near the ceiling and fails once the guard has tripped', () => {
  const today = '2026-09-10';
  const at = (posts) => ({ usage: { [today]: { posts, users: 0 } } });
  assert.equal(checkBudget(at(1000), { budget: 50000, today }).status, 'ok');
  assert.equal(checkBudget(at(45000), { budget: 50000, today }).status, 'warn');
  assert.equal(checkBudget(at(50000), { budget: 50000, today }).status, 'fail');
});

test('worstStatus reports the most severe check', () => {
  assert.equal(worstStatus([{ status: 'ok' }, { status: 'ok' }]), 'ok');
  assert.equal(worstStatus([{ status: 'ok' }, { status: 'warn' }]), 'warn');
  assert.equal(worstStatus([{ status: 'warn' }, { status: 'fail' }]), 'fail');
});
