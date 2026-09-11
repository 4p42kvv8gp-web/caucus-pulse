# Semantic story matching

Status, 2026-09-10 (night build, branch `claude/night-semantic-index`).

The owner's rule: *"We need to look at the posts and examine them for
similarities in the current trends we're tracking, keyword searches and
numerical data are not enough."* This layer does the "look at the posts"
part in two steps that are kept deliberately separate:

1. **Similarity** (measured, cheap, local): every archived post is embedded
   with a small sentence model on the CPU; every tracked story gets a centroid
   from the posts already tied to it; the corpus is ranked against it. This
   finds the posts that never use the story's names.
2. **Judgment** (Claude, a few hundred tokens per post): the nearest posts
   are *read*, one batch at a time, and each gets yes/no and a one-line reason
   citing the words that decided it. Similarity proposes; the reader decides.

The proof below runs both steps on three tracked subjects and reports what
came back. All numbers are reproducible from `docs/semantic-proof/*.json`
(`npm run semantic-proof` rewrites them; `--no-llm` re-ranks without spend).

## Headline

On the Coxon / AI-safety story, the 40 corpus posts nearest the story's
20-post seed contain **25 that Claude confirmed as on-story, 23 of which
never say Coxon, Hubinger or Anthropic**. A keyword search for those names
finds 5 posts outside the seed in the entire 10,482-post archive. The
neighbours include Lieu's two AI Kill Switch posts, Magaziner's "AI insiders
saying their technology is a threat to humanity", Gallego's "risk of
extinction from AI", the FRONTIER Act post, and an Aug 20 post that the
story's own framing ("builders begging for guardrails") predates by three
weeks. The other 15 are AI posts on *adjacent* subjects — data-centre power
bills, AI and jobs, kids' online safety, surveillance pricing — that cosine
similarity cannot tell apart from the story (the very top neighbour, at
0.883, is a data-centre post) and that the judge separated cleanly with
stated reasons. That split is the argument for keeping both steps.

## Method

### Model

`BAAI/bge-small-en-v1.5`, as the ONNX conversion `Xenova/bge-small-en-v1.5`
at commit `ea104dacec62c0de699686887e3f920caeb4f3e3`, int8 weights
(`onnx/model_quantized.onnx`, 34.0 MB), 384 dimensions, CLS pooling and L2
normalisation as the original model specifies. Every file's size and digest
(git blob sha1 for the small files, sha256 for the LFS weights) is pinned in
`src/embeddings.js` and re-verified at every load; `npm run download-model`
is the only network step and refuses anything that does not match.

Why BGE-small rather than MiniLM (the other model the Codex branch shipped):
same dimensionality and roughly the same cost per token, but BGE-small ranks
higher on retrieval benchmarks and the Codex branch's own paraphrase probe
preferred it — recovering paraphrases is exactly the job here. Its 512-token
ceiling is moot for 280-character posts. The price is ~3x MiniLM's wall time,
which at one minute for the whole archive does not matter.

Runtime: `@huggingface/transformers@3.8.1` (exact pin; the q8 file layout and
pipeline options were verified against it), ONNX Runtime on the CPU with
`intraOpNumThreads = os.availableParallelism()`. Two install notes carried
over from the Codex branch's pnpm setup, translated to npm:
`.npmrc` sets `onnxruntime-node-install-cuda=skip` because onnxruntime-node's
postinstall otherwise downloads CUDA binaries on linux/x64 (verified: with the
flag the bin directory holds only the CPU `.so` files); `package.json`
`overrides` pins the transitive `sharp` to 0.35.4, which clears the two high
advisories `npm audit` reported against the 0.34 line (audit is now clean).
No GPU anything is installed or used.

### Text and index

What is embedded is the post text with X's `t.co` link stubs removed, HTML
entities decoded and whitespace folded (`prepareText`). Quotes and replies
get nothing extra tonight — see Limits.

`data/embeddings/index.bin` holds one int8 row per post with a per-row
float32 scale; `index.json` carries the ids in row order, the model identity
(`Xenova/bge-small-en-v1.5@ea104…#cls/q8`) and the format version.
Quantisation error is below one step per component and ~1e-4 in cosine,
invisible at the margins that matter here. `src/embedding-index.js` loads it
into a float32 matrix once; `neighbors()` is a dot product over the whole
matrix (4M multiplies for 10k posts, well under 10 ms), so there is no
approximate structure to keep consistent.

`npm run embed` (`src/embed-archive.js`) is incremental: it embeds only ids
the index lacks and rewrites the two files; a run with nothing new touches
nothing. A changed model id forces a rebuild rather than mixing spaces. The
poller calls the same `embedArchive()` right after `appendToArchive`, and
the nightly chain runs it before `classify` (see Integration below).

### Stories and centroids

`src/semantic.js` builds the story map from two sources, merged by key:
`config/taxonomy.yaml` subtopics with `story: true` (posts from
`data/topics/*.json` assignments, plus any post that *is* or *references* one
of the row's `anchors` — a quote tweet of Coxon's post that never names him
counts, as the owner asked), and `data/stories.json` candidates whose
placement resolves to kind `story` with at least three posts. A story's
centroid is the normalised mean of its posts' vectors.

- `relatedStories(postId | text, {k, minSim})` → the stories a post is near.
  A free-text query goes through BGE's query instruction; a post id uses its
  stored vector.
- `relatedPosts(storyKey, {k, minSim, excludeAssigned})` → posts near the
  story that are **not** assigned to it, with similarities — the candidate
  list for a reader.
- `nearSeed(ids, …)` → the same for an ad-hoc seed (what the proof uses).

### The judge

`scripts/semantic-proof.js`, `claude-opus-5` (the classifier's model), one
call per 20 posts, `effort: medium`. The prompt states the story, its
RELATED / NOT-related rules, six seed posts for calibration, and the
candidates; the model returns JSON with a reason per id and is retried once
if any id is missing (it happened once, on the Acton batch). Three subjects,
six calls, 18.5k input / 7.0k output tokens in total.

## Results

Corpus: 10,482 unique posts, 2026-08-20 → 2026-09-10. K = 40 nearest
non-seed posts per subject.

| Subject | Seed | Judged | Related | P@10 | P@20 | P@40 | Related w/o keyword | Keyword hits outside seed | Lowest related sim | Highest unrelated sim |
|---|---|---|---|---|---|---|---|---|---|---|
| Coxon resignation / AI safety (story, seed by rule) | 20 | 40 | 25 | 0.60 | 0.70 | 0.625 | 23 | 5 | 0.827 | 0.883 |
| Amy Acton attack (story candidate) | 5 | 40 | 7 | 0.70 | 0.35 | 0.175 | 1 | 7 | 0.848 | 0.839 |
| Data centers & energy costs (gap candidate) | 21 | 40 | 33 | 1.00 | 1.00 | 0.825 | 0 | 65 | 0.801 | 0.823 |

"Keyword" is the subject's obvious regex (`coxon|hubinger|anthropic`,
`acton`, `data.?cent(er|re)`).

### Coxon / AI safety

Seed: posts that quote or retweet `2097476196791709843` or name
Coxon/Hubinger/Anthropic on 2026-09-09 — 20 posts. Two of the owner's named
examples are *in* the seed by the reference rule, not by keyword: Landsman's
"Another AI wakeup call for Congress…" and Lieu's "Republican leadership
should take up the bipartisan AI Kill Switch Bill NOW" both quote the Coxon
post without naming anyone. That rule (`anchors:` on a taxonomy story row)
is implemented in `buildStories`.

What the neighbours add that no keyword finds (rank, sim, judge's reason):

- 16 · 0.859 · Lieu, Sep 8: "Society has a long-standing solution for
  machines that pose catastrophic risks. It's called a kill switch." —
  *'machines that pose catastrophic risks… AI Kill Switch Act'*
- 26 · 0.846 · Lieu, Aug 29: "…came back in time to author the bipartisan AI
  Kill Switch bill #Skynet" — *the bill in the story*
- 6 · 0.875 and 27 · 0.843 · Magaziner (and an RT of it), Sep 9: "Everyone is
  talking about AI insiders saying their technology is a threat to humanity.
  Here is what Congress can do…"
- 7 · 0.874 and 25 · 0.848 · Gallego quote/RT, Sep 9: "Mitigating the risk of
  extinction from AI should be a global priority on par with pandemics and
  nuclear war"
- 5 · 0.876 · Sep 9: "The time for burying our heads in the sand is over. If
  the people working directly on these technologies are…"
- 9 · 0.868 · Aug 21: "AI models are breaking out of containment and hacking
  into other companies" and 13/40 · Sep 4: OpenAI/Claude security incidents
  — the earlier chapter of the same story
- 21 · 0.849 · Sep 1: the FRONTIER Act, "the strongest AI safety legislation
  ever introduced"
- 22 · 0.849 · Aug 20: "Artificial intelligence is moving faster than ever,
  and the risks are growing with it… builders begging for guardrails"

What similarity got wrong and the judge caught: rank 1 (0.883) "new AI data
centers are sending their power bills through the roof"; rank 4 (0.879) "AI
doesn't come at the cost of American jobs"; rank 11 surveillance pricing;
ranks 34/36 kids' online safety; rank 38 the Doctors Not AI Act. Every one
is an AI post; none is the story. Their similarities overlap the related
ones completely (0.827–0.883 both ways), so no threshold separates them.

### Amy Acton attack

Seed: the 5 posts the story candidate carries. The seven nearest posts
(0.949 → 0.848) are all the attack — "grateful Amy Acton is safe and sound",
"the violence directed at Dr. Amy Acton today in Ohio", Kelly's "I just
spoke to Amy Acton. She's tough." — i.e. the classifier tied five posts to
the story and missed seven more, which the index surfaces in order. One of
the seven ("Every candidate deserves… ensured that Amy and Eric were safe")
does not contain the surname. Rank 8 onward (≤ 0.839) is the surrounding
genre — Minneapolis and San Diego shootings, a councilmember's heart attack,
"thoughts and prayers" of every kind — and all 33 were judged unrelated. A
small, lexically tight story: a clean cliff, and the judge's reasons name the
other incident each time.

### Data centers & energy costs (gap)

Seed: the 21 posts across the gap's candidates. 33 of 40 neighbours are the
subject, and precision is perfect through rank 20 — but every related one
contains "data center", and the regex finds 65 more posts outside the seed.
For a keyword-bound subject the embedding adds ordering and a judged
expansion path (21 → 54 posts in one pass), not recall. Rank 24 (0.823,
"Our towns are just trying to protect themselves… Big Tech") was judged
unrelated *from the post alone*; it is almost certainly a data-centre reply
whose meaning lives in the parent post. That is the quoted-context limit
below, and the parallel `night-quoted-context` build is the fix.

### Similarity scale (for thresholds)

Against any story centroid the median corpus post sits at 0.655–0.664 and
rank 1000 at 0.726–0.734; the three subjects' rank-100 similarities are
0.780 / 0.787 / 0.775. Nothing judged related fell below 0.801. Hence
`DEFAULT_MIN_SIM = 0.8` in `src/semantic.js`: the floor for "worth reading",
with the judge (or a person) deciding above it. At that floor the three
probes returned 118 candidates of which 65 (55%) were on-story — the number
to expect before reading, not after.

## Numbers

- Embedding the archive: **10,482 posts in 60.0 s** (175 posts/s) on this
  4-CPU host, batch 32, plus ~0.5 s model load. A 300-post smoke run took
  2.8 s including warm-up, so a poll's worth of new posts costs seconds.
- Index: `index.bin` 4,067,016 bytes + `index.json` 230,799 bytes =
  **4.3 MB** committed (float16 rows would have been 8.0 MB, over the
  budget; float32 16 MB).
- Model on disk: 34.7 MB in `data/models/` (git-ignored).
- Judge: 6 calls, 18,535 input / 7,031 output tokens.
- Tests: `test/embedding-index.test.js`, `test/semantic.test.js` — index
  round trip and neighbours, quantisation bounds, centroid maths, story
  building from both sources (assignments + anchors + candidates with
  `mergeInto` chains), `relatedPosts` exclusion and thresholds,
  `relatedStories` on id/text/vector, `nearSeed`. `embed()` is stubbed; no
  model, no network.

## Limits

- **Adjacent subjects are not separable by cosine.** Inside a dense macro
  (AI this month) the story's neighbours and its cousins overlap fully in
  similarity. The judge is not optional there; alternatively a story could
  carry negative anchors ("not: data centres") and the centroid could be
  contrasted, which is untested.
- **No quoted or parent context.** A reply or quote whose meaning depends on
  its parent embeds as its own words (data-centre rank 24). When the
  quoted-context branch lands, `prepareText` should take the parent text
  as a second field — and the index must be rebuilt (the model id in the
  manifest does not change, so bump the format or add a `text` version).
- **Retweets embed as the retweeted text** ("RT @user: …"), so an RT of a
  seed post ranks near it. Right for the story unit; the *author* of the
  vector is the retweeter, which reports must keep straight.
- **Seed quality bounds everything.** The Acton story worked from five
  posts because its wording is tight; a diffuse story with a five-post seed
  would pull its genre (see rank 8+). Use anchors and assigned posts, not
  hand-picked exemplars, and let the judged additions feed the next
  centroid.
- **English model.** Non-English posts (`lang` ≠ `en`) are embedded by an
  English model; treat their similarities as noise.
- **Similarity is not agreement.** A post attacking the Kill Switch bill
  would sit next to one supporting it. The layer answers "same story", never
  "same message"; stance is the judge's or the syntax layer's.
- **Thresholds are one night's calibration** on three subjects and 120
  judged posts. Re-run `npm run semantic-proof` after any model or text
  change and after the taxonomy's story rows land; the JSON outputs are the
  regression record.

## Integration

Status, 2026-09-10 (night build, branch `claude/night-semantic-integration`).
The layer above is now in the pipeline in three places, each guarded so a
checkout without the model or the index keeps working:

- **Embedding keeps up with capture.** `npm run nightly` is
  `refresh → embed → classify → …`; `src/poll.js` calls `embedArchive()`
  after `appendToArchive`, before live tagging, so a poll's vectors are on
  disk when the tagger asks for them (measured: 2 new posts in 0.6 s, model
  load included). Without the model, `embedArchive()` returns `skipped`
  (`modelAvailable()` in `src/embeddings.js`), the CLI prints one line and
  exits 0 (`--require-model` makes it an error), and the poller logs the
  skip. The `poll` and `nightly` workflows restore `data/models/` from the
  Actions cache (key = the model revision) and fall back to
  `npm run download-model`, both `continue-on-error`.
- **Similarity hints for the classifier.** `withCandidates()` in
  `src/classify.js` attaches `candidates` to each post before
  `chunkRequests` — nightly, `classify-range` and `classify-live` all go
  through it. Vectors come from the index; posts the index lacks are
  embedded in one batch, or skipped with one warning when the model is
  absent. The top `settings.semantic.candidates` (3) stories within
  `settings.semantic.min_sim` (0.8) of the post become
  `{"story": "macro/sub", "sim"}` when the story is a live taxonomy row,
  `{"emerging": "<label>", "sim"}` when it is a stories.json candidate the
  taxonomy has not promoted (retired rows produce nothing). One rule in the
  system prompt says what they are: hints from wording similarity, to be
  assigned only when the text or quoted context supports it. A post with no
  candidates serialises exactly as before, and the cached system block does
  not depend on the items, so the prompt cache is unaffected. Dry run on
  2026-09-09 (603 posts to the model): 39 hinted, 42 ms, no model call; all
  hints were emerging labels because the taxonomy carried no `story: true`
  rows yet that night.
- **"Similar, unlabeled" on the dashboard.** `attachRelated()` in
  `src/sitedata.js` gives every Emerging card and every story row up to
  `settings.semantic.related_posts` (5) posts from the 7-day window whose
  vector sits near the story's posts and that carry no label for it —
  `relatedPosts()` for a story the map knows, `nearSeed()` over the
  cluster's own posts for a gap. Excluded: posts outside the window,
  retweets, and posts already labelled with the story by the live tagger.
  Each entry carries id, similarity, handle, trimmed text, time and the
  labels it does have; `site/index.html` renders them as a compact list
  under the card / row with a title that says "measured similarity, not a
  judgment". Rebuild on 2026-09-10: 9 of 11 clusters got lists, rollups.json
  grew 293 → 310 KB (13 KB of lists).

Observed while wiring, not fixed tonight: with only 11 posts the
`epstein-files` candidate's centroid pulls generic congressional-oversight
retweets (truncated "RT @…" fallbacks whose originals are not archived) in
at 0.81–0.84, so hints from small candidate stories are noisier than the
0.8 floor suggests. Options: a higher floor for hints than for the dashboard
lists (`settings.semantic` already separates the counts, not the floors),
skipping hints for truncated retweet fallbacks, or requiring a minimum seed
size before a candidate story hints at all.

## Files

- `src/embeddings.js` — model pin, verification, `modelAvailable()`, `loadEmbedder()`, `embed()`, `prepareText()`
- `src/embedding-index.js` — int8 index: `createIndex`, `load`, `upsert`, `neighbors`, `save`
- `src/embed-archive.js` — `npm run embed`, incremental; the poller's post-capture step
- `src/semantic.js` — `buildStories`, `centroid`, `createSemantic` → `relatedStories`, `relatedPosts`, `nearSeed`, `storyKeyFor`; `loadSemantic()`, `loadSemanticOrNull()`, `configuredMinSim()`, `storyRow()` / `storyTopic()`
- `src/classify.js` — `withCandidates()`, `candidateHint()`; `src/taxonomy.js` — the "candidates" prompt rule
- `src/sitedata.js` — `attachRelated()`; `site/index.html` — the "Similar, unlabeled" lists
- `config/settings.json` → `semantic` — `min_sim`, `candidates`, `related_posts`
- `test/classify-candidates.test.js`, `test/sitedata-related.test.js` — hint wiring, prompt stability, dashboard attachment (semantic layer stubbed)
- `scripts/download-embedding-model.js` — `npm run download-model`
- `scripts/semantic-proof.js` — `npm run semantic-proof`; outputs in `docs/semantic-proof/`
- `data/embeddings/index.bin`, `index.json` — the committed index
- `.npmrc`, `package.json` overrides — CPU-only install, patched `sharp`
