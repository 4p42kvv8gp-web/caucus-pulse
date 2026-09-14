// Durable, bounded shadow interpretation. This module never touches ordinary
// topics/corrections or promotes events to the dashboard. Persistence and the
// scheduler's single-writer checkpoint are injected by the caller.
import { createHash } from 'node:crypto';

const STATES = new Set(['planned', 'submitting', 'response-saved', 'accepted', 'partial', 'submission-unknown', 'superseded']);
const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const params = (plan) => plan.request.params ?? plan.request;
function checkPlan(plan) {
  if (!object(plan) || typeof plan.key !== 'string' || !plan.key || ['__proto__', 'constructor', 'prototype'].includes(plan.key)
      || !object(plan.request) || !Array.isArray(plan.posts) || !plan.posts.length
      || plan.posts.some((p) => !object(p) || typeof p.id !== 'string' || !p.id)
      || new Set(plan.posts.map((p) => p.id)).size !== plan.posts.length
      || ['sourceHash', 'correctionHash', 'policyVersion'].some((k) => typeof plan[k] !== 'string' || !plan[k])
      || !['retrospective', 'as-of'].includes(plan.mode)
      || typeof plan.runAsOf !== 'string' || !Number.isFinite(Date.parse(plan.runAsOf))) throw new Error('Invalid shadow event plan');
}
// A receipt freezes the original request and observation time. Advancing the
// run clock alone must not resubmit an already interpreted source manifest.
const identity = (plan) => hash({ sourceHash: plan.sourceHash, correctionHash: plan.correctionHash,
  policyVersion: plan.policyVersion, mode: plan.mode, model: params(plan).model,
  postIds: plan.posts.map((p) => p.id) });
const rejection = (error) => error?.requestSent === false || error?.status === 429 || error?.status === 529
  || (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 && error.status !== 408);
const retryable = (error) => error?.status === 429 || error?.status === 529 || error?.requestSent === false;
const errorInfo = (error) => ({ message: String(error?.message || error).slice(0, 500),
  ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
  ...(typeof error?.code === 'string' ? { code: error.code } : {}) });

export async function runEventShadow(plans, {
  state, save, checkpoint = async () => {}, client, refresh = async () => {}, validate,
  currentSnapshot, now = () => new Date().toISOString(), maxCalls = 2
} = {}) {
  if (!object(state) || state.version !== 1 || !object(state.receipts) || !Array.isArray(state.events)
      || !Array.isArray(plans) || !integer(maxCalls)
      || [save, checkpoint, refresh, validate, currentSnapshot].some((fn) => typeof fn !== 'function')) throw new Error('Invalid shadow runner dependencies/state');
  const timestamp = () => {
    const value = typeof now === 'function' ? now() : now;
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Invalid shadow runner clock');
    return value;
  };
  let sum = 0;
  for (const [key, receipt] of Object.entries(state.receipts)) {
    checkPlan(receipt.plan);
    if (receipt.plan.key !== key || !STATES.has(receipt.status) || !integer(receipt.attempts)) throw new Error('Invalid shadow receipt');
    sum += receipt.attempts;
  }
  if ((state.attempts != null && (!integer(state.attempts) || state.attempts < sum))
      || (state.maxCalls != null && !integer(state.maxCalls))) throw new Error('Invalid shadow attempt ledger');
  state.attempts ??= sum;
  state.maxCalls = Math.min(state.maxCalls ?? maxCalls, maxCalls);
  const persist = async (remote = false) => { await save(state); if (remote) await checkpoint(state); };
  const removeEvents = (key) => { state.events = state.events.filter((e) => e.receiptKey !== key); };
  async function isCurrent(receipt) {
    const snapshot = await currentSnapshot(receipt.plan);
    if (!object(snapshot) || typeof snapshot.sourceHash !== 'string' || typeof snapshot.correctionHash !== 'string') throw new Error('Invalid current source/correction snapshot');
    if (snapshot.sourceHash === receipt.plan.sourceHash && snapshot.correctionHash === receipt.plan.correctionHash) return true;
    receipt.supersededFrom = receipt.status;
    receipt.status = 'superseded'; receipt.supersededAt = timestamp(); receipt.currentSnapshot = clone(snapshot);
    removeEvents(receipt.plan.key);
    await persist(true);
    return false;
  }
  for (const plan of plans) {
    checkPlan(plan);
    if (Object.hasOwn(state.receipts, plan.key)) {
      if (identity(state.receipts[plan.key].plan) !== identity(plan)) throw new Error(`Shadow request key collision: ${plan.key}`);
      continue;
    }
    state.receipts[plan.key] = { plan: clone(plan), inputHash: hash(plan.request),
      postIds: plan.posts.map((p) => p.id), status: 'planned', attempts: 0, plannedAt: timestamp() };
  }
  await persist();

  // Never infer that a request was unsent because its response was not saved.
  // This also covers a process that exited between the checkpoint and the call.
  for (const receipt of Object.values(state.receipts)) {
    if (receipt.status !== 'submitting') continue;
    receipt.status = 'submission-unknown'; receipt.unknownAt = timestamp();
    receipt.error = { message: 'Interrupted submission: reconcile provider outcome; automatic retry disabled' };
    await persist(true);
  }
  let calls = 0;
  for (const receipt of Object.values(state.receipts)) {
    if (receipt.status === 'superseded') continue;
    if (!(await isCurrent(receipt))) continue;
    if (['accepted', 'partial', 'submission-unknown'].includes(receipt.status)) continue;
    if (receipt.status === 'planned') {
      if (receipt.retryable === false || state.attempts >= state.maxCalls) continue;
      if (typeof client?.messages?.create !== 'function') throw new Error('Shadow model client is unavailable');
      await refresh();
      // Refresh/checkpoint can take time: source changes before the paid call
      // should not consume another interpretation attempt.
      if (!(await isCurrent(receipt))) continue;
      receipt.status = 'submitting'; receipt.submittedAt = timestamp(); receipt.attempts++;
      state.attempts++; delete receipt.error; delete receipt.retryable;
      await persist(true); // BOTH local save and durable checkpoint must finish
      let message;
      try {
        calls++;
        message = await client.messages.create(params(receipt.plan), { maxRetries: 0 });
      } catch (error) {
        receipt.error = errorInfo(error); receipt.failedAt = timestamp();
        if (rejection(error)) {
          receipt.status = 'planned'; receipt.retryable = retryable(error);
          receipt.lastRejection = { ...receipt.error, at: receipt.failedAt };
        } else {
          receipt.status = 'submission-unknown'; receipt.unknownAt = receipt.failedAt;
        }
        await persist(true);
        continue; // at most one submission per receipt per invocation
      }
      // Save failures here propagate. A restart sees either submitting (never
      // retry blindly) or response-saved (validate the stored response only).
      receipt.response = clone(message); receipt.status = 'response-saved'; receipt.respondedAt = timestamp();
      await persist(true);
    } else if (receipt.status === 'response-saved') {
      // The preceding process may have saved locally but failed its remote
      // checkpoint. Finish that checkpoint before interpreting the response.
      await persist(true);
    }
    const result = await validate(receipt.response, receipt.plan.posts, {
      sourceHash: receipt.plan.sourceHash, correctionHash: receipt.plan.correctionHash,
      runAsOf: receipt.plan.runAsOf, mode: receipt.plan.mode, policyVersion: receipt.plan.policyVersion
    });
    if (!object(result) || typeof result.valid !== 'boolean' || !Array.isArray(result.events)
        || !Array.isArray(result.errors) || !Array.isArray(result.unresolved)) throw new Error('Invalid shadow validator result');
    receipt.validation = clone(result);
    // A correction/source edit made while the request or validator was running
    // invalidates acceptance, even when the model response itself is well formed.
    if (!(await isCurrent(receipt))) continue;
    receipt.status = result.valid ? 'accepted' : 'partial'; receipt.validatedAt = timestamp();
    removeEvents(receipt.plan.key);
    if (result.valid) for (const event of result.events) state.events.push({ ...clone(event), receiptKey: receipt.plan.key });
    await persist(true);
  }
  const count = (status) => Object.values(state.receipts).filter((r) => r.status === status).length;
  await persist(true); // also finish a prior acceptance checkpoint on a no-call replay
  return { state, calls, attempts: state.attempts, accepted: count('accepted'), partial: count('partial'),
    unknown: count('submission-unknown'), superseded: count('superseded') };
}
