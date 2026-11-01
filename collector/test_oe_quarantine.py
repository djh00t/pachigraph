import hashlib
import hmac
import unittest
from pathlib import Path
import tempfile

from collector import REDACTION, ScannerError, UnmappableFinding
import oe_quarantine
import oe_qstore


def _secret():
    return "".join(("syn", "thetic", "-secret-", "marker"))


def _scanner_for(secret, rule="generic-rule"):
    def scanner(text):
        return [{"RuleID": rule, "Secret": secret}] if secret in text else []

    return scanner


class RedactionTests(unittest.TestCase):
    def test_quarantine_split_redactions(self):
        secret = _secret()
        finding_key = b"k" * 32
        findings = [
            ("generic-rule", "/text", secret),
            ("generic-rule", "/text", secret),
            ("generic-rule", "/record/token~k", secret),
        ]
        entries = oe_quarantine.build_redactions(findings, finding_key)
        self.assertEqual(
            [item["path"] for item in entries],
            ["/record/token~k#0", "/text#0", "/text#1"],
        )
        expected = hmac.new(finding_key, secret.encode(), hashlib.sha256).hexdigest()[:32]
        self.assertTrue(all(item["fp"] == expected for item in entries))
        self.assertTrue(all(item["rule"] == "generic-rule" for item in entries))
        blob = str(entries)
        self.assertNotIn(secret, blob)
        self.assertNotIn(hashlib.sha256(secret.encode()).hexdigest(), blob)
        self.assertNotIn("length", entries[0])

    def test_quarantine_split(self):
        secret = _secret()
        events = []

        class Recording(oe_qstore.Store):
            def put_item(self, *args, **kwargs):
                item = super().put_item(*args, **kwargs)
                events.append("commit")
                return item

        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.sqlite3"
            state.write_bytes(b"")
            store = Recording(state)
            keys = {"local_salt": b"s" * 32, "finding_key": b"k" * 32}
            uploads = []

            def upload(payload):
                events.append("upload")
                uploads.append(payload)

            visible = {
                "record": {"role": "user"},
                "text": "hello " + secret,
                "timestamp": "2020-01-01T00:00:00.000Z",
            }
            hidden = {
                "record": {"visibility": "hidden", "content": {"parts": [secret]}},
                "text": "",
                "timestamp": "2020-01-01T00:00:00.000Z",
            }
            sanitized = []
            for index, envelope in enumerate((visible, hidden)):
                cleaned, counters = oe_quarantine.split(
                    envelope,
                    keys,
                    store,
                    _scanner_for(secret),
                    {
                        "tenant": "t-1",
                        "thread_id": "thread",
                        "record_id": f"r{index}",
                        "conversation_id": "c",
                        "node_id": f"n{index}",
                    },
                )
                self.assertEqual(counters["quarantined"], 1)
                upload(cleaned)
                sanitized.append(cleaned)
            self.assertEqual(events[:4], ["commit", "upload", "commit", "upload"])
            self.assertNotIn(secret, sanitized[0]["text"])
            self.assertIn(REDACTION, sanitized[0]["text"])
            self.assertNotIn(secret, str(sanitized[1]["record"]))
            self.assertIn(REDACTION, str(sanitized[1]["record"]["content"]))
            for payload in sanitized:
                self.assertFalse(oe_quarantine.uploaded_contains_secret(payload, secret))
                self.assertIn("fp", payload["record"]["redactions"][0])
            self.assertEqual(store.counts()[0], 2)
            original = store.db.execute("SELECT original FROM items").fetchone()[0]
            self.assertIn(secret, original)
            other = dict(visible, text="hello " + secret + "x")
            left, _ = oe_quarantine.split(
                visible, keys, None, _scanner_for(secret), _meta()
            )
            right, _ = oe_quarantine.split(
                other, keys, None, _scanner_for(secret + "x"), _meta()
            )
            # Same redacted shape can still differ when the secret, and therefore fp, differs.
            self.assertNotEqual(
                oe_quarantine.redacted_revision(left),
                oe_quarantine.redacted_revision(right),
            )

            def unmapped(_text):
                return [{"RuleID": "generic-rule", "Secret": "missing-from-text"}]

            events.clear()
            cleaned, counters = oe_quarantine.split(
                visible, keys, store, unmapped, _meta("only")
            )
            self.assertIsNone(cleaned)
            self.assertEqual(counters["quarantine_only"], 1)
            self.assertNotIn("upload", events)

            def crash(_text):
                raise ScannerError("secret scanner failed")

            with self.assertRaises(ScannerError):
                oe_quarantine.split(visible, keys, store, crash, _meta("crash"))
            store.close()


def _meta(suffix="m"):
    return {
        "tenant": "t-1",
        "thread_id": "thread",
        "record_id": suffix,
        "conversation_id": "c",
        "node_id": suffix,
    }


if __name__ == "__main__":
    unittest.main()
