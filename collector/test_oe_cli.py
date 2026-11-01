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
