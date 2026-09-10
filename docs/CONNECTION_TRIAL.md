# Bounded X connection trial

The September 8 connection trial verified that the supplied active bearer can access the usage endpoint, List profiles and List posts. The documented `/2/usage/credits` endpoint returned HTTP 404. Usage counts do not establish remaining dollar credit, so the normal collector still requires a verified balance. [Credits endpoint](https://docs.x.com/x-api/usage/get-usage-credits), [usage endpoint](https://docs.x.com/x-api/usage/get-usage)

The explicit fallback is a one-time, expiring **$3.025 lifetime ceiling across the entire existing request ledger**, not a new daily allowance. Existing spending and uncertain reservations count against it. A known low balance, accounting fault, authentication error or non-404 credits error blocks the fallback. No scheduler, credit purchase or automatic top-up starts.

## Observed result

- Three List pages captured 300 account profiles. A continuation cursor remains; the scan is incomplete and was not promoted to a complete List inventory.
- One List-post page captured five recent posts. It succeeded with the `tweet` field dialect. First-page initialization does not establish historical completeness or coverage between earlier checkpoints.
- Four paid source requests recorded $3.025 in conservative local accounting: 300 user resources at $0.01 and five post resources at $0.005. Provider billing was not independently verified. There were no uncertain requests or accounting faults in this trial.
- The trial ceiling is now exhausted. Normal polling remains off. Four captured posts await stronger account evidence; one was admitted after the official-link and numeric-profile check.

Private observations live under `data/operations/`. They contain access/coverage metadata, not credentials. The active bearer is stored separately with owner-only permissions and is never returned in dashboard or status responses.

## Commands

The command previews by default, without a token read or network request:

```sh
node scripts/connection-trial.js inventory EXPIRY_ISO
node scripts/connection-trial.js posts EXPIRY_ISO
```

An expiry must be no more than seven hours ahead. `--execute` makes the explicitly bounded requests only if the ledger has enough remaining allowance. Reissuing the command cannot reset the ceiling. The normal worker remains a separate operation with its original balance and reserve guards.

The trial is evidence that the adapters work with this account, not evidence of complete caucus coverage, a full archive, a verified prepaid balance, or a working automatic polling schedule.
