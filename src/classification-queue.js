// Durable batch manifests. A batch keeps its original input IDs and taxonomy
// across restarts and calendar changes; completed IDs prevent a stale legacy
// pendingBatch pointer from replaying already-published results.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { p, writeJSON } from './util.js';
import { sourceContextStatus } from './source-context.js';

export const queuePath = p('data', 'classification-batches.json');
export const emptyQueue = () => ({ version: 1, jobs: [], completed: {} });
export const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function readQueue(file = queuePath) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return emptyQueue();
    throw e;
  }
  const queue = JSON.parse(text);
  if (queue?.version !== 1 || !Array.isArray(queue.jobs) || queue.jobs.length > 1 || !queue.completed || typeof queue.completed !== 'object' || Array.isArray(queue.completed)) {
    throw new Error(`Invalid classification queue: ${file}`);
  }
  for (const job of queue.jobs) {
    if (!job?.key || !Array.isArray(job.dates) || !job.dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) || !job.taxonomy || !job.manifest || Array.isArray(job.manifest) || (job.batchId != null && typeof job.batchId !== 'string')) throw new Error(`Invalid classification job: ${file}`);
    const ids = new Set();
    for (const entry of Object.values(job.manifest)) {
      if (!Array.isArray(entry?.ids)) throw new Error(`Invalid classification manifest: ${file}`);
      for (const id of entry.ids) {
        if (typeof id !== 'string' || !/^\d+$/.test(id) || ids.has(id)) throw new Error(`Invalid or duplicate classification manifest ID: ${file}`);
        ids.add(id);
      }
      for (const [id, evidence] of Object.entries(entry.evidenceByPost || {})) {
        if (!entry.ids.includes(id) || !Array.isArray(evidence) || evidence.some((e) => typeof e?.id !== 'string' || !e.id)) throw new Error(`Invalid classification evidence manifest: ${file}`);
      }
      for (const [id, context] of Object.entries(entry.sourceContextByPost || {})) {
        if (!entry.ids.includes(id) || typeof context?.incomplete !== 'boolean' || !/^[a-f0-9]{64}$/.test(context.fingerprint || '')) throw new Error(`Invalid source context manifest: ${file}`);
      }
      for (const [id, context] of Object.entries(entry.quotedContextByPost || {})) {
        if (!entry.ids.includes(id) || typeof context?.id !== 'string' || !/^\d{1,25}$/.test(context.id)
            || !/^[a-f0-9]{64}$/.test(context.textHash || '') || !Number.isSafeInteger(context.textChars) || context.textChars < 1
            || (context.createdAt != null && (typeof context.createdAt !== 'string' || !Number.isFinite(Date.parse(context.createdAt))))) throw new Error(`Invalid quoted source manifest: ${file}`);
      }
    }
  }
  return queue;
}

export function saveQueue(queue, file = queuePath) {
  writeJSON(file, queue);
}

// Read IDs from the actual serialized request, rather than rebuilding its
// membership from a later archive or a changed chunk size.
export function requestManifest(requests) {
  const manifest = {};
  const allIds = new Set();
  for (const request of requests) {
    if (!request.custom_id || Object.hasOwn(manifest, request.custom_id)) throw new Error('Duplicate or missing classification custom_id');
    const content = request.params?.messages?.[0]?.content;
    if (typeof content !== 'string') throw new Error('Classification input must be JSONL text');
    const lines = content.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const ids = lines.map((line) => line.id);
    for (const id of ids) {
      if (typeof id !== 'string' || !/^\d+$/.test(id)) throw new Error(`Invalid source post ID: ${String(id)}`);
      if (allIds.has(id)) throw new Error(`Source post ID requested twice: ${id}`);
      allIds.add(id);
    }
    const evidenceByPost = {}, contextVersions = {}, sourceContextByPost = {}, quotedContextByPost = {};
    for (const line of lines) {
      if (line.type === 'retweet') sourceContextByPost[line.id] = sourceContextStatus({ ...line, reposted: line.reposting });
      const quoted = line.quoting;
      // A compact receipt of the exact quoted wording that was submitted.
      // Legacy requests without a source ID remain readable, but cannot gain
      // provenance by guessing one after the request has already completed.
      if (typeof quoted?.id === 'string' && /^\d{1,25}$/.test(quoted.id) && typeof quoted.text === 'string' && quoted.text.trim()) {
        quotedContextByPost[line.id] = { id: quoted.id, authorId: quoted.authorId ?? null, handle: quoted.handle ?? null,
          createdAt: quoted.createdAt ?? null, textChars: quoted.text.length,
          textHash: createHash('sha256').update(quoted.text).digest('hex') };
      }
      if (line.evidence != null || line.officialAgenda != null) {
        for (const sources of [line.evidence, line.officialAgenda]) {
          if (sources != null && (!Array.isArray(sources) || sources.some((e) => typeof e?.id !== 'string' || !e.id))) throw new Error(`Invalid source evidence for post ${line.id}`);
        }
        const supplied = [...(line.evidence || []), ...(line.officialAgenda || [])];
        if (new Set(supplied.map((e) => e.id)).size !== supplied.length) throw new Error(`Invalid source evidence for post ${line.id}`);
        evidenceByPost[line.id] = supplied;
      }
      if (line.contextVersion != null) {
        if (!Number.isInteger(line.contextVersion) || line.contextVersion < 0) throw new Error(`Invalid context version for post ${line.id}`);
        contextVersions[line.id] = line.contextVersion;
      }
    }
    manifest[request.custom_id] = { ids, evidenceByPost, contextVersions, sourceContextByPost, quotedContextByPost, inputHash: hash(request.params) };
  }
  return manifest;
}

export function prepareJob(queue, { requests, dates, model, taxonomy, source = 'nightly', now = new Date().toISOString() }) {
  if (queue.jobs.length) throw new Error('Resolve the existing classification batch before submitting another');
  const job = { key: randomUUID(), status: 'submitting', source, dates: [...new Set(dates)].sort(), model, taxonomy, taxonomyHash: hash(taxonomy), manifest: requestManifest(requests), submittedAt: now, batchId: null };
  queue.jobs.push(job);
  return job;
}

export function finishJob(queue, job, now = new Date().toISOString()) {
  if (!job.batchId) throw new Error('Cannot complete a classification job without a batch ID');
  queue.completed[job.batchId] = { dates: job.dates, completedAt: now };
  queue.jobs = queue.jobs.filter((j) => j.key !== job.key);
}

// Only errors that explicitly reject a request are safe to resubmit. Network
// timeouts and 5xx failures may happen after acceptance, so their intent stays
// in the queue until its provider batch ID is reconciled.
export async function submitJob(client, queue, details, { file = queuePath, onAttempt = () => {} } = {}) {
  const job = prepareJob(queue, details);
  saveQueue(queue, file);
  onAttempt(); // local intent is durable; the next operation contacts the provider
  try {
    const batch = await client.messages.batches.create({ requests: details.requests });
    if (!batch?.id) throw new Error('Batch submission returned no ID');
    job.batchId = batch.id;
    job.status = 'processing';
    saveQueue(queue, file);
    return job;
  } catch (e) {
    if ((e.status >= 400 && e.status < 500 && e.status !== 408) || e.code === 'ANTHROPIC_BUDGET_EXCEEDED' || e.requestSent === false) {
      queue.jobs = queue.jobs.filter((j) => j.key !== job.key);
    } else {
      job.status = 'submission-unknown';
      job.error = String(e.message || e).slice(0, 300);
    }
    saveQueue(queue, file);
    throw e;
  }
}

// Serialize runner invocations on one host/check-out. The lock is local
// ephemeral state, never a file under the git-backed data directory. A dead
// process lock fails closed and names its location for explicit recovery;
// silently unlinking it could race another recovering process.
export const queueLockPath = (file = queuePath) => path.join(os.tmpdir(), `caucus-classification-${hash(path.resolve(file)).slice(0, 24)}.lock`);
export async function withQueueLock(file, run) {
  const lock = queueLockPath(file);
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let owner;
    try { owner = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { /* fail closed on a torn lock */ }
    let active = false;
    if (Number.isInteger(owner?.pid) && owner.pid > 0) {
      try { process.kill(owner.pid, 0); active = true; } catch (signalError) { active = signalError.code !== 'ESRCH'; }
    }
    throw new Error(active ? `Another classification runner is active (pid ${owner.pid}); retry later.` : `Classification lock needs recovery: ${lock}. Verify its owner has exited before removing it.`);
  }
  const token = randomUUID();
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }));
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    return await run();
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    // Never remove a lock another process replaced during explicit recovery.
    try { if (JSON.parse(fs.readFileSync(lock, 'utf8')).token === token) fs.unlinkSync(lock); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
