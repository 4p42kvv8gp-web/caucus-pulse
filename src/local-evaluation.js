import {evaluationSet,runEvaluation} from './evaluation.js';
import {createLocalClassifierClient} from './classifier-client.js';
import {classifierFingerprint,localClassifierSpec} from './classifier-contract.js';
import {INTELLIGENCE_VERSION} from './intelligence.js';

/** A separate, offline candidate run. It never queues production work or saves feedback. */
export async function evaluateLocalClassifier(store,setId,{createClient=createLocalClassifierClient}={}){
  const set=evaluationSet(store,setId);
  if(set.removedCases||set.cases.some(c=>c.state!=='current')||set.contractVersion!==INTELLIGENCE_VERSION)
    throw new Error('Invalid evaluation set: source, correction or classification contract changed; create a new version.');
  const runtime=await createClient();
  try{
    if(runtime.fingerprint!==classifierFingerprint)throw new Error('Invalid evaluation runtime: selected model fingerprint differs.');
    return await runEvaluation({store,setId,providerName:'Local offline candidate',
      model:`${localClassifierSpec.name}@${classifierFingerprint}`,
      providerUsesExamples:localClassifierSpec.engine!=='political-debate-nli',
      provider:async request=>(await runtime.classify(request)).result});
  }finally{await runtime.close();}
}
