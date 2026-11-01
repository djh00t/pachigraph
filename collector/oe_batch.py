"""Per-thread batches sized the same way as collect."""

import json

from collector import MAX_BATCH, MAX_REQUEST


def build_batches(items: list[tuple[str, dict]]) -> list[dict]:
    batches = []
    current_thread = None
    current = []
    current_size = 0

    def flush():
        nonlocal current_size
        if current:
            batches.append({"thread_id": current_thread, "records": list(current)})
            current.clear()
            current_size = 0

    for thread_id, record in items:
        if current_thread is None:
            current_thread = thread_id
        if thread_id != current_thread:
            flush()
            current_thread = thread_id
        if not current:
            current_size = len(
                json.dumps(
                    {"thread_id": thread_id, "records": []},
                    ensure_ascii=False,
                    separators=(",", ":"),
                ).encode()
            )
        record_size = len(
            json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode()
        )
        added_size = record_size + (1 if current else 0)
        if current and (len(current) >= MAX_BATCH or current_size + added_size > MAX_REQUEST):
            flush()
            current_size = len(
                json.dumps(
                    {"thread_id": thread_id, "records": []},
                    ensure_ascii=False,
                    separators=(",", ":"),
                ).encode()
            )
            added_size = record_size
        current.append(record)
        current_size += added_size
    flush()
    return batches
