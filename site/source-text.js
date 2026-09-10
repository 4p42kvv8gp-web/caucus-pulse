export function highlightedText(text,spans,escape) {
  const intervals=[];
  for(const span of [...spans].sort((a,b)=>a.start-b.start||b.end-a.end)){
    if(!Number.isSafeInteger(span.start)||!Number.isSafeInteger(span.end)||span.start<0||span.end<=span.start||span.end>text.length||text.slice(span.start,span.end)!==span.text)throw new Error('Source evidence changed. Reload the results.');
    const prior=intervals.at(-1);
    if(prior&&span.start<=prior.end)prior.end=Math.max(prior.end,span.end);else intervals.push({start:span.start,end:span.end});
  }
  let html='',from=0;
  for(const span of intervals){html+=escape(text.slice(from,span.start))+`<mark class="phrase-match">${escape(text.slice(span.start,span.end))}</mark>`;from=span.end;}
  return html+escape(text.slice(from));
}
