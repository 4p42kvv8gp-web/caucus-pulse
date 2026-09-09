export function storyContextHtml(context,{esc,date,sourceEvidence}){
  if(!context)return '';
  const {stories,outside}=context;
  const link=source=>{
    let u;try{u=new URL(source.url);}catch{return esc(source.title);}
    if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return esc(source.title);
    return `<a href="${esc(u.href)}" target="_blank" rel="noopener noreferrer">${esc(source.title)}</a>`;
  };
  return `<section class="explanation"><h3>Story context</h3>
    ${(stories?.matches??[]).map(story=>`<div class="evidence"><strong>${esc(story.topic)} / ${esc(story.subtopic)} <span class="tag">Suggested story</span></strong><p>${esc(story.summary)}</p><p>${esc(story.explanation)}</p>${sourceEvidence(story.evidence)}<details><summary>Background sources and dates</summary><ul>${story.sources.map(s=>`<li>${link(s)} · ${esc(s.publishedOn??'Publication date unavailable')}<p>${esc(s.supports)}</p></li>`).join('')}</ul><p class="quiet">${esc(story.knowledgeTiming)} National attention has not been measured.</p></details></div>`).join('')||'<p class="quiet">No matching story in the researched examples yet.</p>'}
    <p class="quiet">These are research suggestions. Your saved interpretation remains in place.</p>
    ${outside?`<h3>Outside reporting</h3><p><span class="tag">${esc(outside.status.replaceAll('-',' '))}</span>${outside.checkedAt?` Checked ${esc(date(outside.checkedAt))}`:''}</p><p class="quiet">${esc(outside.note)}</p>
      ${outside.query?`<details><summary>What this lookup searches</summary><p>${esc(outside.query)}</p><p class="quiet">${esc(date(outside.window.from))} – ${esc(date(outside.window.until))}. This can include reporting after the post.</p></details>`:''}
      ${(outside.articles??[]).length?`<ul>${outside.articles.map(s=>`<li>${link(s)}<p class="quiet">${esc(s.domain)} · Indexed ${esc(date(s.indexedAt))} · Content awaiting review</p></li>`).join('')}</ul>`:''}
      <button class="secondary" type="button" id="outside-lookup" ${outside.canLookup?'':'disabled'}>Check outside reporting</button><span class="quiet" id="outside-state" role="status"></span>`:''}</section>`;
}
