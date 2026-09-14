# Dashboard source review

The dashboard publishes captured House posts even when classification is pending or an accepted result assigns no topic. Both states have explicit feed labels. The default feed shows 200 posts at a time; Show more reveals the remainder. Topic filters and ranking use the entire loaded seven-day archive. Size-limited rollups carry a manifest of content-named full-text pages, validated for total count and unique IDs before replacing the previous data.

All original post text and its account handle link to the source's numeric X status ID. Quoted sources carry their own IDs. Related matches, emerging samples, event timelines, extracted passages, and copied source reviews retain original URLs. An origin account whose historical post ID is unavailable has a profile link; the product never fabricates the missing post URL. Legacy incident timeline IDs are restored only when stored text and time uniquely match an archived post.

Counts distinguish accounts from roster members. The latter join explicit person/member IDs when available and otherwise normalized roster member names; unknown identities do not become invented people. Topic rows retain both account and member counts. Phrase adoption deduplicates official and campaign accounts and its threshold counts roster members. Core-message totals count each captured post once, even if it has multiple matching labels. Category breakdowns can overlap.

Phrases and Emerging explicitly describe all House posts in the last seven days; the filters above do not change those sections. Momentum describes observed captured/labelled activity for all House accounts in a rolling 24-hour window, not a forecast or an independently validated assessment.

News context comes only from the public news store. The dashboard distinguishes retrieved context from the supplied source IDs actually used by an accepted classifier result. Source links, publication dates, fetch times and later-publication flags remain visible. There is no read of the private inbox context file. Recent public headlines can be browsed independently of member posts.

The page refreshes every two minutes. The freshness label uses the last completed collection interval (`lastPollAt`), separately flags later incomplete attempts, and calls a capture older than 45 minutes stale. It never treats `lastPollSuccessAt` (one successful API response) as a completed interval. A failed refresh preserves the loaded data and displays an error. Filters, source disclosures and feed scroll position survive background refreshes; an open export remains stable, and edits are preserved when copied.

Hosted GitHub Pages reads the public repository's current main-branch data directly. This is necessary because scheduled workflow commits made with GITHUB_TOKEN do not automatically rebuild Pages. New UI code still requires a Pages build on initial deployment. Local previews use relative files.

Validation: source-ID and URL escaping, exact legacy source recovery, private-field exclusion, identity deduplication, complete archive pages, serialized refresh behavior, hosted/local routing, and drill-down contracts have unit coverage. Browser checks exercised pending-post filtering, original/quoted links, export source URLs, and incident copy with no nested button anchors.
