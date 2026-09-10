// Story <-> post matching over the committed embedding index.
//
// The story is the unit. Each tracked story gets a centroid — the normalised
// mean of the vectors of the posts already tied to it — and two questions
// become dot products:
//   relatedStories(post | text)  which stories is this post near?
//   relatedPosts(storyKey)       which posts are near this story but NOT
//                                assigned to it? (the misses a keyword
//                                search cannot find: "Another AI wakeup call
//                                for Congress" never says Coxon)
//
// Where stories come from, in this order, merged by key:
//   1. config/taxonomy.yaml subtopics with `story: true` — posts come from
//      data/topics/<date>.json assignments, plus any post that IS or
//      references one of the row's `anchors` (a quote tweet of Coxon's post
//      that doesn't mention him counts).
//   2. data/stories.json candidates whose placement resolves to kind
//      "story" with at least `minCandidatePosts` posts — the emerging layer,
//      until the promoted rows land in the taxonomy.
//
// Similarity is a retrieval signal, not a judgment: a neighbour is a
// candidate for a reader (human or Claude) to confirm. docs/SEMANTIC_MATCHING.md
// has the measured precision that the default thresholds rest on.
import { p, readJSON } from './util.js';
import { loadTaxonomy } from './taxonomy.js';
import { loadArchive, archiveDates, topicsPath } from './store.js';
import { load as loadIndex } from './embedding-index.js';
import { normalise, embed as sharedEmbed } from './embeddings.js';

export const storiesPath = p('data', 'stories.json');

// Calibrated on the Coxon / Acton / data-centre probes of 2026-09-10 (see
// docs/SEMANTIC_MATCHING.md). Centroid similarities are compressed — the
// median post sits at ~0.66 from any story's centroid and rank 1000 at ~0.73
// — and nothing Claude judged on-story fell below 0.80, while off-story
// neighbours from adjacent subjects reach 0.88. So 0.80 is the floor for
// "worth reading", not a verdict: above it a reader (or the judge in
// scripts/semantic-proof.js) still decides.
export const DEFAULT_MIN_SIM = 0.8;

export function centroid(vectors) {
  const rows = vectors.filter(Boolean);
  if (!rows.length) return null;
  const dim = rows[0].length;
  const c = new Float32Array(dim);
  for (const v of rows) for (let i = 0; i < dim; i++) c[i] += v[i];
  for (let i = 0; i < dim; i++) c[i] /= rows.length;
  return normalise(c);
}

// A stories.json candidate's placement, following mergeInto chains to the
// placement that finally names the story.
export function effectivePlacement(placements, candidateKey) {
  let pl = placements?.[candidateKey];
  for (let hops = 0; pl?.mergeInto && placements[pl.mergeInto] && hops < 8; hops++) pl = placements[pl.mergeInto];
  return pl || null;
}

const isPostId = (s) => typeof s === 'string' && /^\d{10,}$/.test(s);

// Story definitions with their post id sets. `topics` is [{date, assignments}].
export function buildStories({ taxonomy = {}, stories = null, topics = [], posts = [], minCandidatePosts = 3 } = {}) {
  const out = new Map();
  const ensure = (key, fields) => {
    if (!out.has(key)) out.set(key, { key, label: key, macro: null, since: null, source: new Set(), ids: new Set(), anchors: new Set() });
    const s = out.get(key);
    for (const [k, v] of Object.entries(fields)) if (v != null && (k !== 'label' || s.label === key)) s[k] = v;
    return s;
  };

  // 1. taxonomy rows flagged as stories
  const bySub = new Map(); // "macro/sub" -> story key
  for (const [macro, m] of Object.entries(taxonomy)) {
    for (const [sub, def] of Object.entries(m?.subtopics || {})) {
      if (!def?.story) continue;
      const clash = out.get(sub);
      const key = clash && clash.macro && clash.macro !== macro ? `${macro}/${sub}` : sub;
      const s = ensure(key, { label: def.label, macro, since: def.since || null });
      s.source.add('taxonomy');
      for (const a of def.anchors || []) s.anchors.add(String(a));
      bySub.set(`${macro}/${sub}`, key);
    }
  }
  if (bySub.size) {
    for (const { assignments } of topics) {
      for (const [id, list] of Object.entries(assignments || {})) {
        for (const t of Array.isArray(list) ? list : []) {
          const [macro, sub] = Array.isArray(t) ? t : [t, null];
          const key = sub && bySub.get(`${macro}/${sub}`);
          if (key) out.get(key).ids.add(id);
        }
      }
    }
    const anchored = [...out.values()].filter((s) => s.anchors.size);
    if (anchored.length) {
      for (const t of posts) {
        for (const s of anchored) {
          if (s.anchors.has(t.id) || (t.refId && s.anchors.has(String(t.refId)))) s.ids.add(t.id);
        }
      }
    }
  }

  // 2. emerging-layer candidates already judged to be stories
  for (const c of stories?.candidates || []) {
    const pl = effectivePlacement(stories.placements, c.key);
    if (pl?.kind !== 'story' || !pl.key || (c.ids?.length || 0) < minCandidatePosts) continue;
    const s = ensure(pl.key, { label: pl.label, macro: pl.macro || null });
    s.source.add('candidate');
    for (const id of c.ids) s.ids.add(String(id));
  }
  return out;
}

export function createSemantic({ index, stories, posts = [], embed = sharedEmbed }) {
  if (!index) throw new Error('createSemantic needs an embedding index');
  const postMap = new Map(posts.map((t) => [String(t.id), t]));
  const centroids = new Map(); // key -> {vector, indexed}

  function storyCentroid(key) {
    if (centroids.has(key)) return centroids.get(key);
    const s = stories.get(key);
    if (!s) throw new Error(`unknown story: ${key}`);
    const vectors = [...s.ids].map((id) => index.get(id));
    const entry = { vector: centroid(vectors), indexed: vectors.filter(Boolean).length };
    centroids.set(key, entry);
    return entry;
  }

  const decorate = (hits) => hits.map((h) => {
    const t = postMap.get(h.id);
    return t
      ? { id: h.id, sim: +h.sim.toFixed(4), authorId: t.authorId, createdAt: t.createdAt, type: t.type, refId: t.refId ?? null, text: t.text }
      : { id: h.id, sim: +h.sim.toFixed(4) };
  });

  // A post id (from the index, else embedded from the archive text), a
  // vector, or free text (embedded with the model's query instruction).
  async function resolveVector(query) {
    if (query instanceof Float32Array || Array.isArray(query)) return normalise(Float32Array.from(query));
    const key = String(query);
    const v = index.get(key);
    if (v) return v;
    const t = postMap.get(key);
    if (t) return (await embed([t.text]))[0];
    if (isPostId(key)) throw new Error(`post ${key} is neither in the index nor the archive`);
    return (await embed([key], { query: true }))[0];
  }

  // Centroid of an ad-hoc seed and its nearest non-seed posts. relatedPosts
  // is this with the story's own ids as the seed.
  function nearSeed(ids, { k = 20, minSim = DEFAULT_MIN_SIM, exclude = null } = {}) {
    const seed = new Set([...ids].map(String));
    const c = centroid([...seed].map((id) => index.get(id)));
    if (!c) return { centroid: null, indexed: 0, hits: [] };
    const skip = exclude ? (id) => seed.has(id) || (exclude instanceof Set ? exclude.has(id) : exclude(id)) : seed;
    return { centroid: c, indexed: [...seed].filter((id) => index.has(id)).length, hits: decorate(index.neighbors(c, k, { exclude: skip, minSim })) };
  }

  return {
    index, stories, postMap,
    list() {
      return [...stories.values()].map((s) => ({
        key: s.key, label: s.label, macro: s.macro, since: s.since, source: [...s.source],
        posts: s.ids.size, indexed: storyCentroid(s.key).indexed
      }));
    },
    story: (key) => stories.get(key) || null,
    centroidOf: (key) => storyCentroid(key).vector,
    nearSeed,
    async relatedStories(query, { k = 5, minSim = DEFAULT_MIN_SIM } = {}) {
      const v = await resolveVector(query);
      const hits = [];
      for (const s of stories.values()) {
        const { vector, indexed } = storyCentroid(s.key);
        if (!vector) continue;
        let dot = 0;
        for (let i = 0; i < v.length; i++) dot += v[i] * vector[i];
        if (dot >= minSim) hits.push({ story: s.key, label: s.label, macro: s.macro, sim: +dot.toFixed(4), posts: s.ids.size, indexed });
      }
      return hits.sort((a, b) => b.sim - a.sim).slice(0, k);
    },
    relatedPosts(storyKey, { k = 20, minSim = DEFAULT_MIN_SIM, excludeAssigned = true } = {}) {
      const s = stories.get(storyKey);
      if (!s) throw new Error(`unknown story: ${storyKey}`);
      const { vector } = storyCentroid(storyKey);
      if (!vector) return [];
      return decorate(index.neighbors(vector, k, { exclude: excludeAssigned ? s.ids : null, minSim }));
    }
  };
}

// Everything from disk: the committed index, the archive, the taxonomy, the
// nightly assignments and the story candidates.
export function loadSemantic({ embed = sharedEmbed, minCandidatePosts = 3 } = {}) {
  const index = loadIndex();
  if (!index) throw new Error('no embedding index at data/embeddings — run: npm run embed');
  const posts = loadArchive();
  const topics = archiveDates().map((date) => readJSON(topicsPath(date))).filter(Boolean);
  const stories = buildStories({ taxonomy: loadTaxonomy(), stories: readJSON(storiesPath), topics, posts, minCandidatePosts });
  return createSemantic({ index, stories, posts, embed });
}
