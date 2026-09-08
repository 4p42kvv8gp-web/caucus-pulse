# Hugging Face intelligence plan

Reviewed September 8, 2026 against the user-supplied proposal and official model documentation. These are candidates for measured development, not deployed features or verified quality/cost claims.

## Skills ready

The installed Hugging Face plugin already provides CLI/model access, datasets, Transformers.js, community evaluations, Trackio, and training guidance. Three additional official skills were installed from `huggingface/skills`: `train-sentence-transformers`, `hf-mem`, and `huggingface-tool-builder`. They become discoverable on the next task turn. Installing skills does not download model weights, train a model, or activate a cloud endpoint.

The product remains private. Any skill's default public Hub publishing or cloud training is overridden by this project's private-data scope and spending controls. Run local experiments first; do not upload source posts, feedback, or trained artifacts to a public repository. No Hub data repository, paid job, model download, or provider subscription was created during this review.

## Model decisions

| Candidate | Planned role | Evaluation boundary |
| --- | --- | --- |
| `sentence-transformers/all-MiniLM-L6-v2` and `BAAI/bge-small-en-v1.5` | Compare semantic retrieval and provisional cross-post grouping. Cache source-versioned passage embeddings and reuse them for search and discovery. | MiniLM defaults to truncation after 256 word pieces; BGE small supports 512 tokens. Split long posts into overlapping, source-offset passages, preserve full text, and record passage coverage. Compare on paraphrases, negation, quotations, and late-post details. |
| `mlburnham/Political_DEBATE_base_v1.0` | Candidate for narrow topic/event hypotheses; compare with the evidence-grounded semantic provider. | Its author recommends the large variant for general zero/few-shot use unless the use case appears in training. Base is not assumed best for our incident classes. Measure recall, precision, abstention, latency and memory on actual reviewed posts. |
| SetFit | Later small classifier trained on reviewed examples, potentially assisted by clearly marked teacher labels. | The eight-example result is a benchmark example, not a guarantee for our taxonomy. Keep training, development and final tests separate by event/text family and time. Promote only after held-out evaluation; model-generated labels are not human truth. |
| `dslim/bert-base-NER` and embedding/keyphrase extraction | Propose observed people, organizations, locations, and concise cluster titles. | This NER model was trained on news and can miss or split social-media entities. A named place does not establish the event's location or district. Ground names/titles in exact evidence and maintain provisional/canonical identity separation. |
| `cardiffnlp/twitter-roberta-base-sentiment-latest` | Optional sentiment experiment if it proves useful. | Its outputs are negative, neutral, and positive. They do not directly distinguish constituent service, emergency reporting, criticism, quotation, or advocacy. Those require separate reviewed communicative-function labels. Do not call sentiment a quality judgment. |

Sources: [MiniLM model card](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2), [BGE model card](https://huggingface.co/BAAI/bge-small-en-v1.5), [Political DEBATE recommendations](https://huggingface.co/mlburnham/Political_DEBATE_base_v1.0), [SetFit documentation](https://huggingface.co/docs/setfit/index), [NER model card](https://huggingface.co/dslim/bert-base-NER), [Cardiff model card](https://huggingface.co/cardiffnlp/twitter-roberta-base-sentiment-latest).

## Product behavior

1. Embed newly saved source passages after each collection pass, independently of classification. Examine both labeled and unlabeled posts so an emerging event inside an established topic remains discoverable. Incremental discovery should follow each 30-minute collection pass; a nightly consolidation can supplement it.
2. Present exact wording counts separately from semantic similarity. A cosine neighbor is a candidate related passage, not proof of paraphrase, endorsement, shared meaning, or coordination. A percentage about exact quoted wording must count literal occurrences; a semantic percentage needs a separately defined, evaluated relation and explicit denominator.
3. Use similarity for candidate retrieval, then check the target claim, negation, attribution and event identity. Preserve single-post incident candidates and uncertainty. Do not infer an incident ended merely because a member stopped posting.
4. Store model revision, tokenizer/chunking version, source hash, passage offsets, vector dimensions, job status and exclusions. Invalidate derived vectors/groups on edits/removals; reject late results for superseded sources. Evaluate group purity and missed related posts, not just attractive example clusters.
5. Apply the user's accepted correction to that post immediately. Broader lessons become versioned examples and evaluation cases. Train only after examples justify it; do not automatically replace the semantic provider after a calendar interval.

## Archive and operating cost

Hugging Face currently lists 100 GB of private storage for free users/organizations. That can be useful for controlled datasets, but a versioned Parquet repository does not replace the transactional application database for corrections, jobs, concurrency, source edits and removals. Keep the live archive in the application database; evaluate private Parquet snapshots only after removal/history handling and access requirements are concrete. [HF storage limits](https://huggingface.co/docs/hub/en/storage-limits)

The proposed $60-to-$20 monthly reduction is unverified. Benchmark actual post volume, passage counts, CPU memory/time, hosted-model token use, storage growth and any Actions charges. Free model weights do not make runtime, storage or hosted inference unlimited. No cost claim or two-vCPU throughput promise should appear in the dashboard until measured.

## Next implementation pass

- Build a private benchmark/export contract from real reviewed posts with protected held-out examples and synthetic safety checks kept separate.
- Select a pinned, compatible embedding runtime and compare MiniLM/BGE on a bounded local run; record weights/license/version and hardware requirements.
- Implement passage jobs, vector persistence, model-version invalidation and semantic retrieval before wiring provisional clusters into the design.
- Add cost-controlled semantic classification jobs and compare narrow DEBATE hypotheses before selecting the poll-time classifier.
- Use Jacob's voice exercises to define event identity, quote/negation boundaries, subtopics and communicative function. No new account setup is required solely to use the installed skills.
