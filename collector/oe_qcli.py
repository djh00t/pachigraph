"""Interactive local quarantine commands. Output is never meant to be pasted."""

import sys

from oe_qstore import QuarantineError, Store


def list_findings(store: Store, stdout=None) -> int:
    stdout = stdout or sys.stdout
    for row in store.list_findings():
        stdout.write(
            f"{row['age']}\t{row['rule']}\t{row['path']}\t{row['fp']}\t{row['thread_id']}\n"
        )
    return 0


def show_finding(store: Store, index: int, reveal: bool, stdout=None) -> int:
    stdout = stdout or sys.stdout
    if not reveal or not stdout.isatty():
        raise QuarantineError("refused")
    rows = store.list_findings()
    if index < 1 or index > len(rows):
        raise QuarantineError("refused")
    stdout.write(store.get_original(rows[index - 1]["item_sha"]) + "\n")
    return 0


def purge(store: Store, *, older_than=None, thread=None, all_rows=False) -> int:
    if all_rows:
        store.purge_all()
    elif thread is not None:
        store.purge_thread(thread)
    elif older_than is not None:
        store.purge_expired(older_than)
    else:
        raise QuarantineError("refused")
    return 0
