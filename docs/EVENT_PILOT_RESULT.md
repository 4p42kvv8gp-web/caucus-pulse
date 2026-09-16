# Fixed event pilot: September 14, 2026

Two live requests reviewed 11 selected public posts at 19:56:55 UTC. Both model answers were saved before validation. The initial job rejected the provider envelope because it contained thinking metadata alongside its JSON answer. A compatibility fix reads only the single text answer; replaying the saved responses passes validation without another API call. The raw responses and original rejection decisions remain retained.

## Selected-case results

The first answer grouped exactly the four expected members into a Johnson/AI-oversight event: [Ted Lieu](https://x.com/i/web/status/2099486798074257742), [Greg Casar](https://x.com/i/web/status/2099487281677554158), [Daniel Goldman](https://x.com/i/web/status/2099508362484302050) and [Mike Thompson](https://x.com/i/web/status/2099515039484960898). All returned supporting passages match their own source posts exactly. Casar's satire is connected to AI safety by his quoted Politico post; his isolated satire alone would be insufficient context. These are four distinct roster members, so the rolling 24-hour three-member threshold is met.

The unrelated Hugging Face hack and generic AI post stayed outside the event. The link-only statement that Congress should step up remained unresolved.

The second answer separated the voting-court, impeachment-announcement and oil-stock-allegation posts into three single-member events. It did not merge them merely because they mentioned overlapping political actors. The incomplete Garcia repost remained unresolved and contributed to no event threshold.

## Unresolved-reference acceptance check

An offline counterexample exposed a validator gap: an answer could mark a post unresolved while also counting it in an event. A copy of the saved Johnson answer substituted [Lieu's generic "Congress should step up" post](https://x.com/i/web/status/2099512150737719793) alongside Casar and Goldman. Despite retaining Lieu's `needs_context: true` and unresolved status, the earlier validator accepted the exact quoted sentence and counted three distinct members. The original saved answer did not make this mistake.

Validator version 3 rejects event membership for any unresolved post or assignment needing context. Uncertainty is per post in the current schema, so none of that post's event memberships can be accepted until the reference is resolved. Offline tests preserve both original answers as passing controls and reject this counterexample without changing saved responses, receipts, attempt counts, or source material. This closes a threshold loophole; it does not measure general event accuracy or resolve the wording issues below.

## Wording that still needs review

- The Johnson action describes the group as criticizing and demanding hearings or session changes. Casar clearly criticizes, but does not explicitly make those demands. A safer shared label is **House Democrats criticize Johnson's approach to AI oversight**; specific demands should be attributed to the members who made them.
- The court-event title should say **Jeffries reports court block on mail-in voting restrictions**. The provided evidence establishes his statement, not independent verification of the ruling.
- Jacobs's action description strengthens her conditional speculation into avoiding an end to the Iran war. Keep her allegation attributed and preserve the conditional wording. Her post does not independently establish the financial claim or motive.

## Decision

Source membership and separation pass these two selected probes. Root and an independent Codex reviewer compared the actual answers against the saved source inputs; this is not staff validation. The wording issues show why exact IDs and literal passages alone cannot establish interpretive accuracy. Keep the results provisional and outside the dashboard while expanding evaluation across additional events, ambiguous references, reposts and unrelated controls. No general precision, recall, prediction or operational detection-rate estimate follows from this pilot.
