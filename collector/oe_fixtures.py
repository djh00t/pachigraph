"""Synthetic OpenAI-export fixtures built in a temp directory.

Nothing here is copied from a real export. The canary and any fake secret are
assembled at runtime.
"""

import json
import uuid
import zipfile
from pathlib import Path

CANARY = "canary-" + uuid.uuid4().hex

_ZIP_TIME = (1980, 1, 1, 0, 0, 0)


def fake_secret() -> str:
    """A synthetic marker assembled from fragments so the literal is not stored."""
    return "".join(("syn", "thetic", "-secret-", "marker"))


def _payload(text: str) -> str:
    return text + "\n" + CANARY + "\n"


def default_extras() -> dict[str, str]:
    return {
        "user.json": _payload("synthetic-user"),
        "sites/x/env": _payload("synthetic-env"),
        "chat.html": _payload("synthetic-html"),
        "file-..x": _payload("synthetic-file"),
    }


def _dumps(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=True)


def _write(zf: zipfile.ZipFile, name: str, data: str | bytes, seed: int) -> None:
    info = zipfile.ZipInfo(filename=name, date_time=_ZIP_TIME)
    info.compress_type = zipfile.ZIP_STORED
    info.comment = str(seed).encode("ascii")
    raw = data.encode("utf-8") if isinstance(data, str) else data
    zf.writestr(info, raw)


def _bodies(conversations, raw: bool) -> list[str]:
    if raw:
        return list(conversations)
    return [_dumps(conversations)]


def _shard_bodies(conversations, raw: bool) -> list[str]:
    if raw:
        return list(conversations)
    if not conversations:
        return ["[]"]
    return [_dumps([item]) for item in conversations]


def build_zip(
    directory,
    conversations,
    layout: str = "single",
    extra_members: dict[str, str] | None = None,
    manifest=None,
    raw: bool = False,
    seed: int = 0,
    name: str = "export.zip",
) -> Path:
    """Build a deterministic zip. ``layout`` is ``single``, ``sharded`` or ``both``."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    extras = default_extras() if extra_members is None else extra_members
    with zipfile.ZipFile(path, "w") as zf:
        if layout in {"single", "both"}:
            body = "[]" if raw else _dumps(list(conversations))
            if raw:
                body = conversations[0] if conversations else "[]"
            _write(zf, "conversations.json", body, seed)
        if layout in {"sharded", "both"}:
            shards = _shard_bodies(conversations, raw)
            if layout == "both" and raw:
                shards = list(conversations)
            for index, body in enumerate(shards):
                _write(zf, f"conversations-{index:03d}.json", body, seed)
        if manifest is not None:
            _write(zf, "export_manifest.json", _dumps(manifest), seed)
        for member in sorted(extras):
            _write(zf, member, extras[member], seed)
    return path


def build_variant(directory, kind: str, seed: int = 1) -> Path:
    """Named layout variants used by the fixture and zip tests."""
    conversations = [conversation("c-variant", [visible_node("n1", None, "hello")])]
    extras = default_extras()
    manifest = None
    layout = "single"
    raw = False
    name = f"{kind}.zip"
    if kind == "both":
        layout = "both"
    elif kind == "duplicate-shard":
        layout = "sharded"
    elif kind == "manifest-match":
        layout = "sharded"
        manifest = {"files": ["conversations-000.json"]}
    elif kind == "manifest-mismatch":
        layout = "sharded"
        manifest = {"files": ["conversations-999.json"]}
    elif kind == "manifest-unrecognized":
        layout = "sharded"
        manifest = {"note": "not a shard list"}
    elif kind == "arabic-digits":
        extras = {**extras, "conversations-\u0660\u0660\u0661.json": "[]"}
        layout = "single"
    elif kind == "trailing-newline":
        extras = {**extras, "conversations-001.json\n": "[]"}
        layout = "single"
    elif kind == "dotdot":
        extras = {**extras, "file-../../x": _payload("synthetic-dotdot")}
        layout = "single"
    else:
        raise ValueError("unknown variant")
    path = build_zip(
        directory,
        conversations,
        layout=layout,
        extra_members=extras,
        manifest=manifest,
        raw=raw,
        seed=seed,
        name=name,
    )
    if kind == "duplicate-shard":
        _append_stored(path, "conversations-0001.json", _dumps(conversations), seed)
    return path


def _append_stored(path: Path, member: str, data: str, seed: int) -> None:
    with zipfile.ZipFile(path, "a") as zf:
        _write(zf, member, data, seed)


def message(
    mid: str,
    role: str,
    parts,
    *,
    recipient: str | None = None,
    content_type: str = "text",
    create_time=1_700_000_000,
    model_slug: str | None = None,
    hidden: bool = False,
    extra: dict | None = None,
) -> dict:
    body = {
        "id": mid,
        "author": {"role": role},
        "content": {"content_type": content_type, "parts": parts},
        "create_time": create_time,
    }
    if recipient is not None:
        body["recipient"] = recipient
    metadata = {}
    if model_slug is not None:
        metadata["model_slug"] = model_slug
    if hidden:
        metadata["is_visually_hidden_from_conversation"] = True
    if metadata:
        body["metadata"] = metadata
    if extra:
        body.update(extra)
    return body


def node(nid: str, parent, children, msg) -> dict:
    return {"id": nid, "parent": parent, "children": list(children), "message": msg}


def visible_node(nid: str, parent, text: str, **kwargs) -> dict:
    return node(nid, parent, [], message(nid + "-m", "user", [text], **kwargs))


def conversation(cid: str, nodes: list[dict], current: str | None = None, **extra) -> dict:
    mapping = {item["id"]: item for item in nodes}
    # children lists are derived when the caller did not set them
    for item in nodes:
        parent = item.get("parent")
        if parent and parent in mapping and item["id"] not in mapping[parent]["children"]:
            mapping[parent]["children"].append(item["id"])
    body = {
        "id": cid,
        "title": "synthetic",
        "create_time": 1_700_000_000,
        "update_time": 1_700_000_000,
        "current_node": current or nodes[-1]["id"],
        "mapping": mapping,
    }
    body.update(extra)
    return body


def active_path_with_null_root() -> dict:
    root = node("root", None, ["leaf"], None)
    leaf = visible_node("leaf", "root", "visible line")
    return conversation("c-null-root", [root, leaf], "leaf")


def side_branch_conversation() -> dict:
    root = visible_node("root", None, "root line")
    current = visible_node("leaf", "root", "leaf line")
    side = visible_node("side", "root", "side line")
    return conversation("c-side", [root, current, side], "leaf")


def cycle_conversation() -> dict:
    a = node("a", "b", [], message("am", "user", ["a"]))
    b = node("b", "a", [], message("bm", "user", ["b"]))
    return conversation("c-cycle", [a, b], "a")


def missing_parent_conversation() -> dict:
    leaf = visible_node("leaf", "missing", "orphan")
    return conversation("c-missing", [leaf], "leaf")


def hidden_messages_conversation() -> dict:
    root = node("root", None, [], None)
    system = node(
        "sys",
        "root",
        [],
        message("sys-m", "system", ["system line"]),
    )
    tool = node("tool", "sys", [], message("tool-m", "tool", ["tool line"]))
    python = node(
        "py",
        "tool",
        [],
        message("py-m", "assistant", ["python line"], recipient="python"),
    )
    visual = node(
        "hid",
        "py",
        [],
        message("hid-m", "assistant", [CANARY], hidden=True),
    )
    return conversation("c-hidden", [root, system, tool, python, visual], "hid")


def newline_id_conversation() -> dict:
    bad = visible_node("bad\nid", None, "text")
    return conversation("c-newline", [bad], "bad\nid")


def numbers_document() -> str:
    """Raw JSON whose literals must survive byte for byte, including non-finite tokens."""
    big = "4" * 400
    huge = "5" * 5000
    secret = fake_secret()
    return (
        '[{"id":"id-\\ud800","title":"t","create_time":1,"update_time":1,'
        '"current_node":"n","mapping":{"\\ud800":{"id":"n","parent":null,"children":[],'
        '"message":{"id":"m","author":{"role":"user"},"recipient":"all",'
        '"content":{"content_type":"text","parts":["text-\\ud800",1.5,'
        f"1e400,-1e400,{big},{huge},NaN,Infinity,-Infinity,\"{secret}\"]}},"
        '"create_time":1700000000,"metadata":{"model_slug":"slug-\\ud800"}}}}]'
    )
