# Backup, verification, and safe restore

Cypress Harbor is a **synthetic, localhost-only demonstration**. The SQLite database stores original imported source CSVs, finance-review decisions, named local users, password hashes, and session records. Treat every backup as sensitive, even when all source data is synthetic. Do not commit backups to this public repository or upload them to bug reports.

## Backup a running demo

First build the TypeScript application (`npm install && npm run build`). From the repository root:

```bash
node dist/src/backup.js backup data/reconciliation.sqlite ../cypress-harbor-backups/backup-2026-11-02.sqlite
node dist/src/backup.js verify ../cypress-harbor-backups/backup-2026-11-02.sqlite
```

The backup command uses SQLite `VACUUM INTO` to generate a consistent snapshot from a live WAL-mode database. It **does not** simply copy the active `.sqlite` file, which could omit uncheckpointed transactions. It creates the destination with restrictive permissions and writes an adjacent `.manifest.json` containing the snapshot's SHA-256 digest, byte size, and verification counts. Both outputs are created without replacing existing files.

Every backup is validated before publication. Validation checks SQLite `integrity_check` and `foreign_key_check`, all saved source CSV digests, all frozen-run snapshot digests, and allocations against payment, obligation, organization, property, and currency constraints.

**Important:** The manifest and its SHA-256 value detect accidental changes; they are not a digital signature or independent attestation. A person able to modify both backup and manifest could rewrite both. Protect the complete pair with filesystem permissions, separate encrypted storage, and verified restore drills. `VACUUM INTO` cannot alone promise durability in every sudden-power-loss scenario. Do not rely on a single local copy.

## Restore only after stopping the server

The restore operation refuses to overwrite any existing database file. Restore to a **new path**, then select that path explicitly when starting the demo:

```bash
# Shut down the Cypress Harbor server before switching DB_PATH.
node dist/src/backup.js verify ../cypress-harbor-backups/backup-2026-11-02.sqlite
node dist/src/backup.js restore ../cypress-harbor-backups/backup-2026-11-02.sqlite data/recovered.sqlite

DB_PATH=./data/recovered.sqlite npm start
```

The verifier refuses backups with missing or mismatched manifests and data corruption; restore checks the checksum and underlying database again after copying into a private temporary file. It publishes the recovered file only when validation succeeds and the destination does not already exist. Existing `data/reconciliation.sqlite` is left unchanged, and no account passwords are reset automatically.

## Failure scenarios covered by automated tests

- Uncheckpointed committed WAL data survives a backup.
- Restored records have the original reconciliation metrics, source reports, allocations, and named accounts.
- A modified original source CSV fails verification.
- A modified backup fails the manifest's SHA-256 check.
- A missing manifest, repeated destination, or attempted overwrite is rejected.
- The standalone backup, verify, and restore commands work and return nonzero status on failures.

The tool is deliberately **manual**. It does not schedule backups, encrypt the files, send data to cloud storage, rotate backups, or make this a production-ready disaster-recovery system. A production rollout needs tested retention rules, encrypted offsite copies, key management, recovery objectives, and authorized operators.
