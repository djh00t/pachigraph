"""CLI dry run, canaries and peak RSS units."""

import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

import collector
import oe_fixtures
import openai_export


class CliTests(unittest.TestCase):
    def test_peak_rss_units(self):
        self.assertEqual(openai_export.rss_to_mib(1048576, "linux"), 1024)
        self.assertEqual(openai_export.rss_to_mib(1048576, "darwin"), 1)

    def test_cli_dry_run(self):
        with tempfile.TemporaryDirectory() as directory:
            path = oe_fixtures.build_zip(
                directory,
                [oe_fixtures.hidden_messages_conversation()],
                seed=3,
                name="dry.zip",
            )
            state = Path(directory) / "state.sqlite3"
            stdout, stderr = io.StringIO(), io.StringIO()
            with redirect_stdout(stdout), redirect_stderr(stderr):
                code = collector.main(
                    [
                        "openai-export",
                        "--zip",
                        str(path),
                        "--dry-run",
                        "--url",
                        "http://127.0.0.1:9",
                        "--state",
                        str(state),
                    ]
                )
            self.assertEqual(code, 0)
            self.assertFalse(state.exists())
            self.assertFalse(Path(str(state) + ".quarantine").exists())
            payload = json.loads(stdout.getvalue())
            self.assertEqual(payload["uploads"], 0)
            for key in (
                "oversized",
                "no_timestamp",
                "hidden",
                "quarantined",
                "non_finite",
                "side_branch",
                "secs",
                "records_per_sec",
                "peak_rss_mib",
            ):
                self.assertIn(key, payload)
            self.assertNotIn(oe_fixtures.CANARY, stdout.getvalue())
            self.assertNotIn(oe_fixtures.CANARY, stderr.getvalue())

    def test_only_allowlist_opened_end_to_end(self):
        with tempfile.TemporaryDirectory() as directory:
            conversations = [oe_fixtures.hidden_messages_conversation()]
            path = oe_fixtures.build_zip(directory, conversations, seed=4, name="canary.zip")
            state = Path(directory) / "state.sqlite3"
            stdout, stderr = io.StringIO(), io.StringIO()

            def upload(_url, _token, payload):
                return 200, {"stored": len(payload["records"]), "duplicate": 0}

            with (
                mock.patch(
                    "openai_export.fetch_whoami",
                    return_value={
                        "tenant": "t-aaaaaaaaaaaaaaaa",
                        "scope": "ingest",
                        "expires_at": "2099-01-01T00:00:00.000Z",
                    },
                ),
                mock.patch.object(collector, "_upload", side_effect=upload),
                mock.patch.object(collector, "_scanner", return_value=[]),
                redirect_stdout(stdout),
                redirect_stderr(stderr),
            ):
                code = collector.main(
                    [
                        "openai-export",
                        "--zip",
                        str(path),
                        "--url",
                        "http://127.0.0.1:9",
                        "--state",
                        str(state),
                    ]
                )
            self.assertEqual(code, 0)
            blob = state.read_bytes() if state.exists() else b""
            quarantine = Path(str(state) + ".quarantine")
            if quarantine.exists():
                blob += quarantine.read_bytes()
            self.assertNotIn(oe_fixtures.CANARY.encode(), blob)
            self.assertNotIn(oe_fixtures.CANARY, stdout.getvalue())
            self.assertNotIn(oe_fixtures.CANARY, stderr.getvalue())


if __name__ == "__main__":
    unittest.main()

class ReviewCliTests(unittest.TestCase):
    def test_whoami_redirect_does_not_send_bearer(self):
        import http.server
        import threading
        received = []
        class Target(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                received.append(self.headers.get("Authorization"))
                self.send_response(200)
                self.end_headers()
            def log_message(self, *args):
                pass
        target = http.server.HTTPServer(("127.0.0.1", 0), Target)
        class Redirect(Target):
            def do_GET(self):
                self.send_response(302)
                self.send_header("Location", "http://127.0.0.1:%d/" % target.server_port)
                self.end_headers()
        source = http.server.HTTPServer(("127.0.0.1", 0), Redirect)
        threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in (source, target)]
        for thread in threads:
            thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                code = openai_export.run("missing", "http://127.0.0.1:%d" % source.server_port, "synthetic", Path(directory) / "state")
                self.assertEqual(code, 6)
                self.assertEqual(received, [])
        finally:
            for server in (source, target):
                server.shutdown()
                server.server_close()
            for thread in threads:
                thread.join()

    def test_collect_whoami_failure_exits_six(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch("openai_export.fetch_whoami", side_effect=openai_export.AuthFailure()), redirect_stderr(io.StringIO()):
            self.assertEqual(collector.main(["collect", "--codex-home", directory, "--url", "http://127.0.0.1:9", "--state", str(Path(directory) / "state")]), 6)

    def test_first_scanner_rule_is_kept(self):
        secret = "".join(("sample", "-value"))
        findings = []
        def scan(text):
            return [{"RuleID": "first", "Secret": secret}, {"RuleID": "last", "Secret": secret}] if secret in text else []
        collector.sanitize({"text": secret}, scanner=scan, findings_out=findings)
        self.assertEqual(findings[0][0], "first")
