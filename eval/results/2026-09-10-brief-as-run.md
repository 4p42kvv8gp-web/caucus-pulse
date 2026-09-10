# Post labeling task

You are labeling public posts by US House Democratic caucus members against a
fixed two-level topic taxonomy. This is a first-pass labeling job: for each
post you decide which topics it is about.

## What you may read

Only the files in this directory:

- `taxonomy.md` — the complete, closed taxonomy. 15 macro topics, 46 subtopics.
- `items.jsonl` — 823 items, one JSON object per line: `{"item_id", "text"}`.
- `schema.md` — the output format.
- `examples.jsonl` — seven worked output lines.

## What you must NOT do

- **Do not use web search, retrieval, or any external tool.** Judge from the
  post text and the taxonomy alone.
- **Do not open, clone, or search any code repository**, and do not try to
  identify where these posts came from.
- Do not compute statistics, summaries, agreement rates, or aggregate counts.
  Return only per-item labels. Aggregation happens elsewhere.
- If at any point you believe you have seen an existing labeling of these
  posts, **stop and say so in plain text instead of continuing.**

## How to work

Process **all 823 items**, in file order. There is **no per-turn or batch-size
limit**. Continue until every item is labeled; do not pause for continuation
prompts between batches. If internal batching is useful, choose any batch
size and keep each item's judgment independent across batches.

**Label each item independently.** Item order is shuffled. Items near each
other in the file are unrelated; two adjacent items about immigration are a
coincidence, not a theme. Never let one item's label influence the next.

Output one JSON line per item, in the order given, nothing else — no prose,
no markdown fences, no commentary between lines.

## The taxonomy rules

These are the rules the labeling is held to. Follow them exactly.

1. **Judge the post's substance, not incidental word matches.** The `(also: …)`
   aliases in `taxonomy.md` are hints about what a subtopic covers, not
   matching rules. A post that happens to contain the word "border" is not
   automatically border policy.

2. **Multi-label.** A post may carry several topics. Most posts get 1–2.
   **Never more than 4.**

3. **Assign the most specific level that fits.** Emit `[macro, subtopic]` when
   a subtopic genuinely applies; emit `[macro, null]` when the macro fits but
   no subtopic under it does.

4. **A subtopic assignment already counts toward its macro.** If you assign
   `["M07", "M07_S03"]`, do **not** also emit `["M07", null]`. Emit each pair
   at most once. Duplicate pairs are a protocol error.

5. **Before you emit `[macro, null]` for a macro, read that macro's full
   subtopic list once and confirm none of them fits.** Do not default to
   `null`.
   *(Some batches will be marked `NO-SWEEP` at the top of the turn. In those
   batches, ignore this rule 5 and label as you naturally would. This is
   deliberate; do not adjust anything else.)*

6. **`labels: []` has two distinct meanings and you must tell them apart.**
   - The post has **no policy content** — a greeting, a scheduling notice,
     an event photo caption, a bare link, a "happy birthday". Emit
     `"labels": [], "gap": null`.
   - The post has **real, coherent policy content that no macro in the
     taxonomy covers.** Emit `"labels": []` and set `"gap"` to a short
     kebab-case subject label.

   **`[macro, null]` is NOT a gap.** A gap means *no macro fits at all*. Worked
   examples: a post about a new rural broadband grant is `[["M15", null]]`,
   not a gap — technology is a macro. A post about farm bill payment schedules
   is `[]` with `gap: "agriculture-farm-policy"` — no macro covers agriculture.

7. **Saying "nothing fits" is a correct answer and is scored as correct.** Do
   not force a post into a category to avoid an empty set. When you do use
   `gap`, **use the most general noun phrase that covers the subject, and
   prefer a label you would plausibly reuse next week.** Reuse the identical
   gap string across items about the same subject — `agriculture-farmers`,
   `agriculture-farm-policy` and `agriculture-farming` for the same subject is
   a failure, not three findings.

8. Only keys that appear in `taxonomy.md` are valid inside `labels`. Never
   invent a key. If you want a category that does not exist, that is what
   `gap` is for.

9. **Include every `item_id` from `items.jsonl` exactly once**, in order. Do not
   merge, skip, reorder, or refuse.

## The `[]` boundary — worked cases

This boundary is where labelers disagree most, so it is pinned here.

- A member's condolence post about a shooting in her city **IS** a topic:
  `[["M13", "M13_S02"]]` (guns & public safety / gun violence). A member
  reacting to violence in her district is how that topic's volume is measured.
  Do not treat condolence framing as "no policy content".
- "Join me at the Springfield Labor Day parade, 10am Monday" — pure scheduling.
  `[]`, `gap: null`.
- "Proud to welcome the 4th grade class of Lincoln Elementary to the Capitol
  today!" — a visit photo with no policy substance. `[]`, `gap: null`.
- "My office helped 40 families get their VA benefits this month. Call us at
  …" — this **IS** constituent services (a macro). Not empty.
- "Happy 250th birthday, America." — `[]`, `gap: null`, unless it argues
  something.
- A bare `https://t.co/xxxx` with no other words — `[]`, `gap: null`,
  `unreadable: "no-text"`.
- A post arguing that a federal agency is defying a court order **IS**
  democracy/rule-of-law content even if no bill is named.

When you genuinely cannot decide, set `confidence: "low"` — do not resolve it
by defaulting to `[]`.

## Uncertainty — two separate fields, both load-bearing

- **`confidence`** — how sure you are of *your own* label set.
  `high` = you would defend every pair. `medium` = the macro is clear, a
  subtopic or a second macro is arguable. `low` = a coin flip, or the text is
  too thin.

- **`basis`** — `"clear"` or `"debatable"`. Set `"debatable"` whenever you
  considered and rejected an alternative that a careful reader could defend,
  and list what you rejected in `alternatives`.

  **`debatable` is not an admission of weakness. It is a data field this task
  needs.** A run where nothing is marked debatable is less useful than one
  where 20% is. It is how legitimate judgement differences are separated from
  errors.

- **`alternatives`** — **at most 2 entries**, each a full pair (`["M07", null]`
  or `["M07", "M07_S02"]`), listing label pairs you did **not** assign but that
  a reasonable labeler could have. A bare macro here vouches only for
  `[macro, null]`, not for any subtopic under it.

  **Do not pad this field.** It is capped at 2 deliberately: an unbounded
  "everything I could imagine" list makes every possible label defensible and
  destroys the measurement. List a near-miss only if you actually weighed it.

## Truncation and language

- Many items end in `…` because the source text was cut off mid-sentence.
  **Label from what is visible and set `unreadable: "truncated"`. Do not
  refuse and do not return an empty set purely because the text is cut off.**
- Some items are not in English. **Non-English is not unreadable.** Judge
  Spanish, Catalan, and other languages on their content and set
  `unreadable: "not-english"` as a flag only.
- `unreadable` values: `null`, `"truncated"`, `"no-text"`, `"not-english"`.
  Always still emit your best `labels`, even when it is `[]`.

## Output schema

One line per item:

```json
{"item_id":"E0142",
 "labels":[["M07","M07_S03"],["M10",null]],
 "confidence":"high",
 "basis":"debatable",
 "alternatives":[["M01",null]],
 "gap":null,
 "unreadable":null,
 "note":"Grocery costs plus premiums; health care is secondary."}
```

Field rules:
- `labels` — array of `[macro_key, subtopic_key_or_null]` pairs. 0 to 4 pairs.
  Keys are the ids left of the colon in `taxonomy.md` (`"M07"`, `"M07_S03"`),
  never the human labels.
- `confidence` — `"high"` | `"medium"` | `"low"`.
- `basis` — `"clear"` | `"debatable"`.
- `alternatives` — array of 0–2 pairs. `[]` when there are none.
- `gap` — `null`, or a kebab-case string. When non-null, `labels` must be `[]`.
- `unreadable` — `null` | `"truncated"` | `"no-text"` | `"not-english"`.
- `note` — ≤ 25 words, plain English. Never include numbers longer than 6
  digits and never quote a taxonomy key that is not in `taxonomy.md`.

## What to hand back

One file, `verdicts.jsonl` — 823 lines, one object per item, schema above.
Nothing else. No summary, no statistics, no analysis.
