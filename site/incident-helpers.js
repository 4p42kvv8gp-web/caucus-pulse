export function uniqueSpan(source, quote, label = 'Evidence', within = null) {
  if (typeof quote !== 'string' || !quote.trim()) throw new Error(`${label}: paste exact words from the source.`);
  const startAt = within?.start ?? 0, endAt = within?.end ?? source.length;
  const region = source.slice(startAt, endAt), first = region.indexOf(quote);
  if (first < 0) throw new Error(`${label}: the wording must match the source exactly, including punctuation.`);
  if (region.indexOf(quote, first + 1) !== -1) throw new Error(`${label}: this wording appears more than once. Include more surrounding words.`);
  const start = startAt + first;
  return {start, end: start + quote.length, text: quote};
}

export function reviewedEvent(source, value, postType = 'original') {
  const evidence = uniqueSpan(source, value.evidence, 'Supporting passage');
  const location = value.location?.trim() ? {name:value.location.trim(), evidence:[uniqueSpan(source, value.location.trim(), 'Location', evidence)]} : null;
  const districtRelation = value.districtRelation || 'not-established';
  if (postType === 'repost' && districtRelation !== 'not-established') throw new Error('A repost cannot establish the reposting member’s district connection.');
  return {description:value.description.trim(), development:value.development, location, districtRelation,
    districtEvidence:districtRelation === 'not-established' ? [] : [uniqueSpan(source,value.districtEvidence,'District evidence')], evidence:[evidence]};
}

export function caseSources(record) {
  const sources = new Map();
  for (const item of record.sources) {
    if (!sources.has(item.post.id)) sources.set(item.post.id,{post:item.post, candidates:[]});
    sources.get(item.post.id).candidates.push(item.candidate);
  }
  return [...sources.values()];
}

export function incidentBrief(record) {
  const sources = caseSources(record);
  return [record.title, `Desk status: ${record.status} (user maintained)`,
    `${sources.length} archived source posts from ${new Set(sources.map(s=>s.post.memberId)).size} stored members.`,
    'This is a source digest. Event occurrence, shared event identity, and present conditions have not been independently verified.',
    ...(record.stale.length || record.omittedOversizedSources ? [`Coverage: ${record.stale.length} outdated links and ${record.omittedOversizedSources} sources outside display limits are excluded.`] : []),
    ...sources.map(({post,candidates})=>[`${post.memberName} (@${post.handle}) · ${post.createdAt} · ${post.type}`,
      ...candidates.map(c=>`${c.basis==='human-source-review'?'Reviewed source interpretation':'Provisional source interpretation'}: ${c.event.description}`),
      post.text,post.sourceUrl].join('\n'))].join('\n\n');
}
