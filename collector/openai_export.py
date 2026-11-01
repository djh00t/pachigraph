"""openai-export pipeline. Network stays behind whoami, _upload and _ack."""

import json
import resource
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

import collector
import oe_batch
import oe_envelope
import oe_identity
import oe_parse
import oe_progress
import oe_qstore
import oe_quarantine
import oe_record
import oe_text
import oe_time
import oe_walk
import oe_zip

COUNTER_KEYS = (
    "uploads",
    "oversized",
    "no_timestamp",
    "hidden",
    "quarantined",
    "non_finite",
    "side_branch",
    "secs",
    "records_per_sec",
    "peak_rss_mib",
    "ambiguous_layout",
    "duplicate_shard",
    "manifest_mismatch",
    "manifest_unrecognized",
    "bad_encoding",
    "bad_tree",
    "bad_id",
    "empty_text",
    "tombstoned",
    "quarantine_only",
    "lone_surrogate",
    "non_text_part",
    "quota_exceeded",
    "records",
    "chunked",
)


class AuthFailure(Exception):
    """401, 403, or a failed whoami. Maps to exit 6."""


class UploadFailure(Exception):
    def __init__(self, code: int = 5):
        super().__init__("upload failed")
        self.code = code


def rss_to_mib(ru_maxrss, platform=None):
    platform = platform or sys.platform
    if platform == "darwin":
        return ru_maxrss / (1024 * 1024)
    return ru_maxrss / 1024


def fetch_whoami(url, token):
    ingest = collector._endpoint(url)
    root = ingest[: -len("/api/ingest")]
    headers = {"Authorization": "Bearer " + token} if token else {}
    request = urllib.request.Request(root + "/api/whoami", headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = json.loads(response.read(1024 * 1024) or b"{}")
    except urllib.error.HTTPError as exc:
        exc.close()
        raise AuthFailure() from exc
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise AuthFailure() from exc
    if not isinstance(body, dict) or not isinstance(body.get("tenant"), str) or not body["tenant"]:
        raise AuthFailure()
    return body


def _map_upload(exc: BaseException, counters):
    cause = exc.__cause__
    code = cause.code if isinstance(cause, urllib.error.HTTPError) else None
    if code in (401, 403):
        raise AuthFailure() from exc
    if code == 507:
        counters["quota_exceeded"] += 1
    raise UploadFailure(5) from exc


def _prepare_counters(counters):
    if counters is None:
        counters = Counter()
    for key in COUNTER_KEYS:
        counters.setdefault(key, 0)
    return counters


def run(
    zip_path,
    url,
    token,
    state_path,
    dry_run=False,
    quarantine_days=30,
    counters=None,
    scanner=None,
    upload=None,
    whoami=None,
):
    counters = _prepare_counters(counters)
    started = time.monotonic()
    code = 1
    try:
        code = _execute(
            zip_path,
            url,
            token,
            state_path,
            dry_run,
            quarantine_days,
            counters,
            scanner,
            upload or collector._upload,
            whoami or fetch_whoami,
        )
    except oe_zip.ZipAbort as exc:
        if exc.counter:
            counters[exc.counter] += 1
        code = 3
    except oe_qstore.QuarantineError:
        code = 7
    except collector.ScannerError:
        code = 4
    except AuthFailure:
        code = 6
    except UploadFailure as exc:
        code = exc.code
    finally:
        elapsed = time.monotonic() - started
        counters["secs"] = round(elapsed, 6)
        counters["records_per_sec"] = (
            counters["records"] / elapsed if elapsed else 0
        )
        counters["peak_rss_mib"] = rss_to_mib(
            resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        )
    return code


def _execute(
    zip_path,
    url,
    token,
    state_path,
    dry_run,
    quarantine_days,
    counters,
    scanner,
    upload,
    whoami,
):
    if dry_run:
        tenant = "dry-run"
        progress = oe_progress.Progress(state_path, dry_run=True)
        store = None
    else:
        qpath = oe_qstore.quarantine_path(state_path)
        if (qpath.exists() or qpath.is_symlink()) and not Path(state_path).exists():
            raise oe_qstore.QuarantineError("quarantine without state")
        tenant = whoami(url, token)["tenant"]
        progress = oe_progress.Progress(state_path)
        store = oe_qstore.Store(state_path)
        store.purge_expired(quarantine_days)
    keys = {"local_salt": progress.local_salt, "finding_key": progress.finding_key}
    try:
        archive = oe_zip.open_export(zip_path)
        try:
            names = [info.filename for info in archive.infolist()]
            selected = oe_zip.select_layout(names, counters)
            state = oe_zip.ReadState()
            conversations = []
            for name in selected:
                body = oe_zip.read_member(
                    archive,
                    archive.getinfo(name),
                    state,
                    lambda text: oe_parse.loads(text, counters),
                )
                if not isinstance(body, list):
                    raise oe_zip.ZipAbort()
                conversations.extend(body)
            if "export_manifest.json" in names:
                manifest = oe_zip.read_member(
                    archive,
                    archive.getinfo("export_manifest.json"),
                    state,
                    lambda text: oe_parse.loads(text, counters),
                )
                oe_zip.check_manifest(manifest, selected, counters)
        finally:
            archive.close()
        for conversation in conversations:
            _conversation(
                conversation,
                url,
                token,
                tenant,
                dry_run,
                counters,
                progress,
                store,
                keys,
                scanner,
                upload,
            )
    finally:
        progress.close()
        if store is not None:
            store.close()
    return 0


def _conversation(
    raw,
    url,
    token,
    tenant,
    dry_run,
    counters,
    progress,
    store,
    keys,
    scanner,
    upload,
):
    conversation = oe_parse.fix_surrogates(raw, counters)
    if not isinstance(conversation, dict):
        counters["bad_tree"] += 1
        return
    conversation_id = conversation.get("id")
    try:
        thread = oe_identity.thread_id(conversation_id)
    except oe_identity.BadId:
        counters["bad_id"] += 1
        return
    if progress.is_tombstoned(url, tenant, thread):
        return
    try:
        nodes = oe_walk.active_path(conversation, counters)
    except oe_walk.BadTree:
        return
    pending = []
    for node in nodes:
        node_id = node.get("id")
        try:
            record_identifier = oe_identity.record_id(conversation_id, node_id)
        except oe_identity.BadId:
            counters["bad_id"] += 1
            return
        classified = oe_text.classify(node, counters)
        if classified is None:
            continue
        message = node.get("message") if isinstance(node.get("message"), dict) else {}
        timestamp = oe_time.format_timestamp(message.get("create_time"), counters)
        if timestamp is None:
            continue
        record = oe_record.build_record(conversation_id, node, classified, timestamp)
        text = classified["text"]
        node_key = oe_progress.node_key(keys["local_salt"], conversation_id, node_id)
        scan = oe_progress.scan_key(keys["local_salt"], record, text, timestamp)
        if progress.is_done(url, tenant, node_key, scan):
            continue
        pending.append(
            {
                "conversation_id": conversation_id,
                "node_id": node_id,
                "record_id": record_identifier,
                "thread": thread,
                "record": record,
                "text": text,
                "timestamp": timestamp,
                "node_key": node_key,
                "scan_key": scan,
                "visibility": classified["visibility"],
            }
        )
    ready = []
    for item in pending:
        sanitized, extra = oe_quarantine.split(
            item,
            keys,
            None if dry_run else store,
            scanner,
            {
                "tenant": tenant,
                "thread_id": item["thread"],
                "record_id": item["record_id"],
                "conversation_id": item["conversation_id"],
                "node_id": item["node_id"],
            },
        )
        for name, value in extra.items():
            counters[name] += value
        if sanitized is None:
            continue
        if oe_envelope.is_oversized(
            item["record_id"], sanitized["record"], sanitized["text"], sanitized["timestamp"]
        ):
            counters["oversized"] += 1
            continue
        ready.append(
            {
                "upload": {
                    "id": item["record_id"],
                    "timestamp": sanitized["timestamp"],
                    "text": sanitized["text"],
                    "record": sanitized["record"],
                },
                "node_key": item["node_key"],
                "scan_key": item["scan_key"],
                "revision": oe_envelope.revision(
                    sanitized["record"], sanitized["text"], sanitized["timestamp"]
                ),
            }
        )
    if pending:
        _flush(
            url,
            token,
            tenant,
            pending[0]["thread"],
            ready,
            dry_run,
            counters,
            progress,
            store,
            upload,
        )


def _flush(url, token, tenant, thread, ready, dry_run, counters, progress, store, upload):
    if not ready:
        return
    batches = oe_batch.build_batches([(thread, item["upload"]) for item in ready])
    offset = 0
    for batch in batches:
        count = len(batch["records"])
        matched = ready[offset : offset + count]
        offset += count
        if dry_run:
            counters["records"] += count
            continue
        try:
            status, body = upload(url, token, batch)
        except RuntimeError as exc:
            _map_upload(exc, counters)
        if status == 410:
            progress.mark_tombstone(url, tenant, thread)
            if store is not None:
                store.purge_thread(thread)
            counters["tombstoned"] += 1
            return
        collector._ack(status, body, count)
        counters["uploads"] += 1
        counters["records"] += count
        for item in matched:
            progress.mark_acked(
                url, tenant, item["node_key"], item["scan_key"], item["revision"]
            )
