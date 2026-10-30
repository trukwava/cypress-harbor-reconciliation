# Named local accounts and role-based authorization

Cypress Harbor remains a **synthetic localhost-only demo**, not production identity management.

## First start

```bash
npm install
npm test
npm start
```

On a brand-new SQLite database, the server creates `demo-admin` and prints a cryptographically generated password **once** in the terminal. Sign in at http://127.0.0.1:4173 using this account. Restarts preserve the salted hash; the original password is **not shown again**. Store it in your local password manager, and do not share or commit terminal logs containing it.

The administrator can select **Users** in the interface to create additional named local accounts. Passwords must be at least 12 characters. To recover a lost administrator password in this synthetic-only demo, export any evidence you want to retain, stop the server, delete the local database in `data/`, and restart; this irreversibly removes local decisions, users, and sessions.

## Permissions

| Operation | Viewer | Reviewer | Administrator |
| --- | --- | --- | --- |
| View scoped queue, evidence, reports, exports | Yes | Yes | Yes |
| Preview CSV | No | Yes | Yes |
| Decide match and review exception | No | Yes | Yes |
| Commit import, approve corrected report, add alias, reconcile | No | No | Yes |
| Create users and reset demo records | No | No | Yes |

Every request derives the user, role, and organization from the server-side session. A client cannot select another organization. Audit entries for reviewer dispositions identify the named account.

## Security behavior and exclusions

Password storage uses random salts and Node scrypt. The browser receives a random 256-bit session token in a HttpOnly, SameSite=Strict cookie scoped to `/api`; SQLite stores its SHA-256 digest. Sessions expire in eight hours and logout revokes the active token. Login failures are throttled locally.

This demonstration lacks MFA, external identity/SSO, password recovery and account-disable UI, credential rotation, secure deployment/TLS design, centralized throttling, production-grade logging, encryption and backup/retention policy, fine-grained per-record entitlements, and multi-organization memberships. Do **not** place the app on an internet-facing server or import real records. A formal security and access review is required before a pilot with authorized customer data.
