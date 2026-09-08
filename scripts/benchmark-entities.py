"""Bounded synthetic comparison for entity suggestions, not human accuracy."""
import importlib.util
import json
import os
from pathlib import Path
import time

ROOT=Path(__file__).resolve().parents[1]
os.umask(0o077)
os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',TOKENIZERS_PARALLELISM='false',HF_HOME=str(ROOT/'data/hf-local'))
import torch
torch.set_num_threads(2);torch.set_num_interop_threads(1)
loader=importlib.util.spec_from_file_location('entity_extractor',ROOT/'scripts/entity-extractor.py')
module=importlib.util.module_from_spec(loader);loader.loader.exec_module(module)
extractor=module.EntityExtractor()
fixtures=[
    ('shooting','Police are responding to a reported shooting at Aurora Town Center.',['Aurora Town Center']),
    ('fire','Cal Fire says a wildfire is burning near Pine Creek.',['Cal Fire','Pine Creek']),
    ('two-places','Families held at Dilley in Texas and Delaney Hall in Newark, New Jersey, deserve answers.',['Dilley','Texas','Delaney Hall','Newark','New Jersey']),
    ('different-roles','Flooding has closed River Road. Residents can seek shelter at North High School. My office in Springfield remains open.',['River Road','North High School','Springfield']),
    ('denial','There is no active shooter at Aurora Town Center. The earlier report was false.',['Aurora Town Center']),
    ('caption','This is unacceptable. https://example.invalid/story',[]),
    ('unicode','🌧 New York residents should follow official alerts. José García can contact our office.',['New York','José García']),
    ('repetition','FEMA is responding. FEMA has shared a new update.',['FEMA']),
    ('late-detail','Routine constituent appointments continue. '*160+'Cal Fire is responding near Pine Creek.',['Cal Fire','Pine Creek'])
]
results=[]
for identifier,text,expected in fixtures:
    # Sentence boundaries are for this synthetic fixture only; the app supplies its own exact passage catalog.
    parts=text.split('. ');passages=[{'id':f'p{i+1}','text':part+('. ' if i<len(parts)-1 else '')} for i,part in enumerate(parts)]
    started=time.monotonic()
    result=extractor.extract(text,passages,deadline=started+40)
    found={e['name'] for e in result['entities']}
    results.append({'fixture':identifier,'text':text,'expectedNames':expected,'missing':[name for name in expected if name not in found],**result,'elapsedMs':round((time.monotonic()-started)*1000)})
report={'kind':'synthetic-entity-engineering-check','model':extractor.spec,'results':results,'humanAccuracyMeasured':False,'note':'Names are mentions only. No incident-location or district inference is performed.'}
path=ROOT/f'data/reports/entity-benchmark-{int(time.time()*1000)}.json';path.write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n')
print(json.dumps({'report':str(path),'cases':len(results),'results':[{'fixture':r['fixture'],'entities':r['entities'],'missing':r['missing'],'elapsedMs':r['elapsedMs'],'windows':r['windows'],'omitted':r['omitted']} for r in results]},ensure_ascii=False))
