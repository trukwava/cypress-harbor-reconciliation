# Cypress Harbor · Cross-System Reconciliation

A **local, synthetic financial-operations demo** for a fictional affordable-housing operator. Import obligation and payment CSV reports, identify conflicts without modifying a ledger, review evidence-linked exceptions, record decisions, and export an auditable reconciliation pack.

This is an original implementation of a cross-system reconciliation workflow. It does **not** reuse third-party code, real customer data, branding or proprietary documents. All examples are synthetic; no external performance claims are presented as validation of the demo.

## Run locally

Requires **Node.js 22.16+** and npm. No external service credentials, Docker, or paid API is needed.

```bash
npm install
npm test
npm start
```

Open **http://127.0.0.1:4173**. The first run creates `data/reconciliation.sqlite`, loads deterministic fixtures, and provisions `demo-admin`. A unique initial password appears **once** in the local terminal. Sign in with that username and password; subsequent restarts do not print the password. The server intentionally binds to loopback only. Set `PORT` to use another local port; see `.env.example` (environment variables are read by Node; the example file is not automatically loaded). To rebuild after source edits, run `npm run build` or `npm run dev`.

## Workflow

1. **Exception queue:** Review the outstanding, partial, unmatched, stale, and identity-related issues. Open an exception to inspect its original source rows, normalized values, allocation evidence, and rule version. Assign a reviewer, annotate, request information, or mark reviewed.
2. **Match review:** Inspect proposed invoice/property matches. Accept or reject a candidate with rationale. Acceptance records a bounded allocation; it does not edit the source report or initiate a payment.
3. **Source imports:** Preview obligation and payment CSVs separately before committing. Inspect parser errors and unresolved mappings. Report date and source system are required. Duplicate records are idempotent; corrected records enter review rather than silently overwriting an earlier source.
4. **Property registry:** Inspect canonical property IDs, entity affiliations, account references, and reviewed aliases. A fuzzy address alone never resolves a property automatically.
5. **Runs & exports:** Reconcile again after decisions, select historical runs, and download a JSON reconciliation pack with frozen source evidence, reconciliation basis, rule version, and unresolved totals. Export the exception queue for any run as spreadsheet-safe UTF-8 CSV; that is a summary, not a substitute for the full evidence pack.

Synthetic data includes **12 properties, 3 entities, 40 obligations, 35 payments**, one deliberately ambiguous address, invoice **101** on two distinct properties, partial allocations, a credit, and a stale source. For the $1,000 obligation with a $600 payment, the explanatory remainder is $400—**not** a second $1,000 debt.

Sample CSVs are under `fixtures/`. Report format descriptions and pilot notes are in `docs/`.

## What the demo does not do

It cannot authenticate users through a production identity provider, connect to a bank, pay bills, update accounting ledgers, verify a debt, or certify compliance. Named local accounts and roles exist for demo validation, but production SSO/MFA and secure deployment are not implemented; it is **not** suitable for deployment to the public internet. Use synthetic data only. The reconciliation runs are advisory, not an accounting system of record.

## Validation

The GitHub CI workflow runs both the Node regression suite and a **Chromium end-to-end smoke test** for the real login, reviewer, import, export, and historical-run screens. See [docs/TESTING.md](docs/TESTING.md) for how to run it locally and what the test proves.


```bash
npm test
```

The suite includes allocation and property/organization boundary tests, CSV malformed-input handling, duplicate imports, correction review, reopen conditions, historical pack consistency, HTTP source access controls, and reload persistence. On October 30, 2026, **17 tests passed locally** on Node 22.16; check current CI or rerun them rather than assuming future revisions inherit that result.

## Design decisions

- **Node HTTP + TypeScript + SQLite** keeps the local demo transparent and credential-free.
- Source rows and immutable reconciliation snapshots preserve provenance even when reviewed corrections are applied.
- Integer minor units prevent floating-point money arithmetic; database triggers enforce allocation limits and same-property/currency boundaries.
- All matching is deterministic. A weak identifier is a proposal, not an authorization.
- API requests resolve their organization and role from a named, locally authenticated account with a revocable eight-hour session cookie. All writes retain origin checks, JSON size bounds and database-level tenant constraints. Production requires a full authorization model, CSRF threat review, migrations, and separate operational controls.

## Data storage and reset

The SQLite database persists to `data/reconciliation.sqlite` by default. The **Reset demo** action replaces only the demo tenant's financial records with the original fixtures, retaining local accounts and sessions. Reset is destructive for demo decisions. Download an export beforehand if you want to preserve a run. The app does not automatically delete the local SQLite database; delete the `data/` directory manually when the server is stopped if you want a clean local removal.

## Status

- [x] Source-preserving CSV import preview and commit
- [x] Canonical registry with reviewed aliases
- [x] Deterministic match suggestions and constrained allocations
- [x] Reconciliation runs and exception-review queue
- [x] Frozen historical evidence and JSON export
- [x] Deterministic demo fixtures and automated tests
- [x] Named local users, scoped sessions, three role levels, and regression tests
- [ ] Production identity (SSO, MFA and recovery), multi-organization memberships, and full threat model
- [ ] Institutional connectors, approvals, and compliance review
- [ ] Finance-reviewer shadow pilot with actual (authorized) records

See [docs/AUTH.md](docs/AUTH.md) for local account setup and the permission matrix and [docs/SECURITY.md](docs/SECURITY.md) for the explicit local-demo security boundary and [docs/PILOT.md](docs/PILOT.md) for a safe next-stage validation plan.
