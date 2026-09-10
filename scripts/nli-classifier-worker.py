"""Bounded local Political DEBATE classification. Source text never leaves this process tree."""
import contextlib
import fcntl
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import sys
import time

ROOT=Path(__file__).resolve().parents[1]
os.environ['HF_HUB_OFFLINE']='1'
os.environ['TRANSFORMERS_OFFLINE']='1'
os.environ['HF_HOME']=str(ROOT/'data/hf-local')
os.environ['TOKENIZERS_PARALLELISM']='false'
TOPICS={
    'Immigration':'immigration, deportation, or immigrant detention',
    'Economy & cost of living':'the economy, prices, wages, trade, taxes, or interest rates',
    'Health care':'health care or health insurance',
    'Reproductive rights':'abortion, contraception, or reproductive rights',
    'Democracy & rule of law':'voting rights, elections administration, due process, or government abuse of power',
    'Oversight':'government investigations, oversight, requests for information, or official accountability',
    'Guns & public safety':'guns, shootings, crime, policing, or threats to physical public safety',
    'Disaster response':'natural disasters, hazardous weather, fires, floods, or emergency response',
    'Labor & workers':'unions, labor, or workers rights',
    'Climate & environment':'climate change, environmental protection, energy policy, or pollution',
    'Education':'schools, education, student debt, or universities',
    'Civil rights & equality':'civil rights or discrimination',
    'Foreign policy & national security':'national security, terrorism, defense, or international affairs',
    'Budget & appropriations':'government funding, federal spending, or appropriations',
    'Technology':'technology, artificial intelligence, data privacy, or cybersecurity',
    'Congress & politics':'congressional politics, political parties, or criticism of politicians',
    'District & constituent services':'assistance to constituents or community services'
}
INCIDENTS={
    'shooting':'The text reports that a shooting or an active shooter incident has occurred.',
    'flooding':'The text reports that flooding has occurred.',
    'fire':'The text reports that a fire or wildfire has occurred.',
    'infrastructure emergency':'The text reports a gas leak, explosion, or hazardous spill that endangers people.',
    'emergency evacuation':'The text reports that people are being evacuated because of a physical emergency.'
}
FUNCTIONS={
    'constituent-service':'The author gives practical advice or assistance intended to help people.',
    'incident-report':'The author reports a physical emergency that has occurred.',
    'incident-update':'The author gives new information about an earlier physical emergency.',
    'correction':'The author corrects an earlier false report.',
    'criticism':'The author criticizes a person, government, policy, or institution.',
    'policy-position':'The author expresses a position on public policy.',
    'legislative-action':'The author describes introducing, voting on, or advancing legislation.',
    'condolence-or-solidarity':'The author expresses condolences or solidarity with people affected by an event.',
    'commemoration':'The author commemorates an event that happened in the past.',
    'event-invitation':'The author invites people to attend an event.'
}


def emit(value):
    sys.stdout.write(json.dumps(value,allow_nan=False,ensure_ascii=True)+'\n')
    sys.stdout.flush()


class InputLimit(Exception):
    pass


def source_windows(passages,tokenizer,limits):
    """Cover every source passage; overlap one passage where possible. Never truncate."""
    windows=[]
    at=0
    while at<len(passages):
        group=[]
        cursor=at
        while cursor<len(passages) and len(group)<limits['maxPassagesPerWindow']:
            trial=group+[passages[cursor]]
            # Leave explicit room for the longest allowed hypothesis and pair separators.
            if len(tokenizer.encode(''.join(p['text'] for p in trial),add_special_tokens=False))>limits['maxSequenceTokens']-96:
                break
            group=trial
            cursor+=1
        if not group:
            raise InputLimit('A complete source passage exceeds the local input limit')
        windows.append({'text':''.join(p['text'] for p in group),'ids':[p['id'] for p in group if p['text'].strip()]})
        if len(windows)>limits['maxWindows']:
            raise InputLimit('The full source requires too many windows')
        if cursor==len(passages):
            break
        at=cursor-1 if len(group)>1 else cursor
    return windows


def main():
    os.umask(0o077)
    runtime=ROOT/'data/nli-runtime'
    lock_fd=os.open(runtime/'worker.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    try:
        fcntl.flock(lock_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:
        emit({'ready':False,'code':'runtime-busy'})
        return
    spec=json.loads((ROOT/'config/local-classifier.json').read_text())
    if spec.get('engine')!='political-debate-nli' or spec.get('policyVersion')!='political-debate-passages-v2':
        raise ValueError('Unsupported NLI profile')
    limits=spec['limits']
    expected={'maxInputCharacters':60000,'maxWindows':24,'maxPassagesPerWindow':10,'maxPairs':600,'maxSequenceTokens':512,'batchSize':4,'threads':2,'deadlineSeconds':160,'threshold':0.95}
    if limits!=expected:
        raise ValueError('Unsupported NLI limits')
    installed_runtime={package:importlib.metadata.version(package) for package in spec['runtime']}
    for package,version in spec['runtime'].items():
        expected_version=version+'+cpu' if package=='torch' and sys.platform=='linux' else version
        if installed_runtime[package]!=expected_version:
            raise ValueError('NLI runtime version mismatch')
    taxonomy=json.loads((ROOT/'config/taxonomy.json').read_text())
    if set(TOPICS)!={t['name'] for t in taxonomy['topics']}:
        raise ValueError('NLI hypotheses do not match the taxonomy')
    loader=importlib.util.spec_from_file_location('model_verifier',ROOT/'scripts/download-classifier-model.py')
    verifier=importlib.util.module_from_spec(loader)
    loader.loader.exec_module(verifier)
    verifier.verify(verifier.DEST)
    with open(os.devnull,'w') as quiet,contextlib.redirect_stdout(quiet),contextlib.redirect_stderr(quiet):
        import torch
        from transformers import AutoTokenizer,AutoModelForSequenceClassification
        torch.set_num_threads(limits['threads'])
        torch.set_num_interop_threads(1)
        tokenizer=AutoTokenizer.from_pretrained(verifier.DEST,local_files_only=True,trust_remote_code=False)
        model=AutoModelForSequenceClassification.from_pretrained(verifier.DEST,local_files_only=True,trust_remote_code=False,use_safetensors=True).eval()
    if model.config.id2label!={0:'entailment',1:'not_entailment'} or model.config.max_position_embeddings!=512:
        raise ValueError('Unexpected model label or context definition')
    entity_extractor=None
    if spec.get('entityModel',{}).get('enabled'):
        loader=importlib.util.spec_from_file_location('entity_extractor',ROOT/'scripts/entity-extractor.py')
        entity_module=importlib.util.module_from_spec(loader);loader.loader.exec_module(entity_module)
        entity_extractor=entity_module.EntityExtractor()
        if entity_extractor.spec['name']!=spec['entityModel']['profile']:raise ValueError('Entity model profile mismatch')
    emit({'ready':True})
    while True:
        line=sys.stdin.buffer.readline(512001)
        if not line:
            return
        if len(line)>512000 or not line.endswith(b'\n'):
            return
        request_id=None
        try:
            request=json.loads(line)
            request_id=request['id']
            source=request['input']
            if not isinstance(request_id,int) or not isinstance(source.get('text'),str) or not source['text'].strip() or len(source['text'])>limits['maxInputCharacters'] or not isinstance(source.get('passages'),list) or not 1<=len(source['passages'])<=512:
                raise InputLimit()
            passages=source['passages']
            if any(set(p)!= {'id','text'} or p['id']!=f'p{i+1}' or not isinstance(p['text'],str) for i,p in enumerate(passages)) or ''.join(p['text'] for p in passages)!=source['text']:
                raise ValueError('Source passage manifest does not match')
            started=time.monotonic()
            windows=source_windows(passages,tokenizer,limits)
            tested=0

            def score_hypotheses(hypotheses,contexts=None):
                nonlocal tested
                pairs=[(hypothesis,window) for hypothesis in hypotheses for window in (windows if contexts is None else contexts) if window['ids']]
                if tested+len(pairs)>limits['maxPairs']:
                    raise InputLimit('The complete analysis would exceed its pair limit')
                best={key:{'key':key,'hypothesis':hyp,'score':-1,'window':None} for key,hyp in hypotheses}
                for at in range(0,len(pairs),limits['batchSize']):
                    if time.monotonic()-started>limits['deadlineSeconds']:
                        raise TimeoutError()
                    batch=pairs[at:at+limits['batchSize']]
                    inputs=tokenizer([w['text'] for _,w in batch],[h[1] for h,_ in batch],padding=True,truncation=False,return_tensors='pt')
                    if inputs['input_ids'].shape[1]>limits['maxSequenceTokens']:
                        raise InputLimit('A full premise and hypothesis exceed the model context')
                    with torch.inference_mode():
                        values=model(**inputs).logits.softmax(-1)[:,0].tolist()
                    tested+=len(batch)
                    for ((key,_),window),value in zip(batch,values):
                        if not 0<=value<=1:
                            raise ValueError('Invalid entailment score')
                        if value>best[key]['score']:
                            best[key].update(score=value,window=window)
                return sorted(best.values(),key=lambda item:(-item['score'],item['key']))

            broad=score_hypotheses([(key,'This text is about '+meaning+'.') for key,meaning in TOPICS.items()])
            incident=score_hypotheses(list(INCIDENTS.items()))
            functions=score_hypotheses(list(FUNCTIONS.items()))
            recent=score_hypotheses([('new-emergency','This passage reports a new or ongoing physical emergency.')])[0]
            threshold=limits['threshold']
            active_incidents=[item for item in incident if item['score']>=threshold]
            # Brief linked reactions cannot be expanded into missing story contents.
            linked_short=len(re.findall(r'\b\w+\b',re.sub(r'https?://\S+','',source['text'])))<12 and bool(re.search(r'https?://',source['text'])) and not active_incidents
            selected=[] if linked_short else [item for item in broad if item['score']>=threshold][:8]
            labels=[]
            for item in selected:
                topic=next(t for t in taxonomy['topics'] if t['name']==item['key'])
                narrow=score_hypotheses([(name,'This text is about '+name.lower()+'.') for name in topic['subtopics']])
                accepted=[n for n in narrow if n['score']>=threshold][:2]
                for sub in accepted or [None]:
                    support=sub or item
                    labels.append({'topic':item['key'],'subtopic':sub['key'] if sub else None,
                        'explanation':'The local model matched this subject hypothesis: '+support['hypothesis']+' The linked original passage is supplied for review; this is a provisional label.',
                        'quoteIds':support['window']['ids']})
            omitted_labels=max(0,len(labels)-8)
            labels=labels[:8]
            fn=[{'function':item['key'],'explanation':'The local model matched this description of the post’s purpose: '+item['hypothesis']+' This requires review.',
                 'quoteIds':item['window']['ids']} for item in functions if item['score']>=threshold][:6]
            events=[]
            commemorative=any(f['function']=='commemoration' for f in fn)
            correction=any(f['function']=='correction' for f in fn)
            for item in active_incidents[:3]:
                if commemorative and not correction and recent['score']<threshold:
                    continue
                window=item['window']
                district_ids=[]
                outside_ids=[]
                if source.get('postType') not in ('repost','quote'):
                    for p in passages:
                        context=[{'text':p['text'],'ids':[p['id']]}]
                        if p['id'] in window['ids'] and re.search(r'\b(in|within) (my|our) (congressional )?district\b',p['text'],re.I):
                            relation_score=score_hypotheses([('inside','The physical emergency is explicitly said to be in the author’s district.')],contexts=context)[0]
                            if relation_score['score']>=threshold:
                                district_ids.append(p['id'])
                        if p['id'] in window['ids'] and re.search(r'\boutside (my|our) (congressional )?district\b',p['text'],re.I):
                            relation_score=score_hypotheses([('outside','The physical emergency is explicitly said to be outside the author’s district.')],contexts=context)[0]
                            if relation_score['score']>=threshold:
                                outside_ids.append(p['id'])
                # Conflicting relations remain unknown instead of selecting the convenient one.
                relation='explicitly-outside' if outside_ids and not district_ids else 'explicitly-stated' if district_ids and not outside_ids else 'not-established'
                evidence=outside_ids if relation=='explicitly-outside' else district_ids if relation=='explicitly-stated' else []
                events.append({'description':('Possible correction of a report concerning ' if correction else 'Possible source report concerning ')+item['key']+'. Inspect the original passage; occurrence is not independently verified.',
                    'development':'update' if correction else 'reported-incident','location':None,'districtRelation':relation,'districtQuoteIds':evidence,'quoteIds':window['ids']})
            if not events and any(l['topic'] in ('Guns & public safety','Disaster response') for l in labels):
                update=next((f for f in fn if f['function'] in ('correction','incident-update')),None)
                if update:
                    events.append({'description':'Possible '+('correction of' if update['function']=='correction' else 'update on')+' an earlier public-safety or emergency report. Read the original passage for the facts and uncertainty.',
                        'development':'update','location':None,'districtRelation':'not-established','districtQuoteIds':[],'quoteIds':update['quoteIds']})
            entity_result=entity_extractor.extract(source['text'],passages,deadline=started+limits['deadlineSeconds']) if entity_extractor else None
            entities=entity_result['entities'] if entity_result else []
            seen={e['name'] for e in entities}
            for p in passages:
                for match in re.finditer(r'(?<![\w@])@[A-Za-z0-9_]{1,15}\b',p['text']):
                    name=match.group()
                    if name not in seen and p['text'].count(name)==1:
                        entities.append({'kind':'other','name':name,'contextId':p['id']});seen.add(name)
            omitted_entities=(entity_result['omitted'] if entity_result else 0)+max(0,len(entities)-12)
            limitations=['Fixed hypotheses and named-mention models propose interpretations; scores are not calibrated accuracy. A named place is not automatically the incident location or a district connection.',
                         'Human corrections take precedence. This model is not trained from the saved reviews; reviewed examples remain available for comparison and future evaluated training.']
            if linked_short:
                limitations.append('This short linked caption lacks reviewed link context. Topic assignment is deferred rather than inferred from an unseen story.')
            elif omitted_labels:
                limitations.append(f'{omitted_labels} additional provisional labels were omitted at the display limit.')
            if omitted_entities:
                detail=f' {omitted_entities} named mentions were omitted because of the display limit or an ambiguous source context.'
                limitations[-1]+=detail
            output={'labels':labels,'entities':entities[:12],'events':events,'functions':fn,
                'summary':('Provisional subjects: '+', '.join(dict.fromkeys(l['topic'] for l in labels))+'. Read the original post for its claims and context.') if labels else 'No automatic subject was assigned with sufficient supported context under the current policy. Review the original post.',
                'limitations':limitations}
            rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            emit({'id':request_id,'output':json.dumps(output,ensure_ascii=False),'metrics':{'promptTokens':len(tokenizer.encode(source['text'],add_special_tokens=False)),
                'outputTokens':0,'elapsedMs':round((time.monotonic()-started)*1000),'peakMemoryBytes':rss if sys.platform=='darwin' else rss*1024,
                'finishReason':'stop','testedPairs':tested,'sourceWindows':len(windows),'omittedLabels':omitted_labels,
                'entityExtraction':{key:value for key,value in entity_result.items() if key!='entities'} if entity_result else None,
                'runtime':{'platform':sys.platform,'python':sys.version.split()[0],'packages':installed_runtime}}})
        except InputLimit:
            emit({'id':request_id,'error':'input-limit'})
        except TimeoutError:
            emit({'id':request_id,'error':'output-limit'})
        except Exception:
            emit({'id':request_id,'error':'inference-failed'})


if __name__=='__main__':
    try:
        main()
    except Exception:
        emit({'ready':False})
        sys.exit(1)
