"""Local quarantine sqlite store. The server never sees these rows.

The findings primary key is (item_sha, path, fp). That differs from spec §5,
which names (item_sha, path). The extra column keeps two fingerprints that
share a path.
"""

import hmac
import hashlib
import os
import sqlite3
import stat
import time
from pathlib import Path

from oe_envelope import canonical


class QuarantineError(Exception):
    """Local quarantine failure. Maps to exit 7."""


def quarantine_path(state_path) -> Path:
    return Path(str(state_path) + ".quarantine")


def _check_directory(directory: Path):
    info = os.lstat(directory)
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise QuarantineError("quarantine directory rejected")
    if info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise QuarantineError("quarantine directory rejected")


def _check_file(path: Path):
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise QuarantineError("quarantine file rejected")
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise QuarantineError("quarantine file rejected")


class Store:
    def __init__(self, state_path, *, allow_missing_state: bool = False):
        self.state_path = Path(state_path)
        self.path = quarantine_path(self.state_path)
        _check_directory(self.state_path.parent)
        exists = self.path.exists() or self.path.is_symlink()
        if exists:
            _check_file(self.path)
            if not self.state_path.exists() and not allow_missing_state:
                raise QuarantineError("quarantine without state")
        else:
            descriptor = os.open(
                self.path, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600
            )
            os.close(descriptor)
        self.db = sqlite3.connect(self.path)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.execute("PRAGMA secure_delete = ON")
        self.db.execute("PRAGMA journal_mode = DELETE")
        self.db.execute(
            """CREATE TABLE IF NOT EXISTS items (
                item_sha TEXT PRIMARY KEY,
                tenant TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                record_id TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                node_id TEXT NOT NULL,
                original TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )"""
        )
        self.db.execute(
            """CREATE TABLE IF NOT EXISTS findings (
                item_sha TEXT NOT NULL REFERENCES items(item_sha) ON DELETE CASCADE,
                rule TEXT NOT NULL,
                path TEXT NOT NULL,
                fp TEXT NOT NULL,
                PRIMARY KEY (item_sha, path, fp)
            )"""
        )
        self.db.commit()

    def close(self):
        self.db.close()

    def put_item(
        self,
        original,
        findings,
        *,
        salt: bytes,
        tenant: str,
        thread_id: str,
        record_id: str,
        conversation_id: str,
        node_id: str,
        created_at: int | None = None,
    ) -> str:
        item_sha = hmac.new(
            salt, canonical(original).encode(), hashlib.sha256
        ).hexdigest()
        when = int(time.time() if created_at is None else created_at)
        self.db.execute(
            """INSERT INTO items
               (item_sha, tenant, thread_id, record_id, conversation_id, node_id, original, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (item_sha) DO NOTHING""",
            (
                item_sha,
                tenant,
                thread_id,
                record_id,
                conversation_id,
                node_id,
                canonical(original),
                when,
            ),
        )
        for finding in findings:
            self.db.execute(
                """INSERT INTO findings (item_sha, rule, path, fp)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT (item_sha, path, fp) DO NOTHING""",
                (item_sha, finding["rule"], finding["path"], finding["fp"]),
            )
        self.db.commit()
        return item_sha

    def purge_expired(self, days: int, *, now: float | None = None):
        self._check_days(days)
        cutoff = int((time.time() if now is None else now) - days * 86400)
        self.db.execute("DELETE FROM items WHERE created_at < ?", (cutoff,))
        self.db.commit()
        self.db.execute("VACUUM")

    def purge_thread(self, thread_id: str):
        self.db.execute("DELETE FROM items WHERE thread_id = ?", (thread_id,))
        self.db.commit()
        self.db.execute("VACUUM")

    def purge_all(self):
        self.db.execute("DELETE FROM items")
        self.db.commit()
        self.db.execute("VACUUM")

    def _check_days(self, days: int):
        if type(days) is not int or days < 1 or days > 365:
            raise QuarantineError("quarantine days rejected")

    def counts(self):
        items = self.db.execute("SELECT COUNT(*) FROM items").fetchone()[0]
        findings = self.db.execute("SELECT COUNT(*) FROM findings").fetchone()[0]
        return items, findings

    def list_findings(self, *, now: float | None = None):
        current = time.time() if now is None else now
        rows = []
        for row in self.db.execute(
            """SELECT i.created_at, f.rule, f.path, f.fp, i.thread_id, i.item_sha
                 FROM findings f JOIN items i ON i.item_sha = f.item_sha
                ORDER BY i.created_at, f.path, f.fp"""
        ):
            age = int((current - row["created_at"]) // 86400)
            rows.append(
                {
                    "age": age,
                    "rule": row["rule"],
                    "path": row["path"],
                    "fp": row["fp"],
                    "thread_id": row["thread_id"],
                    "item_sha": row["item_sha"],
                }
            )
        return rows

    def get_original(self, item_sha: str):
        row = self.db.execute(
            "SELECT original FROM items WHERE item_sha = ?", (item_sha,)
        ).fetchone()
        return None if row is None else row["original"]
