"""Pure chunker. Built only for the gated path; no clock and no randomness."""

import copy
import hashlib

from oe_envelope import CAP, envelope_bytes
from oe_identity import chunk_id

_TWO = {'"', "\\", "\b", "\f", "\n", "\r", "\t"}


def code_point_cost(char: str) -> int:
    if char in _TWO:
        return 2
    if ord(char) < 0x20:
        return 6
    return len(char.encode("utf-8"))


def text_cost(text: str) -> int:
    return sum(code_point_cost(char) for char in text)


def chunk_budget(record, timestamp: str) -> int:
    placeholder = copy.deepcopy(record)
    placeholder["chunk"] = {
        "index": 999999,
        "count": 999999,
        "node_sha256": "0" * 64,
    }
    return CAP - envelope_bytes("a" * 64, placeholder, "", timestamp)


def split_text(text: str, budget: int) -> list[str]:
    if budget < 1:
        raise ValueError("chunk budget")
    parts = []
    rest = text
    while rest:
        cost = 0
        end = 0
        for index, char in enumerate(rest):
            needed = code_point_cost(char)
            if cost + needed > budget:
                break
            cost += needed
            end = index + 1
        if end == 0:
            raise ValueError("chunk budget")
        cut = _cut(rest[:end], budget)
        parts.append(rest[:cut])
        rest = rest[cut:]
        if len(parts) > 999_999:
            raise ValueError("too many chunks")
    return parts


def _cut(prefix: str, budget: int) -> int:
    half = budget / 2
    for separator, width in (("\n\n", 2), ("\n", 1)):
        found = prefix.rfind(separator)
        if found == -1:
            continue
        kept = found + width
        if kept < len(prefix) and text_cost(prefix[:kept]) >= half:
            return kept
    return len(prefix)


def chunk_node(conversation_id, node_id, record, text, timestamp, visibility):
    """Return chunk upload dicts, or None when the node stays a gap."""
    if visibility != "visible":
        return None
    budget = chunk_budget(record, timestamp)
    parts = split_text(text, budget)
    digest = hashlib.sha256(text.encode()).hexdigest()
    chunks = []
    count = len(parts)
    for index, part in enumerate(parts):
        body = copy.deepcopy(record)
        body["chunk"] = {"index": index, "count": count, "node_sha256": digest}
        identifier = chunk_id(conversation_id, node_id, index)
        if envelope_bytes(identifier, body, part, timestamp) > CAP:
            raise ValueError("chunk exceeds cap")
        chunks.append(
            {
                "id": identifier,
                "record": body,
                "text": part,
                "timestamp": timestamp,
            }
        )
    return chunks
