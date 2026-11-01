"""Pipeline, replay and exit codes for openai-export."""

import io
import json
import tempfile
import unittest
import urllib.error
from collections import Counter
from pathlib import Path
from unittest import mock

import oe_fixtures
import openai_export


def _secret():
    return "".join(("syn", "thetic", "-secret-", "marker"))


def _scanner(secret):
    calls = []

    def scanner(text):
        calls.append(text)
        if secret and secret in text:
            return [{"RuleID": "generic-rule", "Secret": secret}]
        return []

    scanner.calls = calls
    return scanner


def _http(code):
    err = urllib.error.HTTPError(
        "http://127.0.0.1:9/api/ingest", code, "status", {}, io.BytesIO(b"")
    )
    exc = RuntimeError("upload failed")
    exc.__cause__ = err
    return exc


class ExportTests(unittest.TestCase):
    def _zip(self, directory, conversations, name="export.zip"):
        return oe_fixtures.build_zip(
            directory, conversations, extra_members={}, seed=1, name=name
        )

    def _one(self, text="hello", secret=None):
        body = text if secret is None else text + " " + secret
        return [
            oe_fixtures.conversation(
                "conversation-alpha",
                [
                    oe_fixtures.visible_node("n1", None, body),
                    oe_fixtures.visible_node("n2", "n1", body + " next"),
                ],
            )
        ]

    def test_replay_and_newer_export_steps(self):
        whoami = mock.Mock(
            return_value={
                "tenant": "t-aaaaaaaaaaaaaaaa",
                "scope": "ingest",
                "expires_at": "2099-01-01T00:00:00.000Z",
            }
        )
        uploads = []

        def upload(_url, _token, payload):
            uploads.append(payload)
            return 200, {"stored": len(payload["records"]), "duplicate": 0}

        scanner = _scanner(None)
        with tempfile.TemporaryDirectory() as directory:
            path = self._zip(directory, self._one())
            state = Path(directory) / "state.sqlite3"
            counters = Counter()
            code = openai_export.run(
                path,
                "http://127.0.0.1:9",
                "synthetic",
                state,
                counters=counters,
                scanner=scanner,
                upload=upload,
                whoami=whoami,
            )
            self.assertEqual(code, 0)
            self.assertEqual(counters["uploads"], 1)
            self.assertGreater(len(scanner.calls), 0)
            whoami.assert_called()
            scanner.calls.clear()
            uploads.clear()
            again = Counter()
            code = openai_export.run(
                path,
                "http://127.0.0.1:9",
                "synthetic",
                state,
                counters=again,
                scanner=scanner,
                upload=upload,
                whoami=whoami,
            )
            self.assertEqual(code, 0)
            self.assertEqual(again["uploads"], 0)
            self.assertEqual(scanner.calls, [])

            dry_whoami = mock.Mock()
            dry = Counter()
            code = openai_export.run(
                path,
                "http://127.0.0.1:9",
                None,
                Path(directory) / "dry.sqlite3",
                dry_run=True,
                counters=dry,
                scanner=scanner,
                upload=upload,
                whoami=dry_whoami,
            )
            self.assertEqual(code, 0)
            dry_whoami.assert_not_called()
            self.assertFalse((Path(directory) / "dry.sqlite3").exists())

    def test_replay_and_newer_export(self):
        secret = _secret()
        other = secret + "x"
        uploads = []

        def upload(_url, _token, payload):
            uploads.append(payload)
            return 200, {"stored": len(payload["records"]), "duplicate": 0}

        whoami = mock.Mock(
            return_value={
                "tenant": "t-aaaaaaaaaaaaaaaa",
                "scope": "ingest",
                "expires_at": "2099-01-01T00:00:00.000Z",
            }
        )
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.sqlite3"
            first = self._zip(directory, self._one("same"), name="a.zip")
            scanner = _scanner(None)
            self.assertEqual(
                openai_export.run(
                    first, "http://127.0.0.1:9", "t", state,
                    scanner=scanner, upload=upload, whoami=whoami,
                ),
                0,
            )
            grown = oe_fixtures.conversation(
                "conversation-alpha",
                [oe_fixtures.visible_node("n1", None, "same")],
            )
            grown["mapping"]["n1"]["children"] = ["extra-child"]
            grown_zip = self._zip(directory, [grown], name="grown.zip")
            scanner.calls.clear()
            uploads.clear()
            counters = Counter()
            self.assertEqual(
                openai_export.run(
                    grown_zip, "http://127.0.0.1:9", "t", state,
                    counters=counters, scanner=scanner, upload=upload, whoami=whoami,
                ),
                0,
            )
            self.assertEqual(counters["uploads"], 0)
            self.assertEqual(scanner.calls, [])

            edited = self._zip(directory, self._one("edited"), name="edited.zip")
            counters = Counter()
            self.assertEqual(
                openai_export.run(
                    edited, "http://127.0.0.1:9", "t", state,
                    counters=counters, scanner=_scanner(None), upload=upload, whoami=whoami,
                ),
                0,
            )
            self.assertEqual(counters["uploads"], 1)

            secret_state = Path(directory) / "secret.sqlite3"
            counters = Counter()
            self.assertEqual(
                openai_export.run(
                    self._zip(directory, self._one("v", secret), name="s1.zip"),
                    "http://127.0.0.1:9", "t", secret_state,
                    counters=counters, scanner=_scanner(secret), upload=upload, whoami=whoami,
                ),
                0,
            )
            counters = Counter()
            self.assertEqual(
                openai_export.run(
                    self._zip(directory, self._one("v", other), name="s2.zip"),
                    "http://127.0.0.1:9", "t", secret_state,
                    counters=counters, scanner=_scanner(other), upload=upload, whoami=whoami,
                ),
                0,
            )
            self.assertEqual(counters["uploads"], 1)

    def test_replay_and_newer_export_exit(self):
        whoami = mock.Mock(
            return_value={
                "tenant": "t-aaaaaaaaaaaaaaaa",
                "scope": "ingest",
                "expires_at": "2099-01-01T00:00:00.000Z",
            }
        )
        with tempfile.TemporaryDirectory() as directory:
            path = self._zip(directory, self._one())
            state = Path(directory) / "state.sqlite3"

            def run(upload, target=None, **kwargs):
                counters = Counter()
                code = openai_export.run(
                    path,
                    "http://127.0.0.1:9",
                    "t",
                    target or state,
                    counters=counters,
                    scanner=_scanner(None),
                    upload=upload,
                    whoami=kwargs.get("whoami", whoami),
                )
                return code, counters

            denied = mock.Mock(side_effect=_http(401))
            self.assertEqual(run(denied)[0], 6)
            self.assertEqual(run(mock.Mock(side_effect=_http(403)))[0], 6)
            code, counters = run(mock.Mock(side_effect=_http(507)))
            self.assertEqual(code, 5)
            self.assertEqual(counters["quota_exceeded"], 1)
            self.assertEqual(run(mock.Mock(side_effect=_http(500)))[0], 5)
            bad_whoami = mock.Mock(side_effect=openai_export.AuthFailure())
            self.assertEqual(run(mock.Mock(), whoami=bad_whoami, target=Path(directory) / "w.sqlite3")[0], 6)

            both = oe_fixtures.build_variant(directory, "both")
            counters = Counter()
            code = openai_export.run(
                both, "http://127.0.0.1:9", "t", Path(directory) / "z.sqlite3",
                dry_run=True, counters=counters, scanner=_scanner(None), upload=mock.Mock(),
            )
            self.assertEqual(code, 3)
            self.assertEqual(counters["ambiguous_layout"], 1)

            def crash(_text):
                raise openai_export.collector.ScannerError("secret scanner failed")

            self.assertEqual(
                openai_export.run(
                    path, "http://127.0.0.1:9", "t", Path(directory) / "c.sqlite3",
                    scanner=crash, upload=mock.Mock(), whoami=whoami,
                ),
                4,
            )
            import os
            os.chmod(directory, 0o707)
            try:
                self.assertEqual(
                    openai_export.run(
                        path, "http://127.0.0.1:9", "t", Path(directory) / "q.sqlite3",
                        scanner=_scanner(None), upload=mock.Mock(), whoami=whoami,
                    ),
                    7,
                )
            finally:
                os.chmod(directory, 0o700)
            # gaps are not failures
            cycle = self._zip(directory, [oe_fixtures.cycle_conversation()], name="cycle.zip")
            counters = Counter()
            self.assertEqual(
                openai_export.run(
                    cycle, "http://127.0.0.1:9", "t", Path(directory) / "g.sqlite3",
                    dry_run=True, counters=counters, scanner=_scanner(None), upload=mock.Mock(),
                ),
                0,
            )
            self.assertGreaterEqual(counters["bad_tree"], 1)

    def test_replay_and_newer_export_410(self):
        calls = []

        def upload(_url, _token, payload):
            calls.append(payload["thread_id"])
            return 410, {}

        whoami = mock.Mock(
            return_value={
                "tenant": "t-aaaaaaaaaaaaaaaa",
                "scope": "ingest",
                "expires_at": "2099-01-01T00:00:00.000Z",
            }
        )
        with tempfile.TemporaryDirectory() as directory:
            path = self._zip(directory, self._one())
            state = Path(directory) / "state.sqlite3"
            counters = Counter()
            self.assertEqual(
                openai_export.run(
                    path, "http://127.0.0.1:9", "t", state,
                    counters=counters, scanner=_scanner(None), upload=upload, whoami=whoami,
                ),
                0,
            )
            self.assertEqual(counters["tombstoned"], 1)
            self.assertEqual(len(calls), 1)
            counters = Counter()
            self.assertEqual(
                openai_export.run(
                    path, "http://127.0.0.1:9", "t", state,
                    counters=counters, scanner=_scanner(None), upload=upload, whoami=whoami,
                ),
                0,
            )
            self.assertEqual(len(calls), 1)
            self.assertEqual(counters["uploads"], 0)


if __name__ == "__main__":
    unittest.main()
