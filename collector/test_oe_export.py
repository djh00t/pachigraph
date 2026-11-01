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

class ReviewRegressionTests(ExportTests):
    def test_upload_failures_and_store_failure(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as directory:
            path = self._zip(directory, self._one())
            who = lambda *_: {"tenant": "t-aaaaaaaaaaaaaaaa"}
            for index, upload in enumerate((lambda *_: (200, {}), mock.Mock(side_effect=ValueError()))):
                self.assertEqual(openai_export.run(path, "http://127.0.0.1:9", "t", Path(directory) / str(index), scanner=_scanner(None), upload=upload, whoami=who), 5)
            with mock.patch("oe_qstore.Store.purge_expired", side_effect=sqlite3.OperationalError("disk full")):
                self.assertEqual(openai_export.run(path, "http://127.0.0.1:9", "t", Path(directory) / "db", scanner=_scanner(None), whoami=who), 7)

    def test_invalid_conversations_are_skipped(self):
        with tempfile.TemporaryDirectory() as directory:
            bad = self._one()[0]
            bad["\ud800"] = 1
            bad["\ufffd"] = 2
            deep = self._one()[0]
            deep["mapping"]["n1"]["message"]["extra"] = float("nan")
            import zipfile
            path = Path(directory) / "invalid.zip"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("conversations.json", json.dumps([bad, deep, self._one()[0]]))
            counters = Counter()
            original = openai_export.oe_record.build_record
            calls = iter([True, False, False])
            def build(*args):
                record = original(*args)
                if next(calls, False):
                    record["invalid"] = float("nan")
                return record
            with mock.patch("oe_record.build_record", side_effect=build):
                self.assertEqual(openai_export.run(path, "http://127.0.0.1:9", None, Path(directory) / "state", dry_run=True, counters=counters, scanner=_scanner(None)), 0)
            self.assertEqual(counters["bad_tree"], 2)
            self.assertGreater(counters["records"], 0)

    def test_fresh_state_purge_and_retention(self):
        import collector
        import oe_qstore
        with tempfile.TemporaryDirectory() as directory:
            path = self._zip(directory, self._one())
            state = Path(directory) / "state"
            who = lambda *_: {"tenant": "t-aaaaaaaaaaaaaaaa"}
            upload = lambda _u, _t, p: (200, {"stored": len(p["records"]), "duplicate": 0})
            args = (path, "http://127.0.0.1:9", "t", state)
            store = oe_qstore.Store(state)
            store.close()
            self.assertEqual(openai_export.run(*args, whoami=who), 7)
            self.assertEqual(collector._quarantine_command(state, ["purge", "--all"]), 0)
            self.assertFalse(oe_qstore.quarantine_path(state).exists())
            self.assertEqual(collector._quarantine_command(state, ["purge", "--all"]), 0)
            self.assertFalse(oe_qstore.quarantine_path(state).exists())
            self.assertEqual(openai_export.run(*args, whoami=who, upload=upload, scanner=_scanner(None)), 0)
            store = oe_qstore.Store(state)
            store.put_item({"text": "old"}, [{"rule": "r", "path": "/text", "fp": "f"}], salt=b"s", tenant="t", thread_id="th", record_id="r", conversation_id="c", node_id="n", created_at=1)
            store.close()
            self.assertEqual(openai_export.run(*args, whoami=who, upload=upload, scanner=_scanner(None)), 0)
            store = oe_qstore.Store(state)
            self.assertEqual(store.counts(), (0, 0))
            store.close()

    def test_410_purges_existing_thread(self):
        import oe_qstore
        import oe_identity
        with tempfile.TemporaryDirectory() as directory:
            path = self._zip(directory, self._one())
            state = Path(directory) / "state"
            state.touch()
            store = oe_qstore.Store(state)
            store.put_item({"text": "old"}, [{"rule": "r", "path": "/text", "fp": "f"}], salt=b"s", tenant="t", thread_id=oe_identity.thread_id("conversation-alpha"), record_id="r", conversation_id="c", node_id="n")
            store.close()
            self.assertEqual(openai_export.run(path, "http://127.0.0.1:9", "t", state, scanner=_scanner(None), upload=lambda *_: (410, {}), whoami=lambda *_: {"tenant": "t"}), 0)
            store = oe_qstore.Store(state)
            self.assertEqual(store.counts(), (0, 0))
            store.close()

    def test_group_writable_directory_rejected(self):
        import os
        with tempfile.TemporaryDirectory() as directory:
            os.chmod(directory, 0o770)
            try:
                self.assertEqual(openai_export.run("missing", "http://127.0.0.1:9", "t", Path(directory) / "state", whoami=lambda *_: {"tenant": "t"}), 7)
            finally:
                os.chmod(directory, 0o700)
