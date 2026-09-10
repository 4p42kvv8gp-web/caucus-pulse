# The dashboard cannot see a story it has no category for

*Measured 2026-09-10 against the 2026-08-20 … 2026-09-09 corpus (10,476 classified posts).*

## The question

Topics are ranked by post count, and post count is dominated by standing message
discipline. Affordability, healthcare and corruption run every day because the
caucus runs them every day on purpose. So the ranking is close to static, and the
worry is that something genuinely new — the thing you would actually want to know
about at 7am — sits below the drumbeat until it has stopped being news.

That worry is correct, but the mechanism is worse than ranking.

## What the corpus shows

On 8–9 September the caucus responded to the retirement of Smithsonian Secretary
Lonnie G. Bunch III. **Twenty original posts** across two days, from many
different members.

Here is where the classifier put them:

| posts | label |
|---|---|
| 7 | *(nothing — empty label)* |
| 4 | `democracy` |
| 3 | `civil-rights` |
| 2 | `civil-rights + democracy` |
| 1 | `democracy/executive-overreach` |
| 1 | `democracy/executive-overreach + civil-rights/racial-justice` |
| 1 | `civil-rights/racial-justice` |
| 1 | `democracy + democracy` |

**Eight different buckets. Seven posts labelled as nothing at all.**

For scale: the median subtopic in the whole taxonomy carries 18 posts over the
full 21 days, and 25 of the 45 live subtopics carry fewer than 20. This one story
in two days outweighs more than half the categories the dashboard is willing to
name — and appears nowhere as itself. Its posts are scattered as a few extra
counts on `democracy` and `civil-rights`, two of the largest macros, where they
are invisible.

This is not a ranking problem that a different sort order fixes. **A good taxonomy
actively hides new stories**, because the classifier's job is to fit each post
into an existing category, and it succeeds. The better the taxonomy, the more
completely a new story dissolves into it.

Gloria Steinem's death on 3 September shows the same shape at smaller scale,
split between `civil-rights` and `civil-rights + reproductive-rights`.

## What did not work

The obvious fix is to look at wording instead of categories: find posts unlike
anything the caucus has said recently. The embedding index that landed in night
wave 3 makes this cheap and needs no Anthropic credit.

Two measures, both computed against the committed index:

- **novelty** — a post's highest cosine similarity to any post in the prior 7 days.
- **echo** — distinct *other* members posting something close to it within 24h.

**Novelty alone ranks oddity, not importance.** The three most novel posts on
9 September were a celebrity tribute, a medal presentation and an in-joke. No
other member touched any of them.

**Novelty combined with echo did not survive a careful implementation.** An early
probe looked promising, but it computed the baseline over whole prior days,
which excluded same-day posts and so scored every post in a spreading story as
novel — inflating both halves of the metric. With a correct rolling window (a
post is novel only against what came *before it*), 34 posts on 8 September clear
the novelty bar and **not one** reaches three echoing members at the 0.72
similarity threshold. Loosening to 0.60 over 48 hours produces 8–22 "echoes" for
things like a local hazmat alert, which is plainly noise.

So the thresholds do not transfer, and the metric is uncalibrated. The module was
written and tested and then **deliberately not committed**, rather than adding
another unwired subsystem to the repo.

## The better candidate

The evidence above suggests the signal directly. The Bunch story is not detectable
as *novel wording*; it is detectable as **cohesive wording with incoherent labels**.

Cluster posts by embedding similarity — the semantic layer already does this — and
then measure the entropy of the classifier labels within each cluster. A tight
cluster whose members land in eight different buckets, seven of them empty, is a
story the taxonomy is failing to hold. That is a direct measurement of the failure
mode, not a proxy for it.

It has three things going for it:

1. It would have caught this case, by construction — the scatter *is* the signal.
2. It needs no Anthropic credit; both inputs are already on disk.
3. It has a natural threshold with a meaning: cluster cohesion above the
   `semantic.min_sim` floor already calibrated at 0.8, and label entropy above
   what a genuinely multi-topic post population would produce.

The obvious failure mode to test for is the reverse case: a cluster that is
*supposed* to span macros. A post about ICE raids at a workplace legitimately
carries both `immigration` and `labor`, and a cluster of those would show high
entropy without being a missed story. The empty-label share is probably what
separates them — a real story the taxonomy cannot hold produces *unlabelled*
posts, not multi-labelled ones. Seven of twenty here.

## What this does not tell you

The measurement is 21 days on one List. Two anecdotes, one strong and one weak,
are the whole evidence base for the failure mode, and both happen to be tributes
to a public figure — which may be the easiest case rather than a representative
one. Whether a policy fight or a district emergency dissolves the same way is
untested.

Before building the detector, the thing worth doing is the blind classifier
evaluation (`eval/`), which samples across the corpus and will say how often the
classifier leaves posts unlabelled and how consistent its bucketing is. That
measurement should come first: it is the denominator this whole argument is
missing.
