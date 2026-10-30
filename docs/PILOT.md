# Pilot plan — Cypress Harbor Housing (fictional)

## Five discovery questions

1. Which monthly source reports are authoritative for each property/account, and who owns their export format?
2. Which stable identifiers survive across systems? How are municipal accounts, property changes, and remittances recorded?
3. What evidence and reviewer sign-off are required before an obligation can be marked resolved?
4. What is the current review time per exception, and which mismatch types cause the most rework?
5. What retention, access, and audit requirements govern these reports and their attachments?

## Measurement and trial

Have one finance reviewer reconstruct a historical month in **shadow mode**, leaving the source systems untouched. Record the baseline workflow duration, unexplained discrepancies, unresolved aging, and misidentified property/payment pairs. During shadow mode, track import time, accepted/rejected matches, false matches, time to evidence review, duplicate-import behavior, and exceptions reopened by changed evidence.

## Success and stop criteria

Each exception must trace to frozen source snapshots and a versioned rule. Reviewer decisions persist across report periods. **Stop immediately** for an allocation to the wrong property/entity, an unexplained total change, irrecoverable evidence loss, or unauthorized cross-organization access. Require real authentication, access review, permissioned storage, and approved retention before bringing real data.

## Next scope

Prioritize reviewed identity mappings and the two CSV adapters over additional analytics. Buyer, pricing, demand, and time savings remain unverified hypotheses.
