# NPR public excerpt quality

On September 16, 2026, three public NPR article pages reproduced two extraction problems: audio-only summaries plus publisher anti-fraud notices were labeled as readable article bodies, and transcript `<p><p>` markup collapsed multiple speaker turns into a single truncated passage. The known NPR content containers also place photo captions inside nested divs, outside the paragraph-class filter.

The extractor now selects the explicit NPR transcript or story-text container using the actual fetched `npr.org` host. It does not trust the canonical URL to activate publisher-specific behavior. It preserves separate transcript turns and a standalone speaker label attached to its next paragraph. It removes photo caption/image blocks and transcript disclaimers while retaining the existing three-passage/600-character limits. Unknown NPR layouts yield no new body evidence.

A page explicitly marked `is-DACS-only no-transcript`, with a complete story-text container matching its declared description exactly and no transcript container, supplies a summary lead only. On a successful fetch this is an explicit correction of an earlier false body: prior passages are removed, the feed description remains, and the normal content hash/version records the change. A timeout, HTTP failure, or unknown layout still retains the earlier readable excerpt. Summary-only audio pages are rechecked at the configured normal body refresh interval (currently six hours), so a later transcript can become available. These changes neither fetch hidden text nor transcribe audio.

The extractor changes apply on subsequent normal refreshes. Older stored versions remain append-only; this release does not rewrite history, trigger paid inference, or claim all old excerpts have been corrected. The existing publisher allowlist, redirect checks, acquisition timestamps, publication dates, robots policy, source links, and fetch limits are unchanged. The three examples establish reproduced cases, not an overall accuracy rate.

## Source fixtures

The small fixtures retain the relevant observed HTML wrappers, source URLs, and declared publication dates. All headline, description, article, transcript, speaker-name, caption, and notice text is explicitly synthetic. Unrelated scripts, images, advertisements, and most page markup were omitted. Full source HTML was used locally to reproduce and verify the extraction behaviors but is not committed. The fixtures test layout handling and provenance preservation; they are not quotations or records of what a real speaker said.

- [Audio summary without a transcript](https://www.npr.org/2026/09/15/nx-s1-5968682/trump-says-developing-ai-is-a-critical-race-downplaying-fears).
- [Politics-chat transcript with implicit paragraph endings](https://www.npr.org/2026/09/13/nx-s1-5964863/politics-chat-trumps-5-000-promise-to-voters-vance-invokes-charlie-kirk).
- [Written story with body paragraphs and an image caption](https://www.npr.org/2026/09/15/nx-s1-5968678/bernie-sanders-and-steve-bannon-to-share-a-stage-to-promote-curbs-on-ai).

Requests returned HTTP 200 using the configured identifying User-Agent and registered NPR hosts. The public robots response allowed these article paths. Source fingerprints below identify the local full-page capture from which each layout fixture was prepared; the hashes identify the real source captures, not the synthetic-text fixture files.

| Fixture | Captured UTC | Full-page SHA-256 |
| --- | --- | --- |
| `npr-audio-summary.html` | 2026-09-16T01:15:39.939542+00:00 | `ab96388ca6a79aaa20cadb07d3dce24720859eab42701e38db005dc91ceb08c3` |
| `npr-transcript.html` | 2026-09-16T01:15:40.051520+00:00 | `84f1abeec306027ab641cc74e9294aec0f6939887e0258a629162cbb41069298` |
| `npr-written-story.html` | 2026-09-16T01:16:45.199466+00:00 | `e3ca8be1b00600fd1bcb419454a05165188bc7cedffbc479a1399aa516c0697d` |

Validation: `node --test test/news-article-extraction.test.js test/news-context.test.js test/news-quality.test.js test/news-provenance.test.js`. Regressions cover observed summary/transcript/story layouts with synthetic prose, host lookalikes, source dates/URLs, false-body correction, preservation on timeout/503/unknown HTML, later transcript acquisition, speaker attribution, and excerpt limits. These tests use saved public fixtures and make no network or model calls.
