# Monitoring setup — September 8, 2026

The user resumed work to resolve credit, account verification and hosting. Continuous collection is still disabled; the earlier seven-hour development heartbeat remains paused.

## Completed in this pass

- Fixed official-site profile extraction for legacy HTTP/@ profile links and the known Drupal social-icon JSON configuration. Only exact X/Twitter hosts and enabled social settings qualify; no scripts are executed and no HTTP profile links are followed. Source URLs, raw page hashes, retrieval times and exact numeric X matches remain attached to evidence. Shared caucus organization profiles cannot establish individual ownership.
- Reprocessed the saved, still-current official pages without changing their retrieval times. This added 32 bindings, bringing the current total from 120 to 152. There are still three admitted posts, five captures, one authentic topic review and four captures awaiting identity evidence.
- Added a reusable access check that distinguishes successful usage access from verified prepaid dollars. Its live check at 17:07 UTC confirmed usage access while the documented credits endpoint still returned HTTP 404. No token replacement, paid post/profile request or balance fabrication occurred. Conservative paid accounting remains $3.025.
- Prepared a 30-minute systemd polling service/timer, with bounded pages and a nonzero exit for unfinished/blocked passes. Nothing was installed or enabled. The 202 Node tests and five account-evidence Python tests pass; the Linux units have not been executed.

## Remaining account work

Of 216 directory-mapped members: 152 have bindings, 46 have an office-linked handle missing from the saved numeric List profiles, 13 have no supported profile link in the page, two link only a shared organization account, one needs review of multiple links, one needs account-type review and one office page remains unavailable. One additional Clerk member has no eligible HTTPS directory mapping. These are evidence gaps, not a finding that those members have no X accounts.

The incomplete List scan is older than its one-hour resume window. Once billing is resolved, explicitly abandon the old scan and run a fresh bounded inventory; retain its observations and the entire spending ledger. A six-page, 100-profile-per-page plan reserves at most $6 at the configured $0.010/profile price. It may need another bounded pass if a cursor remains. Refresh the dated Clerk and office evidence and apply the matching numeric profiles. Campaign/personal identities still require corroboration; an official account does not prove another handle belongs to the member.

## Credit resolution

Preview: `node scripts/check-x-access.js`. Actual account-metadata check: `node scripts/check-x-access.js --execute`. The latter saves a sanitized private report at `data/operations/x-access-check.json`, records a valid prepaid observation only when returned, and exits 2 if credit or usage access is unavailable. Neither command retrieves posts or account profiles.

The configured URL matches [X's documented credits endpoint](https://docs.x.com/x-api/usage/get-usage-credits). The current empty 404 does not establish whether the account lacks an entitlement or the endpoint is unavailable for another reason. The owner has been asked for the current Developer Console prepaid balance and whether another app uses that wallet. A console-confirmed budget, if needed, must have its own provenance and explicit limits; it must not be relabeled as a successful API observation. No such override is implemented or activated. The current automated worker still requires a fresh API balance.

## Host and schedule

The concrete server proposal and acceptance steps are in [Private hosting](PRIVATE_HOSTING.md). There is no configured host connection, hosting CLI or SSH configuration in this workspace. The owner has been asked whether an existing hosting account is available. Provisioning, credentials and any new recurring charge remain unresolved.

The prepared timer runs at minutes 00 and 30 UTC, with up to 15 seconds of jitter. Its service requests at most ten pages of 25 posts: a maximum reservation of $1.25 per pass, reduced by the normal $25/day, $350/pilot and $50-reserve guards. It uses the stored checkpoint and page leases; systemd does not start another instance of the same active service. A blocked/incomplete pass exits nonzero for host monitoring. Timeout/interruption retains conservative request accounting.

Before enabling the timer, validate the unit files on the actual Linux host, complete a bounded successful collection/recovery test, and connect failed/stale-run monitoring to the real schedule. Arrange daily fresh Clerk/List/office evidence renewal before their 24-hour windows expire; this timer only collects posts and does not perform renewal. The current dashboard truthfully reports automatic collection as off. Wire its schedule status to actual host execution when enabling, rather than treating these templates as proof of a running service. Owner login, encrypted off-host recovery and reboot testing remain in the host acceptance sequence.

Only two immediate owner inputs are needed: the X billing details and the existing hosting provider (or confirmation there is none). Deployment and remaining verification implementation stay with development.
