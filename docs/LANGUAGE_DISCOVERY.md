# Automatic repeated wording

The language service finds exact passages repeated in at least two saved posts. It supplies the full available source text, character spans, dates, source links, and descriptive post/member counts. It preserves case, spacing, punctuation, apostrophes, and negation. A repeated passage can be much longer than two or four words; there is no maximum phrase word count.

This is an implemented local analysis service, available through the API and a read-only local command. It is ready to connect to the incoming dashboard design. The current visual interface remains unchanged while Claude's redesign is pending.

## What a group means

The service favors a longer shared passage over redundant suffixes of the same passage. A shorter passage remains when it has additional occurrences beyond the longer version. For example, two posts might share a complete sentence, while a third shares only its central phrase; both the sentence and the more widely used phrase can appear.

The default minimum is three words; it can be lowered to two. This selects passages for inspection, not every possible substring. The complete original post is retained regardless of which patterns are displayed. URL spans form discovery boundaries so a shared link does not become a language finding; the URL remains in the full source text.

Reposts are excluded from these counts. Quote-post captions are labeled separately, but embedded quotations and the speaker's stance are not interpreted. Repeated wording alone does not establish agreement, coordination, a new event, or breaking news. The first occurrence is only the first within the selected saved sources, not the phrase's first use on X.

Post counts deduplicate IDs. Member counts use the existing account-to-member attribution, so two accounts assigned to one member count once. Historical calibration identities retain their provisional identity notes. This feature does not verify identity itself.

## API

`GET /api/language` uses the last 24 hours by default. Parameters:

| Parameter | Meaning |
| --- | --- |
| `since`, `until` | Explicit ISO dates. Start included, end excluded. Maximum window is 31 days. |
| `windowHours` | Default window length when `since` is absent; 1–744 hours. |
| `query` | Substring filter on source text. Current SQLite matching folds ASCII case. |
| `memberId`, `type` | Filter by stored member attribution or original/reply/quote/repost type. |
| `topic`, `subtopic` | Filter by current labels, giving current source-version corrections precedence. Both must match the same label when supplied together. |
| `minWords` | Minimum repeated phrase length, 2–100; default 3. This is a minimum, not a maximum. |
| `minMembers` | Minimum distinct attributed members in the matching posts; default 1. Two distinct posts are still required. |
| `limit` | Maximum returned groups, 1–100; default 40. |

The response includes:

- `window` and `generatedAt`, making the observation period explicit.
- `groups`: exact phrase, word count, descriptive counts, first/last dates, and source spans. Groups are ordered by latest supporting post date, then phrase text; this is not an importance ranking.
- `sources`: full available text keyed by ID, source version, original date, provenance kind, context coverage, and identity note. It excludes raw provider payloads, feedback, and credentials.
- `coverage`: selected versus analyzed posts, excluded reposts, all resource omissions, and whether discovery is partial.

Occurrence offsets are JavaScript UTF-16 indices with an exclusive end. Use `source.text.slice(start, end)` to reproduce the exact phrase. Source hashes let a consumer detect later edits. Up to 200 occurrences per group are returned, sampled from the newest posts and then displayed chronologically; `occurrenceCount` still counts every matching span in the admitted selection, and `occurrencesOmitted` states the remainder.

An empty current window is expected when the archive contains only old calibration examples. Do not insert demonstration findings or silently move the time window to make it look live. An explicitly selected historical window retains its original dates and provenance.

## Local command

```sh
node scripts/language.js
node scripts/language.js --windowHours 2 --minWords 2
node scripts/language.js --since 2026-09-07T00:00:00Z --until 2026-09-08T00:00:00Z
```

The command prints only status, coverage, and group counts. It performs no network or model requests and does not print private post wording. `CAUCUS_DB_PATH` can select a separate local test database. Detailed source evidence is returned by the private API rather than exported into Git.

## Resource and coverage limits

Each request examines at most the newest 500 eligible posts, 200,000 UTF-16 source characters, and 40,000 tokens including exact whitespace, punctuation, and source boundaries. Oversized posts are omitted whole from that calculation; source storage is never shortened. Selection uses the date index and streams bounded rows without hydrating the complete archive or raw payloads. Counts and selected rows share a short database transaction.

The discovery algorithm builds a suffix array and longest-common-prefix intervals instead of storing every n-gram. It then checks occurrences against exact source and word boundaries. A request admits at most 300 candidate phrases totaling 500,000 characters, at most 20 million source characters of occurrence scanning, and 100,000 match checks. It omits an unfinished group's counts rather than calling them complete.

The serialized groups/source payload is capped at one million characters, excluding the small coverage/metadata envelope. A source is returned in full or omitted with a response-limit flag. `groupsOmittedFromResponse` also reports the presentation limit. Narrow the period or filters if a calculation is partial; a partial result is not an exhaustive trend report.

Patterns are recomputed from current stored sources when requested, so subsequent requests reflect source edits, removals, and review changes. No persistent phrase cache or collection scheduler is started. A future dashboard can refresh this local endpoint once per minute, separately from X collection.

## Verified behavior and remaining intelligence work

Synthetic tests cover long passages, negation, exact spacing and punctuation, Unicode offsets, cross-midnight windows, duplicates, multiple accounts per member, quotes/reposts, URL/source boundaries, source edits/removals, resource limits, HTTP validation, and agreement with exhaustive enumeration on small corpora.

This is exact language discovery. Paraphrase grouping, embedded quotation attribution, semantic event clustering, novelty, and interpretation of district incidents remain unfinished. The word tokenizer handles letter/number sequences and apostrophes; it is not a language-specific segmenter for every writing system. Current query case folding is limited to ASCII even though exact source text and offsets preserve Unicode.
