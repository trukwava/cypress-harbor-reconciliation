#!/usr/bin/env python3
"""End-to-end browser smoke test. Uses synthetic data in a disposable local DB."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def reserve_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def exercise_browser(base: str, password: str, work: Path) -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(accept_downloads=True, viewport={"width": 1440, "height": 900})
        page = context.new_page()
        page.set_default_timeout(12000)
        javascript_errors: list[str] = []
        page.on("pageerror", lambda error: javascript_errors.append(str(error)))

        def login(username: str, secret: str) -> None:
            page.locator("#login-username").fill(username)
            page.locator("#login-password").fill(secret)
            page.get_by_role("button", name="Sign in").click()
            page.locator("#workspace").wait_for(state="visible")
            page.locator("#content h1").wait_for(state="visible")

        def state(run_id: str | None = None) -> dict:
            uri = "/api/state" + (("?run=" + run_id) if run_id else "")
            result = page.evaluate(
                """async uri => {
                    const r=await fetch(uri);
                    if (!r.ok) throw Error('API state status: '+r.status);
                    return r.json();
                }""", uri
            )
            assert isinstance(result, dict)
            return result

        page.goto(base, wait_until="domcontentloaded")
        page.locator("#login-view").wait_for(state="visible")
        login("demo-admin", password)
        initial = state()
        assert len(initial["obligations"]) == 40
        assert len(initial["payments"]) == 35
        first_run = initial["latest"]["id"]

        # Inspect the original source evidence in the actual dialog, then review.
        target = next(item for item in initial["exceptions"] if item["kind"] == "paid_elsewhere_still_due")
        page.locator('[data-detail="' + target["id"] + '"]').click()
        dialog = page.locator("#detail-dialog")
        dialog.wait_for(state="visible")
        assert "Original imported values" in dialog.inner_text()
        assert "Preserved source evidence" in dialog.inner_text()
        page.locator("#exception-status").select_option("reviewed")
        page.locator("#exception-owner").fill("Browser Finance Reviewer")
        page.locator("#exception-note").fill("Inspected source obligations and payment evidence")
        # A simulated transient error must not throw away the typed disposition.
        page.route("**/api/exceptions/*/review",
                   lambda route: route.fulfill(status=503, content_type="application/json",
                                               body='{"error":"Temporary review outage"}'),
                   times=1)
        dialog.get_by_role("button", name="Save review and audit event").click()
        page.locator("#alert").filter(has_text="Temporary review outage").wait_for(state="visible")
        assert dialog.is_visible()
        assert page.locator("#exception-note").input_value() == "Inspected source obligations and payment evidence"
        dialog.get_by_role("button", name="Save review and audit event").click()
        dialog.wait_for(state="hidden")
        assert next(e for e in state()["exceptions"] if e["id"] == target["id"])["status"] == "reviewed"

        # Native file upload -> preview -> persisted source report.
        page.locator('[data-page="imports"]').click()
        input_file = work / "browser_obligation.csv"
        input_file.write_text(
            "obligation_key,property_ref,invoice_ref,amount,reported_due,due_date,currency\n"
            "BROWSER-OBL-1,CHH-P01,BROWSER-INV-1,49.00,49.00,2026-10-27,USD\n",
            encoding="utf-8",
        )
        page.locator("#upload-file").set_input_files(str(input_file))
        page.get_by_role("button", name="Preview & validate").click()
        page.locator("#preview-panel").get_by_text("Import preview", exact=False).wait_for()
        assert "BROWSER-OBL-1" in page.locator("#preview-panel").inner_text()
        # Preserve the preview and selected CSV if the server rejects one commit.
        page.route("**/api/import/commit",
                   lambda route: route.fulfill(status=503, content_type="application/json",
                                               body='{"error":"Temporary import outage"}'),
                   times=1)
        page.locator("#commit-import").click()
        page.locator("#alert").filter(has_text="Temporary import outage").wait_for(state="visible")
        assert "BROWSER-OBL-1" in page.locator("#preview-panel").inner_text()
        assert page.locator("#commit-import").is_enabled()
        page.locator("#commit-import").click()
        page.locator("#alert").filter(has_text="Report preserved").wait_for(state="visible")
        # Import preserves the record, but the last reconciliation view stays frozen.
        imported_state = state()
        assert len(imported_state["obligations"]) == 40
        assert any(r["filename"] == "browser_obligation.csv" for r in imported_state["reports"])

        # Fresh run and downloadable evidence pack; prior run remains frozen.
        page.locator("#run-reconcile").click()
        page.locator("#alert").filter(has_text="Reconciliation complete").wait_for(state="visible")
        new_run = state()["latest"]["id"]
        assert new_run != first_run
        page.locator('[data-page="history"]').click()
        with page.expect_download() as download_event:
            page.locator('a[href="/api/export?run=' + new_run + '"]').first.click()
        pack_path = work / "reconciliation.json"
        download_event.value.save_as(pack_path)
        pack = json.loads(pack_path.read_text(encoding="utf-8"))
        assert pack["manifest"]["selected_run"] == new_run
        assert len(pack["original_obligations"]) == 41
        with page.expect_download() as csv_event:
            page.locator('a[href="/api/export/exceptions.csv?run=' + new_run + '"]').first.click()
        csv_out = work / "exceptions.csv"
        csv_event.value.save_as(csv_out)
        csv_body = csv_out.read_text(encoding="utf-8")
        assert '"run_id","exception_id"' in csv_body
        assert new_run in csv_body
        page.locator('[data-select-run="' + first_run + '"]').click()
        page.locator("#alert").filter(has_text="Viewing selected run").wait_for(state="visible")
        historical = state(first_run)
        assert len(historical["obligations"]) == 40
        assert historical["metrics"]["original_obligations_minor"] == initial["metrics"]["original_obligations_minor"]

        # Admin creates named accounts from the real user interface.
        for username, secret, role in [
            ("browser-viewer", "Viewer-Passphrase-123456", "viewer"),
            ("browser-reviewer", "Reviewer-Passphrase-123456", "reviewer"),
        ]:
            page.locator("#manage-users").click()
            page.locator("#new-user-name").fill(username)
            page.locator("#new-user-password").fill(secret)
            page.locator("#new-user-role").select_option(role)
            page.get_by_role("button", name="Create user").click()
            page.locator("#detail-dialog").wait_for(state="hidden")

        page.locator("#logout").click()
        page.locator("#login-view").wait_for(state="visible")
        login("browser-viewer", "Viewer-Passphrase-123456")
        assert page.locator("#run-reconcile").is_hidden()
        assert page.locator("#manage-users").is_hidden()
        page.locator("[data-detail]").first.click()
        assert page.locator("#exception-form").is_hidden()
        assert page.locator("#exception-form").is_hidden(), "Viewer must not see a review form"
        page.locator("#detail-dialog [data-close]").first.click()
        page.locator('[data-page="imports"]').click()
        assert page.locator("#upload-file").is_disabled()

        page.locator("#logout").click()
        page.locator("#login-view").wait_for(state="visible")
        login("browser-reviewer", "Reviewer-Passphrase-123456")
        assert page.locator("#run-reconcile").is_hidden()
        page.locator("[data-detail]").first.click()
        page.locator("#exception-form").wait_for(state="visible")
        page.locator("#detail-dialog [data-close]").first.click()
        page.locator('[data-page="matches"]').click()
        assert page.locator("[data-match]").count() > 0
        page.locator('[data-page="imports"]').click()
        assert page.locator("#commit-import").is_disabled()
        # Regression for narrow-screen reviewer navigation and action layout.
        page.set_viewport_size({"width": 390, "height": 844})
        page.locator('[data-page="queue"]').click()
        assert page.locator("#navigation").is_visible()
        sizes = page.evaluate("""() => ({
            viewport: window.innerWidth,
            document: document.documentElement.scrollWidth
        })""")
        assert sizes["document"] <= sizes["viewport"] + 2, sizes
        page.locator('[data-page="history"]').click()
        assert page.locator('a[href^="/api/export/exceptions.csv"]').first.is_visible()
        assert not javascript_errors, javascript_errors
        context.close()
        browser.close()


def main() -> None:
    assert (ROOT / "dist/src/server.js").is_file(), "Run npm run build first"
    with tempfile.TemporaryDirectory(prefix="chh-browser-") as directory:
        work = Path(directory)
        port = reserve_port()
        env = {**os.environ, "DB_PATH": str(work / "synthetic.sqlite"), "HOST": "127.0.0.1", "PORT": str(port)}
        log_path = work / "server.log"
        with log_path.open("w+", encoding="utf-8") as logfile:
            server = subprocess.Popen(
                ["node", str(ROOT / "dist/src/server.js")],
                cwd=ROOT, env=env, stdout=logfile, stderr=subprocess.STDOUT,
            )
            try:
                secret = None
                deadline = time.monotonic() + 30
                while time.monotonic() < deadline:
                    if server.poll() is not None:
                        raise RuntimeError("Synthetic test server exited early")
                    logfile.flush()
                    match = re.search(
                        r"LOCAL DEMO FIRST-USE LOGIN .* password: (\S+)",
                        log_path.read_text(encoding="utf-8"),
                    )
                    if match:
                        secret = match.group(1)
                        break
                    time.sleep(0.2)
                if not secret:
                    raise RuntimeError("First-use test account was not created")
                exercise_browser("http://127.0.0.1:" + str(port), secret, work)
            finally:
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=5)
    print("PASS: real-browser import, evidence, review, run export, historical snapshot, and role checks")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"BROWSER SMOKE FAILED: {type(error).__name__}: {error}", file=sys.stderr)
        raise
