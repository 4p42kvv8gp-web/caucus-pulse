import {reviewedEvent, caseSources, incidentBrief} from './incident-helpers.js';

export function createIncidentDesk({api, esc, date, sourceHeader, filters, error, setDirty, onTeach}) {
  const $ = id => document.getElementById(id);
  let desk = null, selected = null, sequence = 0, dirty = false, eventSerial = 0, detailSequence = 0;
  const json = (method,value) => ({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
  const markDirty = value => {dirty=value;if(value)detailSequence++;setDirty(value);};
  const mayLeave = () => !dirty || confirm('Discard the unsaved incident changes?');
  const badge = candidate => `<span class="tag ${candidate.basis==='human-source-review'?'reviewed':''}">${candidate.needsContext?'Needs context':candidate.basis==='human-source-review'?'Source reviewed':'Provisional · first report'}</span>`;
  const eventSummary = event => `<p>${esc(event.description)}</p><p class="quiet">${esc(event.development.replaceAll('-',' '))} · ${event.location?esc(event.location.name):'Location unresolved'} · ${event.districtRelation==='explicitly-stated'?'In-district wording':event.districtRelation==='explicitly-outside'?'Outside-district wording':'District connection unresolved'}</p>`;
  function renderList() {
    const sources = new Map(desk.sources.map(p=>[p.id,p]));
    $('incident-count').textContent = `${desk.candidates.length} suggestions · ${desk.cases.filter(c=>c.status==='watching').length} watched cases`;
    $('incident-incoming').innerHTML = desk.candidates.map(candidate=>{
      const post=sources.get(candidate.postId), title=candidate.story?.subtopic || candidate.event.location?.name || candidate.event.description;
      return `<button class="incident-item ${selected?.kind==='source'&&selected.id===post.id?'selected':''}" data-incident-post="${esc(post.id)}"><span class="incident-item-title">${esc(title)}</span><span class="quiet">${esc(post.memberName)} · ${esc(date(post.createdAt))}</span>${badge(candidate)}</button>`;
    }).join('') || '<div class="empty">No incident suggestions in this archive selection. Posts awaiting collection or review are not covered.</div>';
    $('incident-cases').innerHTML = desk.cases.map(c=>`<button class="incident-item ${selected?.kind==='case'&&selected.id===c.id?'selected':''}" data-incident-case="${esc(c.id)}"><span class="incident-item-title">${esc(c.title)}</span><span class="quiet">${esc(c.status)} · ${c.linkedSources} stored event links</span></button>`).join('') || '<p class="quiet">Track a report to start a case. You decide which sources belong together.</p>';
    const c=desk.coverage;
    $('incident-coverage').textContent = `${c.availablePosts} archived posts in the time selection. ${desk.decisions.noEvent} source reviews reject an incident; ${desk.decisions.needsContext} need context.${c.candidatePostLimitReached||c.omittedOversizedPosts||c.omittedCandidates?` Display is partial: ${c.omittedOversizedPosts} oversized posts and ${c.omittedCandidates} candidates omitted${c.candidatePostLimitReached?'; candidate scan limit reached':''}.`:''}${c.omittedCases?` ${c.omittedCases} older cases outside this view.`:''} Tracked cases are shown across all dates.`;
  }
  async function load() {
    const current=++sequence;
    try {
      const data=await api(`/api/incidents?${filters()}`);
      if(current!==sequence)return;
      desk=data;renderList();
      if(!selected&&!dirty)$('incident-detail').innerHTML='<div class="panel incident-placeholder"><span class="eyebrow">SOURCE-FIRST INCIDENT DESK</span><h2>Select a report or a tracked case</h2><p>Read the original post, assess what it reports, then add it to a case. A location or district connection needs supporting words from the source.</p><p class="quiet">Open any post in the teaching desk to add an incident the model missed.</p></div>';
    } catch(e) {if(current===sequence)error(e.message);}
  }
  function eventFields(event={}) {
    const n=++eventSerial;
    const options=(items,value)=>items.map(([id,label])=>`<option value="${id}" ${id===value?'selected':''}>${label}</option>`).join('');
    return `<fieldset class="event-editor"><legend>Source report</legend><label for="event-description-${n}">Describe what the post reports</label><textarea id="event-description-${n}" name="description" maxlength="1200" rows="2" required>${esc(event.description)}</textarea>
      <label for="event-development-${n}">Development</label><select id="event-development-${n}" name="development">${options([['reported-incident','An incident is being reported'],['update','An update or correction'],['resolution','The source reports a resolution'],['unspecified','Cannot determine']],event.development||'unspecified')}</select>
      <label for="event-evidence-${n}">Exact supporting passage from this post</label><textarea id="event-evidence-${n}" name="evidence" rows="3" required>${esc(event.evidence?.[0]?.text)}</textarea>
      <label for="event-location-${n}">Named location within that passage (optional)</label><input id="event-location-${n}" name="location" maxlength="200" value="${esc(event.location?.name)}" placeholder="Paste the exact place name">
      <label for="event-district-${n}">Connection to this member’s district</label><select id="event-district-${n}" name="districtRelation">${options([['not-established','Not established by the text'],['explicitly-stated','Explicitly placed in the district'],['explicitly-outside','Explicitly placed outside the district']],event.districtRelation||'not-established')}</select>
      <label for="event-district-evidence-${n}">Exact words establishing that district connection</label><textarea id="event-district-evidence-${n}" name="districtEvidence" rows="2">${esc(event.districtEvidence?.[0]?.text)}</textarea>
      <button class="text-button danger" type="button" data-remove-event>Remove this report</button></fieldset>`;
  }
  function sourceDetail(result) {
    const {post,candidates}=result;
    selected={kind:'source',id:post.id};
    $('incident-detail').innerHTML=`<article class="post-card">${sourceHeader(post)}<p class="post-text">${esc(post.text)}</p><div class="post-footer"><span class="quiet">Source text preserved · media and linked pages not assessed</span><button class="text-button" data-teach-incident="${esc(post.id)}">Review topics →</button></div></article>
      <div class="panel"><div class="section-heading"><h2>Review the report</h2><button type="button" class="text-button" id="incident-reload">Reload latest</button></div><p class="quiet">${esc(result.note)}</p>
      <form id="incident-review-form" class="feedback-form"><label>Decision<select id="incident-decision"><option value="events-supported" ${result.decision==='events-supported'?'selected':''}>These source reports are supported</option><option value="no-event" ${result.decision==='no-event'?'selected':''}>This post does not report an incident</option><option value="needs-context" ${result.decision==='needs-context'||result.decision==='unreviewed'?'selected':''}>I need more context</option></select></label>
      <div id="incident-event-rows">${candidates.length?candidates.map(c=>eventFields(c.event)).join(''):eventFields()}</div><button type="button" class="secondary" id="incident-add-event">+ Add a source report</button>
      <label>Why is this interpretation supported?<textarea id="incident-reason" rows="3" maxlength="2000" required placeholder="Explain the wording and any uncertainty…"></textarea></label>
      <div class="feedback-actions"><button class="primary" type="submit">Save incident review</button><span id="incident-save-state" class="success" role="status"></span></div></form></div>
      ${candidates.length?`<div class="panel"><h2>Track this source</h2><p class="quiet">Choose a source interpretation and place it in a case you maintain.</p><form id="incident-track-form" class="feedback-form"><label>Source interpretation<select id="incident-track-event">${candidates.map((c,i)=>`<option value="${esc(c.key)}">${i+1}. ${esc(c.event.description)}</option>`).join('')}</select></label><label>Case<select id="incident-track-case"><option value="">Start a new case</option>${(desk?.cases??[]).map(c=>`<option value="${esc(c.id)}">${esc(c.title)} · ${esc(c.status)}</option>`).join('')}</select></label><label id="incident-title-label">New case title<input id="incident-track-title" maxlength="160" placeholder="A short, descriptive title"></label><button class="secondary" type="submit">Track selected report</button></form></div>`:''}
      ${result.history.length?`<details class="panel"><summary>Incident review history · ${result.reviewCount} saved</summary>${result.history.map(h=>`<div class="history"><strong>${esc(date(h.createdAt))}</strong><p>${esc(h.decision.replaceAll('-',' '))}${h.appliesToCurrentText?'':' · earlier source version'}</p><p>${esc(h.reason)}</p></div>`).join('')}</details>`:''}`;
    const form=$('incident-review-form');let reviewDirty=false;
    function decisionChanged(){const supported=$('incident-decision').value==='events-supported';$('incident-event-rows').hidden=!supported;$('incident-add-event').hidden=!supported;for(const el of $('incident-event-rows').querySelectorAll('input,select,textarea'))el.disabled=!supported;}
    decisionChanged();
    form.addEventListener('input',()=>{reviewDirty=true;markDirty(true);});form.addEventListener('change',()=>{reviewDirty=true;markDirty(true);});
    $('incident-decision').addEventListener('change',decisionChanged);
    $('incident-add-event').addEventListener('click',()=>{if($('incident-event-rows').children.length>=6)return error('A source can have up to six reviewed reports.');$('incident-event-rows').insertAdjacentHTML('beforeend',eventFields());reviewDirty=true;markDirty(true);});
    $('incident-event-rows').addEventListener('click',event=>{if(event.target.closest('[data-remove-event]')){event.target.closest('fieldset').remove();reviewDirty=true;markDirty(true);}});
    $('incident-reload').addEventListener('click',()=>void openSource(post.id));
    form.addEventListener('submit',async event=>{
      event.preventDefault();const button=event.submitter;button.disabled=true;error('');
      try{
        const decision=$('incident-decision').value;
        const events=decision==='events-supported'?[...form.querySelectorAll('.event-editor')].map(row=>reviewedEvent(post.text,Object.fromEntries([...row.querySelectorAll('[name]')].map(el=>[el.name,el.value])),post.type)):[];
        const saved=await api(`/api/posts/${post.id}/incidents`,json('POST',{sourceHash:post.contentHash,predictionHash:post.analysisHash,revision:result.revision,decision,events,reason:$('incident-reason').value}));
        markDirty(false);sourceDetail(saved);$('incident-save-state').textContent='Saved with the source wording and your explanation.';await load();
      }catch(e){error(e.message);button.disabled=false;}
    });
    if($('incident-track-form')){
      $('incident-track-form').addEventListener('input',()=>markDirty(true));
      $('incident-track-case').addEventListener('change',()=>{$('incident-title-label').hidden=!!$('incident-track-case').value;markDirty(true);});
      $('incident-track-form').addEventListener('submit',async event=>{
        event.preventDefault();event.submitter.disabled=true;error('');
        try{
          if(reviewDirty)throw new Error('Save or reload your incident review before tracking its interpretation.');
          const link={postId:post.id,sourceHash:post.contentHash,predictionHash:post.analysisHash,eventKey:$('incident-track-event').value};
          const id=$('incident-track-case').value;
          const result=id?await (async()=>{const current=await api(`/api/incidents/cases/${id}`);return api(`/api/incidents/cases/${id}`,json('PATCH',{revision:current.revision,addSources:[link],reason:'Added this source report from the incident desk.'}));})():await api('/api/incidents/cases',json('POST',{title:$('incident-track-title').value,sources:[link]}));
          markDirty(false);caseDetail(result);await load();
        }catch(e){error(e.message);event.submitter.disabled=false;}
      });
    }
    if(desk)renderList();
  }
  async function openSource(id) {
    if(!mayLeave())return false;
    const current=++detailSequence;markDirty(false);
    try{const result=await api(`/api/posts/${id}/incidents`);if(current!==detailSequence)return false;sourceDetail(result);error('');return true;}
    catch(e){if(current===detailSequence)error(e.message);return false;}
  }
  function caseDetail(record) {
    selected={kind:'case',id:record.id};
    $('incident-detail').innerHTML=`<div class="panel"><div class="section-heading"><div><span class="eyebrow">TRACKED CASE</span><h2>${esc(record.title)}</h2></div><button class="secondary" id="incident-copy" type="button">Copy source digest</button></div><p class="quiet">${record.posts} source posts · ${record.members} stored members · ${esc(record.status)}</p><p class="quiet">${esc(record.note)}</p><span id="incident-copy-state" class="success" role="status"></span>
      <form id="incident-case-form" class="feedback-form"><label>Case title<input id="incident-case-title" maxlength="160" value="${esc(record.title)}" required></label><label>Desk status<select id="incident-case-status">${['watching','resolved','dismissed'].map(v=>`<option value="${v}" ${v===record.status?'selected':''}>${v==='watching'?'Watching':v==='resolved'?'Resolved by your review':'Dismissed by your review'}</option>`).join('')}</select></label><label>Reason for this update<textarea id="incident-case-reason" maxlength="1000" rows="2" required></textarea></label><button class="secondary" type="submit">Save case update</button><button class="text-button" id="incident-case-reload" type="button">Reload latest</button></form></div>
      ${record.stale.length||record.omittedOversizedSources?`<div class="notice">${record.stale.length} links changed after they were added; ${record.omittedOversizedSources} sources exceed display limits. They are excluded from the timeline and digest.${record.stale.map(s=>`<div class="post-footer"><button class="text-button" data-incident-post="${esc(s.postId)}">Review changed source →</button><button class="text-button danger" data-remove-link="${esc(s.eventKey)}">Remove outdated link</button></div>`).join('')}</div>`:''}
      <div class="section-heading"><h2>Source timeline</h2><span class="quiet">Earliest archived source first</span></div>
      ${caseSources(record).map(({post,candidates})=>`<article class="post-card">${sourceHeader(post)}<p class="post-text">${esc(post.text)}</p>${candidates.map(c=>`<div class="evidence">${badge(c)}${eventSummary(c.event)}<button class="text-button danger" type="button" data-remove-link="${esc(c.key)}">Remove this interpretation from the case</button></div>`).join('')}<button class="text-button" data-incident-post="${esc(post.id)}">Review source interpretation →</button></article>`).join('')||'<div class="empty">No current source links are available for this case.</div>'}
      <details class="panel"><summary>Case history</summary>${record.history.map(h=>`<div class="history"><strong>${esc(date(h.createdAt))} · ${esc(h.action)}</strong><p>${esc(h.reason||h.title)}</p></div>`).join('')}</details>`;
    $('incident-copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(incidentBrief(record));$('incident-copy-state').textContent='Copied locally. Nothing was sent.';}catch{$('incident-copy-state').textContent='Clipboard unavailable. Select and copy the visible source text.';}});
    $('incident-case-form').addEventListener('input',()=>markDirty(true));$('incident-case-form').addEventListener('change',()=>markDirty(true));
    $('incident-case-reload').addEventListener('click',()=>void openCase(record.id));
    $('incident-case-form').addEventListener('submit',async event=>{event.preventDefault();event.submitter.disabled=true;try{
      const result=await api(`/api/incidents/cases/${record.id}`,json('PATCH',{revision:record.revision,title:$('incident-case-title').value,status:$('incident-case-status').value,reason:$('incident-case-reason').value}));markDirty(false);caseDetail(result);await load();error('');
    }catch(e){error(e.message);event.submitter.disabled=false;}});
    for(const button of $('incident-detail').querySelectorAll('[data-remove-link]'))button.addEventListener('click',async()=>{
      if(!mayLeave())return;
      button.disabled=true;
      try{const result=await api(`/api/incidents/cases/${record.id}`,json('PATCH',{revision:record.revision,removeSources:[button.dataset.removeLink],reason:'Removed this source interpretation from the case.'}));markDirty(false);caseDetail(result);await load();}
      catch(e){error(e.message);button.disabled=false;}
    });
    if(desk)renderList();
  }
  async function openCase(id) {
    if(!mayLeave())return false;
    const current=++detailSequence;markDirty(false);
    try{const result=await api(`/api/incidents/cases/${id}`);if(current!==detailSequence)return false;caseDetail(result);error('');return true;}
    catch(e){if(current===detailSequence)error(e.message);return false;}
  }
  $('view-incidents').addEventListener('click',event=>{
    const post=event.target.closest('[data-incident-post]'), item=event.target.closest('[data-incident-case]'), teach=event.target.closest('[data-teach-incident]');
    if(post)void openSource(post.dataset.incidentPost);else if(item)void openCase(item.dataset.incidentCase);else if(teach&&mayLeave()){markDirty(false);onTeach(teach.dataset.teachIncident);}
  });
  $('incident-refresh').addEventListener('click',()=>void load());
  return {load,openSource,isDirty:()=>dirty};
}
