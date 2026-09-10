# Memory — what persists, what is regenerated, what the model is shown

Owner's question (2026-09-10): *"Will this layer have long-term memory?"*
Yes. The repo is the datastore, and since tonight the story layer keeps a
ledger per story that no later run rewrites, plus a rolling summary written
from it. This page says where each kind of memory lives, which files are
derived (rebuildable from the archive) and which are remembered (never
recomputed), and exactly what each judging step is shown.

## What persists where

| Layer | File(s) | Kind | Rule |
|---|---|---|---|
| Corpus | `data/archive/YYYY-MM-DD.jsonl` | remembered | append-only capture, bucketed by ET day; `merge=union`; deduped by id on read |
| Engagement | `data/metrics/YYYY-MM-DD.json` | remembered | the 24h refresh, keyed by id; never re-billed |
| Taxonomy | `config/taxonomy.yaml` | authored + promoted | hand edits are authoritative; `npm run stories -- --promote` appends `story: true, since:` subtopics. **Retirement** (`retired: YYYY-MM-DD` on a story subtopic) keeps the row and the dossier and marks both retired — nothing is deleted, so old assignments still resolve. *(promotion/retirement automation: night-story-promotion, pending)* |
| Classification | `data/topics/<date>.json` | derived, then corrected | the nightly batch rewrites a day only when re-run; live tags in `data/topics-live/` fill the current day |
| Corrections | `config/corrections.yaml` → `corrected` map in `data/topics/<date>.json` | remembered | editors' precedents; re-applied after every classify; the newest N are shown to the classifier |
| Phrases | `data/phrases.json`, `data/syntax/<date>.json` | ledger + derived | first-seen per phrase and per member; the day file is recomputed |
| Story candidates | `data/stories.json` | cache | `placements` (one model call per candidate, never repeated), `confirmation` (duplicate groups, accumulated), `promoted`; candidates themselves are rebuilt from the emerging clusters in the window |
| Incidents | `data/incidents.json` | cache | grouping is rebuilt; `intel` per incident is kept until the incident gains posts |
| Outside context | `data/context.json`, `data/narratives/<key>/` | snapshot | newsletter/article hits per story, hand- or pass-searched; context, not verification |
| Semantic index | `data/semantic/` *(night-semantic-integration, pending)* | cache | embeddings by post id and a centroid per story; keyed by content |
| **Story dossiers** | `data/dossiers/<story-key>.json` | **remembered** | header + append-only daily entries + cached summary. See below. |
| Dossier pages | `docs/dossiers/<story-key>.md`, `docs/dossiers/README.md` | derived | rendered from the JSON every run |
| Rollups / site data / reports | `data/rollups/`, `site/data/`, `reports/` | derived | rebuilt from the layers above on every run |

Derived files can be deleted and rebuilt. Remembered files are the memory:
losing one loses what the system knew at the time (metrics that X no longer
serves, a day's ledger as it was when the day closed).

## The dossier

One per developing story: every taxonomy subtopic marked `story: true`,
every promoted candidate, and every candidate the placement pass called a
story that nobody has promoted yet (status `provisional`). Several
candidates that placed to one key are one story; when a provisional story is
promoted its key survives, so the dossier runs across provisional → active
without a seam. Built by `npm run dossiers` (`src/dossiers.js`), in the
nightly chain after the judging steps and before the report.

```
{
  key, label, macro, sub, since, anchors, aliases,
  status: provisional | active | retired, source, candidateKeys,
  firstSeen, lastSeen, hash, updatedAt,
  summary: { text, asOf, model, hash } | null,
  entries: [ { date, posts, retweets, members, byCaucus, newMembers, leaders,
               framing, framingSource, topPosts, ids, press, corrections, judgments } ]
}
```

- `entries` is **append-only**. A run recomputes only its target day (the
  nightly's "yesterday", or `--date=`) and adds days that have no entry
  yet. Days before the target are copied through byte-for-byte even when
  the archive, the assignments or the author table changed under them. What
  the data said about a day when the day closed is what the dossier
  remembers about it; if a later correction moves a post, the correction is
  recorded on the day it was filed, not by rewriting the past.
- Every entry is measured from the House roster: `posts` are originals,
  `retweets` amplification, `members`/`byCaucus` distinct members,
  `newMembers` the handles first seen on this story that day, `leaders`
  the most active handles, `topPosts` the most engaged (id, handle,
  engagement, quote ≤ 120 chars), `ids` the originals counted.
- `framing` names the day's line, strongest source first: the reason from
  *why it moved* (`data/why/<date>.json`, pending), else the message
  families the posts fall in (`data/families/<date>.json`, pending), else
  the top two phrases shared by at least two members. `framingSource` says
  which.
- `press` are the newsletter/article hits dated that day (or discovered
  later, in which case they land on the day they were discovered — the
  item keeps its own date). `corrections` are posts editors moved onto or
  off the story, on the day the correction was filed, with the note.
  `judgments` are what other layers decided about the story with their
  reasons: merges (evidence-backed folds and confirmed duplicate groups
  from `data/stories.json`), lookalikes (`data/lookalikes.json`, pending)
  and corroboration (`data/incidents.json` merge log, pending). Undated
  judgments land on the target day when first seen and are never repeated.
- `summary` is Claude's rolling summary (≤ 120 words: what the story is,
  how it developed, who leads it, how the framing shifted, open questions),
  written from the header and the entries plus the previous summary. It is
  regenerated **only when the ledger changed**: `summary.hash` is the
  content hash of the header facts and the entries, `summary.prompt` the
  version of the prompt that wrote it, and a run skips the call while both
  match (bumping `SUMMARY_VERSION` in `src/dossiers.js` rewrites every
  summary once). Runs are capped at 40 calls (`--max-calls=`); `--no-llm`
  keeps whatever summary is on file. `asOf` is the target date, never the
  wall clock, so an unchanged story leaves an unchanged file.
- `anchors` are the posts that define the story: the taxonomy's `anchors:`
  when it has them (night-quoted-context, pending), else the most engaged
  post the ledger had seen when the dossier was first built — fixed from
  then on, so a louder later day does not redefine the story.

`docs/dossiers/<key>.md` is the same ledger as a timeline table with the
summary on top; `docs/dossiers/README.md` indexes them by last seen.

## What is regenerated

- Every night: today's entry for every story; the docs pages; the summary
  of any story whose ledger changed (usually the ones that posted).
- Never: a past day's entry. To rewrite history on purpose — a story was
  mis-keyed, an author table was wrong for a week — delete the dossier
  file and let the next run rebuild it from the archive. The rebuild is
  deterministic for the same inputs, and the summary is rewritten once.
- The `hash` and `updatedAt` on the file move only when the ledger or the
  summary did; a quiet story produces no git diff.

## What the model is shown at each decision

Every judging step gets the same **Memory** block, rendered by
`src/memory.js` from the dossiers: one line of facts per story (key,
status, since, last seen, leaders, aliases), its summary, and the framings
of the last three posting days. It is sorted by key and dated from the
ledger, so it is byte-identical until a dossier changes — which is what the
prompt cache needs.

| Decision | Reads | Memory shown | Status |
|---|---|---|---|
| Live classification (`classify-live.js`) | the poll's new posts + taxonomy + editors' precedents | `memoryForClassifier()`: the 12 most recently seen active/provisional stories, as a second cached system block. Provisional stories have no taxonomy id, so the block tells the model to put such posts in `emerging` under the story's label — that is how a provisional story's days link up before promotion. | wired tonight |
| Nightly classification (`classify.js`) | the day's posts + taxonomy | the same block as a second system block in `chunkRequests` | TODO — `classify.js` was off-limits tonight; the batch classifies without memory until then |
| Duplicate confirmation (`stories.js confirmDuplicates`) | every story candidate's label, daily labels, first/last samples | `memoryForStories(keys)` for the stories the candidates placed to, between the rules and the cluster list | wired tonight |
| Why it moved (`why.js`) | the driving posts of each top mover | `memoryForStories(keys of the movers)` so the reason is written against yesterday's framing | hook — night-why-it-moved |
| Feed lookalikes | unlabeled posts next to a story in the semantic index | `nearbyStoryContext(post, k)` — the k nearest stories with their summaries (semantic index when present, alias match until then) | hook — night-semantic-integration |
| Incident corroboration | incident posts | `memoryForStories(keys the incidents are tagged with)`; verdicts written back as `merges` / `corroboration` in `data/incidents.json` | hook — night-incident-corroboration |
| Rolling summary (`dossiers.js`) | the dossier's header, entries and previous summary | its own previous summary, for continuity | wired tonight |
| Daily report (`report.js`) | dossier diffs | "Stories: what changed since yesterday" — posts vs the previous posting day, new members, framing shift, press, corrections, judgments, and the first sentence of the summary | wired tonight |

Reading a story back:

```js
import { storyContext, nearbyStoryContext } from './src/memory.js';
storyContext('dolly-parton-tribute');
// → { key, label, macro, status, since, lastSeen, anchors, aliases, summary,
//     summaryAsOf, recentFramings, leaders: [{handle, posts}] }
await nearbyStoryContext('Dolly gave my district the Imagination Library', 2);
// → [{ ...storyContext, match: { by: 'alias', score, terms } }]
```

Rules that hold everywhere: numbers are measured and never overwritten by a
judgment; a judgment carries its reason and its evidence (ids, quotes); the
model is never shown a keyword hit alone; every cache is keyed by content
and every run is bounded.
