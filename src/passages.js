// These offsets address the original JavaScript string. Embeddings never replace source text.
export function coveredPassages(text, countTokens, model) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('A passage source must contain text.');
  if (text.length > model.maxCharacters) throw new Error('Source exceeds the embedding character limit.');
  const boundaries = [0];
  for (const character of text) boundaries.push(boundaries.at(-1) + character.length);
  const indexOf = new Map(boundaries.map((offset, index) => [offset, index]));
  const sentenceEnds = new Set(); const wordEnds = new Set();
  for (const part of new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)) sentenceEnds.add(part.index + part.segment.length);
  for (const part of new Intl.Segmenter('en', { granularity: 'word' }).segment(text)) wordEnds.add(part.index + part.segment.length);
  function count(start, end) {
    const n = countTokens(text.slice(start, end));
    if (!Number.isInteger(n) || n < 1) throw new Error('Invalid tokenizer length.');
    return n;
  }
  const passages = []; let startIndex = 0;
  while (startIndex < boundaries.length - 1) {
    if (passages.length >= model.maxPassages) throw new Error('Source exceeds the embedding passage limit.');
    const start = boundaries[startIndex];
    // Bound every tokenizer input, including pathological punctuation and whitespace.
    let endIndex = Math.min(boundaries.length - 1, startIndex + model.maxTokens * 12);
    if (count(start, boundaries[endIndex]) > model.maxTokens) {
      let low = startIndex + 1, high = endIndex;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (count(start, boundaries[middle]) <= model.maxTokens) low = middle;
        else high = middle - 1;
      }
      endIndex = low;
    }
    if (endIndex < boundaries.length - 1) {
      const minimum = startIndex + Math.ceil((endIndex - startIndex) / 2);
      for (const preferred of [sentenceEnds, wordEnds]) {
        let candidate = endIndex;
        while (candidate > minimum && !preferred.has(boundaries[candidate])) candidate--;
        if (preferred.has(boundaries[candidate])) { endIndex = candidate; break; }
      }
    }
    // WordPiece counts need not be monotonic at incomplete word boundaries. Always recheck.
    while (endIndex > startIndex + 1 && count(start, boundaries[endIndex]) > model.maxTokens) endIndex--;
    const end = boundaries[endIndex], tokenCount = count(start, end);
    if (tokenCount > model.maxTokens) throw new Error('A source character exceeds the tokenizer limit.');
    passages.push({ index: passages.length, start, end, text: text.slice(start, end), tokenCount });
    if (end === text.length) break;
    // Overlap by a bounded suffix. Never sacrifice progress or make an unbounded tokenization.
    let overlapIndex = Math.max(startIndex + 1, endIndex - model.overlapTokens * 8);
    while (overlapIndex < endIndex && count(boundaries[overlapIndex], end) > model.overlapTokens + 2) overlapIndex++;
    while (overlapIndex < endIndex && !wordEnds.has(boundaries[overlapIndex])) overlapIndex++;
    startIndex = Math.max(startIndex + 1, overlapIndex);
  }
  if (!passages.length || passages[0].start !== 0 || passages.at(-1).end !== text.length ||
      passages.some((p, i) => i && p.start > passages[i - 1].end)) throw new Error('Incomplete source passage coverage.');
  return passages;
}

export function semanticPassages(text, countTokens, model) {
  const windows = coveredPassages(text, countTokens, model).map(p => ({ ...p, kind: 'context-window' }));
  const known = new Set(windows.map(p => `${p.start}:${p.end}`));
  const detailTexts = new Set();
  let detailOmitted = 0,detailDuplicateOccurrences=0;
  for (const part of new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)) {
    const start = part.index, end = start + part.segment.length;
    if (known.has(`${start}:${end}`) || !part.segment.trim()) continue;
    if (detailTexts.has(part.segment)) { detailDuplicateOccurrences++; continue; }
    detailTexts.add(part.segment);
    // Long sentences are already covered by windows; avoid unbounded extra tokenization.
    if (part.segment.length > model.maxTokens * 12) { detailOmitted++; continue; }
    const tokenCount = countTokens(part.segment);
    if (tokenCount > model.maxTokens || windows.length >= model.maxPassages) { detailOmitted++; continue; }
    if (!Number.isInteger(tokenCount) || tokenCount < 1) throw new Error('Invalid tokenizer length.');
    windows.push({ start,end,text:part.segment,tokenCount,kind:'sentence' });
  }
  windows.sort((a,b) => a.start - b.start || a.end - b.end);
  return { passages:windows.map((p,index) => ({...p,index})),detailOmitted,detailDuplicateOccurrences };
}
