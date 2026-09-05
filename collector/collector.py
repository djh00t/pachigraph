#!/usr/bin/env python3
# ruff: noqa: B023 - per-file closures run before the surrounding loop advances.
"""Bounded, fail-closed importer for local Codex JSONL sessions."""

import argparse
import datetime
import hashlib
import json
import math
import os
import plistlib
import re
import sqlite3
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Sequence
from pathlib import Path

MAX_RECORD = 384 * 1024
MAX_REQUEST = 512 * 1024
MAX_LINE = MAX_RECORD * 2
MAX_BATCH = 100
REDACTION = "[REDACTED]"
UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
)
ISO_TIMESTAMP = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$"
)


class ScannerError(RuntimeError):
    """Report a scanner failure that must stop collection."""


def _scanner(text):
    args = [
        "/opt/homebrew/bin/gitleaks",
        "stdin",
        "--report-format",
        "json",
        "--report-path",
        "-",
        "--exit-code",
        "0",
        "--no-banner",
        "--log-level",
        "error",
        "--ignore-gitleaks-allow",
        "--gitleaks-ignore-path",
        "/dev/null",
        "--max-decode-depth",
        "3",
    ]
    env = {
        k: v
        for k, v in os.environ.items()
        if k not in ("GITLEAKS_CONFIG", "GITLEAKS_CONFIG_TOML")
    }
    try:
        with tempfile.TemporaryDirectory() as cwd:
            p = subprocess.run(
                args,
                input=text,
                text=True,
                capture_output=True,
                env=env,
                cwd=cwd,
                timeout=30,
                check=False,
            )
    except (OSError, subprocess.SubprocessError) as exc:
        raise ScannerError("secret scanner failed") from exc
    if p.returncode != 0:
        raise ScannerError("secret scanner failed")
    try:
        return json.loads(p.stdout or "[]")
    except json.JSONDecodeError as exc:
        raise ScannerError("secret scanner returned invalid report") from exc


def _strings(value):
    strings = []

    def walk(item):
        if isinstance(item, str):
            strings.append(item)
        elif isinstance(item, dict):
            for key, child in item.items():
                strings.append(str(key))
                walk(child)
        elif isinstance(item, list):
            for child in item:
                walk(child)

    walk(value)
    return strings


def _findings(scanner, value):
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    findings = scanner(
        "CODEX-COLLECTOR-RECORD\n" + encoded + "\n" + "\n".join(_strings(value))
    )
    if not isinstance(findings, list) or any(not isinstance(f, dict) for f in findings):
        raise ScannerError("secret scanner returned invalid report")
    return findings


def sanitize(
    value: object, scanner: Callable[[str], object] | None = None
) -> tuple[object, int]:
    """Scan decoded strings, redact exact secrets recursively, then scan again."""
    scanner = scanner or _scanner
    findings = _findings(scanner, value)
    secrets = []
    source_strings = _strings(value)
    for finding in findings:
        secret = finding.get("Secret") or finding.get("Match")
        if not isinstance(secret, str) or not secret or secret == REDACTION:
            raise ScannerError("secret scanner returned invalid finding")
        if not any(secret in text for text in source_strings):
            raise ScannerError("secret scanner finding cannot be mapped")
        secrets.append(secret)
    secrets = sorted(set(secrets), key=len, reverse=True)
    changed = 0

    def clean(item):
        nonlocal changed
        if isinstance(item, str):
            for secret in secrets:
                count = item.count(secret)
                if count:
                    changed += count
                    item = item.replace(secret, REDACTION)
            return item
        if isinstance(item, list):
            return [clean(child) for child in item]
        if isinstance(item, dict):
            result = {}
            for key, child in item.items():
                new_key = clean(str(key))
                if new_key in result:
                    raise ScannerError("redaction creates duplicate dictionary key")
                result[new_key] = clean(child)
            return result
        return item

    cleaned = clean(value)
    if _findings(scanner, cleaned):
        raise ScannerError("secret remains after redaction")
    return cleaned, changed


def _text(value):
    parts = []

    def walk(v, key=""):
        if isinstance(v, str) and (
            not key
            or key.lower()
            in {
                "user",
                "assistant",
                "tool",
                "output",
                "message",
                "text",
                "content",
                "prompt",
                "response",
            }
        ):
            parts.append(v)
        elif isinstance(v, dict):
            for k, x in v.items():
                walk(x, str(k))
        elif isinstance(v, list):
            for x in v:
                walk(x, key)

    walk(value)
    return "\n".join(parts)


def _timestamp(record):
    for key in ("timestamp", "created_at", "time", "ts"):
        if isinstance(record.get(key), str):
            return record[key]
    payload = record.get("payload")
    if isinstance(payload, dict):
        for key in ("timestamp", "created_at", "time", "ts"):
            if isinstance(payload.get(key), str):
                return payload[key]
    return ""


def _valid_timestamp(value):
    if not isinstance(value, str) or not ISO_TIMESTAMP.fullmatch(value):
        return False
    try:
        parsed = datetime.datetime.fromisoformat(
            value[:-1] + "+00:00" if value.endswith("Z") else value
        )
    except ValueError:
        return False
    return parsed.tzinfo is not None and parsed.utcoffset() is not None


def _record_error(value, maximum=64):
    pending = [(value, 0)]
    while pending:
        item, depth = pending.pop()
        if depth > maximum:
            return "nesting-depth"
        if isinstance(item, (int, float)) and not isinstance(item, bool):
            try:
                if not math.isfinite(item):
                    return "non-finite-number"
            except OverflowError:
                return "non-finite-number"
        if isinstance(item, dict):
            pending.extend((child, depth + 1) for child in item.values())
        elif isinstance(item, list):
            pending.extend((child, depth + 1) for child in item)
    return None


def _type(record):
    return str(record.get("type") or record.get("event") or "record")


def _native_id(record):
    if _type(record) == "session_meta":
        return None
    for key in ("record_id", "event_id", "uuid", "id"):
        if isinstance(record.get(key), (str, int)):
            return str(record[key])
    payload = record.get("payload")
    if isinstance(payload, dict):
        for key in ("record_id", "event_id", "uuid", "id"):
            if isinstance(payload.get(key), (str, int)):
                return str(payload[key])
    return None


def discover(
    home: str | os.PathLike[str],
    includes: Sequence[str | os.PathLike[str]] | None = None,
) -> list[Path]:
    """Return safe JSONL files selected from the two Codex session roots."""
    roots = [Path(home) / "sessions", Path(home) / "archived_sessions"]
    resolved_roots = [
        root.resolve() for root in roots if root.is_dir() and not root.is_symlink()
    ]
    candidates = []
    if includes:
        candidates = [Path(path) for path in includes]
    else:
        for root in roots:
            if not root.is_dir():
                continue
            for directory, names, files in os.walk(root, followlinks=False):
                names[:] = [
                    name for name in names if not Path(directory, name).is_symlink()
                ]
                candidates.extend(Path(directory, name) for name in files)
    found = []
    for path in candidates:
        try:
            metadata = path.lstat()
            resolved = path.resolve(strict=True)
        except OSError:
            if includes:
                raise ValueError("included file is not safe to read")
            continue
        if (
            path.suffix != ".jsonl"
            or not stat.S_ISREG(metadata.st_mode)
            or path.is_symlink()
        ):
            if includes:
                raise ValueError("included file is not a regular JSONL file")
            continue
        if not any(resolved.is_relative_to(root) for root in resolved_roots):
            if includes:
                raise ValueError("included file is outside Codex session roots")
            continue
        found.append(path)
    return sorted(set(found))


def _bounded_lines(fh, hasher=None):
    """Yield bounded complete lines with their exact byte boundaries."""
    while True:
        start = fh.tell()
        raw = fh.readline(MAX_LINE + 1)
        if not raw:
            return
        if raw.endswith(b"\n"):
            if hasher:
                hasher.update(raw)
            yield raw, True, start, fh.tell()
            continue
        if len(raw) <= MAX_LINE:
            yield raw, False, start, start
            return
        if hasher:
            hasher.update(raw)
        while raw and not raw.endswith(b"\n"):
            raw = fh.readline(MAX_LINE + 1)
            if hasher and raw:
                hasher.update(raw)
        if raw:
            yield b"", True, start, fh.tell()
            continue
        else:
            yield b"", False, start, start
            return


class State:
    """Store upload progress, occurrence counters, gaps, and tombstones."""

    def __init__(self, path: str | os.PathLike[str]):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path))
        os.chmod(path, 0o600)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS progress (url TEXT, source TEXT, thread TEXT, mode TEXT, size INTEGER, mtime INTEGER, offset INTEGER, digest TEXT, PRIMARY KEY(url,source,thread,mode))"
        )
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS occurrence (url TEXT, source TEXT, thread TEXT, mode TEXT, timestamp TEXT, type TEXT, count INTEGER, PRIMARY KEY(url,source,thread,mode,timestamp,type))"
        )
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS gap (url TEXT, source TEXT, thread TEXT, start INTEGER, end INTEGER, reason TEXT, PRIMARY KEY(url,source,thread,start,end))"
        )
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS tombstone (url TEXT, thread TEXT, PRIMARY KEY(url,thread))"
        )
        self.db.commit()

    def progress(self, url, source, thread, mode):
        row = self.db.execute(
            "SELECT size,mtime,offset,digest FROM progress WHERE url=? AND source=? AND thread=? AND mode=?",
            (url, source, thread, mode),
        ).fetchone()
        if not row:
            return None
        counts = {
            (timestamp, kind): count
            for timestamp, kind, count in self.db.execute(
                "SELECT timestamp,type,count FROM occurrence WHERE url=? AND source=? AND thread=? AND mode=?",
                (url, source, thread, mode),
            )
        }
        return row + (counts,)

    def set_progress(
        self,
        url,
        source,
        thread,
        mode,
        size,
        mtime,
        offset,
        digest,
        counts,
        dirty,
        reset=False,
    ):
        with self.db:
            if reset:
                self.db.execute(
                    "DELETE FROM occurrence WHERE url=? AND source=? AND thread=? AND mode=?",
                    (url, source, thread, mode),
                )
            self.db.executemany(
                "INSERT OR REPLACE INTO occurrence VALUES (?,?,?,?,?,?,?)",
                [
                    (url, source, thread, mode, key[0], key[1], counts[key])
                    for key in dirty
                ],
            )
            self.db.execute(
                "INSERT OR REPLACE INTO progress VALUES (?,?,?,?,?,?,?,?)",
                (url, source, thread, mode, size, mtime, offset, digest),
            )

    def add_gap(self, url, source, thread, start, end, reason):
        self.db.execute(
            "INSERT OR REPLACE INTO gap VALUES (?,?,?,?,?,?)",
            (url, source, thread, start, end, reason),
        )
        self.db.commit()

    def replace_gaps(self, url, source, thread, gaps):
        with self.db:
            self.db.execute(
                "DELETE FROM gap WHERE url=? AND source=? AND thread=?",
                (url, source, thread),
            )
            self.db.executemany(
                "INSERT INTO gap VALUES (?,?,?,?,?,?)",
                [(url, source, thread, *gap) for gap in gaps],
            )

    def pending_gaps(self, url):
        return self.db.execute(
            "SELECT count(*) FROM gap WHERE url=?", (url,)
        ).fetchone()[0]

    def has_gaps(self, url, source, thread):
        return (
            self.db.execute(
                "SELECT 1 FROM gap WHERE url=? AND source=? AND thread=? LIMIT 1",
                (url, source, thread),
            ).fetchone()
            is not None
        )

    def deleted(self, url, thread):
        return (
            self.db.execute(
                "SELECT 1 FROM tombstone WHERE url=? AND thread=?", (url, thread)
            ).fetchone()
            is not None
        )

    def mark_deleted(self, url, thread):
        self.db.execute("INSERT OR IGNORE INTO tombstone VALUES (?,?)", (url, thread))
        self.db.commit()

    def close(self):
        self.db.close()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Reject redirects so credentials never move to another endpoint."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(
            req.full_url, code, "redirect refused", headers, fp
        )


def _endpoint(url):
    parsed = urllib.parse.urlparse(url)
    if (
        not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.fragment
        or parsed.query
        or parsed.scheme not in {"https", "http"}
    ):
        raise ValueError("invalid endpoint")
    if parsed.scheme == "http" and parsed.hostname not in {
        "localhost",
        "127.0.0.1",
        "::1",
    }:
        raise ValueError("HTTPS required")
    return (
        url.rstrip("/")
        if parsed.path.rstrip("/").endswith("/api/ingest")
        else url.rstrip("/") + "/api/ingest"
    )


def _upload(url, token, payload):
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    if len(data) > MAX_REQUEST:
        raise ValueError("request exceeds limit")
    _endpoint(url)
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(
        _endpoint(url), data=data, headers=headers, method="POST"
    )
    try:
        with urllib.request.build_opener(NoRedirect()).open(
            req, timeout=30
        ) as response:
            body = response.read(1024 * 1024)
            return response.status, json.loads(body or b"{}")
    except urllib.error.HTTPError as exc:
        exc.close()
        if exc.code == 410:
            return 410, {}
        raise RuntimeError("upload failed") from exc
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError("upload failed") from exc


def _ack(status, body, expected):
    if not 200 <= status < 300 or not isinstance(body, dict):
        raise RuntimeError("upload failed")
    stored, duplicate = body.get("stored"), body.get("duplicate")
    if (
        type(stored) is not int
        or type(duplicate) is not int
        or stored < 0
        or duplicate < 0
        or stored + duplicate != expected
    ):
        raise RuntimeError("upload acknowledgement invalid")


def _token(path):
    if not path:
        return None
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
        try:
            metadata = os.fstat(descriptor)
            if (
                not stat.S_ISREG(metadata.st_mode)
                or metadata.st_uid != os.getuid()
                or stat.S_IMODE(metadata.st_mode) != 0o600
            ):
                raise ValueError("token file permissions invalid")
            chunks = []
            remaining = 16 * 1024 + 1
            while remaining:
                chunk = os.read(descriptor, remaining)
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            data = b"".join(chunks)
        finally:
            os.close(descriptor)
    except ValueError:
        raise
    except OSError as exc:
        raise ValueError("token file cannot be read safely") from exc
    if len(data) > 16 * 1024:
        raise ValueError("token invalid")
    try:
        token = data.decode()
    except UnicodeDecodeError as exc:
        raise ValueError("token invalid") from exc
    if not token.strip() or "\n" in token or "\r" in token:
        raise ValueError("token invalid")
    return token.strip()


def _local_endpoint(url):
    return urllib.parse.urlparse(_endpoint(url)).hostname in {
        "localhost",
        "127.0.0.1",
        "::1",
    }


def _resume(fh, progress, size):
    hasher = hashlib.sha256()
    if not progress:
        return 0, hasher, {}
    _, _, offset, expected, counts = progress
    if offset < 0 or offset > size:
        return 0, hasher, {}
    remaining = offset
    while remaining:
        chunk = fh.read(min(1024 * 1024, remaining))
        if not chunk:
            return 0, hashlib.sha256(), {}
        hasher.update(chunk)
        remaining -= len(chunk)
    if hasher.hexdigest() != expected:
        fh.seek(0)
        return 0, hashlib.sha256(), {}
    return offset, hasher, counts


def collect(
    home: str | os.PathLike[str],
    url: str,
    state_path: str | os.PathLike[str],
    token: str | None = None,
    dry_run: bool = False,
    limit_threads: int | None = None,
    rescan: bool = False,
    includes: Sequence[str | os.PathLike[str]] | None = None,
) -> dict[str, int]:
    """Sanitize and upload eligible session records with resumable state."""
    _endpoint(url)
    if limit_threads is not None and (
        type(limit_threads) is not int or limit_threads <= 0
    ):
        raise ValueError("limit-threads must be positive")
    if not dry_run and not _local_endpoint(url) and not token:
        raise ValueError("token required for remote upload")
    state = State(state_path)
    stats = {
        "threads": 0,
        "records": 0,
        "redacted": 0,
        "gaps": 0,
        "batches": 0,
        "skipped_files": 0,
    }
    try:
        for path in discover(home, includes):
            try:
                descriptor = os.open(
                    path,
                    os.O_RDONLY
                    | getattr(os, "O_CLOEXEC", 0)
                    | getattr(os, "O_NOFOLLOW", 0),
                )
            except OSError:
                continue
            with os.fdopen(descriptor, "rb") as fh:
                metadata = os.fstat(fh.fileno())
                if not stat.S_ISREG(metadata.st_mode):
                    continue
                source = hashlib.sha256(str(path.resolve()).encode()).hexdigest()
                thread = None
                for raw, complete, _, _ in _bounded_lines(fh):
                    if not complete:
                        break
                    if not raw:
                        continue
                    try:
                        item = json.loads(raw)
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        continue
                    if isinstance(item, dict) and _type(item) == "session_meta":
                        payload = item.get("payload")
                        if isinstance(payload, dict) and payload.get("id"):
                            thread = str(payload["id"])
                            break
                if not thread or not UUID_RE.fullmatch(thread):
                    stats["gaps"] += 1
                    stats["skipped_files"] += 1
                    if not dry_run:
                        state.add_gap(
                            url,
                            source,
                            "",
                            0,
                            metadata.st_size,
                            "missing-valid-session-metadata",
                        )
                    continue
                if state.deleted(url, thread):
                    continue
                if limit_threads is not None and stats["threads"] >= limit_threads:
                    break
                stats["threads"] += 1
                mode = "backfill" if rescan else "normal"
                fh.seek(0)
                saved = None if dry_run else state.progress(url, source, thread, mode)
                offset, hasher, counts = _resume(fh, saved, metadata.st_size)
                if (
                    rescan
                    and offset == metadata.st_size
                    and state.has_gaps(url, source, thread)
                ):
                    fh.seek(0)
                    offset, hasher, counts = 0, hashlib.sha256(), {}
                full_pass = offset == 0
                reset_counts = full_pass
                dirty_counts = set()
                batch = []
                batch_end = offset
                batch_digest = hasher.hexdigest()
                last_end = offset
                last_digest = batch_digest
                seen_gaps = []
                complete_file = True
                tombstoned = False
                checkpoint_end = offset

                # Both closures run synchronously before the file-loop advances.
                def save_progress(end, digest, saved_counts):
                    nonlocal checkpoint_end, reset_counts
                    current = os.fstat(fh.fileno())
                    state.set_progress(
                        url,
                        source,
                        thread,
                        mode,
                        current.st_size,
                        current.st_mtime_ns,
                        end,
                        digest,
                        saved_counts,
                        dirty_counts,
                        reset_counts,
                    )
                    dirty_counts.clear()
                    reset_counts = False
                    checkpoint_end = end

                def flush():
                    nonlocal batch, tombstoned
                    if not batch:
                        return
                    if not dry_run:
                        status, body = _upload(
                            url, token, {"thread_id": thread, "records": batch}
                        )
                        if status == 410:
                            state.mark_deleted(url, thread)
                            tombstoned = True
                            batch = []
                            return
                        _ack(status, body, len(batch))
                        save_progress(batch_end, batch_digest, counts)
                    stats["batches"] += 1
                    batch = []

                for raw, complete, start, end in _bounded_lines(fh, hasher):
                    if not complete:
                        complete_file = False
                        break
                    reason = None
                    item = None
                    if not raw:
                        reason = "oversized-line"
                    else:
                        try:
                            item = json.loads(raw)
                        except (UnicodeDecodeError, json.JSONDecodeError):
                            reason = "malformed-json"
                        if item is not None and not isinstance(item, dict):
                            reason = "non-object"
                        elif item is not None:
                            reason = _record_error(item)
                    if reason:
                        if reason in {"nesting-depth", "non-finite-number"}:
                            ts, typ = _timestamp(item), _type(item)
                            if _valid_timestamp(ts):
                                key = (ts, typ)
                                counts[key] = counts.get(key, 0) + 1
                                dirty_counts.add(key)
                        stats["gaps"] += 1
                        seen_gaps.append((start, end, reason))
                        if not dry_run:
                            state.add_gap(url, source, thread, start, end, reason)
                        last_end, last_digest = end, hasher.hexdigest()
                        if batch:
                            batch_end, batch_digest = last_end, last_digest
                        continue

                    ts, typ = _timestamp(item), _type(item)
                    if not _valid_timestamp(ts):
                        stats["gaps"] += 1
                        reason = "invalid-timestamp"
                        seen_gaps.append((start, end, reason))
                        if not dry_run:
                            state.add_gap(url, source, thread, start, end, reason)
                        last_end, last_digest = end, hasher.hexdigest()
                        if batch:
                            batch_end, batch_digest = last_end, last_digest
                        continue
                    occurrence = counts.get((ts, typ), 0)
                    clean, redacted = sanitize(item)
                    stats["redacted"] += redacted
                    native = _native_id(item)
                    logical_id = native or f"{ts}\0{typ}\0{occurrence}"
                    rec = {
                        "id": hashlib.sha256(logical_id.encode()).hexdigest(),
                        "timestamp": ts,
                        "text": _text(clean),
                        "record": clean,
                    }
                    if (
                        len(
                            json.dumps(
                                rec, ensure_ascii=False, separators=(",", ":")
                            ).encode()
                        )
                        > MAX_RECORD
                    ):
                        counts[(ts, typ)] = occurrence + 1
                        dirty_counts.add((ts, typ))
                        stats["gaps"] += 1
                        reason = "oversized-record"
                        seen_gaps.append((start, end, reason))
                        if not dry_run:
                            state.add_gap(url, source, thread, start, end, reason)
                        last_end, last_digest = end, hasher.hexdigest()
                        if batch:
                            batch_end, batch_digest = last_end, last_digest
                        continue
                    request = {"thread_id": thread, "records": batch + [rec]}
                    if (
                        len(batch) >= MAX_BATCH
                        or len(
                            json.dumps(
                                request, ensure_ascii=False, separators=(",", ":")
                            ).encode()
                        )
                        > MAX_REQUEST
                    ):
                        flush()
                        if tombstoned:
                            break
                    counts[(ts, typ)] = occurrence + 1
                    dirty_counts.add((ts, typ))
                    batch.append(rec)
                    stats["records"] += 1
                    last_end, last_digest = end, hasher.hexdigest()
                    batch_end, batch_digest = last_end, last_digest
                if tombstoned:
                    continue
                flush()
                if tombstoned:
                    continue
                if not dry_run and not batch and last_end > checkpoint_end:
                    save_progress(last_end, last_digest, counts)
                if not dry_run and full_pass and complete_file:
                    state.replace_gaps(url, source, thread, seen_gaps)
                    state.replace_gaps(url, source, "", [])
    finally:
        state.close()
    check = State(state_path)
    try:
        stats["pending_gaps"] = check.pending_gaps(url)
    finally:
        check.close()
    return stats


def launchd_plist(
    home: str | os.PathLike[str],
    url: str,
    state: str | os.PathLike[str],
    token_file: str | os.PathLike[str] | None = None,
) -> bytes:
    """Build a daily launchd property list without embedding token contents."""
    args = [
        sys.executable,
        str(Path(__file__).resolve()),
        "collect",
        "--codex-home",
        str(home),
        "--url",
        url,
        "--state",
        str(state),
    ]
    if token_file:
        args += ["--token-file", str(token_file)]
    return plistlib.dumps(
        {
            "Label": "local.codex.collector",
            "ProgramArguments": args,
            "StartCalendarInterval": {"Hour": 3, "Minute": 0},
            "RunAtLoad": True,
        }
    )


def main(argv: list[str] | None = None) -> int:
    """Run the collector command-line interface."""
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    c = sub.add_parser("collect")
    c.add_argument("--codex-home", default=str(Path.home() / ".codex"))
    c.add_argument("--url", required=True)
    c.add_argument("--token-file")
    c.add_argument("--state", default=str(Path.home() / ".codex" / "collector.sqlite3"))
    c.add_argument("--limit-threads", type=int)
    c.add_argument("--file", action="append", dest="includes")
    c.add_argument("--dry-run", action="store_true")
    c.add_argument("--rescan", "--backfill", action="store_true")
    l = sub.add_parser("launchd")
    l.add_argument("--codex-home", default=str(Path.home() / ".codex"))
    l.add_argument("--url", required=True)
    l.add_argument("--state", required=True)
    l.add_argument("--token-file")
    l.add_argument("--output", required=True)
    l.add_argument("--install", action="store_true")
    a = parser.parse_args(argv)
    try:
        if a.command == "collect":
            result = collect(
                a.codex_home,
                a.url,
                a.state,
                _token(a.token_file),
                a.dry_run,
                a.limit_threads,
                rescan=a.rescan,
                includes=a.includes,
            )
            print(
                json.dumps(
                    {k: v for k, v in result.items() if k != "record_ids"},
                    separators=(",", ":"),
                )
            )
            if result["gaps"] or result["pending_gaps"]:
                return 1
        else:
            output = Path(a.output)
            output.write_bytes(
                launchd_plist(a.codex_home, a.url, a.state, a.token_file)
            )
            os.chmod(output, 0o600)
            if a.install:
                target = Path.home() / "Library" / "LaunchAgents" / output.name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(output.read_bytes())
                os.chmod(target, 0o600)
                subprocess.run(
                    ["launchctl", "bootstrap", f"gui/{os.getuid()}", str(target)],
                    check=True,
                    capture_output=True,
                    text=True,
                )
    except Exception:  # noqa: BLE001 - CLI errors must not expose secret-bearing details.
        print("collector failed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
