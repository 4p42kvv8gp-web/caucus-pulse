# Local classification and its limits

The current first-pass provider is `mlburnham/Political_DEBATE_large_v1.0`, revision `1a3aff1ecb97ad93a6de598f7414b1707de7e7c3`. Its author recommends the large model for general zero-shot use. It runs locally on two CPU threads with no source uploads, hosted endpoint or paid inference request. [Model documentation](https://huggingface.co/mlburnham/Political_DEBATE_large_v1.0)

## What the product does

- Proposes multiple broad subjects and up to two suggested subtopics per supported subject, with a maximum of eight displayed labels. Oversight is an overlapping subject, so an investigation can also carry its policy topic.
- Tests separate hypotheses for communicative functions and physical-emergency reports. These are provisional suggestions, not quality judgments, sentiment scores, verified incidents or measures of political coordination.
- Refers to numbered passages selected from the exact original source. The application resolves them to original UTF-16 spans, including punctuation, repeated sentences, whitespace and negation. Model-rewritten quotations and invented offsets are not accepted.
- Uses complete, overlapping source windows. It never silently truncates a long post. An input, pair-count or time limit leaves a visible failed/skipped job and retains the source and previous analysis.
- Defers topic inference for brief linked reactions without a supported emergency flag. It does not fill in an unseen article or referenced post. A saved human interpretation can still supply the correct topic.
- Preserves the full analysis history and model, taxonomy, policy, implementation and source versions. New sources queue automatically; changed or removed sources invalidate pending results. Leases and the previous-analysis check prevent late output from overwriting a newer run.

The model tests hypotheses; the explanation shows the matched hypothesis and the supporting original passage. It does not generate narrative summaries that could invent family relationships, locations or events. Named incident locations remain unknown unless a separate supported analysis supplies them. Exact observed @handles are preserved without guessing expanded names or canonical identities.

## Learning and review

The teaching desk supports supported labels, an explicit empty answer, and “need more context.” Reviews retain the source hash and the prediction actually displayed. A changed source or prediction rejects a stale submission without pretending the old interpretation still applies. Current human labels always take precedence.

Bounded semantic retrieval of accepted examples is available to the optional generative adapter. It excludes held-out posts, identical copies, direct references and edit siblings. The selected Political DEBATE provider uses fixed hypotheses, **does not consume these examples**, and records that fact. No weights have been trained from the one existing human review. Reviews form an auditable basis for later SetFit/DEBATE training and separate held-out evaluation; a model-generated label is not human truth.

## Engineering evidence from September 8

The three real development posts produced valid source-linked suggestions. The brief linked political caption abstained instead of inventing the missing story; its existing human oversight correction remained applicable. The immigration release produced immigration subjects without a physical-emergency event. The anniversary/security-review post produced national-security, congressional-politics and oversight subjects without a current incident. These are inspected development cases, not a held-out accuracy claim.

The first full NLI engineering run returned valid output on 18/18 synthetic cases; 9/18 met every richer generative-model expectation. Most misses were deliberately unimplemented named-entity/location outputs. Additional misses included the correction event, weather-advice function, and hazardous-road topic. The next narrow pass fixed the correction-event case; weather-advice and hazardous-road classification remain weaknesses. Keep these in the review/evaluation set rather than claiming a solved accuracy percentage.

Observed NLI processing was roughly 2–4 seconds for short fixtures with about 1.9 GB peak process memory. A 1,568-token long fixture took about 81 seconds across 13 complete windows and 494 hypothesis pairs, with about 2.1 GB peak memory. These are measurements on this Mac, not a two-vCPU hosting throughput promise. A 0.95 entailment threshold is provisional and **not** a 95% probability of correctness; raw scores are not shown as user-facing confidence.

Earlier local Qwen 4B/9B experiments are not the selected provider. Qwen 9B passed an 18-case synthetic prompt check but made unsupported interpretations on real captions and mishandled copied punctuation. A reasoning-mode trial exceeded the time limit. Those observations motivated passage selection and the narrower NLI first pass. The optional Qwen profile remains an experimental comparison; it should not be described as production-ready.

## Setup and operations

Use Python 3.12 on macOS ARM64 for the tested lock:

```sh
python3 scripts/setup-local-classifier.py
python3 scripts/download-classifier-model.py
node scripts/classifier.js status
node scripts/classifier.js run 5
```

The public model download is approximately 1.75 GB, pinned to the revision and per-file digests in `config/local-classifier.json`. Source data and model assets are ignored by Git. The 35-package NLI environment has pinned public wheel hashes and had zero known OSV findings when checked September 8. Reusing the already installed environment passed dependency consistency checks; a fresh Linux installation has not been validated. Linux deployment needs a CPU-only PyTorch lock, not an assumed CUDA installation.

Enable `intelligence.localClassifier.enabled` to process up to five jobs per minute pass after startup. A single process lock prevents the preview and CLI from loading duplicate large models. `CAUCUS_DISABLE_LOCAL_CLASSIFIER=1` starts the archive for maintenance without loading it. Failed model output is not retried indefinitely; `node scripts/classifier.js queue POST_ID` explicitly requests another source-bound attempt.

Limits: 60,000 source characters, 512 source passages, at most 24 complete windows and 10 passages per window, 512 model tokens per premise/hypothesis pair, 600 total tested pairs, batches of four, two CPU threads, 160-second inference deadline, and a 180-second client deadline. Over-limit work remains visible rather than receiving fabricated results.
