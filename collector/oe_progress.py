"""Local checkpoint keys for openai-export. A dry run keeps them in memory."""

import hmac
import hashlib
import os
import sqlite3
from pathlib import Path

from oe_envelope import canonical


def node_key(local_salt: bytes, conversation_id: str, node_id: str) -> str:
    message = f"chatgpt\n{conversation_id}\n{node_id}".encode()
    return hmac.new(local_salt, message, hashlib.sha256).hexdigest()


def scan_key(local_salt: bytes, record, text: str, timestamp: str) -> str:
    payload = canonical({"record": record, "text": text, "timestamp": timestamp})
    return hmac.new(local_salt, payload.encode(), hashlib.sha256).hexdigest()


class Progress:
    def __init__(self, path, *, dry_run: bool = False):
        self.dry_run = dry_run
        self.path = None if dry_run else Path(path)
        if dry_run:
            self.db = sqlite3.connect(":memory:")
        else:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.db = sqlite3.connect(str(self.path))
            os.chmod(self.path, 0o600)
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS oe_keys (name TEXT PRIMARY KEY, value BLOB NOT NULL)"
        )
        self.db.execute(
            """CREATE TABLE IF NOT EXISTS oe_progress (
                url TEXT NOT NULL,
                tenant TEXT NOT NULL,
                node_key TEXT NOT NULL,
                scan_key TEXT NOT NULL,
                revision TEXT NOT NULL,
                PRIMARY KEY (url, tenant, node_key, scan_key)
            )"""
        )
        self.db.execute(
            """CREATE TABLE IF NOT EXISTS oe_tombstone (
                url TEXT NOT NULL,
                tenant TEXT NOT NULL,
                thread TEXT NOT NULL,
                PRIMARY KEY (url, tenant, thread)
            )"""
        )
        self._ensure_keys()
        self.db.commit()

    def _ensure_keys(self):
        rows = dict(self.db.execute("SELECT name, value FROM oe_keys"))
        if "local_salt" in rows and "finding_key" in rows:
            self.local_salt = rows["local_salt"]
            self.finding_key = rows["finding_key"]
            return
        self.local_salt = os.urandom(32)
        self.finding_key = os.urandom(32)
        self.db.execute(
            "INSERT INTO oe_keys (name, value) VALUES ('local_salt', ?), ('finding_key', ?)",
            (self.local_salt, self.finding_key),
        )

    def close(self):
        self.db.close()

    def is_done(self, url, tenant, node, scan) -> bool:
        row = self.db.execute(
            """SELECT 1 FROM oe_progress
                WHERE url=? AND tenant=? AND node_key=? AND scan_key=?""",
            (url, tenant, node, scan),
        ).fetchone()
        return row is not None

    def mark_acked(self, url, tenant, node, scan, revision):
        self.db.execute(
            """INSERT INTO oe_progress (url, tenant, node_key, scan_key, revision)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (url, tenant, node_key, scan_key)
               DO UPDATE SET revision=excluded.revision""",
            (url, tenant, node, scan, revision),
        )
        self.db.commit()

    def is_tombstoned(self, url, tenant, thread) -> bool:
        row = self.db.execute(
            "SELECT 1 FROM oe_tombstone WHERE url=? AND tenant=? AND thread=?",
            (url, tenant, thread),
        ).fetchone()
        return row is not None

    def mark_tombstone(self, url, tenant, thread):
        self.db.execute(
            "INSERT OR IGNORE INTO oe_tombstone (url, tenant, thread) VALUES (?, ?, ?)",
            (url, tenant, thread),
        )
        self.db.commit()
