import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/db.js';
import { reserveHoldouts, learningStatus } from '../src/learning-context.js';
import { createEvaluationSet, evaluateBaseline, evaluationReport } from '../src/evaluation.js';
import {evaluateLocalClassifier} from '../src/local-evaluation.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const [command = 'status', ...args] = process.argv.slice(2);
process.umask(0o077);
const store = openStore(process.env.CAUCUS_DB_PATH ?? resolve(root, 'data/pulse.sqlite'));
try {
  let result;
  if (command === 'status' && !args.length) result = learningStatus(store);
  else if (command === 'reserve' && args.length) result = reserveHoldouts(store, args);
  else if (command === 'create' && args.length > 1) {
    const set = createEvaluationSet(store, { title: args[0], postIds: args.slice(1) });
    result = { setId: set.id, title: set.title, cases: set.originalCases };
  } else if (command === 'baseline' && args.length === 1) {
    const report = await evaluateBaseline(store, args[0]);
    result = { runId: report.runId, status: report.status, counts: report.counts, note: report.note };
  } else if(command==='local'&&args.length===1){
    const report=await evaluateLocalClassifier(store,args[0]);
    result={runId:report.runId,status:report.status,provider:report.provider,model:report.model,counts:report.counts,note:report.note};
  } else if (command === 'report' && args.length === 1) {
    const report = evaluationReport(store, args[0]);
    result = { runId: report.runId, status: report.status, counts: report.counts, note: report.note };
  } else throw new Error('Use: learning.js status | reserve POST_ID... | create "Session name" POST_ID... | baseline SET_ID | local SET_ID | report RUN_ID');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.code==='CLASSIFIER_BUSY'?'Stop the preview classifier before running a separate local evaluation.':/^(Invalid |Use:)/.test(error.message) ? error.message : 'Learning operation failed; existing source and reviews are retained.');
  process.exitCode = 1;
} finally { store.close(); }
