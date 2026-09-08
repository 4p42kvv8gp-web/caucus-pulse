import { parentPort,workerData } from 'node:worker_threads';
import { groupSubjectPassages } from './subject-groups-core.js';
try{parentPort.postMessage({result:groupSubjectPassages(workerData.snapshot,workerData.options)});}
catch{parentPort.postMessage({error:'failed'});}
