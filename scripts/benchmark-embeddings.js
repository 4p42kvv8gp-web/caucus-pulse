import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { createEmbeddingRuntime, cosine } from '../src/local-embeddings.js';

// Synthetic probes only: no assertion that these are real posts or human-reviewed labels.
const sources = [
  ['flood-service', 'Rising water has shut the county bridge. Residents can find emergency shelter at the high school.'],
  ['wildfire-service', 'Fire crews issued an evacuation order for Pine Valley. Leave now and follow the marked route.'],
  ['immigration-facility', 'Families held at the Willow immigration detention center need access to lawyers and medical care.'],
  ['fed-support', 'The Federal Reserve must remain independent of political pressure when setting interest rates.'],
  ['fed-oppose', 'The Federal Reserve should not remain independent of political pressure when setting interest rates.'],
  ['fed-paraphrase', 'Central bankers should make monetary policy decisions without interference from elected officials.'],
  ['quote-rejected', 'Officials said "there is an active shooter at the mall." Police now confirm that report was false.'],
  ['shooting-report', 'Police report a shooting at the shopping center. Avoid the area while emergency responders work.'],
  ['flood-metaphor', 'Our office received a flood of emails supporting the transportation bill this morning.'],
  ['office-hours', 'Our constituent service office will hold regular walk-in hours on Thursday afternoon.'],
  ['sports', 'Congratulations to the local high school basketball team on winning the regional championship.'],
  ['late-incident', 'Today we met local volunteers and discussed community projects. '.repeat(140) + 'A gas leak has now forced evacuation of the apartment building on Cedar Street.']
];
const probes = [
  ['flood', 'flooding, road closures and emergency shelter', ['flood-service']],
  ['wildfire', 'wildfire evacuation instructions', ['wildfire-service']],
  ['detention', 'legal assistance for people in immigration custody', ['immigration-facility']],
  ['fed-subject', 'central bank independence from politicians', ['fed-support','fed-oppose','fed-paraphrase']],
  ['shooting-subject', 'reports about a shooting at a shopping mall', ['shooting-report','quote-rejected']],
  ['gas-leak', 'gas leak apartment evacuation', ['late-incident']]
];
const reports = [];
for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ['minilm','bge']) {
  const started = performance.now();
  const runtime = await createEmbeddingRuntime({ name });
  const loadMs = performance.now() - started;
  try {
    const embedded = [];
    const embedStarted = performance.now();
    for (const [id, text] of sources) embedded.push({ id, ...(await runtime.embedPost(text)) });
    const embedMs = performance.now() - embedStarted;
    const results = [];
    const queryStarted = performance.now();
    for (const [id, text, expected] of probes) {
      const query = await runtime.embedQuery(text);
      const ranked = embedded.map(source => ({ id: source.id,
        similarity: Math.max(...source.passages.map(p => cosine(p.vector, query.vector)))
      })).sort((a,b) => b.similarity - a.similarity);
      results.push({ id, expectedSyntheticSubjects: expected, topThree: ranked.slice(0, 3),
        firstExpectedRank: ranked.findIndex(row => expected.includes(row.id)) + 1 });
    }
    const sourceVector = id => embedded.find(row => row.id === id).passages[0].vector;
    const long = embedded.find(row => row.id === 'late-incident');
    reports.push({ model: runtime.model, fixture: 'synthetic-subject-probes-v1',
      sourceCount: sources.length, passageCount: embedded.reduce((n,p) => n + p.passages.length,0),
      loadMs, embedMs, queryMs: performance.now() - queryStarted, rssBytes: process.memoryUsage().rss,
      longSource: { characters: long.textLength, coveredCharacters: long.coveredCharacters, passages: long.passages.length,
        finalPassageEndsAtSourceEnd: long.passages.at(-1).end === long.textLength },
      opposingStatementsCosine: cosine(sourceVector('fed-support'), sourceVector('fed-oppose')),
      paraphraseCosine: cosine(sourceVector('fed-support'), sourceVector('fed-paraphrase')), results,
      limitations: ['Synthetic engineering probes, not a held-out human accuracy evaluation.',
        'Similarity retrieves a shared subject; it does not establish agreement, verified incidents, or coordination.',
        'Timing is from this local machine with two inference threads, not a hosted-runner throughput promise.'] });
  } finally { await runtime.close(); }
}
await mkdir('data/reports', { recursive: true, mode: 0o700 });
const path = `data/reports/embedding-benchmark-${Date.now()}.json`;
await writeFile(path, JSON.stringify({ createdAt: new Date().toISOString(), reports }, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ path, reports: reports.map(r => ({ model: r.model.name, loadMs: r.loadMs,
  embedMs: r.embedMs, queryMs: r.queryMs, passageCount: r.passageCount, longSource: r.longSource,
  firstExpectedRanks: r.results.map(v => [v.id,v.firstExpectedRank]), opposingStatementsCosine: r.opposingStatementsCosine,
  paraphraseCosine: r.paraphraseCosine })) }, null, 2));
