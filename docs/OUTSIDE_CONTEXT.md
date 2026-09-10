# Outside context for story candidates

`data/context.json` attaches a few newsletter hits from the owner's briefing
inbox to each story candidate in `data/stories.json`, so the Emerging panel
can show what the outside world was saying while the caucus was posting. It
is **unreviewed context, not verification**: a hit means a newsletter in the
window contained the candidate's keywords, nothing more.

## Source

- Gmail account `tobriefornottobrief@gmail.com` — the owner's newsletter
  inbox: Bloomberg briefings, NYT (The Morning / The Evening / Today's
  Headlines / breaking alerts / N.Y. and California Today), Politico and
  Politico Pro dailies and alerts, Axios, White House pool reports and press
  releases, plus Semafor, Punchbowl and Puck.
- Read-only access. The search pass only calls `search_threads`; nothing is
  labelled, sent, forwarded or deleted, and no thread body is fetched.

## How a candidate is searched

1. Candidates: the top 25 in `data/stories.json` whose placement is a
   `story` or a `gap` (by posts). Noise and unplaced candidates are skipped.
2. Queries: 2–3 per candidate, derived from `placement.label`,
   `placement.aliases` and the sample post. Unquoted keywords first, a
   `subject:(…)` variant when the bare keywords only return generic body
   hits, proper nouns as-is. `searched` in the file lists exactly what ran.
3. Window: `firstSeen − 2 days` through `lastSeen + 1 day`, as Gmail
   `after:`/`before:` (before is exclusive, so it is written as
   `lastSeen + 2`). Hits outside the window are dropped even when relevant;
   the `note` field says so when that happened.
4. Keep: up to 5 messages per candidate, in relevance order — subject-level
   matches first, then preheader/snippet matches, then body-only matches
   whose query was specific enough (a name, a place) to trust. Generic
   newsletter hits ("Delivered daily by 6 am…") with no visible link to the
   subject are skipped. `why` is one clause explaining the link and is
   honest about weak matches ("body mention").
5. Nothing matched: the entry keeps its `searched` list, an empty `matches`
   array and a `note` explaining why (too generic, no coverage, word-count
   false positives for `988`, …).

## File shape

```json
{
  "generatedAt": "2026-09-10T…Z",
  "account": "tobriefornottobrief@gmail.com",
  "stories": {
    "<candidate key from stories.json>": {
      "key": "<placement key>", "label": "<placement label>", "kind": "story|gap",
      "window": ["YYYY/MM/DD", "YYYY/MM/DD"],
      "searched": ["<gmail query>", …],
      "matches": [{ "sender", "from", "subject", "date", "snippet", "threadId", "why" }, …],
      "note": "<optional: why nothing / what was excluded>"
    }
  }
}
```

`sender` is the publication (Bloomberg, NYT, Politico Pro alert, White House
pool…); `from` is the raw address. `snippet` is the Gmail preview text,
capped at 200 characters. `threadId` lets the owner open the thread.

## How the dashboard uses it

`src/sitedata.js` → `contextKeyFor(cluster, context.stories)` matches an
Emerging cluster to an entry by candidate key, placement key or label
(slug-normalised, so a re-keyed placement still finds its context) and
attaches the top 3 matches as `cluster.context`. `site/index.html` renders
them under the cluster card as a compact **In the news** list
(sender · subject · date; hover for `why`). Clusters with no entry render
nothing extra.

## Limits

- **No article bodies.** Only the subject line and Gmail's preview snippet
  are stored; the newsletter itself is not read, so a hit can be a passing
  mention in a 2,000-word briefing.
- **Newsletter snippets only.** The inbox is a curated set of briefings, not
  a news search. A story the caucus is loud about can be absent simply
  because no subscribed newsletter led with it that day.
- **Dated.** The file is a snapshot (`generatedAt`) over each candidate's
  window at the time it was built. It is not rebuilt by the poll or nightly
  jobs; rerun the search pass when `stories.json` changes materially.
- **Unreviewed.** Keyword matching against preview text, judged by one pass
  and never checked against the full message. Treat a match as "worth
  opening", not as confirmation that the newsletter covered the story.
