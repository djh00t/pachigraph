import hashlib
import io
import json
import os
import plistlib
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import collector


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        (self.home / "sessions" / "nested").mkdir(parents=True)
        (self.home / "archived_sessions").mkdir()
        self.state = self.home / "state.sqlite3"

    def tearDown(self):
        self.tmp.cleanup()

    def write_session(self, rel, lines):
        p = self.home / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("\n".join(json.dumps(x) for x in lines) + "\n")
        return p

    def test_archived_discovery_and_redaction(self):
        token = "ghp_123456789012345678901234567890123456"
        self.write_session(
            "archived_sessions/a.jsonl",
            [
                {
                    "type": "session_meta",
                    "timestamp": "2026-01-01T00:00:00Z",
                    "payload": {"id": "550e8400-e29b-41d4-a716-446655440001"},
                },
                {
                    "type": "user",
                    "timestamp": "2026-01-01T00:01:00Z",
                    "payload": {"message": "secret " + token},
                },
            ],
        )
        result = collector.collect(
            self.home, "http://localhost:9", self.state, dry_run=True
        )
        self.assertEqual(result["threads"], 1)
        self.assertEqual(result["records"], 2)
        self.assertGreaterEqual(result["redacted"], 1)
        self.assertNotIn(token, json.dumps(result))

    def test_partial_final_line_is_deferred(self):
        p = self.home / "sessions" / "a.jsonl"
        p.write_text(
            json.dumps(
                {
                    "type": "session_meta",
                    "timestamp": "2026-01-01T00:00:00Z",
                    "payload": {"id": "550e8400-e29b-41d4-a716-446655440000"},
                }
            )
            + "\n"
            + json.dumps({"type": "user", "timestamp": "2026-01-01T00:00:00Z"})
        )
        result = collector.collect(
            self.home, "http://localhost:9", self.state, dry_run=True
        )
        self.assertEqual(result["records"], 1)
        with p.open("a") as f:
            f.write("\n")
        result = collector.collect(
            self.home, "http://localhost:9", self.state, dry_run=True
        )
        self.assertEqual(result["records"], 2)

    def test_scanner_failure_fails_closed(self):
        self.write_session(
            "sessions/a.jsonl",
            [
                {
                    "type": "session_meta",
                    "timestamp": "2026-01-01T00:00:00Z",
                    "payload": {"id": "550e8400-e29b-41d4-a716-446655440000"},
                },
                {"type": "user", "timestamp": "2026-01-01T00:00:01Z"},
            ],
        )
        with (
            mock.patch.object(
                collector, "_scanner", side_effect=collector.ScannerError("failed")
            ),
            self.assertRaises(collector.ScannerError),
        ):
            collector.collect(self.home, "http://localhost:9", self.state, dry_run=True)

    def test_http_failure_does_not_advance_checkpoint(self):
        self.write_session(
            "sessions/a.jsonl",
            [
                {
                    "type": "session_meta",
                    "timestamp": "2026-01-01T00:00:00Z",
                    "payload": {"id": "550e8400-e29b-41d4-a716-446655440000"},
                },
                {
                    "type": "user",
                    "timestamp": "2026-01-01T00:00:00Z",
                    "payload": {"text": "hello"},
                },
            ],
        )

        class Failing(BaseHTTPRequestHandler):
            def do_POST(self):
                self.send_response(503)
                self.end_headers()

            def log_message(self, *_):
                pass

        server = HTTPServer(("127.0.0.1", 0), Failing)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with self.assertRaises(RuntimeError):
                collector.collect(
                    self.home, f"http://127.0.0.1:{server.server_port}", self.state
                )
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
        db = collector.State(self.state)
        self.assertEqual(
            db.db.execute("SELECT count(*) FROM progress").fetchone()[0], 0
        )
        db.close()

    def test_ids_are_stable_for_revision_and_copy(self):
        lines = [
            {
                "type": "session_meta",
                "timestamp": "2026-01-01T00:00:00Z",
                "payload": {"id": "550e8400-e29b-41d4-a716-446655440000"},
            },
            {
                "type": "user",
                "timestamp": "2026-01-01T00:00:00Z",
                "payload": {"text": "one"},
            },
        ]
        p = self.write_session("sessions/a.jsonl", lines)
        first = collector.collect(
            self.home, "http://localhost:9", self.state, dry_run=True
        )
        ids1 = first["records"]
        p.write_text(
            "\n".join(
                json.dumps(x)
                for x in lines[:-1]
                + [
                    {
                        "type": "user",
                        "timestamp": "2026-01-01T00:00:00Z",
                        "payload": {"text": "two"},
                    }
                ]
            )
            + "\n"
        )
        second = collector.collect(
            self.home, "http://localhost:9", self.state, dry_run=True
        )
        self.assertEqual(ids1, second["records"])

    def test_dry_run_does_not_checkpoint_and_includes_metadata(self):
        self.write_session(
            "sessions/a.jsonl",
            [
                {
                    "type": "session_meta",
                    "timestamp": "2026-01-01T00:00:00Z",
                    "payload": {
                        "id": "550e8400-e29b-41d4-a716-446655440000",
                        "text": "metadata",
                    },
                },
                {
                    "type": "user",
                    "timestamp": "2026-01-01T00:00:01Z",
                    "payload": {"text": "hello"},
                },
            ],
        )
        result = collector.collect(
            self.home, "http://localhost:9", self.state, dry_run=True
        )
        self.assertEqual(result["records"], 2)
        db = collector.State(self.state)
        self.assertEqual(
            db.db.execute("SELECT count(*) FROM progress").fetchone()[0], 0
        )
        db.close()

    def test_launchd_schedule_is_daily(self):
        xml = collector.launchd_plist(self.home, "https://example.test", self.state)
        plist = plistlib.loads(xml)
        self.assertEqual(plist["StartCalendarInterval"], {"Hour": 3, "Minute": 0})

    def test_scanner_rejects_malformed_findings(self):
        with self.assertRaises(collector.ScannerError):
            collector.sanitize(
                {"secret-key": "value"}, scanner=lambda _: {"Secret": "value"}
            )

    def test_uuid7_session_is_collected(self):
        self.write_session(
            "sessions/a.jsonl",
            [
                {
                    "type": "session_meta",
                    "timestamp": "2026-01-01T00:00:00Z",
                    "payload": {"id": "019cbbc4-7fd4-7bca-9dc4-d63a3439189e"},
                },
                {
                    "type": "user",
                    "timestamp": "2026-01-01T00:00:00Z",
                    "payload": {"text": "hello"},
                },
            ],
        )
        result = collector.collect(
            self.home, "http://localhost:9", self.state, dry_run=True
        )
        self.assertEqual(result["threads"], 1)
        self.assertEqual(result["records"], 2)

    def test_real_gitleaks_redacts_decoded_values_and_dictionary_keys(self):
        token = "ghp_123456789012345678901234567890123456"
        with mock.patch.dict(os.environ, {"GITLEAKS_CONFIG": "/does/not/exist"}):
            clean, changed = collector.sanitize(
                {
                    "payload": {
                        f"key-{token}": f"# gitleaks:allow first line\n{token}\nlast line"
                    },
                }
            )
        rendered = json.dumps(clean)
        self.assertNotIn(token, rendered)
        self.assertGreaterEqual(changed, 2)
        self.assertEqual(collector._scanner("\n".join(collector._strings(clean))), [])

    def test_overlapping_secret_and_match_are_one_replacement(self):
        token = "ghp_123456789012345678901234567890123456"
        finding = {"Secret": token, "Match": "token=" + token}
        clean, changed = collector.sanitize(
            {"text": "token=" + token},
            scanner=lambda text: [finding] if token in text else [],
        )
        self.assertEqual(clean, {"text": "token=" + collector.REDACTION})
        self.assertEqual(changed, 1)

    def test_redacted_dictionary_key_collision_fails_closed(self):
        one = "ghp_123456789012345678901234567890123456"
        two = "ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN"

        def scanner(text):
            return [
                {"Secret": value, "Match": value}
                for value in (one, two)
                if value in text
            ]

        with self.assertRaises(collector.ScannerError):
            collector.sanitize({one: 1, two: 2}, scanner=scanner)

    def test_interrupted_multibatch_resume_uses_exact_line_offset(self):
        lines = [
            {
                "type": "session_meta",
                "timestamp": "2026-01-01T00:00:00Z",
                "payload": {"id": "019cbbc4-7fd4-7bca-9dc4-d63a3439189e"},
            }
        ]
        lines += [
            {
                "type": "user",
                "timestamp": "2026-01-01T00:00:01Z",
                "payload": {"text": (f"record-{i}\n" + "x" * 260)},
            }
            for i in range(4)
        ]
        self.write_session("sessions/a.jsonl", lines)
        received = []
        failures_left = [1]

        class Handler(BaseHTTPRequestHandler):
            def do_POST(inner):
                body = json.loads(
                    inner.rfile.read(int(inner.headers["Content-Length"]))
                )
                received.append(body)
                if len(received) == 2 and failures_left[0]:
                    failures_left[0] -= 1
                    inner.send_response(503)
                    inner.end_headers()
                    return
                inner.send_response(200)
                inner.send_header("Content-Type", "application/json")
                inner.end_headers()
                inner.wfile.write(
                    json.dumps(
                        {"stored": len(body["records"]), "duplicate": 0}
                    ).encode()
                )

            def log_message(self, *_):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with mock.patch.object(collector, "MAX_REQUEST", 900):
                with self.assertRaises(RuntimeError):
                    collector.collect(
                        self.home, f"http://127.0.0.1:{server.server_port}", self.state
                    )
                first_acked = {r["id"] for r in received[0]["records"]}
                received.clear()
                collector.collect(
                    self.home, f"http://127.0.0.1:{server.server_port}", self.state
                )
                resumed = {r["id"] for batch in received for r in batch["records"]}
            self.assertTrue(first_acked)
            self.assertTrue(resumed)
            self.assertTrue(first_acked.isdisjoint(resumed))
            self.assertEqual(len(first_acked | resumed), len(lines))
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_changed_prefix_is_rescanned_but_append_scans_only_tail(self):
        path = self.write_session(
            "sessions/a.jsonl",
            [
                {
                    "type": "session_meta",
                    "timestamp": "2026-01-01T00:00:00Z",
                    "payload": {"id": "019cbbc4-7fd4-7bca-9dc4-d63a3439189e"},
                },
                {
                    "type": "user",
                    "timestamp": "2026-01-01T00:00:00Z",
                    "payload": {"text": "one"},
                },
            ],
        )

        class Handler(BaseHTTPRequestHandler):
            def do_POST(inner):
                body = json.loads(
                    inner.rfile.read(int(inner.headers["Content-Length"]))
                )
                inner.send_response(200)
                inner.send_header("Content-Type", "application/json")
                inner.end_headers()
                inner.wfile.write(
                    json.dumps(
                        {"stored": len(body["records"]), "duplicate": 0}
                    ).encode()
                )

            def log_message(self, *_):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        scans = []
        try:
            with mock.patch.object(
                collector,
                "_scanner",
                side_effect=lambda text, *_: scans.append(text) or [],
            ):
                collector.collect(
                    self.home, f"http://127.0.0.1:{server.server_port}", self.state
                )
                scans.clear()
                with path.open("a") as fh:
                    fh.write(
                        json.dumps(
                            {
                                "type": "user",
                                "timestamp": "2026-01-01T00:00:01Z",
                                "payload": {"text": "two"},
                            }
                        )
                        + "\n"
                    )
                collector.collect(
                    self.home, f"http://127.0.0.1:{server.server_port}", self.state
                )
                self.assertEqual(
                    len(scans), 2
                )  # initial scan and clean rescan for the appended record
                scans.clear()
                data = path.read_text().replace('"one"', '"uno"')
                path.write_text(data)
                collector.collect(
                    self.home, f"http://127.0.0.1:{server.server_port}", self.state
                )
                self.assertEqual(
                    len(scans), 6
                )  # all three records, each scanned then verified clean
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_discovery_only_returns_regular_jsonl_inside_roots(self):
        good = self.write_session("sessions/a.jsonl", [{"type": "x"}])
        self.write_session("sessions/ignore.txt", [{"type": "x"}])
        outside = self.home / "outside.jsonl"
        outside.write_text("{}\n")
        (self.home / "sessions" / "link.jsonl").symlink_to(outside)
        (self.home / "sessions" / "linked-dir").symlink_to(self.home)
        self.assertEqual(collector.discover(self.home), [good])

    def test_ack_rejects_boolean_and_negative_counts(self):
        for body in ({"stored": True, "duplicate": 0}, {"stored": -1, "duplicate": 2}):
            with self.subTest(body=body), self.assertRaises(RuntimeError):
                collector._ack(200, body, 1)

    def test_limit_threads_must_be_positive(self):
        with self.assertRaises(ValueError):
            collector.collect(
                self.home,
                "http://localhost:9",
                self.state,
                dry_run=True,
                limit_threads=0,
            )

    def test_token_file_is_opened_without_following_symlinks(self):
        target = self.home / "token"
        target.write_text("secret")
        target.chmod(0o600)
        link = self.home / "token-link"
        link.symlink_to(target)
        with self.assertRaises(ValueError):
            collector._token(link)

    def test_remote_live_collection_requires_token(self):
        with self.assertRaises(ValueError):
            collector.collect(self.home, "https://example.test", self.state)

    def test_cli_failure_has_nonzero_exit_status(self):
        token = self.home / "bad-token"
        token.write_text("secret")
        token.chmod(0o644)
        run = subprocess.run(
            [
                sys.executable,
                str(Path(collector.__file__)),
                "collect",
                "--codex-home",
                str(self.home),
                "--url",
                "https://example.test",
                "--state",
                str(self.state),
                "--token-file",
                str(token),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(run.returncode, 1)
        self.assertEqual(run.stderr, "collector failed\n")

    def test_completed_backfill_retries_persisted_gaps(self):
        path = self.home / "sessions" / "a.jsonl"
        path.write_text(
            json.dumps(
                {
                    "type": "session_meta",
                    "timestamp": "2026-01-01T00:00:00Z",
                    "payload": {"id": "019cbbc4-7fd4-7bca-9dc4-d63a3439189e"},
                }
            )
            + "\n{malformed}\n"
        )

        class Handler(BaseHTTPRequestHandler):
            def do_POST(inner):
                body = json.loads(
                    inner.rfile.read(int(inner.headers["Content-Length"]))
                )
                inner.send_response(200)
                inner.send_header("Content-Type", "application/json")
                inner.end_headers()
                inner.wfile.write(
                    json.dumps(
                        {"stored": len(body["records"]), "duplicate": 0}
                    ).encode()
                )

            def log_message(self, *_):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            first = collector.collect(
                self.home, f"http://127.0.0.1:{server.server_port}", self.state
            )
            normal = collector.collect(
                self.home, f"http://127.0.0.1:{server.server_port}", self.state
            )
            backfill = collector.collect(
                self.home,
                f"http://127.0.0.1:{server.server_port}",
                self.state,
                rescan=True,
            )
            again = collector.collect(
                self.home,
                f"http://127.0.0.1:{server.server_port}",
                self.state,
                rescan=True,
            )
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
        self.assertEqual(
            (first["gaps"], normal["gaps"], backfill["gaps"], again["gaps"]),
            (1, 0, 1, 1),
        )
        self.assertEqual(again["pending_gaps"], 1)

    def test_file_without_valid_session_metadata_is_a_pending_gap(self):
        (self.home / "sessions" / "broken.jsonl").write_text('{"type":"user"}\n')
        result = collector.collect(
            self.home, "http://localhost:9", self.state, dry_run=True
        )
        self.assertEqual(result["gaps"], 1)
        self.assertEqual(result["skipped_files"], 1)

    def test_explicit_file_outside_session_roots_is_rejected(self):
        outside = self.home / "outside.jsonl"
        outside.write_text("{}\n")
        with self.assertRaises(ValueError):
            collector.collect(
                self.home,
                "http://localhost:9",
                self.state,
                dry_run=True,
                includes=[outside],
            )

    def test_record_ids_use_native_id_or_timestamp_type_occurrence(self):
        self.write_session(
            "sessions/a.jsonl",
            [
                {
                    "type": "session_meta",
                    "timestamp": "2026-01-01T00:00:00Z",
                    "payload": {"id": "019cbbc4-7fd4-7bca-9dc4-d63a3439189e"},
                },
                {
                    "type": "user",
                    "timestamp": "2026-01-01T00:00:00Z",
                    "payload": {"text": "one"},
                },
                {
                    "type": "user",
                    "timestamp": "2026-01-01T00:00:00Z",
                    "payload": {"text": "two"},
                },
                {
                    "type": "event",
                    "timestamp": "2026-01-01T00:00:01Z",
                    "payload": {"id": "native-42", "text": "three"},
                },
            ],
        )
        ids = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(inner):
                body = json.loads(
                    inner.rfile.read(int(inner.headers["Content-Length"]))
                )
                ids.extend(record["id"] for record in body["records"])
                inner.send_response(200)
                inner.send_header("Content-Type", "application/json")
                inner.end_headers()
                inner.wfile.write(
                    json.dumps(
                        {"stored": len(body["records"]), "duplicate": 0}
                    ).encode()
                )

            def log_message(self, *_):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            collector.collect(
                self.home, f"http://127.0.0.1:{server.server_port}", self.state
            )
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
        self.assertEqual(
            ids,
            [
                "c1952676795c3ee72e42dcd356f0514cd4c7dbe54dacbbece5e0ddb1946a61f4",
                "cac275dd91bbed98f785a15aa87394cbe7849a4ab31e7b31cfc094161c61fd6f",
                "8dc45b6683fab9af648bea4affdfb97918725f7ac40d25b43c9d77c4de78795e",
                "aa16d7844113642ba5a4cbdb3b74b452acea15ed034a1e5a531aaaffa34d7a16",
            ],
        )

    def test_batches_are_capped_at_one_hundred_records(self):
        lines = [
            {
                "type": "session_meta",
                "timestamp": "2026-01-01T00:00:00Z",
                "payload": {"id": "019cbbc4-7fd4-7bca-9dc4-d63a3439189e"},
            }
        ]
        lines += [
            {
                "type": "user",
                "timestamp": f"2026-01-01T00:{index // 60:02d}:{index % 60:02d}Z",
                "payload": {"text": str(index)},
            }
            for index in range(101)
        ]
        self.write_session("sessions/a.jsonl", lines)
        sizes = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(inner):
                body = json.loads(
                    inner.rfile.read(int(inner.headers["Content-Length"]))
                )
                sizes.append(len(body["records"]))
                inner.send_response(200)
                inner.send_header("Content-Type", "application/json")
                inner.end_headers()
                inner.wfile.write(
                    json.dumps(
                        {"stored": len(body["records"]), "duplicate": 0}
                    ).encode()
                )

            def log_message(self, *_):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with mock.patch.object(collector, "_scanner", return_value=[]):
                collector.collect(
                    self.home, f"http://127.0.0.1:{server.server_port}", self.state
                )
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
        self.assertEqual(sizes, [100, 2])

    def test_missing_or_naive_timestamp_is_an_explicit_gap(self):
        self.write_session(
            "sessions/a.jsonl",
            [
                {
                    "type": "session_meta",
                    "payload": {"id": "019cbbc4-7fd4-7bca-9dc4-d63a3439189e"},
                },
                {
                    "type": "user",
                    "timestamp": "2026-01-01T00:00:00",
                    "payload": {"text": "naive"},
                },
                {
                    "type": "user",
                    "timestamp": "2026-01-01T00:00:00Z",
                    "payload": {"text": "valid"},
                },
            ],
        )
        result = collector.collect(
            self.home, "http://localhost:9", self.state, dry_run=True
        )
        self.assertEqual(result["records"], 1)
        self.assertEqual(result["gaps"], 2)

    def test_space_separator_timestamp_is_an_explicit_gap(self):
        self.write_session(
            "sessions/a.jsonl",
            [
                {
                    "type": "session_meta",
                    "timestamp": "2026-01-01T00:00:00Z",
                    "payload": {"id": "019cbbc4-7fd4-7bca-9dc4-d63a3439189e"},
                },
                {"type": "user", "timestamp": "2026-01-01 00:00:00+00:00"},
                {"type": "user", "timestamp": "2026-01-01T00:00:01Z"},
            ],
        )
        result = collector.collect(
            self.home, "http://localhost:9", self.state, dry_run=True
        )
        self.assertEqual(result["records"], 2)
        self.assertEqual(result["gaps"], 1)

    def test_nesting_depth_64_is_allowed_and_65_is_a_gap(self):
        def nested(depth):
            value = "leaf"
            for _ in range(depth):
                value = {"child": value}
            return value

        lines = [
            {
                "type": "session_meta",
                "timestamp": "2026-01-01T00:00:00Z",
                "payload": {"id": "019cbbc4-7fd4-7bca-9dc4-d63a3439189e"},
            },
            {
                "type": "user",
                "timestamp": "2026-01-01T00:00:01Z",
                "payload": nested(62),
            },
            {
                "type": "user",
                "timestamp": "2026-01-01T00:00:02Z",
                "payload": nested(63),
            },
            {
                "type": "user",
                "timestamp": "2026-01-01T00:00:03Z",
                "payload": nested(64),
            },
        ]
        self.write_session("sessions/a.jsonl", lines)
        with mock.patch.object(collector, "_scanner", return_value=[]):
            result = collector.collect(
                self.home, "http://localhost:9", self.state, dry_run=True
            )
        self.assertEqual(result["records"], 3)
        self.assertEqual(result["gaps"], 1)

    def test_non_finite_numbers_are_explicit_gaps(self):
        self.write_session(
            "sessions/a.jsonl",
            [
                {
                    "type": "session_meta",
                    "timestamp": "2026-01-01T00:00:00Z",
                    "payload": {"id": "019cbbc4-7fd4-7bca-9dc4-d63a3439189e"},
                },
                {
                    "type": "user",
                    "timestamp": "2026-01-01T00:00:01Z",
                    "payload": {"value": float("nan")},
                },
                {
                    "type": "user",
                    "timestamp": "2026-01-01T00:00:02Z",
                    "payload": {"value": 1e400},
                },
                {
                    "type": "user",
                    "timestamp": "2026-01-01T00:00:03Z",
                    "payload": {"value": 10**400},
                },
            ],
        )
        uploads = []

        def upload(_url, _token, payload):
            uploads.append(payload)
            return 200, {"stored": len(payload["records"]), "duplicate": 0}

        with (
            mock.patch.object(collector, "_scanner", return_value=[]),
            mock.patch.object(collector, "_upload", side_effect=upload),
        ):
            result = collector.collect(self.home, "http://localhost:9", self.state)
        self.assertEqual(result["records"], 1)
        self.assertEqual(result["gaps"], 3)
        self.assertEqual(result["pending_gaps"], 3)
        self.assertEqual(len(uploads[0]["records"]), 1)

    def test_nesting_gap_consumes_occurrence_for_backfill_stability(self):
        def nested(depth):
            value = "leaf"
            for _ in range(depth):
                value = {"child": value}
            return value

        metadata = {
            "type": "session_meta",
            "timestamp": "2026-01-01T00:00:00Z",
            "payload": {"id": "019cbbc4-7fd4-7bca-9dc4-d63a3439189e"},
        }
        deep = {
            "type": "user",
            "timestamp": "2026-01-01T00:00:01Z",
            "payload": nested(64),
        }
        following = {
            "type": "user",
            "timestamp": "2026-01-01T00:00:01Z",
            "payload": {"text": "following"},
        }
        path = self.write_session("sessions/a.jsonl", [metadata, deep, following])
        uploads = []

        def upload(_url, _token, payload):
            uploads.append(payload)
            return 200, {"stored": len(payload["records"]), "duplicate": 0}

        with mock.patch.object(collector, "_scanner", return_value=[]), mock.patch.object(
            collector, "_upload", side_effect=upload
        ):
            first = collector.collect(self.home, "http://localhost:9", self.state)
            self.assertEqual(first["gaps"], 1)
            path.write_text("\n".join(json.dumps(x) for x in [metadata, {**deep, "payload": nested(63)}, following]) + "\n")
            second = collector.collect(
                self.home, "http://localhost:9", self.state, rescan=True
            )
        self.assertEqual(second["gaps"], 0)
        first_following = [
            record
            for record in uploads[0]["records"]
            if record["text"] == "following"
        ]
        second_following = [
            record
            for record in uploads[1]["records"]
            if record["text"] == "following"
        ]
        self.assertEqual(len(first_following), 1)
        self.assertEqual(len(second_following), 1)
        self.assertEqual(first_following[0]["id"], second_following[0]["id"])

    def test_record_size_boundary_accepts_exact_limit_and_rejects_plus_one(self):
        def record_for(size):
            def make(length):
                item = {
                    "type": "user",
                    "timestamp": "2026-01-01T00:00:01Z",
                    "payload": {"text": "x" * length},
                }
                rec = {
                    "id": hashlib.sha256(
                        b"2026-01-01T00:00:01Z\0user\00"
                    ).hexdigest(),
                    "timestamp": item["timestamp"],
                    "text": "x" * length,
                    "record": item,
                }
                return item, len(
                    json.dumps(rec, ensure_ascii=False, separators=(",", ":")).encode()
                )

            _, base = make(0)
            delta = size - base
            self.assertEqual(delta % 2, 0)
            item, actual = make(delta // 2)
            self.assertEqual(actual, size)
            return item

        exact = record_for(collector.MAX_RECORD)
        oversize = {
            **exact,
            "payload": {"text": exact["payload"]["text"] + "x"},
        }
        self.write_session(
            "sessions/a.jsonl",
            [
                {
                    "type": "session_meta",
                    "timestamp": "2026-01-01T00:00:00Z",
                    "payload": {"id": "019cbbc4-7fd4-7bca-9dc4-d63a3439189e"},
                },
                exact,
                oversize,
            ],
        )
        with mock.patch.object(collector, "_scanner", return_value=[]):
            result = collector.collect(
                self.home, "http://localhost:9", self.state, dry_run=True
            )
        self.assertEqual(result["records"], 2)
        self.assertEqual(result["gaps"], 1)

    def test_encoded_secret_fails_closed_when_finding_cannot_be_mapped(self):
        encoded = "Z2hwXzEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDEyMzQ1Ng=="
        with self.assertRaises(collector.ScannerError):
            collector.sanitize({"payload": {"text": encoded}})

    def test_endpoint_requires_a_hostname(self):
        with self.assertRaises(ValueError):
            collector._endpoint("https:///api")

    def test_real_gitleaks_preserves_generic_key_value_context(self):
        token = "0123456789abcdef0123456789abcdef01234567"
        clean, changed = collector.sanitize({"api_key": token})
        self.assertEqual(clean, {"api_key": collector.REDACTION})
        self.assertEqual(changed, 1)

    def test_cli_reports_gap_counts_and_exits_nonzero(self):
        self.write_session(
            "sessions/a.jsonl",
            [
                {
                    "type": "session_meta",
                    "timestamp": "2026-01-01T00:00:00Z",
                    "payload": {"id": "019cbbc4-7fd4-7bca-9dc4-d63a3439189e"},
                },
                {"type": "user"},
            ],
        )
        run = subprocess.run(
            [
                sys.executable,
                str(Path(collector.__file__)),
                "collect",
                "--codex-home",
                str(self.home),
                "--url",
                "http://localhost:9",
                "--state",
                str(self.state),
                "--dry-run",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        summary = json.loads(run.stdout)
        self.assertEqual(run.returncode, 1)
        self.assertEqual(summary["gaps"], 1)
        self.assertNotIn(str(self.home), run.stdout + run.stderr)

    def test_scanner_runtime_errors_fail_closed(self):
        outcomes = [
            OSError("missing"),
            SimpleNamespace(returncode=2, stdout="[]"),
            SimpleNamespace(returncode=0, stdout="{"),
        ]
        for outcome in outcomes:
            with (
                self.subTest(outcome=outcome),
                mock.patch.object(
                    collector.subprocess,
                    "run",
                    side_effect=outcome if isinstance(outcome, Exception) else None,
                    return_value=None if isinstance(outcome, Exception) else outcome,
                ),
                self.assertRaises(collector.ScannerError),
            ):
                collector._scanner("safe")

    def test_token_and_endpoint_boundary_variants(self):
        self.assertIsNone(collector._token(None))
        token = self.home / "token"
        token.write_text("secret")
        token.chmod(0o600)
        self.assertEqual(collector._token(token), "secret")
        token.write_text("secret\nsecond")
        with self.assertRaises(ValueError):
            collector._token(token)
        token.write_bytes(b"x" * (16 * 1024 + 1))
        with self.assertRaises(ValueError):
            collector._token(token)
        for url in (
            "http://example.test",
            "https://user@example.test",
            "https://example.test/?query=yes",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                collector._endpoint(url)
        self.assertEqual(
            collector._endpoint("https://example.test/api/ingest/"),
            "https://example.test/api/ingest",
        )

    def test_state_helpers_and_resume_reject_stale_digest(self):
        state = collector.State(self.state)
        try:
            state.mark_deleted("https://example.test", "thread")
            self.assertTrue(state.deleted("https://example.test", "thread"))
            state.add_gap("https://example.test", "source", "thread", 1, 2, "bad")
            self.assertTrue(state.has_gaps("https://example.test", "source", "thread"))
            state.replace_gaps("https://example.test", "source", "thread", [])
            self.assertFalse(state.has_gaps("https://example.test", "source", "thread"))
        finally:
            state.close()
        offset, _, counts = collector._resume(
            io.BytesIO(b"abc"), (3, 0, 3, "wrong", {("t", "x"): 1}), 3
        )
        self.assertEqual((offset, counts), (0, {}))

    def test_launchd_cli_writes_private_plist_without_installing(self):
        output = self.home / "collector.plist"
        result = collector.main(
            [
                "launchd",
                "--codex-home",
                str(self.home),
                "--url",
                "https://example.test",
                "--state",
                str(self.state),
                "--output",
                str(output),
            ]
        )
        self.assertEqual(result, 0)
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        self.assertEqual(
            plistlib.loads(output.read_bytes())["Label"], "local.codex.collector"
        )


if __name__ == "__main__":
    unittest.main()
