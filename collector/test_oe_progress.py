import os
import stat
import tempfile
import unittest
from pathlib import Path

import oe_progress


class ProgressTests(unittest.TestCase):
    def test_state_file_created_with_private_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.sqlite3"
            previous = os.umask(0o022)
            try:
                progress = oe_progress.Progress(path)
            finally:
                os.umask(previous)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            progress.close()

    def test_checkpoint_after_ack_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.sqlite3"
            first = oe_progress.Progress(path)
            salt, finding = first.local_salt, first.finding_key
            self.assertEqual(len(salt), 32)
            self.assertEqual(len(finding), 32)
            self.assertNotEqual(salt, finding)
            first.close()
            second = oe_progress.Progress(path)
            self.assertEqual(second.local_salt, salt)
            self.assertEqual(second.finding_key, finding)
            second.close()

            before = set(Path(directory).iterdir())
            dry = oe_progress.Progress(Path(directory) / "missing.sqlite3", dry_run=True)
            dry.close()
            self.assertEqual(set(Path(directory).iterdir()), before)
            self.assertFalse((Path(directory) / "missing.sqlite3").exists())

    def test_checkpoint_after_ack(self):
        with tempfile.TemporaryDirectory() as directory:
            progress = oe_progress.Progress(Path(directory) / "state.sqlite3")
            record = {"node_id": "n"}
            node = oe_progress.node_key(progress.local_salt, "c", "n")
            scan = oe_progress.scan_key(progress.local_salt, record, "hello", "2020-01-01T00:00:00.000Z")
            self.assertFalse(progress.is_done("http://127.0.0.1:9", "t-1", node, scan))
            progress.mark_acked("http://127.0.0.1:9", "t-1", node, scan, "r1")
            self.assertTrue(progress.is_done("http://127.0.0.1:9", "t-1", node, scan))
            self.assertFalse(progress.is_done("http://127.0.0.1:9", "t-2", node, scan))
            changed = oe_progress.scan_key(
                progress.local_salt, record, "hello!", "2020-01-01T00:00:00.000Z"
            )
            self.assertNotEqual(scan, changed)
            self.assertFalse(progress.is_done("http://127.0.0.1:9", "t-1", node, changed))
            progress.close()


if __name__ == "__main__":
    unittest.main()
