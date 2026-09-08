export function createOverview({api, esc, date, postCard, filters, review, topic, wording, incident}) {
  const $=id=>document.getElementById(id);let sequence=0, phrases=new Map();
  function render(data) {
    const total=data.page.totalPosts;
    $('dashboard-subject-count').textContent=`${data.topics.length} topics · ${total} selected posts`;
    const order=$('dashboard-topic-sort').value;
    const topics=[...data.topics].sort((a,b)=>order==='name'?a.topic.localeCompare(b.topic):(order==='posts'?b.posts-a.posts||b.members-a.members:b.members-a.members||b.posts-a.posts)||a.topic.localeCompare(b.topic));
    $('dashboard-topics').innerHTML=topics.map(t=>{
      const share=total?Math.min(100,100*t.posts/total):0;
      return `<tr><td><button class="subject-title" data-overview-topic="${esc(t.topic)}">${esc(t.topic)}</button><div class="subject-subtopics">${t.subtopics.map(s=>`<span><button class="text-button" data-overview-topic="${esc(t.topic)}" data-overview-subtopic="${esc(s.label)}">${esc(s.label)}</button><b>${s.posts} ${s.posts===1?'post':'posts'}</b></span>`).join('')}</div></td><td>${t.posts}</td><td>${t.members}</td><td>${Math.round(share)}%<meter class="share-meter" min="0" max="100" value="${share.toFixed(2)}" aria-label="Share of filtered posts">${Math.round(share)}%</meter></td></tr>`;
    }).join('')||'<tr><td colspan="4"><div class="empty">No labeled subjects in this selection. Explore all archived dates or review an unclassified post.</div></td></tr>';
    $('dashboard-feed').innerHTML=data.posts.slice(0,5).map(postCard).join('')||'<div class="empty">No archived posts match this selection.</div>';
  }
  async function loadSignals() {
    const current=++sequence;const params=new URLSearchParams(filters());
    // Discovery APIs intentionally have a bounded recent window even when archive browsing is unbounded.
    const windowNote=params.has('since')?'Uses the selected time window.':'Last 24 hours; archive browsing above may include older posts.';
    const calls=[['dashboard-language',`/api/language?${params}&limit=5&minMembers=2`],['dashboard-emerging',`/api/emerging?${params}&limit=4`],['dashboard-incidents',`/api/incidents?${params}`]];
    const results=await Promise.allSettled(calls.map(async([,path])=>api(path)));
    if(current!==sequence)return;
    results.forEach((result,i)=>{
      const target=$(calls[i][0]);
      if(result.status==='rejected'){target.innerHTML=`<p class="quiet">${esc(result.reason.message)}</p>`;return;}
      const data=result.value;
      if(i===0){
        phrases=new Map(data.groups.map(g=>[g.id,g.phrase]));
        target.innerHTML=data.groups.map(g=>`<div class="signal-item"><button class="text-button" data-overview-phrase="${esc(g.id)}">“${esc(g.phrase.length>180?g.phrase.slice(0,180)+'…':g.phrase)}”</button><p class="quiet">${g.distinctMembers} stored members · ${g.matchingPosts} posts</p></div>`).join('')||'<p class="quiet">No repeated passage meets the two-member threshold in this selection.</p>';
        target.insertAdjacentHTML('beforeend',`<p class="signal-note">Exact wording, with source punctuation preserved. ${esc(windowNote)}${data.coverage.partial?' Processing coverage is partial.':''} Similar wording does not establish coordination.</p>`);
      }else if(i===1){
        target.innerHTML=data.groups.map(g=>`<div class="signal-item"><p>${esc(g.title.text.length>150?g.title.text.slice(0,150)+'…':g.title.text)}</p><span class="quiet">${g.members} stored members · ${g.posts} posts · source excerpt</span></div>`).join('')||'<p class="quiet">No related-subject group meets the current source and member thresholds.</p>';
        target.insertAdjacentHTML('beforeend',`<p class="signal-note">Provisional passage groups. ${esc(windowNote)} ${data.coverage.complete?'':'Index or processing coverage is partial. '}Related subjects may contain opposing positions.</p>`);
      }else{
        const sources=new Map(data.sources.map(p=>[p.id,p]));
        target.innerHTML=data.candidates.slice(0,5).map(c=>{const post=sources.get(c.postId);return `<div class="signal-item"><button class="text-button" data-overview-incident="${esc(post.id)}">${esc(c.event.location?.name||c.event.description)}</button><p class="quiet">${esc(post.memberName)} · ${esc(date(post.createdAt))} · ${c.basis==='human-source-review'?'source reviewed':'suggested'}</p></div>`;}).join('')||'<p class="quiet">No incident suggestions in the selected archive window. This does not establish that no incident occurred.</p>';
        const c=data.coverage;
        target.insertAdjacentHTML('beforeend',`<p class="signal-note">${esc(windowNote)} ${data.candidates.length>5?`${data.candidates.length-5} more suggestions in the incident desk. `:''}${c.candidatePostLimitReached||c.omittedOversizedPosts||c.omittedCandidates?'Candidate processing coverage is partial. ':''}Reports need source review; current conditions are unverified.</p>`);
      }
    });
  }
  $('view-dashboard').addEventListener('click',event=>{
    const r=event.target.closest('[data-review]'),t=event.target.closest('[data-overview-topic]'),p=event.target.closest('[data-overview-phrase]'),i=event.target.closest('[data-overview-incident]');
    if(r)review(r.dataset.review);else if(t)topic(t.dataset.overviewTopic,t.dataset.overviewSubtopic);else if(p)wording(phrases.get(p.dataset.overviewPhrase));else if(i)incident(i.dataset.overviewIncident);
  });
  return {render,loadSignals};
}
