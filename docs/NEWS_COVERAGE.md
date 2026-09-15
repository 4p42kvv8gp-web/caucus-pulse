# Public news coverage

The dashboard's public-news panel separates source acquisition from available
evidence. A completed HTTP fetch can still yield no recent items. A failed
fetch can leave previously acquired items available for interpretation.

`src/news-coverage.js` derives `news.coverage` during each dashboard build from
the stored news items, configured source registry and per-source fetch status.
Counts use a rolling 14-day publication window ending at `coverage.asOf`;
they can decrease as records age even when no new source fetch occurs. The
existing recent-news list and emerging-card retrieval keep their own 10-day
loader window.

Each source reports:

- Eligible items with a known, nonfuture publication date inside 14 days.
- Items with saved article excerpts: `extract: body` plus a nonblank passage.
- Items with a headline or summary but no saved article excerpt.
- Any remaining eligible items without readable text.
- The newest known publication date and its linked source, including older
  records when no recent items exist.
- The last recorded fetch time and outcome, independently of item counts.

Item identities are deduplicated by highest content version, then the latest
observation at the same version, matching the news loader. Publisher-host
checks apply after deduplication; an invalid newest revision cannot restore an
older revision to the count. Unconfigured sources, undated or future items and
publisher mismatches do not contribute. Excerpts are short stored passages;
these counts do not establish reporting accuracy or full-article coverage.

Only explicit public fields are projected. Private metadata, raw source bodies
and fetch-error details are excluded. The panel links configured feeds and the
latest retained public source. Older dashboard data without coverage metadata
shows that the details are unavailable instead of inventing zero counts.

`test/news-coverage.test.js` covers version and date boundaries, source filters,
stale successful feeds, failed fetches with retained evidence, time-based
expiry, privacy and the actual panel renderer. The same UI labels separately
supplied official legislative evidence as a **Floor agenda**.
