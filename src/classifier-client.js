import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { classifierMessages, classifierEvidenceCatalog, parseClassifierOutput, classifierFingerprint, localClassifierSpec, CLASSIFIER_PROMPT_VERSION, taxonomy } from './classifier-contract.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const failure = (message = 'Local classification is unavailable.', code = 'CLASSIFIER_UNAVAILABLE') => Object.assign(new Error(message), { code });

export async function createLocalClassifierClient({ python = resolve(root, localClassifierSpec.engine==='political-debate-nli'?'data/nli-runtime/bin/python':'data/classifier-runtime/bin/python'), timeoutMs = 180000, onInvalidOutput = null } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000) throw new Error('Invalid classifier timeout.');
  const nli=localClassifierSpec.engine==='political-debate-nli';
  const child = spawn(python, [resolve(root, nli?'scripts/nli-classifier-worker.py':'scripts/local-classifier-worker.py')], {
    cwd: root, env: { PYTHONNOUSERSITE: '1', PYTHONUNBUFFERED: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false' },
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true
  });
  let closed = false, initialized = false, active = null, sequence = 0, buffer = '';
  let readyResolve, readyReject;
  const queue = [];
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const startup = setTimeout(() => stop(failure('Local classifier did not start in time.')), 60000);
  const exited = new Promise(resolve => child.once('close', resolve));
  function stop(error = failure()) {
    if (closed) return exited;
    closed = true; clearTimeout(startup); readyReject(error);
    if (active) { clearTimeout(active.timer); active.reject(error); active = null; }
    for (const item of queue.splice(0)) item.reject(error);
    child.stdin.destroy(); child.kill('SIGTERM');
    const hardStop = setTimeout(() => child.kill('SIGKILL'), 3000); hardStop.unref();
    exited.then(() => clearTimeout(hardStop));
    return exited;
  }
  function next() {
    if (closed || !initialized || active || !queue.length) return;
    active = queue.shift();
    active.timer = setTimeout(() => stop(failure('Local classification exceeded its time limit.', 'CLASSIFIER_TIMEOUT')), timeoutMs);
    child.stdin.write(JSON.stringify({ id: active.id, ...active.payload }) + '\n');
  }
  child.stdin.on('error', () => stop());
  child.on('error', () => stop());
  child.on('close', () => { if (!closed) stop(); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => {
    buffer += data;
    if (buffer.length > 200000) { stop(failure('Local classifier returned an invalid response.')); return; }
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      let value; try { value = JSON.parse(line); } catch { stop(); return; }
      if (Object.hasOwn(value, 'ready')) {
        clearTimeout(startup);
        if (initialized || value.ready !== true) { stop(value.code==='runtime-busy'?failure('Another local classifier process is already running.','CLASSIFIER_BUSY'):failure('Local model or runtime could not be verified.')); return; }
        initialized = true; readyResolve(); next(); continue;
      }
      if (!active || value.id !== active.id) { stop(); return; }
      const current = active; active = null; clearTimeout(current.timer);
      if (value.error) current.reject(value.error === 'input-limit' ? failure('The complete source and examples exceed the local model input limit.', 'CLASSIFIER_INPUT_LIMIT')
        : value.error === 'output-limit' ? failure('Local classification did not finish within its output limit.', 'CLASSIFIER_OUTPUT_LIMIT') : failure());
      else {
        try {
          const result = parseClassifierOutput(current.request, value.output);
          const m = value.metrics;
          if (!m || !['promptTokens', 'outputTokens', 'elapsedMs', 'peakMemoryBytes'].every(k => Number.isFinite(m[k]) && m[k] >= 0) || m.finishReason !== 'stop') throw new Error('Invalid runtime metrics.');
          current.resolve({ result, metrics: m });
        } catch (error) {
          // Optional local engineering diagnostics; the server never supplies this callback.
          if (typeof onInvalidOutput === 'function') {
            try { onInvalidOutput({ postId: current.request.input.postId, output: value.output, reason: error.message }); } catch {}
          }
          current.reject(failure('The model response did not pass source-evidence validation.', 'CLASSIFIER_INVALID_OUTPUT'));
        }
      }
      next();
    }
  });
  await ready;
  function classify(request) {
    if (closed) return Promise.reject(failure());
    if (queue.length >= 4) return Promise.reject(failure('Local classification is busy.', 'CLASSIFIER_BUSY'));
    let payload;
    try {
      payload=nli?{input:{text:request.input.text,postType:request.input.postType,passages:classifierEvidenceCatalog(request.input.text).map(({id,text})=>({id,text}))}}:{messages:classifierMessages(request)};
      if (Buffer.byteLength(JSON.stringify(payload)) > 500000) throw failure('Classification input is too large.', 'CLASSIFIER_INPUT_LIMIT');
    } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => { queue.push({ id: ++sequence, request, payload, resolve, reject }); next(); });
  }
  return { fingerprint: classifierFingerprint, profile: { model: localClassifierSpec, taxonomyVersion: taxonomy.version, promptVersion: CLASSIFIER_PROMPT_VERSION },
    classify, status: () => ({ ready: initialized && !closed, busy: Boolean(active), queued: queue.length, model: localClassifierSpec.name }), close: () => stop() };
}
