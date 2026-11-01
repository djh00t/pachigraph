"""Committed chatgpt identity values. The tenant is not part of any id."""

import hashlib
import uuid

NAMESPACE = uuid.UUID("3bc4a14a-bc67-4a13-9072-ef542523c620")


class BadId(Exception):
    """A conversation or node id contains a newline."""


def _check(value: str) -> str:
    if not isinstance(value, str) or "\n" in value:
        raise BadId()
    return value


def thread_id(conversation_id: str) -> str:
    return str(uuid.uuid5(NAMESPACE, "chatgpt\n" + _check(conversation_id)))


def record_id(conversation_id: str, node_id: str) -> str:
    raw = "chatgpt\n" + _check(conversation_id) + "\n" + _check(node_id)
    return hashlib.sha256(raw.encode()).hexdigest()


def chunk_id(conversation_id: str, node_id: str, index: int) -> str:
    raw = (
        "chatgpt\n"
        + _check(conversation_id)
        + "\n"
        + _check(node_id)
        + "\nchunk\n"
        + str(index)
    )
    return hashlib.sha256(raw.encode()).hexdigest()


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()
