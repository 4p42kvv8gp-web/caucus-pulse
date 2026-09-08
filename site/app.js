const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const date = value => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not available';
const state = { data: null, view: 'explore', selected: null, dirty: false, sequence: 0, cursor: '', pageParams: '', semanticSequence:0,emergingSequence:0 };

async function api(path, options) {
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || 'Request failed.'); error.code = result.code; throw error; }
  return result;
}
function showError(message) { $('error').textContent = message; $('error').hidden = !message; }
function filterParams() {
  const params = new URLSearchParams({ query: $('search').value, memberId: $('member').value,
    topic: $('topic').value, type: $('post-type').value });
  if ($('period').value !== 'all') params.set('since', new Date(Date.now() - Number($('period').value) * 3_600_000).toISOString());
  return params;
}
function setOptions(element, options, first) {
  const previous = element.value;
  // Keep a selected filter visible if a correction removes its last matching post.
  if (previous && !options.some(o => o.id === previous)) options = [...options, { id: previous, name: previous }];
  element.innerHTML = `<option value="">${esc(first)}</option>` + options.map(o => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('');
  if (options.some(o => o.id === previous)) element.value = previous;
}
function tags(post) {
  return `<div class="tags">${post.labels.length ? post.labels.map(l => `<span class="tag">${esc(l.topic)}${l.subtopic ? ` / ${esc(l.subtopic)}` : ''}</span>`).join('') : '<span class="tag">Awaiting subject classification</span>'}<span class="tag ${post.reviewStatus === 'reviewed' ? 'reviewed' : ''}">${post.reviewStatus === 'reviewed' ? 'Reviewed correction' : 'Provisional'}</span></div>`;
}
function sourceEvidence(spans = []) {
  return spans.map(span => `<blockquote class="post-text">${esc(span.text)}</blockquote>`).join('');
}
function semanticDetails(analysis) {
  const entities = analysis.entities ?? []; const events = analysis.events ?? [];
  return `${entities.length ? `<h3>Entities mentioned</h3>${entities.map(e => `<div class="evidence"><strong>${esc(e.name)} · ${esc(e.kind)}</strong>${sourceEvidence(e.evidence)}</div>`).join('')}` : ''}
    ${events.length ? `<h3>Possible events</h3><p class="quiet">Descriptions of what the source reports. Whether an event is new has not been established.</p>${events.map(e => `<div class="evidence"><strong>${esc(e.development)}</strong><p>${esc(e.description)}</p>${sourceEvidence(e.evidence)}<p class="quiet">${e.location ? `Named location: ${esc(e.location.name)}` : 'Location not established'} · ${e.districtRelation === 'explicitly-stated' ? 'Source explicitly mentions the district' : 'District connection not established'}</p>${sourceEvidence(e.districtEvidence)}</div>`).join('')}` : ''}`;
}
function sourceHeader(post) {
  const initials = post.memberName.split(' ').map(s => s[0]).slice(0, 2).join('');
  return `<div class="post-header"><div class="avatar" aria-hidden="true">${esc(initials)}</div><div><span class="author">${esc(post.memberName)}</span><span class="post-meta">@${esc(post.handle)} · ${esc(post.type)}<br>${esc(date(post.createdAt))}</span></div><a class="post-source" href="${esc(post.sourceUrl)}" target="_blank" rel="noopener noreferrer">View on X ↗</a></div>`;
}
function postCard(post) {
  const coverage = post.textCoverage === 'api-text-verified' ? 'API text verified' : post.textCoverage === 'extended-api-text' ? 'Extended API text returned' : 'Available API text; completeness unverified';
  return `<article class="post-card">${sourceHeader(post)}<p class="post-text">${esc(post.text)}</p>${tags(post)}<div class="post-footer"><span class="quiet">${esc(coverage)} · media not reviewed</span><button class="text-button" data-review="${esc(post.id)}">Review classification →</button></div></article>`;
}
function renderStats() {
  const c = state.data.coverage;
  $('stats').innerHTML = [
    ['Archived source posts', c.postCount, `${c.historicalPostCount} historical examples / ${c.collectedPostCount} from collection`],
    ['Members represented', c.memberCount, 'Within this archive only'],
    ['Posts reviewed', c.reviewedPosts, 'Your saved corrections'],
    ['Daily X ceiling', `$${state.data.budget.dailyCeilingUsd}`, `$50 reserve · ${state.data.budget.state?.balanceFresh ? 'recent balance check' : 'balance check required'}`]
  ].map(([label, value, note]) => `<div class="stat"><label>${esc(label)}</label><strong>${esc(value)}</strong><small>${esc(note)}</small></div>`).join('');
  $('archive-notice').textContent = `${c.historicalPostCount} historical examples and ${c.collectedPostCount} posts admitted from collection. ${c.collectionStatus}. Semantic analysis and automatic trend discovery are still being built; current automatic labels use a word-matching baseline.`;
}
function renderExplore() {
  const { posts, topics, page } = state.data;
  $('result-count').textContent = `${posts.length} of ${page.totalPosts} matching posts · ${state.cursor ? 'older page' : 'newest first'}`;
  $('posts').innerHTML = posts.map(postCard).join('') || '<div class="empty">No archived posts match these filters. The preview contains historical examples; select “All archived dates” to see them.</div>';
  if (state.cursor || page.hasMore) $('posts').insertAdjacentHTML('beforeend', `<div class="post-footer" aria-label="Post pages">${state.cursor ? '<button class="text-button" data-page="newest">Back to newest posts</button>' : '<span></span>'}${page.hasMore ? '<button class="text-button" data-page="older">Older posts →</button>' : ''}</div>`);
  $('topics').innerHTML = topics.map(t => `<div class="topic-row"><div class="topic-head"><strong>${esc(t.topic)}</strong><span>${t.posts} posts</span></div><span class="quiet">${t.members} distinct ${t.members === 1 ? 'member' : 'members'}</span>${t.subtopics.map(s => `<div class="subtopic">${esc(s.label)}<br><span class="quiet">${s.posts} ${s.posts === 1 ? 'post' : 'posts'}</span></div>`).join('')}</div>`).join('') || '<p class="quiet">No labeled subjects in this selection.</p>';
}
function renderCoverage() {
  const c = state.data.coverage; const b = state.data.budget;
  const ops = state.data.operations; const usage = b.state;
  const roster = ops.roster.snapshot;
  const inventory = ops.inventory;
  const dollars = micro => `$${((micro ?? 0) / 1_000_000).toFixed(3)}`;
  function rows(items) { return items.map(([label, value]) => `<div class="detail-row"><small>${esc(label)}</small>${esc(value)}</div>`).join(''); }
  $('coverage').innerHTML = `<div class="panel"><h3>Source coverage</h3>${rows([
    ['Collection', c.collectionStatus], ['Accounts', c.rosterStatus], ['Earliest archived post', date(c.firstPostAt)],
    ['House Clerk inventory', roster ? `${roster.memberCount} names / published ${roster.publishedOn} / ${roster.fresh ? 'within observation window' : 'refresh required'}` : 'Not imported'],
    ['Roster last retrieved', date(roster?.retrievedAt)],
    ['Supplied List inventory', inventory?.current ? `${inventory.current.accounts} observed accounts / ${inventory.fresh ? 'current observation' : 'refresh required'} / completed ${date(inventory.current.completedAt)}` : 'No completed account scan'],
    ['Account scan in progress', inventory?.active ? `${inventory.active.status} / ${inventory.active.pages} pages / ${inventory.active.reason ?? 'continuing'}` : 'None'],
    ['Latest archived post', date(c.lastPostAt)], ['Last source retrieval', date(c.lastImportedAt)],
    ['Context', 'Available source text is preserved; each post states its text coverage. Media and linked content are not reviewed.'],
    ['Captured posts awaiting roster validation', String(ops.awaitingRoster)],
    ['Analysis jobs', `${ops.analysisPending} pending / ${ops.analysisFailed} failed`],
    ['Collection intervals', ops.sources.length ? ops.sources.map(s => `${s.status ?? 'Not started'}${s.reason ? `: ${s.reason}` : ''}`).join('; ') : 'No live interval has started']
  ])}<p class="quiet">A roster name does not establish X account ownership or historical membership before the source observation.</p><a href="https://x.com/i/lists/1841177179872243858" target="_blank" rel="noopener noreferrer">Open the supplied X List ↗</a> · <a href="https://clerk.house.gov/xml/lists/MemberData.xml" target="_blank" rel="noopener noreferrer">House Clerk source ↗</a></div>
  <div class="panel"><h3>Budget and analysis</h3>${rows([
    ['Reported prepaid credit', `$${b.reportedCreditUsd} — not yet verified against the account`],
    ['Configured limits', `$${b.dailyCeilingUsd} per UTC day / $${b.pilotCeilingUsd} total pilot / $${b.reserveUsd} reserve`],
    ['Usage', b.usageStatus],
    ['Conservative spending recorded', `${dollars(usage?.dailyMicro)} today / ${dollars(usage?.totalMicro)} total`],
    ['Provider balance', usage?.balanceVerifiedAt ? `${usage.balanceFresh ? 'Fresh' : 'Expired'} observation from ${date(usage.balanceVerifiedAt)}` : 'Not yet verified; paid requests are blocked'],
    ['Uncertain or unfinished paid requests', String(usage?.unresolvedRequests ?? 0)],
    ['Analysis', c.analysisStatus],
    ['General lessons awaiting review', String(c.pendingRuleProposals)], ['Optional paid work', 'Bulk history and repeated engagement checks are disabled.']
  ])}</div>`;
  const connection = state.data.connection;
  $('connection-status').textContent = connection?.configured ? `Token present (${connection.source === 'environment' ? 'runtime environment' : 'private local file'}). Saving makes no access test; the balance and collection observations are shown above.` : 'No product token is configured yet.';
  $('save-connection').disabled = connection?.source === 'environment';
}
function labelRow(label = {}) {
  return `<div class="label-entry"><label>Topic<input name="topic" maxlength="100" value="${esc(label.topic)}" placeholder="e.g. Immigration"></label><label>Subtopic (optional)<input name="subtopic" maxlength="160" value="${esc(label.subtopic)}" placeholder="e.g. Dilley detention facility"></label><button type="button" class="remove" aria-label="Remove label">×</button></div>`;
}
function renderReview() {
  const posts = state.data.posts;
  if (!posts.some(p => p.id === state.selected)) state.selected = posts[0]?.id ?? null;
  $('review-select').innerHTML = posts.map(p => `<option value="${esc(p.id)}">${esc(p.memberName)} · ${esc(date(p.createdAt))}</option>`).join('');
  $('review-select').value = state.selected ?? '';
  const post = posts.find(p => p.id === state.selected);
  if (!post) { $('review').innerHTML = '<div class="empty">No posts match the current filters. Broaden the selection to start a review.</div>'; return; }
  const proposal = post.provenance.assistantProposal;
  $('review').innerHTML = `<div class="review-grid"><div><article class="post-card">${sourceHeader(post)}<p class="post-text">${esc(post.text)}</p>${tags(post)}
    <div class="explanation"><h3>Current analysis explanation</h3><p class="quiet">${esc(post.analysis.method)} · ${esc(post.analysis.version ?? 'Awaiting analysis')}</p><p>${esc(post.analysis.explanation)}</p>${post.analysis.labels.map(l => `<div class="evidence"><strong>${esc(l.topic)}${l.subtopic ? ` / ${esc(l.subtopic)}` : ''}</strong>${esc(l.explanation)}${sourceEvidence(l.evidence)}</div>`).join('')}
    ${semanticDetails(post.analysis)}
    ${proposal ? `<div class="explanation"><h3>Prepared discussion proposal</h3><p>${esc(proposal.justification)}</p><p class="quiet">${esc(proposal.uncertainty)}</p><p class="quiet">Prepared by the assistant for this exercise; not an accepted rule or an automated semantic result.</p></div>` : ''}
    <div class="limits">Context limits<ul>${post.analysis.limitations.map(l => `<li>${esc(l)}</li>`).join('')}</ul></div></div></article></div>
    <div class="panel"><h3>Your interpretation</h3><p class="quiet">${esc(post.provenance.reviewPrompt ?? 'What should this post be classified as, and what wording supports that interpretation?')}</p>
    <form id="feedback-form" class="feedback-form"><div id="label-rows">${(post.labels.length ? post.labels : [{}]).map(labelRow).join('')}</div><button type="button" class="secondary" id="add-label">+ Add another topic</button>
    <label>Why is this the right interpretation?<textarea id="feedback-reason" rows="4" maxlength="2000" placeholder="Explain the distinction you want the product to learn…" required></textarea></label>
    <label>Possible general lesson (optional)<textarea id="feedback-rule" rows="3" maxlength="2000" placeholder="A rule to test on other posts. This will be saved as a proposal."></textarea></label>
    <p class="quiet">Leave all topic rows blank to mark this post as needing classification. The reason is still required.</p><div class="feedback-actions"><button class="primary" type="submit">Save correction</button><span id="save-state" class="success" role="status"></span></div></form>
    ${post.feedback.length ? `<div class="history"><h3>Saved review history</h3>${post.feedback.map(f => `<p><strong>${esc(date(f.createdAt))}</strong>${!f.appliesToCurrentText ? ' · Earlier source version' : ''}<br>${esc(f.reason)}${f.ruleProposal ? `<br><span class="quiet">Proposed general lesson: ${esc(f.ruleProposal)}</span>` : ''}</p>`).join('')}</div>` : ''}</div></div>`;
  $('add-label').addEventListener('click', () => { $('label-rows').insertAdjacentHTML('beforeend', labelRow()); state.dirty = true; });
  $('label-rows').addEventListener('click', event => { if (event.target.closest('.remove')) { event.target.closest('.label-entry').remove(); state.dirty = true; } });
  $('feedback-form').addEventListener('input', () => { state.dirty = true; });
  $('feedback-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter; button.disabled = true; showError('');
    const labels = [...document.querySelectorAll('.label-entry')].map(row => ({
      topic: row.querySelector('[name=topic]').value.trim(), subtopic: row.querySelector('[name=subtopic]').value.trim() || null
    })).filter(l => l.topic || l.subtopic);
    try {
      await api(`/api/posts/${post.id}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceHash: post.contentHash, labels, reason: $('feedback-reason').value, ruleProposal: $('feedback-rule').value || null }) });
      state.dirty = false; await refresh();
      if ($('save-state')) $('save-state').textContent = 'Saved. This post now uses your correction.';
    } catch (error) { showError(error.message); button.disabled = false; }
  });
}
async function refresh({ cursor = '', params = null } = {}) {
  const sequence = ++state.sequence;
  try {
    const query = new URLSearchParams(params ?? filterParams());
    const pageParams = query.toString();
    if (cursor) query.set('cursor',cursor);
    const data = await api(`/api/dashboard?${query}`);
    if (sequence !== state.sequence) return;
    state.data = data; state.cursor = cursor; state.pageParams = pageParams;
    showError(''); renderStats(); renderExplore(); renderCoverage();
    setOptions($('member'), data.members, 'All members');
    setOptions($('topic'), data.availableTopics.map(t => ({ id: t, name: t })), 'All topics');
    if (!state.dirty) renderReview();
    $('updated').textContent = cursor ? 'Reading older posts · return to newest to refresh' : `View refreshed ${new Date(data.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    if (state.view === 'wording' && $('phrase-input').value) await loadPhrase();
    if (state.view === 'semantic') { await semanticStatus(); if($('semantic-query').value) await loadSemantic(); }
    if (state.view === 'emerging') await loadEmerging();
  } catch (error) {
    if (sequence !== state.sequence) return;
    if (error.code === 'EXPLORER_CHANGED') {
      await refresh(); showError('The archive changed. Showing the newest results so pages stay consistent.');
    } else showError(`${error.message} Last successful data remains visible.`);
  }
}
const headings = {
  explore: ['Listen. Trace. Understand.', 'Read the source. Explore the subjects. Teach the distinctions.'],
  teach: ['Teach the distinctions.', 'Your judgment becomes a saved example the product can learn from.'],
  wording: ['Keep every word.', 'Look closely at the language, with the complete source alongside it.'],
  semantic: ['Find related subjects.', 'Search ideas while keeping each source and its wording visible.'],
  emerging: ['Watch subjects take shape.', 'Provisional passage groups, observed activity, and the source evidence.'],
  coverage: ['Trust starts with coverage.', 'See the boundaries of the archive and the state of the product.']
};
function setView(view) {
  state.view = view;
  for (const el of document.querySelectorAll('.view')) el.hidden = el.id !== `view-${view}`;
  for (const el of document.querySelectorAll('[data-view]')) { el.classList.toggle('active', el.dataset.view === view); el.setAttribute('aria-current', el.dataset.view === view ? 'page' : 'false'); }
  [$('page-title').textContent, $('page-description').textContent] = headings[view];
  if(view==='semantic')void semanticStatus();
  if(view==='emerging')void loadEmerging();
}
async function semanticStatus(){
  try{
    const status=await api('/api/semantic');
    $('semantic-status').textContent=`${status.indexedPosts} of ${status.archivePosts} archived posts indexed. ${status.runtime.ready?'Search runs privately on this computer.':'The local model is not ready.'} ${status.pending?`${status.pending} posts awaiting indexing. `:''}${status.failed||status.skipped?`${status.failed} failed / ${status.skipped} outside indexing limits.`:''}`;
    $('semantic-submit').disabled=!status.runtime.ready;
  }catch(error){$('semantic-status').textContent=error.message;$('semantic-submit').disabled=true;}
}
async function loadSemantic(){
  const sequence=++state.semanticSequence;
  const query=$('semantic-query').value;
  if(!query.trim())return;
  $('semantic-submit').disabled=true;
  try{
    const result=await api('/api/semantic/search',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({query,filters:Object.fromEntries(filterParams()),limit:20})});
    if(sequence!==state.semanticSequence)return;
    const c=result.coverage;
    $('semantic-results').innerHTML=`<div class="panel"><h3>${c.returnedPosts} related-subject results</h3><p class="quiet">${esc(result.searchNote)}</p><p class="quiet">${c.indexedPosts} of ${c.totalPosts} filtered posts indexed; ${c.examinedPosts} examined for this search. ${c.complete?'The indexed selection was examined.':'Coverage is partial: some sources or passages were not examined.'}${c.omittedSentenceDetails?` ${c.omittedSentenceDetails} additional sentence details were omitted; full context windows remain indexed.`:''}</p></div>`+
      (result.results.map(({post,evidence})=>{
        const best=evidence[0];
        return `<article class="post-card">${sourceHeader(post)}<p class="quiet">Highlighted passage matched the subject. Read the surrounding wording for context.</p><p class="post-text">${esc(post.text.slice(0,best.start))}<mark class="phrase-match">${esc(best.text)}</mark>${esc(post.text.slice(best.end))}</p>${tags(post)}<p class="quiet">${post.type==='repost'?'Amplified wording; authorship and agreement are not established.':post.type==='quote'?'Quotation context and agreement are not established.':'Media and linked context have not been reviewed.'}</p></article>`;
      }).join('')||'<div class="empty">No indexed posts are available in this selection. Broaden the filters or check indexing status.</div>');
    showError('');
  }catch(error){if(sequence===state.semanticSequence)showError(error.message);}
  finally{if(sequence===state.semanticSequence)$('semantic-submit').disabled=false;}
}
$('semantic-form').addEventListener('submit',event=>{event.preventDefault();void loadSemantic();});
async function loadEmerging(){
  const sequence=++state.emergingSequence;$('emerging-refresh').disabled=true;
  try{
    const result=await api(`/api/emerging?${filterParams()}`);
    if(sequence!==state.emergingSequence)return;
    const sources=new Map(result.sourcePosts.map(p=>[p.id,p])),c=result.coverage;
    $('emerging-results').innerHTML=`<div class="panel"><h3>${result.groups.length} candidate groups</h3><p class="quiet">${esc(date(result.window.since))} — ${esc(date(result.window.until))}</p><p class="quiet">${c.admittedPosts} posts examined from ${c.indexedPosts} indexed, non-repost sources in the selection. ${c.unindexedPosts} posts await indexing. ${c.complete?'The selected indexed archive was covered.':'Coverage is partial because some sources were unindexed or outside processing limits.'}</p><p class="quiet">${esc(result.note)}</p></div>`+
      (result.groups.map(group=>{
        const short=group.title.text.length>180?group.title.text.slice(0,180)+'…':group.title.text;
        return `<article class="panel"><p class="quiet">Representative source excerpt · provisional group</p><h3>${esc(short)}</h3><p>${group.posts} posts · ${group.members} distinct stored members</p><p class="quiet">Latest half-hour: ${group.recent.posts} observed posts. ${group.previous.completeWindow?`Previous half-hour: ${group.previous.posts} observed posts.`:'The previous half-hour is not fully covered by this indexed selection.'}</p><p class="quiet">First observed within this selection: ${esc(date(group.firstObservedInSelection))}</p>
          ${group.sourceTopics.length?`<div class="tags">${group.sourceTopics.map(t=>`<span class="tag">${esc(t.topic)}${t.subtopic?' / '+esc(t.subtopic):''}</span>`).join('')}</div><p class="quiet">Topics assigned to the source posts; these are not confirmed group labels.</p>`:''}
          <details><summary>Read the ${group.posts} source posts</summary>${group.evidence.map(e=>{
            const post=sources.get(e.postId);
            return `<div class="evidence"><strong>${esc(post.memberName)}</strong><p class="quiet">${esc(date(post.createdAt))} · ${esc(post.type)}${post.type==='quote'?' · Quotation context unresolved':''}</p><p class="post-text">${esc(post.text.slice(0,e.start))}<mark class="phrase-match">${esc(post.text.slice(e.start,e.end))}</mark>${esc(post.text.slice(e.end))}</p><a href="${esc(post.sourceUrl)}" target="_blank" rel="noopener noreferrer">View on X ↗</a></div>`;
          }).join('')}</details></article>`;
      }).join('')||'<div class="empty">No candidate group meets the current source and member requirements. This does not establish that no real-world trend exists.</div>');
    showError('');
  }catch(error){if(sequence===state.emergingSequence)showError(error.message);}
  finally{if(sequence===state.emergingSequence)$('emerging-refresh').disabled=false;}
}
$('emerging-refresh').addEventListener('click',()=>void loadEmerging());
async function loadPhrase() {
  const params = filterParams(); params.set('phrase', $('phrase-input').value);
  try {
    const result = await api(`/api/phrases?${params}`); showError('');
    $('phrase-results').innerHTML = `<div class="panel"><h3>${result.matchingPosts} matching posts · ${result.distinctMembers} distinct members</h3><p class="quiet">${esc(result.note)}</p><p class="quiet">First occurrence within this selection: ${esc(date(result.firstObservedInSelection))}</p></div>` + result.occurrences.map(o => `<article class="post-card"><h3>${esc(o.memberName)} <span class="quiet">${esc(date(o.createdAt))}</span></h3><p class="post-text">${esc(o.text.slice(0, o.span.start))}<mark class="phrase-match">${esc(o.span.text)}</mark>${esc(o.text.slice(o.span.end))}</p><a href="${esc(o.sourceUrl)}" target="_blank" rel="noopener noreferrer">Open source ↗</a></article>`).join('');
  } catch (error) { showError(error.message); }
}
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
$('posts').addEventListener('click', event => {
  const page = event.target.closest('[data-page]');
  if (page) {
    if (state.dirty && !confirm('Discard the unsaved review before switching pages?')) return;
    state.dirty = false; page.disabled = true;
    const options = page.dataset.page === 'older' ? { cursor:state.data.page.nextCursor,params:state.pageParams } : {};
    refresh(options).finally(() => { page.disabled = false; }); return;
  }
  const button = event.target.closest('[data-review]');
  if (!button) return;
  if (state.dirty && !confirm('Discard the unsaved review before switching posts?')) return;
  state.dirty = false; state.selected = button.dataset.review; renderReview(); setView('teach');
});
$('review-select').addEventListener('change', event => {
  if (state.dirty && !confirm('Discard the unsaved review before switching posts?')) { event.target.value = state.selected; return; }
  state.dirty = false; state.selected = event.target.value; renderReview();
});
for (const id of ['member', 'topic', 'post-type', 'period']) $(id).addEventListener('change', refresh);
let searchTimer;
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(refresh, 200); });
$('phrase-form').addEventListener('submit', event => { event.preventDefault(); loadPhrase(); });
$('connection-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('save-connection'); button.disabled = true; $('connection-result').textContent = ''; showError('');
  try {
    await api('/api/settings/x-credential', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bearerToken: $('x-token').value }) });
    $('x-token').value = ''; $('connection-result').textContent = 'Saved privately. Collection remains off.';
    await refresh();
  } catch (error) { showError(error.message); }
  finally { button.disabled = state.data?.connection?.source === 'environment'; }
});
window.addEventListener('beforeunload', event => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });
await refresh(); setInterval(() => { if (!state.cursor && !state.dirty) refresh(); }, 60_000);
