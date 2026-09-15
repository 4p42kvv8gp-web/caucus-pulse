// Derived source coverage, separate from transport success and interpretation.
// The caller supplies the stored news snapshot; no fetch or persistence here.
import { newsSourceIssue } from './news-context.js';

const DAY = 86_400_000;
const textPresent = (value) => typeof value === 'string' && value.trim().length > 0;
const dateValue = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
function publicUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function buildNewsCoverage({ items = [], sources = [], status = {}, now = Date.now(), windowDays = 14 } = {}) {
  if (!Array.isArray(items) || !Array.isArray(sources) || !Number.isFinite(now) || !Number.isFinite(windowDays) || windowDays <= 0) {
    throw new Error('Invalid news coverage inputs');
  }
  const floor = now - windowDays * DAY;
  const configured = new Map(sources.filter((source) => textPresent(source?.id)).map((source) => [source.id, source]));
  const latestVersions = new Map();
  // Match loadNews: highest content version wins; the last observation wins
  // a tie. Filtering comes afterward, so a rejected revision cannot resurrect
  // an older version with the same identity.
  for (const item of items) {
    if (!textPresent(item?.id)) continue;
    const previous = latestVersions.get(item.id);
    if (!previous || (item.version || 0) >= (previous.version || 0)) latestVersions.set(item.id, item);
  }
  const bySource = new Map([...configured.keys()].map((id) => [id, []]));
  for (const item of latestVersions.values()) {
    if (!configured.has(item.sourceId) || !publicUrl(item.url) || newsSourceIssue(item, [...configured.values()])) continue;
    const published = dateValue(item.publishedAt);
    if (published == null || published > now) continue;
    bySource.get(item.sourceId).push({ item, published });
  }
  const rows = [...configured.values()].map((source) => {
    const known = bySource.get(source.id).sort((a, b) => b.published - a.published || a.item.id.localeCompare(b.item.id));
    const eligible = known.filter(({ published }) => published >= floor);
    const withExcerpt = ({ item }) => item.extract === 'body' && Array.isArray(item.passages) && item.passages.some(textPresent);
    const withExcerpts = eligible.filter(withExcerpt).length;
    const headlineOrSummary = eligible.filter((row) => !withExcerpt(row) && (textPresent(row.item.title) || textPresent(row.item.summary))).length;
    const fetched = status?.sources?.[source.id];
    const lastFetchAt = dateValue(fetched?.lastFetchAt);
    const latest = known[0]?.item;
    return {
      id: source.id, publisher: textPresent(source.publisher) ? source.publisher : source.id,
      sourceUrl: publicUrl(source.url), eligibleItems: eligible.length,
      withExcerpts, headlineOrSummary, withoutReadableText: eligible.length - withExcerpts - headlineOrSummary,
      latestPublishedAt: latest ? new Date(known[0].published).toISOString() : null,
      latestItem: latest ? { title: String(latest.title || 'Latest source item'), url: publicUrl(latest.url) } : null,
      lastFetchAt: lastFetchAt != null && lastFetchAt <= now ? new Date(lastFetchAt).toISOString() : null,
      lastFetchOutcome: fetched?.ok === true ? 'succeeded' : fetched?.ok === false ? 'failed' : 'not-observed'
    };
  });
  const total = (key) => rows.reduce((n, row) => n + row[key], 0);
  return {
    asOf: new Date(now).toISOString(), windowDays, windowStart: new Date(floor).toISOString(),
    eligibleItems: total('eligibleItems'), withExcerpts: total('withExcerpts'),
    headlineOrSummary: total('headlineOrSummary'), withoutReadableText: total('withoutReadableText'),
    sourcesWithRecentItems: rows.filter((row) => row.eligibleItems > 0).length,
    sourcesWithoutRecentItems: rows.filter((row) => row.eligibleItems === 0).length,
    failedSources: rows.filter((row) => row.lastFetchOutcome === 'failed').length,
    sources: rows
  };
}
