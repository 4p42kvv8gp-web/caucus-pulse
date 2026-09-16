// Interpretation health is independent of source capture and file publication.
// Only an actual request/result receipt can move the attempt/success clocks.
const REASONS = new Set(['provider-credits', 'provider-auth', 'provider-rate-limit',
  'provider-unavailable', 'invalid-response', 'inference-error']);
const iso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString() : null;

export function inferenceFailureReason(error) {
  const status = Number(error?.status);
  const type = error?.error?.error?.type || error?.error?.type || error?.type;
  const message = String(error?.message || error?.error?.error?.message || error?.error?.message || error || '');
  if (/credit balance is too low|insufficient (?:api )?credits/i.test(message)) return 'provider-credits';
  if ([401, 403].includes(status) || type === 'authentication_error' || type === 'permission_error'
    || /(?:^|\s)(?:401|403)\b|authentication_error|token exchange failed/i.test(message)) return 'provider-auth';
  if (status === 429 || type === 'rate_limit_error' || /rate_limit_error/.test(message)) return 'provider-rate-limit';
  if (status >= 500 || type === 'overloaded_error' || /overloaded_error|provider unavailable/i.test(message)) return 'provider-unavailable';
  return 'inference-error';
}

export const stopsInferenceRun = (reason) => ['provider-credits', 'provider-auth'].includes(reason);

export function inferenceReceipt(request, { attemptedAt, observedAt, kind = 'sync' } = {}) {
  const acceptedCount = request?.acceptedIds?.length || 0;
  const retryCount = request?.retryIds?.length || 0;
  const failed = Boolean(request?.error || retryCount);
  return { attemptedAt: iso(attemptedAt), observedAt: iso(observedAt), kind,
    status: failed ? (acceptedCount ? 'partial' : 'failed') : 'complete',
    reasonCode: failed ? (REASONS.has(request?.reasonCode) ? request.reasonCode
      : request?.error ? inferenceFailureReason(request.error) : 'invalid-response') : null,
    acceptedCount, retryCount };
}

function validReceipt(value) {
  if (!value || !iso(value.attemptedAt) || !iso(value.observedAt)
    || Date.parse(value.observedAt) < Date.parse(value.attemptedAt)
    || !['complete', 'partial', 'failed'].includes(value.status)
    || !Number.isInteger(value.acceptedCount) || value.acceptedCount < 0
    || !Number.isInteger(value.retryCount) || value.retryCount < 0
    || (value.status === 'complete' && value.retryCount !== 0)
    || (value.status === 'failed' && value.acceptedCount !== 0)
    || (value.status === 'partial' && (!value.acceptedCount || !value.retryCount))) return null;
  return { attemptedAt: iso(value.attemptedAt), observedAt: iso(value.observedAt),
    kind: value.kind === 'batch-result' ? 'batch-result' : 'sync', status: value.status,
    reasonCode: value.status === 'complete' ? null : REASONS.has(value.reasonCode) ? value.reasonCode : 'inference-error',
    acceptedCount: value.acceptedCount, retryCount: value.retryCount };
}

// An old batch collected after a newer failed live call cannot establish that
// new requests work again. Order by submission/attempt time, then observation.
function latest(receipts) {
  const severity = (r) => stopsInferenceRun(r.reasonCode) ? 3 : r.status === 'failed' ? 2 : r.status === 'partial' ? 1 : 0;
  return receipts.filter(Boolean).sort((a, b) => Date.parse(b.attemptedAt) - Date.parse(a.attemptedAt)
    || Date.parse(b.observedAt) - Date.parse(a.observedAt)
    || severity(b) - severity(a) || String(a.reasonCode).localeCompare(String(b.reasonCode)))[0] || null;
}

export function mergeInferenceHealth(previous, requestStatus = {}) {
  const receipts = [previous?.lastAttempt, previous?.lastSuccess, previous?.lastFailure,
    ...Object.values(requestStatus).filter((row) => !row?.deferred).map((row) => row?.inference)]
    .map(validReceipt).filter(Boolean);
  if (!receipts.length) return previous?.schemaVersion === 1 ? previous : null;
  return { schemaVersion: 1, lastAttempt: latest(receipts),
    lastSuccess: latest(receipts.filter((r) => r.acceptedCount > 0)),
    lastFailure: latest(receipts.filter((r) => r.status !== 'complete')) };
}

export function buildInferenceHealth(files, coverage, { now = Date.now() } = {}) {
  const receipts = files.flatMap((file) => [file?.inference?.lastAttempt, file?.inference?.lastSuccess, file?.inference?.lastFailure])
    .map(validReceipt).filter((r) => r && Date.parse(r.observedAt) <= now && Date.parse(r.attemptedAt) <= now);
  const last = latest(receipts);
  const success = latest(receipts.filter((r) => r.acceptedCount > 0));
  const pending = coverage.pendingIn24h || 0;
  // Legacy status rows lack actual request timestamps. Surface a stored error
  // when coverage is incomplete, but do not manufacture an attempt/success date
  // from classifiedAt/updatedAt. New explicit receipts supersede this fallback.
  const legacy = !last && pending > 0 ? files.filter(Boolean)
    .sort((a, b) => Date.parse(b.updatedAt || b.classifiedAt || 0) - Date.parse(a.updatedAt || a.classifiedAt || 0))
    .flatMap((file) => Object.values(file.requestStatus || {}).filter((row) => (row?.retryIds || []).some((id) =>
      !file.corrected?.[id] && (!Object.hasOwn(file.assignments || {}, id)
        || (file.pendingIds || []).includes(id) || (file.unclassified || []).includes(id)))))
    .find((row) => !row?.deferred && (row?.error || row?.retryIds?.length)) : null;
  const hasCurrentFailure = last ? last.status !== 'complete' : Boolean(legacy);
  const reasonCode = hasCurrentFailure ? (last?.reasonCode || (legacy?.error ? inferenceFailureReason(legacy.error) : 'invalid-response')) : null;
  const status = hasCurrentFailure ? (stopsInferenceRun(reasonCode) ? 'blocked' : 'degraded')
    : pending > 0 ? 'pending' : last ? 'healthy' : 'unknown';
  return { status, reasonCode, hasCurrentFailure,
    lastAttemptAt: last?.attemptedAt || null, lastSuccessAt: success?.observedAt || null,
    capturedIn24h: coverage.capturedIn24h || 0, classifiedIn24h: coverage.classifiedIn24h || 0,
    pendingIn24h: pending, coverageComplete: pending === 0 };
}
