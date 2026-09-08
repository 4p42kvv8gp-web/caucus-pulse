# Account identity from public source evidence

An X List entry is an observed account, not proof that a current House Democratic member owns it. The verification path joins three separate observations:

1. The dated [House Clerk roster](https://clerk.house.gov/xml/lists/MemberData.xml) supplies membership, Bioguide ID and district.
2. The [House directory](https://www.house.gov/representatives) links that occupied district and matching surname to an office website. The public fetcher extracts X profile anchors and enabled social-icon settings from that website.
3. A previously captured List profile supplies the exact handle and numeric X author ID. Matching a display name alone is insufficient.

The fetcher uses only public HTTPS House pages, with four concurrent requests, redirect restrictions, time limits and a 3 MB page ceiling. It saves the source URL, final URL, actual retrieval time, hash and raw HTML locally. It does not call X, log in, follow page instructions, or infer ownership from failed pages.

```sh
python3 scripts/fetch-account-evidence.py --limit 25
node scripts/verify-account-evidence.js data/reference/identity/account-evidence-TIMESTAMP.json
node scripts/verify-account-evidence.js data/reference/identity/account-evidence-TIMESTAMP.json --apply
```

The second command validates a preview without writing bindings. The third imports unambiguous matches and attempts to promote captured posts. These are local administrative commands; evidence reports are trusted local artifacts produced by the fetcher, not cryptographically signed ownership certificates. Hash checks detect mismatched source artifacts, not an adversarial rewrite of an entire local proof package.

Missing/multiple profile links, a handle not yet observed numerically, a campaign/personal account type requiring review, conflicting IDs and overlapping ownership conflicts remain unresolved. A profile with an office-style name linked from one matched office page is treated as the current official account. Campaign accounts need a separate reviewed evidence path. Pages available only through an unsupported URL are recorded as unmapped rather than silently guessed.

## Dates and renewal

Bindings explicitly use a limited current-observation window, with no more than 24 hours of retrospective operational inference and an expiry bounded by the Clerk, office-page and X-profile observations. This does not establish years of historical ownership. The source post carries that limitation. Fresh corroborating evidence appends adjacent uncovered intervals; it does not rewrite an older binding or its proof. Conflicting owners require review.

Once admitted, a post retains its specific member identity, district, roster snapshot and account-binding ID. Later account changes cannot silently relabel its history. Source capture and rejected identity checks remain separate from the member archive.

## September 8 observation

The 217-name Clerk snapshot and official directory yielded 216 eligible HTTPS mappings. Of 216 office-page attempts, 215 succeeded. Combined with the incomplete 300-profile List observation, 120 current official-account bindings were established. One newly captured post was admitted; four captures remained unresolved. These counts are separate from full List coverage and do not imply that every member's official, campaign and personal accounts have been verified.

## Link parsing correction at 17:00 UTC

Policy `house-directory-office-link-v2` also recognizes legacy HTTP and @-prefixed profile links, plus enabled entries in the known Drupal social-icon JSON configuration. It never follows those HTTP URLs or executes scripts. It retains the observed value and source kind separately from the canonical HTTPS profile. Arbitrary script strings, unsupported hosts/ports, disabled settings and shared organization profiles do not establish individual ownership.

Reprocessing the existing fresh official pages added 32 bindings, bringing the active count to 152. Original source retrieval times and historical bindings were preserved. Full List and campaign/personal coverage remain incomplete. See [Monitoring setup](MONITORING_SETUP.md) for the remaining gaps.
