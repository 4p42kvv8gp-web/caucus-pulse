# Local semantic search

The **Related subjects** view finds source passages by subject, including wording that differs from the query. It highlights a matching passage within the complete available post. It keeps quotations, negation, source dates, account identity, and current reviewed labels visible. Results are retrieval candidates: similarity does not establish agreement, factual verification, incident identity, or coordination. No similarity percentage is presented as the share of members saying something.

## Runtime and reproducibility

- Pinned `@huggingface/transformers@3.8.1`, Node 24.19.x, ONNX CPU inference with two intra-operation threads. The pnpm lockfile and workspace settings belong together. Install with `pnpm install --frozen-lockfile --ignore-scripts`; CPU binaries are bundled, and CUDA downloads are disabled.
- A transitive `sharp` override pins 0.35.3 to address [GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj). The text-only path was verified with that override; the September 8 dependency audit reported zero known advisories. This is a dated check, not a permanent security guarantee.
- MiniLM: `Xenova/all-MiniLM-L6-v2`, revision `751bff37182d3f1213fa05d7196b954e230abad9`; q8 ONNX, 384 dimensions, normalized mean pooling, 256-token input ceiling. This is an ONNX conversion of [sentence-transformers/all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2), whose default truncation boundary is 256 word pieces.
- BGE candidate: `Xenova/bge-small-en-v1.5`, revision `ea104dacec62c0de699686887e3f920caeb4f3e3`; q8 ONNX, 384 dimensions, 512-token ceiling. Use normalized **CLS** pooling and the retrieval-query prefix from the [original BGE model instructions](https://huggingface.co/BAAI/bge-small-en-v1.5). Its conversion's example uses mean pooling; this implementation follows the original model's CLS contract.
- `node scripts/download-embedding-model.js minilm` downloads only pinned public model assets (23,685,047 bytes). The BGE variant is 34,726,871 bytes. File sizes and original Git-blob/SHA-256 digests must match. Files are staged before publication into ignored `data/models/`; no account token or source text is sent. A corrupt existing model directory is not silently replaced.
- Inference re-verifies local files, disables remote model loading and model caches, and runs in a worker thread with an empty inherited environment. Queries and source posts stay local. The application never downloads a missing model during a request.

## Complete source coverage

Source text remains the authority; model tokenization is a separate derived representation. Overlapping context windows respect the actual tokenizer limit and preserve original UTF-16 offsets. Every character is covered before a source can be marked indexed. Word/sentence boundaries are preferred, Unicode surrogate pairs stay intact, and every final token count is checked again.

Additional distinct sentence slices help retrieve a brief development surrounded by unrelated material. Repeated identical sentence text uses one representative detail slice; its other occurrences remain in the source and overlapping context windows. Semantic sentence slices must not be used as exact occurrence counts. Exact-language discovery has its own occurrence service.

Limits are 100,000 UTF-16 source characters and 256 total passages. Sources exceeding the context-window limit are skipped entirely for indexing, with their full text retained. If only additional sentence detail exceeds its limit, context coverage remains complete and omitted detail is recorded. Unsupported/non-text media and missing linked/reference context are not embedded or inferred.

## Durable jobs and invalidation

Schema 7 adds model manifests, jobs and passage vectors. A model fingerprint includes the artifact revision, runtime, pooling, token limits and passage algorithm. Registering a model queues existing posts; new posts are queued transactionally. Changed source wording/reference versions clear old vectors and reset the job. Removal cascades vectors and jobs; a tombstone prevents replay. Late or overlapping workers cannot publish across a changed source, expired lease, or removal.

Jobs claim a two-minute lease and publish all passages in one transaction. Errors retain source data and generic failure status. Abandoned jobs can be reclaimed after expiry; after three claims they need attention. Failed jobs do not loop automatically. There is one inference worker, up to eight waiting requests, a 60-second operation/startup limit, and a 384 MB JavaScript-heap limit. Native ONNX memory is outside that heap limit and requires separate production measurement.

The preview indexes at most 25 posts per pass, independently of label classification. Status is `GET /api/semantic`; `POST /api/semantic/search` accepts `{ "query": "subject", "filters": {}, "limit": 20 }`. Queries are not saved. Structured filters match the explorer; an optional `filters.query` is an additional literal substring requirement. Invalid inputs fail before inference. Local model failures return 503; a full waiting queue returns 429.

Search scans at most 5,000 newest indexed posts and 20,000 passages in the chosen filters, then returns at most 50 posts, default 20, with a 300,000-character source-response budget. Results deduplicate posts and return up to three matching spans per post. Counts distinguish all selected, indexed, examined, omitted and returned sources. A cap can exclude older posts or stop within a post's passages; the response explicitly marks partial scan coverage. Similarity has no calibrated acceptance threshold. Original sources can still be found through literal/structured archive search when outside semantic coverage.

`node scripts/embeddings.js status` is local metadata only; `index 25` runs one bounded local pass. `search "your subject"` prints result IDs, offsets and coverage without source wording. Failed jobs require inspection before a deliberate local retry. Database/WAL/backup removal propagation still needs the deployment cleanup milestone.

## Engineering checks, September 8, 2026

The complete suite passes 102 tests, including 14 passage/index/API tests. Tests cover source preservation, Unicode, non-monotonic token counts, length limits, model identity, normalization, edit/removal races, lease expiry, rollback, migration/reopen, current review filters, bounded responses and unavailable models. Tests use synthetic data and never count as Jacob's feedback.

`node scripts/benchmark-embeddings.js` uses twelve synthetic posts and six subject queries. Both candidates ranked an expected subject first for all six probes after adding sentence details. A 9,039-character fixture retained its final incident sentence and all context; MiniLM produced 28 total passages across the fixtures, BGE 24. Observed embedding time was approximately 158 ms versus 453 ms, with warm-query totals about 8 ms versus 20 ms, on this local Apple ARM machine. These are small engineering probes, not a human accuracy evaluation or a two-vCPU hosting throughput guarantee.

Opposite-position sentences had cosine about 0.90 for MiniLM and 0.95 for BGE, while one paraphrase scored about 0.46/0.77. This directly demonstrates why similarity must not be reported as agreement or coordination. MiniLM is the initial lightweight default; both need diverse real-post evaluation before clustering thresholds or model preference are considered validated.

The preview's two historical posts were actually indexed into eight passages; the search API returned HTTP 200 with source spans. Its existing one review was preserved, X/model API spending remained zero, and semantic classification was not fabricated. Browser visual verification remains pending under the existing administrator-policy failure.
