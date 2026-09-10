// Does the embedding index find the posts a keyword search misses, and are
// they actually about the story? For each subject: take its seed posts, rank
// the rest of the corpus by similarity to the seed's centroid, then have
// Claude read the nearest K and say yes/no with a reason. Numbers and
// judgments land in docs/semantic-proof/<subject>.json; the write-up is
// docs/SEMANTIC_MATCHING.md.
//
//   node --use-env-proxy scripts/semantic-proof.js                 (npm run semantic-proof)
//   node --use-env-proxy scripts/semantic-proof.js --no-llm        # neighbours only, no spend
//   node --use-env-proxy scripts/semantic-proof.js --subjects=coxon --k=40
import fs from 'node:fs';
import path from 'node:path';
import { anthropicClient } from '../src/anthropic-auth.js';
import { p, settings, readJSON } from '../src/util.js';
import { parseJsonLoose } from '../src/taxonomy.js';
import { loadSemantic, storiesPath, effectivePlacement } from '../src/semantic.js';

const arg = (name, dflt) => {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : dflt;
};
const K = Number(arg('k', 40));
const NO_LLM = process.argv.includes('--no-llm');
const OUT = p('docs', 'semantic-proof');
const MODEL = settings.classify?.model || 'claude-opus-5';

const sem = loadSemantic();
const posts = [...sem.postMap.values()];
const storyJson = readJSON(storiesPath) || { candidates: [], placements: {} };
const candidateIds = (key) => {
  const ids = new Set();
  for (const c of storyJson.candidates || []) {
    if (effectivePlacement(storyJson.placements, c.key)?.key === key) for (const id of c.ids) ids.add(String(id));
  }
  return [...ids];
};

const COXON_ANCHOR = '2097476196791709843';
const SUBJECTS = {
  coxon: {
    label: 'Jacob Coxon resignation / AI safety',
    kind: 'story (seed by rule)',
    seed: () => posts.filter((t) => t.refId === COXON_ANCHOR || (t.text || '').includes(COXON_ANCHOR)
      || (t.createdAt.startsWith('2026-09-09') && /coxon|hubinger|anthropic/i.test(t.text || ''))).map((t) => t.id),
    keyword: /coxon|hubinger|anthropic/i,
    description: `On 2026-09-09 AI researcher Jacob Coxon publicly resigned from Anthropic (post ${COXON_ANCHOR}) warning that frontier labs are racing toward superintelligence they cannot control; Anthropic alignment lead Evan Hubinger put the odds of AI killing everyone above 10%. House Democrats reacted all day: "the call is coming from inside the house", demands for emergency hearings, the bipartisan AI Kill Switch bill, the FRONTIER Act, federal AI safety oversight before profit "ends humanity".
A post is RELATED if it is about this story or is part of the same conversation: catastrophic / existential AI risk, frontier-model safety, AI models escaping or hacking, superintelligence, AI safety legislation or oversight framed around those dangers, or Congress's response to the insiders' warnings.
A post is NOT related if its AI angle is a different subject: data-center electricity bills, AI and jobs or wages, AI in health care decisions, kids' online safety, surveillance pricing, deepfakes, general "Big Tech accountability" with no safety-risk content.`
  },
  'amy-acton-attack': {
    label: 'Attack on Dr. Amy Acton (Ohio governor candidate)',
    kind: 'story (candidate)',
    seed: () => [...(sem.story('amy-acton-attack')?.ids || [])],
    keyword: /acton/i,
    description: `On 2026-09-06 Dr. Amy Acton, the Democratic candidate for Governor of Ohio, was attacked while campaigning; she and her husband Eric were unhurt, others were injured. Members reacted with relief that she is safe, condemnation of political violence, and calls to lower the temperature.
A post is RELATED if it is about this attack, Dr. Acton's safety, or explicitly reacts to it as political violence.
A post is NOT related if it is about a different shooting, attack or tragedy (Minneapolis, San Diego mosque, a school shooting), about gun policy generally, or about political violence with no tie to the Acton attack.`
  },
  'data-centers': {
    label: 'Data centers & energy costs',
    kind: 'gap (candidate)',
    seed: () => candidateIds('data-centers'),
    keyword: /data.?cent(er|re)/i,
    description: `A taxonomy gap the emerging layer keeps surfacing: AI/crypto data centers and what they do to electricity bills, the grid, water and local communities — moratorium calls, utility-rate fights, siting battles, tech companies paying for power.
A post is RELATED if it is about data centers, or about rising utility / electricity bills where data centers or AI power demand are the stated cause.
A post is NOT related if it is about AI safety, AI and jobs, energy prices with no data-center link, or generic cost-of-living messaging.`
  }
};

const selected = arg('subjects', Object.keys(SUBJECTS).join(',')).split(',').filter(Boolean);
const client = NO_LLM ? null : await anthropicClient();

async function judge(subject, batch) {
  const seedExamples = subject.seedIds.slice(0, 6).map((id) => sem.postMap.get(id)).filter(Boolean)
    .map((t) => `- ${t.text.replace(/\s+/g, ' ').slice(0, 280)}`).join('\n');
  const listing = batch.map((h, i) => `${i + 1}. id=${h.id} date=${h.createdAt.slice(0, 10)} ${h.type}\n${h.text.replace(/\s+/g, ' ')}`).join('\n\n');
  const system = `You audit a semantic-similarity index for a monitor of House Democratic caucus posts on X. For each candidate post decide whether it belongs to the story described, using only what the post itself says. Be strict about the NOT-related rules: nearby subjects are the point of the audit. Reply with ONLY a JSON object: {"judgements":[{"id":"<id>","related":true|false,"reason":"<one line citing the words in the post that decided it>"}]} with every candidate id exactly once.`;
  const user = `STORY: ${subject.label}\n${subject.description}\n\nPosts already tied to the story (for calibration):\n${seedExamples}\n\nCANDIDATES (${batch.length}):\n\n${listing}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await client.messages.create({
      model: MODEL, max_tokens: 6000, system, output_config: { effort: 'medium' },
      messages: [{ role: 'user', content: user }]
    });
    if (res.stop_reason === 'refusal') throw new Error(`judge refused: ${res.stop_details?.category}`);
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const parsed = parseJsonLoose(text);
    const map = new Map((parsed?.judgements || []).map((j) => [String(j.id), j]));
    if (batch.every((h) => map.has(h.id))) {
      return { map, usage: { in: res.usage.input_tokens, out: res.usage.output_tokens } };
    }
    console.error(`judge returned ${map.size}/${batch.length} ids, retrying`);
  }
  throw new Error('judge never covered every candidate');
}

fs.mkdirSync(OUT, { recursive: true });
for (const key of selected) {
  const subject = SUBJECTS[key];
  if (!subject) { console.error(`unknown subject ${key}`); continue; }
  subject.seedIds = subject.seed();
  const seedSet = new Set(subject.seedIds);
  const all = sem.nearSeed(subject.seedIds, { k: sem.index.count, minSim: -1 });
  const ranks = [10, 20, 40, 100, 200, 500, 1000];
  const simAtRank = Object.fromEntries(ranks.map((r) => [r, all.hits[r - 1] ? +all.hits[r - 1].sim.toFixed(3) : null]));
  const median = all.hits[Math.floor(all.hits.length / 2)]?.sim;
  const hits = all.hits.slice(0, K);
  const keywordHitsInCorpus = posts.filter((t) => subject.keyword.test(t.text || '') && !seedSet.has(t.id)).length;

  let usage = { in: 0, out: 0 };
  const judged = new Map();
  if (!NO_LLM) {
    for (let at = 0; at < hits.length; at += 20) {
      const batch = hits.slice(at, at + 20);
      const r = await judge(subject, batch);
      usage.in += r.usage.in; usage.out += r.usage.out;
      for (const [id, j] of r.map) judged.set(id, j);
    }
  }
  const neighbors = hits.map((h, i) => ({
    rank: i + 1, id: h.id, sim: h.sim, createdAt: h.createdAt, type: h.type, refId: h.refId, authorId: h.authorId,
    keyword: subject.keyword.test(h.text || ''), text: h.text,
    ...(judged.has(h.id) ? { related: Boolean(judged.get(h.id).related), reason: String(judged.get(h.id).reason || '') } : {})
  }));
  const precisionAt = (n) => {
    const rows = neighbors.slice(0, n).filter((r) => 'related' in r);
    return rows.length ? +(rows.filter((r) => r.related).length / rows.length).toFixed(3) : null;
  };
  const related = neighbors.filter((r) => r.related);
  const summary = {
    subject: key, label: subject.label, kind: subject.kind, seedSize: subject.seedIds.length, seedIndexed: all.indexed,
    k: K, judgedAt: NO_LLM ? null : new Date().toISOString(), model: NO_LLM ? null : MODEL, usage,
    simAtRank, medianSim: median != null ? +median.toFixed(3) : null,
    precision: { at10: precisionAt(10), at20: precisionAt(20), at40: precisionAt(40) },
    related: related.length,
    relatedWithoutKeyword: related.filter((r) => !r.keyword).length,
    keywordMatchesOutsideSeed: keywordHitsInCorpus,
    lowestRelatedSim: related.length ? Math.min(...related.map((r) => r.sim)) : null,
    highestUnrelatedSim: neighbors.some((r) => r.related === false) ? Math.max(...neighbors.filter((r) => r.related === false).map((r) => r.sim)) : null,
    seedIds: subject.seedIds, neighbors
  };
  fs.writeFileSync(path.join(OUT, `${key}.json`), JSON.stringify(summary, null, 1) + '\n');
  const { neighbors: _n, seedIds: _s, ...brief } = summary;
  console.log(JSON.stringify(brief));
  for (const r of neighbors) console.log(`${String(r.rank).padStart(2)} ${r.sim.toFixed(3)} ${r.createdAt.slice(0, 10)} ${r.keyword ? 'KW' : '  '} ${r.related === true ? 'YES' : r.related === false ? 'no ' : '?  '} ${r.text.replace(/\s+/g, ' ').slice(0, 90)}${r.reason ? `\n      ${r.reason}` : ''}`);
}
