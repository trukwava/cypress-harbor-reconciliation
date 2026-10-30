# Browser workflow smoke test

The core suite (`npm test`) uses Node's test runner to check deterministic matching, payment-allocation constraints, reviewer permissions, source-import idempotency, historical snapshots, and exports. It does not render the browser.

A separate **Playwright Chromium** test is in `tests/browser_smoke.py`. It runs in GitHub Actions for every pull request and for pushes to `main`, using a disposable, local-only server and temporary SQLite database. It uses no production accounts, no network connectors, no real financial records, and no persistent administrator credentials.

The browser test exercises actual controls for signing in; inspecting original/normalized exception evidence; recording a disposition; uploading and previewing a synthetic obligation CSV; committing an import; reconciling and downloading a JSON evidence pack; switching to an earlier run and comparing frozen totals; creating viewer/reviewer accounts; and enforcing their different visible controls. It also fails if browser JavaScript exceptions occur.

## Run on your own machine

With Node.js 22.16+, Python 3.11+, and npm:

```bash
npm install
npm test
npm run build
python -m pip install playwright==1.56.0
python -m playwright install chromium
python tests/browser_smoke.py
```

On Linux, installing Chromium dependencies may require `python -m playwright install --with-deps chromium`. CI installs them automatically. The test starts its own server on a dynamically selected loopback port, reads the one-time admin password from its own disposable startup log, and tears down its server and database.

## Scope and limitations

This is a workflow smoke test, not a complete accessibility, compatibility, visual-regression, penetration, or concurrency test. Test failures block PR completion. Do not run tests against a shared demo database or a live deployment. Real finance records are out of scope. The app remains localhost-only.
