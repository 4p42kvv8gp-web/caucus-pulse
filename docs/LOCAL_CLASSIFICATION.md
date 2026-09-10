# Local classification and its limits

The current first-pass provider is `mlburnham/Political_DEBATE_large_v1.0`, revision `1a3aff1ecb97ad93a6de598f7414b1707de7e7c3`. Its author recommends the large model for general zero-shot use. It runs locally on two CPU threads with no source uploads, hosted endpoint or paid inference request. [Model documentation](https://huggingface.co/mlburnham/Political_DEBATE_large_v1.0)

## What the product does

- Proposes multiple broad subjects and up to two suggested subtopics per supported subject, with a maximum of eight displayed labels. Oversight is an overlapping subject, so an investigation can also carry its policy topic.
- Tests separate hypotheses for communicative functions and physical-emergency reports. These are provisional suggestions, not quality judgments, sentiment scores, verified incidents or measures of political coordination.
- Refers to numbered passages selected from the exact original source. The application resolves them to original UTF-16 spans, including punctuation, repeated sentences, whitespace and negation. Model-rewritten quotations and invented offsets are not accepted.
- Uses complete, overlapping source windows. It never silently truncates a long post. An input, pair-count or time limit leaves a visible failed/skipped job and retains the source and previous analysis.
- Defers topic inference for brief linked reactions without a supported emergency flag. It does not fill in an unseen article or referenced post. A saved human interpretation can still supply the correct topic.
- Preserves the full analysis history and model, taxonomy, policy, implementation and source versions. New sources queue automatically; changed or removed sources invalidate pending results. Leases and the previous-analysis check prevent late output from overwriting a newer run.

The model tests hypotheses; the explanation shows the matched hypothesis and the supporting original passage. It does not generate narrative summaries that could invent family relationships, locations or events. A separate named-mention model now proposes person, organization, location and other types; every name must be an exact source span. These are provisional types, not verified identities or incident locations. Exact observed @handles are also preserved without expanded names.

## Named mentions

`dslim/bert-base-NER`, revision `d1a3e8f13f8c3566299d95fcfc9a8d2382a9affc`, runs locally in the same CPU environment. Six pinned files total 433,513,302 bytes. Its MIT-licensed model was trained on CoNLL news text and has known social-media limitations. [Model documentation](https://huggingface.co/dslim/bert-base-NER)

Explicit overlapping token windows reach the complete available source, including late details. Every non-whitespace source character must be represented in the tokenizer offsets. Missing coverage, excessive windows or the shared deadline fail visibly instead of truncating the source. Complete BIO groups retain original Unicode and spacing; partial wordpieces and cut-window groups are rejected. Ambiguous repeated names within a passage are omitted rather than assigned guessed offsets. Up to 12 mentions are returned with disclosed omissions; source coverage uses UTF-16 character counts.

Nine synthetic development cases exercised place, agency, person, Unicode, repetition, denial and late-source details. Seven contained all expected names. The model missed some facility, road and school names, including Dilley and Delaney Hall in one fixture. On a real political caption it treated a rhetorical name as an organization. These observations are explicit limitations, not an accuracy estimate. The Teach desk shows suggested types and original context for review. No mention automatically fills an incident's location or verifies a district connection.

## Learning and review

The teaching desk supports supported labels, an explicit empty answer, and “need more context.” Reviews retain the source hash and the prediction actually displayed. A changed source or prediction rejects a stale submission without pretending the old interpretation still applies. Current human labels always take precedence.

Bounded semantic retrieval of accepted examples is available to the optional generative adapter. It excludes held-out posts, identical copies, direct references and edit siblings. The selected Political DEBATE provider uses fixed hypotheses, **does not consume these examples**, and records that fact. No weights have been trained from the one existing human review. Reviews form an auditable basis for later SetFit/DEBATE training and separate held-out evaluation; a model-generated label is not human truth.

## Engineering evidence from September 8

The three real development posts produced valid source-linked suggestions. The brief linked political caption abstained instead of inventing the missing story; its existing human oversight correction remained applicable. The immigration release produced immigration subjects without a physical-emergency event. The anniversary/security-review post produced national-security, congressional-politics and oversight subjects without a current incident. These are inspected development cases, not a held-out accuracy claim.

The first full NLI engineering run returned valid output on 18/18 synthetic cases; 9/18 met every richer generative-model expectation. Most misses were deliberately unimplemented named-entity/location outputs. Additional misses included the correction event, weather-advice function, and hazardous-road topic. The next narrow pass fixed the correction-event case; weather-advice and hazardous-road classification remain weaknesses. Keep these in the review/evaluation set rather than claiming a solved accuracy percentage.

Observed NLI processing was roughly 2–4 seconds for short fixtures with about 1.9 GB peak process memory. A 1,568-token long fixture took about 81 seconds across 13 complete windows and 494 hypothesis pairs, with about 2.1 GB peak memory. Adding named mentions produced source-valid output for all three real development posts in approximately 2.4–5.9 seconds each, with process peak memory around 2.3 GB. These are measurements on this Mac, not a two-vCPU hosting throughput promise. A 0.95 entailment threshold is provisional and **not** a 95% probability of correctness; raw scores are not shown as user-facing confidence.

Earlier local Qwen 4B/9B experiments are not the selected provider. Qwen 9B passed an 18-case synthetic prompt check but made unsupported interpretations on real captions and mishandled copied punctuation. A reasoning-mode trial exceeded the time limit. Those observations motivated passage selection and the narrower NLI first pass. The optional Qwen profile remains an experimental comparison; it should not be described as production-ready.

## Setup and operations

Use Python 3.12 on macOS ARM64 for the exercised runtime, or Linux x86_64 for the prepared CPU lock:

```sh
python3 scripts/setup-local-classifier.py
python3 scripts/download-classifier-model.py
python3 scripts/download-classifier-model.py --entities
node scripts/classifier.js status
node scripts/classifier.js run 5
```

The public topic model download is approximately 1.75 GB, pinned to the revision and per-file digests in `config/local-classifier.json`; named mentions use `config/entity-model.json`. Source data and model assets are ignored by Git. The 35-package NLI environment has pinned public wheel hashes and had zero known OSV findings when checked September 8. The separate Linux lock uses official Torch 2.14.0+cpu and has verified wheel hashes and dependency metadata closure. Its approximately 250 MB package set has been downloaded, but a Linux installation has not been executed. See [Private hosting](PRIVATE_HOSTING.md) for the target-host checks.

Enable `intelligence.localClassifier.enabled` to process five jobs per bounded pass after startup. The server promptly follows with another pass while work remains, yielding between passes so HTTP and shutdown stay responsive. A drain is capped at 100 passes; the minute timer checks for new or remaining work. A closed runtime leaves unattempted sources pending. A single process lock prevents the preview and CLI from loading duplicate large models. `CAUCUS_DISABLE_LOCAL_CLASSIFIER=1` starts the archive for maintenance without loading it. Failed model output is not retried indefinitely; `node scripts/classifier.js queue POST_ID` explicitly requests another source-bound attempt.

Normal service shutdown cancels model startup or active inference, waits for the child process to exit, and defers still-current interrupted work without consuming a failed attempt. Edited/removed sources, replaced leases and newer explicit analyses cannot be overwritten by an old shutdown path. An actual Mac service drill stopped during startup and inference, then restarted the same synthetic archive: six deferred sources each completed once, crossing the five-job pass boundary, with zero provider requests. Use `node scripts/host-shutdown-smoke.js` with the preview stopped to repeat this isolated check on the intended host; it is separate from Linux validation.

Limits: 60,000 source characters, 512 source passages, at most 24 complete windows and 10 passages per window, 512 model tokens per premise/hypothesis pair, 600 total tested pairs, batches of four, two CPU threads, 160-second inference deadline, and a 180-second client deadline. Over-limit work remains visible rather than receiving fabricated results.
