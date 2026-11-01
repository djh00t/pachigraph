import os
import stat
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import oe_qstore


def _secret():
    return "".join(("syn", "thetic", "-secret-", "marker"))


class QuarantineStoreTests(unittest.TestCase):
    def _state(self, directory):
        path = Path(directory) / "state.sqlite3"
        path.write_bytes(b"")
        os.chmod(path, 0o600)
        return path

    def test_local_quarantine_perms(self):
        with tempfile.TemporaryDirectory() as directory:
            state = self._state(directory)
            store = oe_qstore.Store(state)
            mode = stat.S_IMODE(os.stat(store.path).st_mode)
            self.assertEqual(mode, 0o600)
            self.assertEqual(store.path.name, "state.sqlite3.quarantine")
            store.close()

            loose = store.path
            os.chmod(loose, 0o644)
            with self.assertRaises(oe_qstore.QuarantineError):
                oe_qstore.Store(state)
            os.chmod(loose, 0o600)

            other = Path(directory) / "other.sqlite3"
            other.write_bytes(b"")
            other_q = oe_qstore.quarantine_path(other)
            # Replace a fresh store path with a symlink before open.
            if other_q.exists():
                other_q.unlink()
            other_q.symlink_to(loose)
            with self.assertRaises(oe_qstore.QuarantineError):
                oe_qstore.Store(other)
            other_q.unlink()

            real_lstat = os.lstat
            real = real_lstat(loose)

            def foreign(path):
                info = real_lstat(path)
                if str(path) == str(loose):
                    seq = list(info)
                    seq[4] = info.st_uid + 1
                    return os.stat_result(seq)
                return info

            with mock.patch("oe_qstore.os.lstat", side_effect=foreign):
                with self.assertRaises(oe_qstore.QuarantineError):
                    oe_qstore.Store(state)

            os.chmod(directory, 0o707)
            try:
                with self.assertRaises(oe_qstore.QuarantineError):
                    oe_qstore.Store(state)
            finally:
                os.chmod(directory, 0o700)

            state.unlink()
            with self.assertRaises(oe_qstore.QuarantineError):
                oe_qstore.Store(state)

    def test_local_quarantine_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            state = self._state(directory)
            store = oe_qstore.Store(state)
            salt = b"s" * 32
            original = {"record": {"a": 1}, "text": _secret(), "timestamp": "2020-01-01T00:00:00.000Z"}
            findings = [{"rule": "generic", "path": "/text#0", "fp": "ab" * 16}]
            kwargs = dict(
                salt=salt,
                tenant="t-1",
                thread_id="thread",
                record_id="r",
                conversation_id="c",
                node_id="n",
            )
            first = store.put_item(original, findings, **kwargs)
            second = store.put_item(original, findings, **kwargs)
            self.assertEqual(first, second)
            self.assertEqual(store.counts(), (1, 1))
            store.db.execute("DELETE FROM items WHERE item_sha=?", (first,))
            store.db.commit()
            self.assertEqual(store.counts(), (0, 0))
            self.assertEqual(store.db.execute("PRAGMA secure_delete").fetchone()[0], 1)
            self.assertEqual(
                str(store.db.execute("PRAGMA journal_mode").fetchone()[0]).lower(),
                "delete",
            )
            self.assertFalse(Path(str(store.path) + "-wal").exists())
            store.close()

    def test_local_quarantine_purge(self):
        with tempfile.TemporaryDirectory() as directory:
            state = self._state(directory)
            store = oe_qstore.Store(state)
            secret = _secret()
            old = {
                "record": {},
                "text": secret,
                "timestamp": "2020-01-01T00:00:00.000Z",
            }
            store.put_item(
                old,
                [{"rule": "generic", "path": "/text#0", "fp": "cd" * 16}],
                salt=b"s" * 32,
                tenant="t-1",
                thread_id="thread-a",
                record_id="r",
                conversation_id="c",
                node_id="n",
                created_at=int(time.time()) - 40 * 86400,
            )
            keep = {"record": {}, "text": "plain", "timestamp": "2020-01-01T00:00:00.000Z"}
            store.put_item(
                keep,
                [{"rule": "generic", "path": "/text#0", "fp": "ef" * 16}],
                salt=b"s" * 32,
                tenant="t-1",
                thread_id="thread-b",
                record_id="r2",
                conversation_id="c2",
                node_id="n2",
                created_at=int(time.time()),
            )
            store.purge_expired(30)
            blob = store.path.read_bytes()
            self.assertNotIn(secret.encode(), blob)
            self.assertEqual(store.counts()[0], 1)
            store.purge_thread("thread-b")
            self.assertEqual(store.counts(), (0, 0))
            with self.assertRaises(oe_qstore.QuarantineError):
                store.purge_expired(0)
            with self.assertRaises(oe_qstore.QuarantineError):
                store.purge_expired(366)
            store.close()

            state.unlink()
            with self.assertRaises(oe_qstore.QuarantineError):
                oe_qstore.Store(state)
            opened = oe_qstore.Store(state, allow_missing_state=True)
            opened.put_item(
                old,
                [{"rule": "generic", "path": "/text#0", "fp": "11" * 16}],
                salt=b"s" * 32,
                tenant="t-1",
                thread_id="thread-a",
                record_id="r",
                conversation_id="c",
                node_id="n",
            )
            opened.purge_all()
            self.assertEqual(opened.counts(), (0, 0))
            self.assertNotIn(secret.encode(), opened.path.read_bytes())
            opened.close()


if __name__ == "__main__":
    unittest.main()
