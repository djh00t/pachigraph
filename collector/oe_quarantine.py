"""Fingerprints that may leave the machine, and the local original that may not."""

import copy
import hashlib
import hmac
from collections import Counter

from collector import REDACTION, ScannerError, UnmappableFinding, sanitize
from oe_envelope import revision
from oe_qstore import Store


def build_redactions(findings_out, finding_key: bytes) -> list[dict]:
    counts = {}
    entries = []
    seen = set()
    for rule, pointer, secret in findings_out:
        occurrence = counts.get((pointer, secret), 0)
        counts[(pointer, secret)] = occurrence + 1
        digest = hmac.new(finding_key, secret.encode("utf-8"), hashlib.sha256).hexdigest()
        entry = {"rule": rule, "path": f"{pointer}#{occurrence}", "fp": digest[:32]}
        key = (entry["rule"], entry["path"], entry["fp"])
        if key in seen:
            continue
        seen.add(key)
        entries.append(entry)
    entries.sort(key=lambda item: (item["path"], item["rule"], item["fp"]))
    return entries


def split(node_envelope, keys, store: Store | None, scanner, meta: dict):
    """Sanitize one node. Commit the local original before the caller uploads."""
    counters = Counter()
    original = {
        "record": copy.deepcopy(node_envelope["record"]),
        "text": node_envelope["text"],
        "timestamp": node_envelope["timestamp"],
    }
    findings = []
    try:
        cleaned, _changed = sanitize(
            {"record": original["record"], "text": original["text"]},
            scanner,
            findings,
        )
    except UnmappableFinding:
        if store is not None:
            store.put_item(
                original,
                [{"rule": "unmapped", "path": "unmapped", "fp": "unmapped"}],
                salt=keys["local_salt"],
                tenant=meta["tenant"],
                thread_id=meta["thread_id"],
                record_id=meta["record_id"],
                conversation_id=meta["conversation_id"],
                node_id=meta["node_id"],
            )
        counters["quarantine_only"] += 1
        return None, counters
    redactions = build_redactions(findings, keys["finding_key"]) if findings else []
    record = cleaned["record"]
    text = cleaned["text"]
    if redactions:
        record = copy.deepcopy(record)
        record["redactions"] = redactions
        if store is not None:
            store.put_item(
                original,
                redactions,
                salt=keys["local_salt"],
                tenant=meta["tenant"],
                thread_id=meta["thread_id"],
                record_id=meta["record_id"],
                conversation_id=meta["conversation_id"],
                node_id=meta["node_id"],
            )
        counters["quarantined"] += 1
    sanitized = {"record": record, "text": text, "timestamp": original["timestamp"]}
    return sanitized, counters


def redacted_revision(sanitized) -> str:
    return revision(sanitized["record"], sanitized["text"], sanitized["timestamp"])


def uploaded_contains_secret(payload, secret: str) -> bool:
    raw = __import__("json").dumps(payload, ensure_ascii=False).encode()
    if secret.encode() in raw:
        return True
    return hashlib.sha256(secret.encode()).hexdigest().encode() in raw
