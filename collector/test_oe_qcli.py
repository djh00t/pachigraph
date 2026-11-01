import io
import unittest
from pathlib import Path
import tempfile

import oe_qcli
import oe_qstore


def _secret():
    return "".join(("syn", "thetic", "-secret-", "marker"))


class QuarantineCommandTests(unittest.TestCase):
    def _store(self, directory):
        state = Path(directory) / "state.sqlite3"
        state.write_bytes(b"")
        store = oe_qstore.Store(state)
        store.put_item(
            {"record": {}, "text": _secret(), "timestamp": "2020-01-01T00:00:00.000Z"},
            [{"rule": "generic", "path": "/text#0", "fp": "ab" * 16}],
            salt=b"s" * 32,
            tenant="t-1",
            thread_id="thread-a",
            record_id="r",
            conversation_id="c",
            node_id="n",
        )
        return store

    def test_local_quarantine_list(self):
        with tempfile.TemporaryDirectory() as directory:
            store = self._store(directory)
            stdout = io.StringIO()
            oe_qcli.list_findings(store, stdout)
            text = stdout.getvalue()
            self.assertNotIn(_secret(), text)
            self.assertEqual(text.count("\n"), 1)
            self.assertIn("generic", text)
            self.assertIn("/text#0", text)
            self.assertIn("thread-a", text)
            store.close()

    def test_local_quarantine_show(self):
        with tempfile.TemporaryDirectory() as directory:
            store = self._store(directory)
            stdout = io.StringIO()
            stdout.isatty = lambda: False
            with self.assertRaises(oe_qstore.QuarantineError):
                oe_qcli.show_finding(store, 1, True, stdout)
            stdout = io.StringIO()
            stdout.isatty = lambda: True
            with self.assertRaises(oe_qstore.QuarantineError):
                oe_qcli.show_finding(store, 1, False, stdout)
            shown = io.StringIO()
            shown.isatty = lambda: True
            oe_qcli.show_finding(store, 1, True, shown)
            self.assertIn(_secret(), shown.getvalue())
            oe_qcli.purge(store, thread="thread-a")
            self.assertEqual(store.counts(), (0, 0))
            store.close()


if __name__ == "__main__":
    unittest.main()
