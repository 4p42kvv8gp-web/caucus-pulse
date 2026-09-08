"""Source-exact named mentions, with overlapping token windows and no geographic inference."""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import time
import unicodedata

ROOT=Path(__file__).resolve().parents[1]
KINDS={'LOC':'location','ORG':'organization','PER':'person','MISC':'other'}
def word_character(character):return character.isalnum() or character=='_' or unicodedata.category(character).startswith('M')
def utf16_length(text):return len(text.encode('utf-16-le'))//2
EXPECTED_LABELS={0:'O',1:'B-MISC',2:'I-MISC',3:'B-PER',4:'I-PER',5:'B-ORG',6:'I-ORG',7:'B-LOC',8:'I-LOC'}

def named_tokens(text,offsets,labels,scores,*,start_cut=False,end_cut=False,threshold=0.9):
    """Keep complete BIO groups, exact original spacing, and conservative token scores."""
    if not len(offsets)==len(labels)==len(scores):raise ValueError('Mismatched token observations')
    active=None;groups=[];real=[i for i,(start,end) in enumerate(offsets) if end>start]
    first=real[0] if real else -1;last=real[-1] if real else -1
    def finish():
        nonlocal active
        if active:
            if not ((start_cut and active['first']==first) or (end_cut and active['last']==last)) and min(active['scores'])>=threshold:
                start,end=active['start'],active['end'];name=text[start:end]
                partial_word=(start>0 and word_character(text[start-1]) and word_character(text[start])) or (end<len(text) and word_character(text[end-1]) and word_character(text[end]))
                if name.strip() and len(name)<=200 and not partial_word:groups.append({'start':start,'end':end,'name':name,'kind':KINDS[active['kind']],'score':min(active['scores'])})
            active=None
    for i,((start,end),label,score) in enumerate(zip(offsets,labels,scores)):
        if not isinstance(start,int) or not isinstance(end,int) or not 0<=start<=end<=len(text) or not 0<=score<=1:raise ValueError('Invalid token observation')
        if start==end or label=='O':finish();continue
        if label not in EXPECTED_LABELS.values():raise ValueError('Unknown entity label')
        prefix,kind=label.split('-',1)
        # Wordpieces can be contiguous; spaces and hyphens are preserved from the source.
        if prefix=='I' and active and active['kind']==kind and start>=active['end']:
            active['end']=end;active['last']=i;active['scores'].append(score)
        else:
            finish();active={'start':start,'end':end,'first':i,'last':i,'kind':kind,'scores':[score]}
    finish();return groups

def mentions_in_passages(mentions,passages,limit=12):
    contexts=[];at=0
    for p in passages:contexts.append((at,at+len(p['text']),p));at+=len(p['text'])
    result=[];seen=set();unmapped=0
    for mention in sorted(mentions,key=lambda m:(m['start'],m['end'],m['kind'])):
        name=mention['name'];match=next((p for start,end,p in contexts if start<=mention['start']<mention['end']<=end),None)
        if not match or match['text'].find(name)<0 or match['text'].find(name,match['text'].find(name)+1)>=0:
            unmapped+=1;continue
        key=(name,mention['kind'],match['id'])
        if key in seen:continue
        seen.add(key);result.append({'kind':mention['kind'],'name':name,'contextId':match['id']})
    return {'entities':result[:limit],'omitted':max(0,len(result)-limit)+unmapped,'observedMentions':len(mentions)}

def token_windows(text,ids,offsets,limits):
    """Build every model window explicitly; do not depend on tokenizer overflow behavior."""
    if not ids or len(ids)!=len(offsets) or len(ids)>100000:raise ValueError('Invalid complete token sequence')
    covered=0
    for start,end in offsets:
        if not isinstance(start,int) or not isinstance(end,int) or not covered<=start<end<=len(text) or text[covered:start].strip():raise ValueError('Tokenizer omitted or reordered source content')
        covered=end
    if text[covered:].strip():raise ValueError('Tokenizer omitted the end of the source')
    capacity=limits['maxTokens']-2;step=capacity-limits['overlapTokens']
    if step<1:raise ValueError('Invalid entity overlap')
    windows=[];at=0
    while at<len(ids):
        end=min(at+capacity,len(ids))
        windows.append({'ids':ids[at:end],'offsets':offsets[at:end],'startCut':at>0,'endCut':end<len(ids)})
        if len(windows)>limits['maxWindows']:raise ValueError('Entity source exceeds its explicit window limit')
        if end==len(ids):break
        at+=step
    return windows

class EntityExtractor:
    def __init__(self):
        self.spec=json.loads((ROOT/'config/entity-model.json').read_text());limits=self.spec['limits']
        if limits!={'maxCharacters':60000,'maxWindows':64,'maxTokens':512,'overlapTokens':64,'batchSize':4,'minimumTokenScore':0.9}:raise ValueError('Unsupported entity bounds')
        directory=ROOT/'data/models'/f'{self.spec["name"]}-{self.spec["revision"]}'
        loader=importlib.util.spec_from_file_location('entity_model_verifier',ROOT/'scripts/download-classifier-model.py')
        verifier=importlib.util.module_from_spec(loader);loader.loader.exec_module(verifier);verifier.verify(directory,self.spec)
        with open(os.devnull,'w') as quiet,contextlib.redirect_stdout(quiet),contextlib.redirect_stderr(quiet):
            import torch
            from transformers import AutoTokenizer,AutoModelForTokenClassification
            self.torch=torch
            self.tokenizer=AutoTokenizer.from_pretrained(directory,local_files_only=True,trust_remote_code=False,use_fast=True)
            self.model=AutoModelForTokenClassification.from_pretrained(directory,local_files_only=True,trust_remote_code=False,use_safetensors=True).eval()
        if not self.tokenizer.is_fast or self.model.config.id2label!=EXPECTED_LABELS or (self.tokenizer.cls_token_id,self.tokenizer.sep_token_id,self.tokenizer.pad_token_id)!=(101,102,0):raise ValueError('Unexpected entity tokenizer or label definition')

    def extract(self,text,passages,*,deadline):
        limits=self.spec['limits']
        if len(text)>limits['maxCharacters'] or ''.join(p['text'] for p in passages)!=text:raise ValueError('Invalid complete entity source')
        encoded=self.tokenizer(text,add_special_tokens=False,return_offsets_mapping=True,truncation=False,verbose=False)
        windows=token_windows(text,encoded['input_ids'],encoded['offset_mapping'],limits)
        found={}
        for at in range(0,len(windows),limits['batchSize']):
            if time.monotonic()>deadline:raise TimeoutError('Entity extraction exceeded the shared analysis deadline')
            batch=windows[at:at+limits['batchSize']];length=max(len(window['ids'])+2 for window in batch)
            input_ids=[];attention=[];offsets=[]
            for window in batch:
                ids=[101]+window['ids']+[102];padding=length-len(ids)
                input_ids.append(ids+[0]*padding);attention.append([1]*len(ids)+[0]*padding);offsets.append([(0,0)]+window['offsets']+[(0,0)]*(padding+1))
            with self.torch.inference_mode():
                tensor=self.torch.tensor(input_ids,dtype=self.torch.long)
                logits=self.model(input_ids=tensor,attention_mask=self.torch.tensor(attention,dtype=self.torch.long),token_type_ids=self.torch.zeros_like(tensor)).logits
                scores,labels=logits.softmax(dim=-1).max(dim=-1)
                scores=scores.tolist();labels=labels.tolist()
            for j,(row_scores,row_labels) in enumerate(zip(scores,labels)):
                for item in named_tokens(text,offsets[j],[EXPECTED_LABELS[k] for k in row_labels],row_scores,start_cut=batch[j]['startCut'],end_cut=batch[j]['endCut'],threshold=limits['minimumTokenScore']):
                    key=(item['start'],item['end'],item['kind'])
                    if key not in found or item['score']>found[key]['score']:found[key]=item
        if time.monotonic()>deadline:raise TimeoutError('Entity extraction exceeded the shared analysis deadline')
        return {**mentions_in_passages(list(found.values()),passages),'windows':len(windows),'sourceTokens':len(encoded['input_ids']),'coveredCharacters':utf16_length(text),'model':self.spec['name'],'revision':self.spec['revision']}
