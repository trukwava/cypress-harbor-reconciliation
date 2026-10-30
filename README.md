# Cypress Harbor · Cross-System Reconciliation

A **local, synthetic financial-operations demo** for a fictional affordable-housing operator. Import obligation and payment CSV reports, identify conflicts without modifying a ledger, review evidence-linked exceptions, record decisions, and export an auditable reconciliation pack.

This project is an original implementation inspired by the workflow described in the [Pursuit AssetFlow Lookbook](https://lookbook.pursuit.org/projects/assetflow). It does **not** reuse AssetFlow's code, real customer data, branding, or proprietary documents. Any reference claims belong to their original source and are not validation of this demo.

## Run locally

Requires **Node.js 22.16+** and npm. No external service credentials, Docker, or paid API is needed.

```bash
npm install
npm test
npm start
```

Open **http://127.0.0.1:4173**. The first run creates `data/reconciliation.sqlite` and loads deterministic fixtures. The server intentionally binds to loopback only. Set `PORT` to use another local port; see `.env.example` (environment variables are read by Node; the example file is not automatically loaded). To rebuild after source edits, run `npm run build` or `npm run dev`.

## Workflow

1. **Exception queue:** Review the outstanding, partial, unmatched, stale, and identity-related issues. Open an exception to inspect its original source rows, normalized values, allocation evidence, and rule version. Assign a reviewer, annotate, request information, or mark reviewed.
2. **Match review:** Inspect proposed invoice/property matches. Accept or reject a candidate with rationale. Acceptance records a bounded allocation; it does not edit the source report or initiate a payment.
3. **Source imports:** Preview obligation and payment CSVs separately before committing. Inspect parser errors and unresolved mappings. Report date and source system are required. Duplicate records are idempotent; corrected records enter review rather than silently overwriting an earlier source.
4. **Property registry:** Inspect canonical property IDs, entity affiliations, account references, and reviewed aliases. A fuzzy address alone never resolves a property automatically.
5. **Runs & exports:** Reconcile again after decisions, select historical runs, and download a JSON reconciliation pack with frozen source evidence, reconciliation basis, rule version, and unresolved totals.

Synthetic data includes **12 properties, 3 entities, 40 obligations, 35 payments**, one deliberately ambiguous address, invoice **101** on two distinct properties, partial allocations, a credit, and a stale source. For the $1,000 obligation with a $600 payment, the explanatory remainder is $400—**not** a second $1,000 debt.

Sample CSVs are under `fixtures/`. Report format descriptions and pilot notes are in `docs/`.

## What the demo does not do

It cannot authenticate real users, connect to a bank, pay bills, update accounting ledgers, verify a debt, or certify compliance. Session handling is designed only for a **single-user localhost demonstration**; it is **not** suitable for deployment to the public internet. Use synthetic data only. The reconciliation runs are advisory, not an accounting system of record.

## Validation

```bash
npm test
```

The suite includes allocation and property/organization boundary tests, CSV malformed-input handling, duplicate imports, correction review, reopen conditions, historical pack consistency, HTTP source access controls, and reload persistence. At publication preparation, **14 tests passed locally** on Node 22.16; check current CI or rerun them rather than assuming future revisions inherit that result.

## Design decisions

- **Node HTTP + TypeScript + SQLite** keeps the local demo transparent and credential-free.
- Source rows and immutable reconciliation snapshots preserve provenance even when reviewed corrections are applied.
- Integer minor units prevent floating-point money arithmetic; database triggers enforce allocation limits and same-property/currency boundaries.
- All matching is deterministic. A weak identifier is a proposal, not an authorization.
- The API is scoped to the synthetic demo organization, with a session cookie, origin checks on writes, a JSON request-size bound, and explicit constraints. Production requires a full authorization model, CSRF threat review, migrations, and separate operational controls.

## Data storage and reset

The SQLite database persists to `data/reconciliation.sqlite` by default. The **Reset demo** action replaces only the demo tenant's records with the original fixtures. Reset is destructive for demo decisions. Download an export beforehand if you want to preserve a run. The app does not automatically delete the local SQLite database; delete the `data/` directory manually when the server is stopped if you want a clean local removal.

## Status

- [x] Source-preserving CSV import preview and commit
- [x] Canonical registry with reviewed aliases
- [x] Deterministic match suggestions and constrained allocations
- [x] Reconciliation runs and exception-review queue
- [x] Frozen historical evidence and JSON export
- [x] Deterministic demo fixtures and automated tests
- [ ] Real authentication, organization role separation, and production threat model
- [ ] Institutional connectors, approvals, and compliance review
- [ ] Finance-reviewer shadow pilot with actual (authorized) records

See [docs/PILOT.md](docs/PILOT.md) for a safe next-stage validation plan.
