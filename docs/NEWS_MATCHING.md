# News matching checks

Retrieval remains deterministic and lexical. Publication/acquisition dates,
publisher checks, exact matching terms and source excerpts remain available;
a returned item is evidence of what a source reported, not verified event
identity or a judgment that the article is correct.

The saved [Pardon Integrity Act quote](https://x.com/i/web/status/2099619115103035830)
reproduced a specific false match. Its complete CBS original contained
“Donald Trump.” Although `Trump` was already treated as common political
wording, `Donald` counted as distinctive. Ordinary connector words then linked
the post to unrelated Dallas convention coverage, a wedding story and a
pre-election agenda article.

Common national political actors' first names, surnames and office aliases
now receive the same nondistinctive treatment. Connector words such as `put`,
`end`, `role` and `efforts` cannot satisfy the separate subject check. A shared
name also cannot count twice as both actor and subject, including when the
query starts with that name.

For queries with at least three remaining subject terms, the chosen report
passage must share a distinctive name and a subject term. Matching those in
separate paragraphs cannot manufacture a supporting excerpt. If only the
headline meets both conditions, it remains a lead. Otherwise the item is
excluded. Short ambiguous references still retain competing leads for review.

The actual saved quote now retrieves none of those four unrelated items.
There is no current pardon report in the tested news snapshot, so a separate
synthetic Pardon Integrity Act report tests positive subject matching without
pretending such an article was acquired. Existing Dilley, Springfield,
North Carolina, hack, voting and contradictory-report tests still pass.

This addresses demonstrated retrieval errors; it is not an overall accuracy
estimate. Already accepted model interpretations are not rewritten by this
change. No NPR extraction rule was changed because the current stored
passages did not reproduce the suspected transcript disclaimer issue.
