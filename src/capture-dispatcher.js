// Bounded, one-off capture scheduling experiment. This is not a production scheduler.
// The only remote mutation this module permits is dispatching poll.yml on main.
export const REPOSITORY = '4p42kvv8gp-web/caucus-pulse';
export const API_VERSION = '2026-03-10';
export const MAX_DURATION_MS = 50 * 60 * 1000;
export const MAX_DISPATCHES = 10;
export const MIN_CAPTURE_INTERVAL_MS = 5 * 60 * 1000;
export const ACTIVE_STATUSES = Object.freeze(['queued', 'pending', 'in_progress', 'requested', 'waiting']);
export const WRITER_PATHS = Object.freeze(['poll', 'nightly', 'authors', 'event-shadow', 'news-context'].map((name) => `.github/workflows/${name}.yml`));
// Observed GitHub-generated Pages runs have no .yml file. These and the three
// checked read-only workflows cannot publish capture state. Any other workflow
// conservatively blocks dispatch until its write behavior is reviewed.
const NON_WRITER_PATHS = new Set([
  'dynamic/pages/pages-build-deployment',
  '.github/workflows/test.yml',
  '.github/workflows/check-x-access.yml',
  '.github/workflows/anthropic-wif-test.yml'
]);
const API_ROOT = `https://api.github.com/repos/${REPOSITORY}`;
const WEB_ROOT = `https://github.com/${REPOSITORY}`;
const MAX_TICKS = 120;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveInt = (value) => Number.isSafeInteger(value) && value > 0;
const numericId = (value) => (positiveInt(value) || (typeof value === 'string' && /^[1-9]\d*$/.test(value) && positiveInt(Number(value)))) ? Number(value) : null;
const error = (code, httpStatus) => Object.assign(new Error(code), { code, ...(httpStatus ? { httpStatus } : {}) });
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = value.includes('.') ? value.replace(/\.(\d+)Z$/, (_, digits) => `.${digits.padEnd(3, '0')}Z`) : value.replace(/Z$/, '.000Z');
  return iso(parsed) === normalized ? parsed : null;
}
function instant(value = Date.now()) {
  const resolved = typeof value === 'function' ? value() : value;
  const ms = resolved instanceof Date ? resolved.getTime() : typeof resolved === 'number' ? resolved : timestamp(resolved);
  if (!Number.isFinite(ms)) throw error('invalid_clock');
  return ms;
}
const iso = (ms) => new Date(ms).toISOString();
const workflowPath = (path) => typeof path === 'string' ? path.split('@')[0] : '';
const apiRunUrl = (id) => `${API_ROOT}/actions/runs/${id}`;
const webRunUrl = (id) => `${WEB_ROOT}/actions/runs/${id}`;
function safeError(cause) {
  // Do not retain response text, arbitrary exception messages, URLs, or headers.
  const allowed = new Set(['request_timeout', 'request_failed', 'request_budget_exhausted', 'response_too_large', 'invalid_json', 'unexpected_http', 'incomplete_run_list', 'invalid_run_list', 'invalid_capture_state', 'invalid_run', 'invalid_dispatch_key']);
  return { code: allowed.has(cause?.code) ? cause.code : 'evidence_unavailable', ...(Number.isInteger(cause?.httpStatus) ? { httpStatus: cause.httpStatus } : {}) };
}
function captureProjection(value, sha) {
  if (!isObject(value) || timestamp(value.lastPollAt) === null || timestamp(value.lastPollAttemptAt) === null) throw error('invalid_capture_state');
  if ((value.lastPollRunId !== undefined && numericId(value.lastPollRunId) === null) || (value.lastPollRunAttempt !== undefined && numericId(value.lastPollRunAttempt) === null)) throw error('invalid_capture_state');
  return {
    lastPollAt: value.lastPollAt,
    lastPollAttemptAt: value.lastPollAttemptAt,
    ...(numericId(value.lastPollRunId) !== null ? { lastPollRunId: String(numericId(value.lastPollRunId)) } : {}),
    ...(numericId(value.lastPollRunAttempt) !== null ? { lastPollRunAttempt: numericId(value.lastPollRunAttempt) } : {}),
    ...(timestamp(value.lastPollSuccessAt) !== null ? { lastPollSuccessAt: value.lastPollSuccessAt } : {}),
    ...(typeof value.sinceId === 'string' && /^\d+$/.test(value.sinceId) ? { sinceId: value.sinceId } : {}),
    ...(typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha) ? { stateBlobSha: sha } : {})
  };
}
function runProjection(value, expectedId) {
  if (!isObject(value) || !positiveInt(value.id) || (expectedId && value.id !== expectedId) ||
      value.url !== apiRunUrl(value.id) || value.html_url !== webRunUrl(value.id) ||
      (!/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(workflowPath(value.path)) && workflowPath(value.path) !== 'dynamic/pages/pages-build-deployment') ||
      ![...ACTIVE_STATUSES, 'completed'].includes(value.status)) throw error('invalid_run');
  return {
    id: value.id, path: workflowPath(value.path), status: value.status,
    ...(positiveInt(value.run_attempt) ? { runAttempt: value.run_attempt } : {}),
    conclusion: value.conclusion === null || typeof value.conclusion === 'string' ? value.conclusion : null,
    url: value.url, htmlUrl: value.html_url,
    ...(typeof value.head_branch === 'string' ? { branch: value.head_branch } : {}),
    ...(typeof value.event === 'string' ? { event: value.event } : {}),
    ...(timestamp(value.created_at) !== null ? { createdAt: value.created_at } : {}),
    ...(timestamp(value.run_started_at) !== null ? { startedAt: value.run_started_at } : {})
  };
}

/** Fixed-repository, bounded REST client. No automatic HTTP retries, including GETs. */
export function createGitHubClient({ token, fetchImpl = fetch, timeoutMs = 10_000, maxRequests = 400, maxPages = 10 } = {}) {
  if (typeof token !== 'string' || !token.trim()) throw error('github_token_required');
  if (!positiveInt(timeoutMs) || timeoutMs > 30_000 || !positiveInt(maxRequests) || maxRequests > 500 || !positiveInt(maxPages) || maxPages > 10) throw error('invalid_client_bounds');
  let requestCount = 0;
  async function request(path, { method = 'GET', body } = {}) {
    if (requestCount >= maxRequests) throw error('request_budget_exhausted');
    requestCount++;
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(error('request_timeout')); }, timeoutMs);
    });
    const operation = (async () => {
      let response;
      try {
        response = await fetchImpl(`${API_ROOT}${path}`, {
          method, redirect: 'error', cache: 'no-store', signal: controller.signal,
          headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': API_VERSION, 'Cache-Control': 'no-cache', ...(body ? { 'Content-Type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {})
        });
      } catch { throw error(controller.signal.aborted ? 'request_timeout' : 'request_failed'); }
      const status = response.status;
      // Status is sufficient for rejected/uncertain dispatches. Never retain error bodies.
      if (status !== 200) return { status, data: null };
      if (Number(response.headers?.get?.('content-length') || 0) > MAX_RESPONSE_BYTES) throw error('response_too_large');
      let text;
      try {
        if (response.body?.getReader) {
          const reader = response.body.getReader(), chunks = [];
          let bytes = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) {
              void reader.cancel().catch(() => {});
              throw error('response_too_large');
            }
            chunks.push(Buffer.from(value));
          }
          text = Buffer.concat(chunks).toString('utf8');
        } else {
          text = await response.text();
          if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw error('response_too_large');
        }
      } catch (cause) {
        if (cause?.code === 'response_too_large') throw cause;
        throw error(controller.signal.aborted ? 'request_timeout' : 'request_failed');
      }
      try { return { status, data: JSON.parse(text) }; } catch { throw error('invalid_json'); }
    })();
    try { return await Promise.race([operation, deadline]); } finally { clearTimeout(timer); }
  }
  async function get(path) {
    const response = await request(path);
    if (response.status !== 200) throw error('unexpected_http', response.status);
    return response.data;
  }
  return {
    get requestCount() { return requestCount; },
    async listActiveWriters({ excludeRunId } = {}) {
      // This is a bounded observation, not an atomic lock. A run can be created
      // after a status query; poll.yml's shared data-writes concurrency remains
      // the authority preventing concurrent capture/publication.
      const writers = new Map();
      for (const status of ACTIVE_STATUSES) {
        let total = null;
        const seen = new Set();
        for (let page = 1; page <= maxPages; page++) {
          const data = await get(`/actions/runs?status=${status}&per_page=100&page=${page}`);
          if (!isObject(data) || !Number.isSafeInteger(data.total_count) || data.total_count < 0 || !Array.isArray(data.workflow_runs) || data.workflow_runs.length > 100) throw error('invalid_run_list');
          if (data.total_count > Math.min(1000, maxPages * 100) || (total !== null && total !== data.total_count)) throw error('incomplete_run_list');
          total = data.total_count;
          for (const row of data.workflow_runs) {
            const run = runProjection(row);
            if (seen.has(run.id)) throw error('incomplete_run_list');
            seen.add(run.id);
            if (run.id !== Number(excludeRunId) && run.status !== 'completed' && !NON_WRITER_PATHS.has(run.path)) writers.set(run.id, run);
          }
          if (seen.size === total) break;
          if (seen.size > total || data.workflow_runs.length < 100 || page === maxPages) throw error('incomplete_run_list');
        }
      }
      return { complete: true, runs: [...writers.values()] };
    },
    async getCaptureState() {
      const data = await get('/contents/data/state.json?ref=main');
      if (!isObject(data) || data.type !== 'file' || data.path !== 'data/state.json' || data.encoding !== 'base64' || typeof data.content !== 'string') throw error('invalid_capture_state');
      const content = data.content.replace(/\s/g, '');
      if (!content || content.length > MAX_RESPONSE_BYTES || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) throw error('invalid_capture_state');
      let value;
      try { value = JSON.parse(Buffer.from(content, 'base64').toString('utf8')); } catch { throw error('invalid_capture_state'); }
      return captureProjection(value, data.sha);
    },
    async getRun(runId) {
      if (!positiveInt(runId)) throw error('invalid_run');
      return runProjection(await get(`/actions/runs/${runId}`), runId);
    },
    async dispatch({ dispatchKey }) {
      if (typeof dispatchKey !== 'string' || !/^capture-pilot-\d+-\d+$/.test(dispatchKey)) throw error('invalid_dispatch_key');
      return request('/actions/workflows/poll.yml/dispatches', { method: 'POST', body: { ref: 'main', inputs: { capture_only: true, dispatch_key: dispatchKey } } });
    }
  };
}

export function initialState({ now = Date.now(), controllerRunId, durationMs = MAX_DURATION_MS, maxDispatches = MAX_DISPATCHES } = {}) {
  const at = instant(now);
  const id = Number(controllerRunId);
  if (!positiveInt(id) || !positiveInt(durationMs) || durationMs > MAX_DURATION_MS || !positiveInt(maxDispatches) || maxDispatches > MAX_DISPATCHES) throw error('invalid_pilot_bounds');
  return {
    schemaVersion: 1, repository: REPOSITORY, controllerRunId: id,
    startedAt: iso(at), deadlineAt: iso(at + durationMs), maxDispatches,
    status: 'active', stopReason: null, tickCount: 0, dispatches: 0,
    pending: null, decisions: [], completed: []
  };
}

/**
 * One scheduling decision. Caller supplies an atomic durable persist(snapshot) and
 * replaces its state with the returned snapshot. A persisted intent is NEVER retried.
 * No timers or repeat dispatch loop live here. Terminal state performs no API calls.
 */
export async function tick({ state, client, persist, now = Date.now } = {}) {
  if (!isObject(state) || state.schemaVersion !== 1 || state.repository !== REPOSITORY || !positiveInt(state.controllerRunId) ||
      !Array.isArray(state.decisions) || !Array.isArray(state.completed) || typeof persist !== 'function' ||
      timestamp(state.startedAt) === null || timestamp(state.deadlineAt) === null ||
      timestamp(state.deadlineAt) <= timestamp(state.startedAt) || timestamp(state.deadlineAt) - timestamp(state.startedAt) > MAX_DURATION_MS ||
      !positiveInt(state.maxDispatches) || state.maxDispatches > MAX_DISPATCHES ||
      !Number.isInteger(state.dispatches) || state.dispatches < 0 || state.dispatches > state.maxDispatches ||
      !Number.isInteger(state.tickCount) || state.tickCount < 0 || !['active', 'stopped'].includes(state.status)) throw error('invalid_pilot_state');
  const next = structuredClone(state);
  if (next.status === 'stopped') return next;
  let at = instant(now);
  const decision = (kind, fields = {}) => { next.decisions.push({ at: iso(at), kind, ...fields }); };
  async function save() {
    try { await persist(structuredClone(next)); } catch { throw error('journal_write_failed'); }
    return next;
  }
  async function stop(reason, fields = {}) {
    next.status = 'stopped'; next.stopReason = reason;
    decision(reason, fields);
    return save();
  }
  next.tickCount++;
  if (next.pending?.phase === 'intent') return stop('uncertain_dispatch');
  if (at < timestamp(next.startedAt)) return stop('clock_moved_backwards');
  if (at >= timestamp(next.deadlineAt)) return stop('duration_complete');
  if (next.tickCount > MAX_TICKS) return stop('tick_limit');
  try {
    if (next.pending) {
      const pending = next.pending;
      if (pending.phase !== 'accepted' || !positiveInt(pending.runId) || timestamp(pending.intentAt) === null || timestamp(pending.baselineCaptureAt) === null) return stop('invalid_pending_receipt');
      const run = await client.getRun(pending.runId);
      if (run.id !== pending.runId || run.path !== '.github/workflows/poll.yml' || run.branch !== 'main' || run.event !== 'workflow_dispatch' || ![...ACTIVE_STATUSES, 'completed'].includes(run.status)) return stop('invalid_child_run');
      if (run.status !== 'completed') {
        decision('waiting_for_child', { runId: run.id, runStatus: run.status });
        return save();
      }
      const capture = captureProjection(await client.getCaptureState());
      at = instant(now);
      const captureAdvanced = timestamp(capture.lastPollAt) > timestamp(pending.baselineCaptureAt) && timestamp(capture.lastPollAt) >= timestamp(pending.intentAt) && timestamp(capture.lastPollAt) <= at;
      const captureAttributed = capture.lastPollRunId === String(run.id) && positiveInt(run.runAttempt) && capture.lastPollRunAttempt === run.runAttempt;
      const captureVerified = captureAdvanced && captureAttributed;
      next.completed.push({
        runId: run.id, dispatchAt: pending.intentAt, observedAt: iso(at), conclusion: run.conclusion,
        baselineCaptureAt: pending.baselineCaptureAt, captureAt: capture.lastPollAt, captureAdvanced, captureAttributed, captureVerified,
        ...(capture.lastPollRunId ? { captureRunId: capture.lastPollRunId } : {}), ...(capture.lastPollRunAttempt ? { captureRunAttempt: capture.lastPollRunAttempt } : {}),
        ...(run.createdAt ? { createdAt: run.createdAt } : {}), ...(run.startedAt ? { startedAt: run.startedAt } : {})
      });
      next.pending = null;
      decision('child_completed', { runId: run.id, conclusion: run.conclusion, captureAdvanced, captureAttributed, captureVerified, captureAt: capture.lastPollAt });
      if (run.conclusion !== 'success') return stop('child_failed', { runId: run.id, captureVerified });
      if (!captureAdvanced) return stop('capture_not_advanced', { runId: run.id });
      if (!captureAttributed) return stop('capture_not_attributed', { runId: run.id });
      // Persist the completed receipt before considering another remote mutation.
      await save();
    }
    if (next.dispatches >= next.maxDispatches) return stop('dispatch_limit');
    const active = await client.listActiveWriters({ excludeRunId: next.controllerRunId });
    if (!active || active.complete !== true || !Array.isArray(active.runs)) return stop('incomplete_writer_evidence');
    if (active.runs.length) {
      decision('writer_busy', { runs: active.runs.map(({ id, path, status }) => ({ id, path, status })) });
      return save();
    }
    const capture = captureProjection(await client.getCaptureState());
    at = instant(now);
    if (at < timestamp(next.startedAt)) return stop('clock_moved_backwards');
    if (at >= timestamp(next.deadlineAt)) return stop('duration_complete');
    const captureTime = timestamp(capture.lastPollAt);
    const attemptTime = timestamp(capture.lastPollAttemptAt);
    if (captureTime > at || attemptTime > at) return stop('future_capture_clock');
    if (at - Math.max(captureTime, attemptTime) < MIN_CAPTURE_INTERVAL_MS || (next.lastDispatchAt && at - timestamp(next.lastDispatchAt) < MIN_CAPTURE_INTERVAL_MS)) {
      decision('capture_recent', { lastPollAt: capture.lastPollAt, lastPollAttemptAt: capture.lastPollAttemptAt });
      return save();
    }
    const dispatchKey = `capture-pilot-${next.controllerRunId}-${next.dispatches + 1}`;
    next.dispatches++;
    next.lastDispatchAt = iso(at);
    next.pending = { phase: 'intent', dispatchKey, intentAt: iso(at), baselineCaptureAt: capture.lastPollAt, baselineAttemptAt: capture.lastPollAttemptAt };
    decision('dispatch_intent', { dispatchKey, baselineCaptureAt: capture.lastPollAt, baselineAttemptAt: capture.lastPollAttemptAt });
    // A failed intent write must throw before POST, never degrade to an unjournaled call.
    await save();
    at = instant(now);
    if (at < timestamp(next.lastDispatchAt) || at >= timestamp(next.deadlineAt)) {
      next.pending = { ...next.pending, phase: 'not_sent' };
      return stop(at < timestamp(next.lastDispatchAt) ? 'clock_moved_backwards' : 'duration_complete');
    }
    let response;
    try { response = await client.dispatch({ dispatchKey }); } catch (cause) { return stop('uncertain_dispatch', safeError(cause)); }
    const data = response?.data;
    if (response?.status >= 400 && response.status < 500 && response.status !== 408) {
      next.pending = { ...next.pending, phase: 'rejected', httpStatus: response.status };
      return stop('dispatch_rejected', { httpStatus: response.status });
    }
    if (response?.status !== 200 || !isObject(data) || !positiveInt(data.workflow_run_id) || data.run_url !== apiRunUrl(data.workflow_run_id) || data.html_url !== webRunUrl(data.workflow_run_id)) return stop('uncertain_dispatch', { ...(Number.isInteger(response?.status) ? { httpStatus: response.status } : {}) });
    next.pending = { ...next.pending, phase: 'accepted', runId: data.workflow_run_id, runUrl: data.run_url, htmlUrl: data.html_url };
    decision('dispatch_accepted', { dispatchKey, runId: data.workflow_run_id, runUrl: data.run_url, htmlUrl: data.html_url });
    // If this write fails, the durable intent remains. Reloading it stops safely.
    return save();
  } catch (cause) {
    // A persistence error may occur either side of POST. Stop the caller immediately;
    // do not hide it by continuing with its older snapshot and retrying a mutation.
    if (cause?.code === 'journal_write_failed') throw cause;
    return stop('evidence_unavailable', safeError(cause));
  }
}
