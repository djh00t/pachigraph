"""Allowlist, zip limits and shard selection for an OpenAI export.

The central-directory walk uses ``struct`` only and runs before ``ZipFile``.
"""

import os
import re
import struct
import zipfile
from dataclasses import dataclass

SIG_EOCD = b"PK\x05\x06"
SIG_ZIP64_LOC = b"PK\x06\x07"
SIG_ZIP64_EOCD = b"PK\x06\x06"
SIG_CD = b"PK\x01\x02"
LOCATOR_SIZE = 20
ZIP64_FIXED = 56

_SINGLE = re.compile(r"conversations\.json")
_SHARD = re.compile(r"conversations-[0-9]{3,}\.json")
_MANIFEST = re.compile(r"export_manifest\.json")

MEMBER_CAP = 512 * 1024 * 1024
TOTAL_CAP = 4 * 1024 * 1024 * 1024
CD_CAP = 48 * 1024 * 1024
COUNT_CAP = 100_000


class ZipAbort(Exception):
    """A zip, layout or encoding failure. Maps to exit 3."""

    def __init__(self, counter: str | None = None, *, reason: str | None = None):
        super().__init__(counter or reason or "zip rejected")
        self.counter = counter
        self.reason = reason


@dataclass
class Limits:
    max_members: int = COUNT_CAP
    max_cd_bytes: int = CD_CAP
    max_member_bytes: int = MEMBER_CAP
    max_total_bytes: int = TOTAL_CAP

    def __post_init__(self):
        # Flags and callers can only lower the constants.
        self.max_members = min(self.max_members, COUNT_CAP)
        self.max_cd_bytes = min(self.max_cd_bytes, CD_CAP)
        self.max_member_bytes = min(self.max_member_bytes, MEMBER_CAP)
        self.max_total_bytes = min(self.max_total_bytes, TOTAL_CAP)


@dataclass
class Tail:
    entries: int
    cd_size: int
    cd_offset: int
    eocd_pos: int
    zip64: bool


class ReadState:
    def __init__(self, limits: Limits | None = None):
        self.limits = limits or Limits()
        self.total = 0


def is_allowlisted(name: str) -> bool:
    return bool(
        _SINGLE.fullmatch(name) or _SHARD.fullmatch(name) or _MANIFEST.fullmatch(name)
    )


def allowlisted_infos(zf: zipfile.ZipFile):
    for info in zf.infolist():
        if is_allowlisted(info.filename):
            yield info


def read_member(zf, info, state: ReadState, loads):
    """Read one member with the counted cap, then drop the raw bytes."""
    cap = state.limits.max_member_bytes
    data = _read_opened(zf, info, cap)
    if len(data) > cap:
        raise ZipAbort(reason="member_read_limit")
    state.total += len(data)
    if state.total > state.limits.max_total_bytes:
        raise ZipAbort(reason="total_limit")
    try:
        s = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ZipAbort("bad_encoding") from exc
    del data
    obj = loads(s)
    del s
    return obj


def _read_opened(zf, info, cap: int) -> bytes:
    """Read at most one byte beyond the member cap, checking ZIP integrity."""
    try:
        with zf.open(info, "r") as handle:
            return handle.read(cap + 1)
    except zipfile.BadZipFile as exc:
        raise ZipAbort() from exc


def read_tail(path) -> Tail:
    with open(path, "rb") as raw:
        return _read_tail(raw)


def _read_tail(raw) -> Tail:
    raw.seek(0, os.SEEK_END)
    filesize = raw.tell()
    if filesize < 22:
        raise ZipAbort()
    scan = min(filesize, (1 << 16) + 22)
    raw.seek(filesize - scan)
    data = raw.read(scan)
    rel = data.rfind(SIG_EOCD)
    if rel < 0 or rel + 22 > len(data):
        raise ZipAbort()
    eocd_pos = filesize - scan + rel
    (
        _sig,
        _disk,
        _cd_disk,
        _entries_disk,
        entries,
        cd_size,
        cd_offset,
        comment_len,
    ) = struct.unpack_from("<IHHHHIIH", data, rel)
    if eocd_pos + 22 + comment_len != filesize:
        raise ZipAbort()
    zip64 = False
    if eocd_pos >= LOCATOR_SIZE:
        raw.seek(eocd_pos - LOCATOR_SIZE)
        loc = raw.read(LOCATOR_SIZE)
        if len(loc) == LOCATOR_SIZE and loc[:4] == SIG_ZIP64_LOC:
            _lsig, _diskno, reloff, _disks = struct.unpack("<4sLQL", loc)
            if reloff != eocd_pos - LOCATOR_SIZE - ZIP64_FIXED:
                raise ZipAbort()
            raw.seek(reloff)
            zdata = raw.read(ZIP64_FIXED)
            if len(zdata) != ZIP64_FIXED or zdata[:4] != SIG_ZIP64_EOCD:
                raise ZipAbort()
            z = struct.unpack("<4sQHHLLQQQQ", zdata)
            if z[1] != 44:
                raise ZipAbort()
            entries = z[7]
            cd_size = z[8]
            cd_offset = z[9]
            zip64 = True
    return Tail(entries, cd_size, cd_offset, eocd_pos, zip64)


def locate_start(tail: Tail) -> int:
    """Directory start, computed the way ``ZipFile`` does, then compared."""
    start = tail.eocd_pos - tail.cd_size
    if tail.zip64:
        start -= ZIP64_FIXED + LOCATOR_SIZE
    if start != tail.cd_offset or start < 0:
        raise ZipAbort()
    return start


def walk_central_directory(raw, start: int, tail: Tail, limits: Limits) -> int:
    raw.seek(start)
    remaining = tail.cd_size
    count = 0
    while remaining:
        if remaining < 46:
            raise ZipAbort()
        hdr = raw.read(46)
        if len(hdr) != 46:
            raise ZipAbort()
        if hdr[:4] != SIG_CD:
            raise ZipAbort()
        name_len, extra_len, comment_len = struct.unpack_from("<HHH", hdr, 28)
        variable = name_len + extra_len + comment_len
        if variable > remaining - 46:
            raise ZipAbort(reason="directory_overrun")
        if variable:
            skipped = raw.read(variable)
            if len(skipped) != variable:
                raise ZipAbort()
        remaining -= 46 + variable
        count += 1
        if count > limits.max_members:
            raise ZipAbort(reason="walk_member_limit")
    if count != tail.entries:
        raise ZipAbort()
    return count


def precheck(path, limits: Limits | None = None) -> Tail:
    limits = limits or Limits()
    with open(path, "rb") as raw:
        tail = _read_tail(raw)
        if tail.entries > limits.max_members:
            raise ZipAbort(reason="tail_member_limit")
        if tail.cd_size > limits.max_cd_bytes:
            raise ZipAbort(reason="directory_size_limit")
        start = locate_start(tail)
        walk_central_directory(raw, start, tail, limits)
        return tail


def open_export(path, limits: Limits | None = None) -> zipfile.ZipFile:
    limits = limits or Limits()
    precheck(path, limits)
    zf = zipfile.ZipFile(path)
    try:
        if len(zf.infolist()) > limits.max_members:
            raise ZipAbort(reason="parsed_member_limit")
        seen = set()
        for info in zf.infolist():
            if not is_allowlisted(info.filename):
                continue
            if info.filename in seen or info.flag_bits & 0x1:
                raise ZipAbort()
            if info.file_size > limits.max_member_bytes:
                raise ZipAbort(reason="member_size_limit")
            seen.add(info.filename)
    except Exception:
        zf.close()
        raise
    return zf


def shard_number(name: str) -> int:
    return int(name[len("conversations-") : -len(".json")])


def select_layout(names: list[str], counters) -> list[str]:
    shards = [name for name in names if _SHARD.fullmatch(name)]
    has_single = any(_SINGLE.fullmatch(name) for name in names)
    if shards and has_single:
        raise ZipAbort("ambiguous_layout")
    numbers = [shard_number(name) for name in shards]
    if len(numbers) != len(set(numbers)):
        raise ZipAbort("duplicate_shard")
    if shards:
        return sorted(shards, key=shard_number)
    if has_single:
        return ["conversations.json"]
    return []


def recognized_manifest_shards(obj):
    """A recognized manifest has one list of shard names. Anything else is not."""
    if not isinstance(obj, dict):
        return None
    found = None
    for value in obj.values():
        if not isinstance(value, list):
            continue
        if value and all(isinstance(item, str) and _SHARD.fullmatch(item) for item in value):
            if found is not None:
                return None
            found = list(value)
    return found


def check_manifest(obj, shard_names: list[str], counters) -> None:
    recognized = recognized_manifest_shards(obj)
    if recognized is None:
        counters["manifest_unrecognized"] += 1
        return
    if set(recognized) != set(shard_names):
        raise ZipAbort("manifest_mismatch")
