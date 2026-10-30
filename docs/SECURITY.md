# Security boundary: synthetic localhost demo

This application is a **local-only prototype with named demo accounts**, not a production multi-user finance service. Do not deploy it on a public hostname, reverse proxy, shared office server, or internet-facing interface. Do not import real tenant, vendor, municipal, or bank records.

## Implemented controls

- **Network:** the ordinary server binds only to `127.0.0.1`, `::1`, or `localhost`; each request verifies its socket peer is loopback and its HTTP `Host` header is one of those local names. This limits DNS-rebinding attacks against the browser's local session. Invalid hosts receive HTTP 403 before issuing a session cookie.
- **Browser write boundary:** a session cookie is issued only after a valid local username/password login, and API requests require a valid non-expired session. Writes require JSON and reject mismatched `Origin` headers, including `null` origins. These controls reduce cross-site browser attacks but **are not user authentication**.
- **Data access:** the API never accepts a client-selected organization ID; every request resolves its organization and permissions from the authenticated user. All normal reads and writes are scoped to the deterministic synthetic demo organization. SQLite triggers additionally reject new or updated child references crossing organization boundaries, including property, external account, source row, obligation, payment, reconciliation run, match decision, exception, and resolution references.
- **Financial invariants:** SQLite prevents allocations from exceeding source payment or obligation amounts, or crossing property, organization, or currency boundaries. Uploaded CSV inputs have bounds and validation; raw evidence is retained separately from normalized fields.
- **Output handling:** content-security-policy and no-sniff response headers; no external model or payment connectors; no secrets required. Only synthetic screenshots and fixtures belong in this repository.

## Limitations and next gate

The browser cookie identifies a named local account through a revocable, expiring database session; this remains **local-only authentication, not production identity management**. Anyone with access to the same user account/browser or to local loopback endpoints may be able to use or reset the demo. The prototype lacks enterprise SSO/MFA, password recovery and user deactivation, hardened remote TLS session handling, multi-organization memberships, data encryption, safe backups, audit retention policy, and real-data validation. It also lacks a migration/backfill check for any pre-existing cross-tenant references: the new triggers protect subsequent writes.

Before any real-data pilot, implement actual user identity and role authorization, server-side organization membership checks on every endpoint, attachment authorization, migration auditing and incident response, scoped approvals, encryption and secure storage, and a deployment-specific threat model. Confirm legal and operational retention requirements. A finance reviewer should run shadow mode on an isolated, approved environment—not this public synthetic demo.

## Named local reviewer permissions

The home page no longer grants a privileged session. Passwords use random salts and scrypt; session tokens are stored hashed, expire after eight hours, and are revoked on logout. Server-side authorization distinguishes viewer (read), reviewer (matching and exception decisions), and administrator (imports, alias maintenance, reconciliation, user creation, and reset). The first administrator password is randomly generated and displayed only in the local terminal on the initial startup. See [AUTH.md](AUTH.md) for the permission matrix and explicit limitations.
