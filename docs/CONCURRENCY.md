# Competing reviewer decisions

Cypress Harbor is a local-only synthetic reconciliation demo. It is not a distributed payment processor.

## Transaction and accounting guarantees

- Each match decision starts a SQLite `BEGIN IMMEDIATE` transaction. Across independent SQLite connections, only one writer may hold that transaction at a time.
- A candidate must still be **proposed**, belong to the latest run, and match the current source-evidence fingerprint.
- An accepted proposal creates an allocation, updates the candidate's decision using a conditional status update, and records its decision and audit event **within the same transaction**. Failure rolls these changes back.
- Database triggers prevent cross-organization, cross-property, cross-currency, over-payment, and over-obligation allocations. Duplicate allocations on the same payment/obligation pair are additionally restricted by a unique key.
- When a separate SQLite writer holds the lock for too long, the API returns HTTP **409** with guidance to refresh and retry. It must never convert such contention into an unexplained 500 or partially commit an allocation.

## Automated coverage

The Node suite tests competing connections with an intentionally held writer lock, then submits two genuinely simultaneous match decisions from separate Node worker threads using independent SQLite connections. An HTTP integration case submits the same proposal from two signed-in reviewer/admin sessions. Exactly one decision may succeed; the other must receive a conflict. All cases verify a single allocation, a single decision, and a single audit event.

This is a specific contention and double-allocation regression, not a substitute for a distributed, high-load financial-system audit. SQLite's five-second busy timeout is appropriate for the demo but should be reviewed in any multi-process deployment. Reviewer exception notes are not versioned yet, so simultaneous edits to an exception's narrative still require a separate optimistic-concurrency safeguard.
