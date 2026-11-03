# Adversarial storage and reviewer crash tests

These checks run in GitHub Actions against disposable, synthetic SQLite files. They never modify an operator's database.

## Covered scenarios

1. **Simulated database capacity exhaustion:** A temporary SQLite `max_page_count` limit causes `SQLITE_FULL` during a large CSV import. Verify that source reports, normalized rows, obligations, and audit records remain unchanged, then lift the limit and retry successfully. This is a deterministic SQLite capacity test, **not** a test of physical disk failure, filesystem I/O faults, or exhausted operating-system storage.
2. **Interrupted reviewer disposition:** A temporary SQLite trigger invokes `SIGKILL` in a separate process after the exception update and resolution insertion, but before the audit insert and COMMIT. Repeat the failure three times and require the note, revision, resolution count, and audit history to remain unchanged. Then save one successful review.
3. **Interrupted match acceptance:** Kill a subprocess after allocation and candidate-status updates, before committing its match-decision row. Repeat three times; check that all interrupted allocations roll back, then accept exactly one decision.
4. **Corrupt backup verification:** Change the backup manifest counts and verify restore refusal. Then alter a frozen run snapshot in the backup, recompute the outer file SHA-256 and manifest, and require the stored snapshot checksum to detect the altered evidence. The restore destination must not be created.

## Recoverable capacity responses

When SQLite reports `SQLITE_FULL`, transactional import and review endpoints now return **HTTP 507 (Insufficient Storage)** rather than an unexplained internal server error. The error asks the operator to free storage or raise the local SQLite page quota before retrying; it does not automatically retry an operation or claim the underlying disk was repaired. A direct allocation call also commits its allocation and audit event atomically, so an audit write failure cannot leave an unrecorded allocation.

After a capacity error, first check free space and the file's integrity in an approved environment, then retry the request once capacity has been restored. An administrative action may be necessary. Capacity errors on reads, writes outside explicit transactions, and hardware I/O failures require separate investigation.

## Interpret carefully

These tests demonstrate rollback, integrity checks, and recovery for specific injected failures. They do **not** simulate power-loss write reordering, storage firmware defects, a malicious database administrator rewriting all hashes, simultaneous failures of backup and live storage, or a distributed deployment. Keep the application localhost-only and synthetic. Exercise actual disk-capacity and power-loss recovery separately in an isolated test environment before any real-data pilot.

Run the Node suite with `npm test`; Chromium remains a separate CI job. Do not point tests or crash workers at an existing finance database.
