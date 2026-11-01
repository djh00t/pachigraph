"""Per-thread batches sized the same way as collect."""

import json

from collector import MAX_BATCH, MAX_REQUEST


def build_batches(items: list[tuple[str, dict]]) -> list[dict]:
    batches = []
    current_thread = None
    current = []

    def flush():
        if current:
            batches.append({"thread_id": current_thread, "records": list(current)})
            current.clear()

    for thread_id, record in items:
        if current_thread is None:
            current_thread = thread_id
        if thread_id != current_thread:
            flush()
            current_thread = thread_id
        trial = current + [record]
        payload = {"thread_id": thread_id, "records": trial}
        size = len(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        )
        if current and (len(trial) > MAX_BATCH or size > MAX_REQUEST):
            flush()
            current.append(record)
        else:
            current.append(record)
    flush()
    return batches
