"""Allowlist, zip limits, shard order and manifest checks."""

import json
import struct
import unittest
import zipfile
from collections import Counter
from pathlib import Path
from unittest import mock

import oe_fixtures
import oe_zip

SIG_EOCD = b"PK\x05\x06"
SIG_CD = b"PK\x01\x02"
SIG_ZIP64_EOCD = b"PK\x06\x06"
SIG_ZIP64_LOC = b"PK\x06\x07"


class ZipTests(unittest.TestCase):
    def test_only_allowlist_opened(self):
        with self._tmp() as directory:
            path = oe_fixtures.build_variant(directory, "dotdot")
            # Plant the names that must never be opened, including the two
            # lookalikes that are not ASCII-digit shards.
            extras = oe_fixtures.default_extras()
            extras["conversations-\u0660\u0660\u0661.json"] = "[]"
            extras["conversations-001.json\n"] = "[]"
            extras["file-../../x"] = extras["file-..x"]
            path = oe_fixtures.build_zip(
                directory,
                [oe_fixtures.conversation("c", [oe_fixtures.visible_node("n", None, "hi")])],
                extra_members=extras,
                manifest={"files": []},
                seed=3,
                name="allow.zip",
            )
            zf = oe_zip.open_export(path)
            opened = []
            real_open = zf.open

            def spy(member, *args, **kwargs):
                opened.append(member.filename if not isinstance(member, str) else member)
                return real_open(member, *args, **kwargs)

            zf.open = spy
            state = oe_zip.ReadState()
            for info in oe_zip.allowlisted_infos(zf):
                oe_zip.read_member(zf, info, state, json.loads)
            zf.close()
            self.assertEqual(sorted(opened), ["conversations.json", "export_manifest.json"])
            for banned in (
                "user.json",
                "sites/x/env",
                "chat.html",
                "file-..x",
                "file-../../x",
                "conversations-\u0660\u0660\u0661.json",
                "conversations-001.json\n",
            ):
                self.assertNotIn(banned, opened)
            self.assertTrue(oe_zip.is_allowlisted("conversations.json"))
            self.assertTrue(oe_zip.is_allowlisted("conversations-001.json"))
            self.assertTrue(oe_zip.is_allowlisted("conversations-0001.json"))
            self.assertFalse(oe_zip.is_allowlisted("conversations-\u0660\u0660\u0661.json"))
            self.assertFalse(oe_zip.is_allowlisted("conversations-001.json\n"))
            self.assertFalse(oe_zip.is_allowlisted("file-../../x"))

    def test_zip_limits_read(self):
        with self._tmp() as directory:
            path = oe_fixtures.build_zip(
                directory,
                [oe_fixtures.conversation("c", [oe_fixtures.visible_node("n", None, "x" * 80)])],
                extra_members={},
                seed=1,
            )
            under = self._patch_uncompressed(path.read_bytes(), 10)
            under_path = Path(directory) / "under.zip"
            under_path.write_bytes(under)
            state = oe_zip.ReadState(
                oe_zip.Limits(max_member_bytes=1000, max_total_bytes=50)
            )
            zf = oe_zip.open_export(
                under_path, oe_zip.Limits(max_member_bytes=1000, max_total_bytes=10**9)
            )
            info = zf.getinfo("conversations.json")
            with self.assertRaises(oe_zip.ZipAbort):
                oe_zip.read_member(zf, info, state, json.loads)
            zf.close()

            bom = self._stored_zip({"conversations.json": b"\xef\xbb\xbf[]"})
            bom_path = Path(directory) / "bom.zip"
            bom_path.write_bytes(bom)
            zf = oe_zip.open_export(bom_path)
            state = oe_zip.ReadState()
            body = oe_zip.read_member(
                zf, zf.getinfo("conversations.json"), state, json.loads
            )
            self.assertEqual(body, [])
            zf.close()

            bad = self._stored_zip({"conversations.json": b"\xff"})
            bad_path = Path(directory) / "bad.zip"
            bad_path.write_bytes(bad)
            zf = oe_zip.open_export(bad_path)
            with self.assertRaises(oe_zip.ZipAbort) as caught:
                oe_zip.read_member(
                    zf, zf.getinfo("conversations.json"), oe_zip.ReadState(), json.loads
                )
            self.assertEqual(caught.exception.counter, "bad_encoding")
            zf.close()

            # A repetitive member is not rejected: there is no ratio check.
            repetitive = oe_fixtures.build_zip(
                directory,
                [oe_fixtures.conversation("c", [oe_fixtures.visible_node("n", None, "a" * 4000)])],
                extra_members={},
                seed=2,
                name="rep.zip",
            )
            zf = oe_zip.open_export(repetitive)
            oe_zip.read_member(
                zf, zf.getinfo("conversations.json"), oe_zip.ReadState(), json.loads
            )
            zf.close()

    def test_zip_limits_tail(self):
        with self._tmp() as directory:
            base = self._stored_zip({"conversations.json": b"[]"})
            many = self._patch_zip64_count(base, entries=100_001, cd_size=None)
            path = Path(directory) / "many.zip"
            path.write_bytes(many)
            self.assertTrue(self._rejects_before_zipfile(path))

            huge = self._patch_zip64_count(
                base, entries=1, cd_size=48 * 1024 * 1024 + 1
            )
            huge_path = Path(directory) / "huge.zip"
            huge_path.write_bytes(huge)
            self.assertTrue(self._rejects_before_zipfile(huge_path))

            patched = self._patch_zip64_count(
                base, entries=1, cd_size=48 * 1024 * 1024 + 1, patch_eocd_counts=1
            )
            patched_path = Path(directory) / "huge-patched.zip"
            patched_path.write_bytes(patched)
            self.assertTrue(self._rejects_before_zipfile(patched_path))

    def test_zip_limits_cd_offset_prepended(self):
        with self._tmp() as directory:
            raw = self._stored_zip({"conversations.json": b"[]"})
            prepended = b"PREPEND" + raw
            path = Path(directory) / "prepended.zip"
            path.write_bytes(prepended)
            # stdlib accepts a zip with bytes in front of the local header.
            self.assertEqual(
                zipfile.ZipFile(path).namelist(), ["conversations.json"]
            )
            self.assertTrue(self._rejects_before_zipfile(path))

            located = self._patch_zip64_count(raw, entries=None, cd_size=None, patch_eocd_counts=1)
            ok_path = Path(directory) / "zip64-patched-counts.zip"
            ok_path.write_bytes(located)
            zf = oe_zip.open_export(ok_path)
            self.assertEqual(zf.namelist(), ["conversations.json"])
            zf.close()

            plain = Path(directory) / "plain.zip"
            plain.write_bytes(raw)
            zf = oe_zip.open_export(plain)
            self.assertIn("conversations.json", zf.namelist())
            zf.close()

    def test_zip_limits_walk(self):
        with self._tmp() as directory:
            # Build time: a repeated central-directory header, not 200k local files.
            # The directory is about 9.7 MiB and the walk stops at 100,001.
            big = self._synthetic_cd(200_000, name_len=5, extra_len=0, tail_entries=1)
            big_path = Path(directory) / "big.zip"
            big_path.write_bytes(big)
            self.assertTrue(self._rejects_before_zipfile(big_path))

            mismatch = self._patch_eocd_entries(self._stored_zip(
                {"conversations.json": b"[]", "conversations-000.json": b"[]"}
            ), 3)
            mismatch_path = Path(directory) / "mismatch.zip"
            mismatch_path.write_bytes(mismatch)
            self.assertTrue(self._rejects_before_zipfile(mismatch_path))

            corrupt = bytearray(self._stored_zip({"conversations.json": b"[]"}))
            sig = corrupt.find(SIG_CD)
            corrupt[sig] ^= 0xFF
            corrupt_path = Path(directory) / "corrupt.zip"
            corrupt_path.write_bytes(corrupt)
            self.assertTrue(self._rejects_before_zipfile(corrupt_path))

            leftover = self._inflate_cd_size(self._stored_zip({"conversations.json": b"[]"}), 10)
            leftover_path = Path(directory) / "leftover.zip"
            leftover_path.write_bytes(leftover)
            self.assertTrue(self._rejects_before_zipfile(leftover_path))

            overrun = self._inflate_name_length(self._stored_zip({"conversations.json": b"[]"}))
            overrun_path = Path(directory) / "overrun.zip"
            overrun_path.write_bytes(overrun)
            self.assertTrue(self._rejects_before_zipfile(overrun_path))

            # Build time: 100,000 directory entries, names plus extras of 290 bytes.
            wide = self._synthetic_cd(100_000, name_len=250, extra_len=40, tail_entries=100_000)
            wide_path = Path(directory) / "wide.zip"
            wide_path.write_bytes(wide)
            zf = oe_zip.open_export(wide_path)
            self.assertEqual(len(zf.infolist()), 100_000)
            zf.close()

    def test_zip_limits(self):
        with self._tmp() as directory:
            base = self._stored_zip({"conversations.json": b"[]"})
            too_big = bytearray(base)
            sig = too_big.find(SIG_CD)
            struct.pack_into("<I", too_big, sig + 24, 1000)
            path = Path(directory) / "header.zip"
            path.write_bytes(too_big)
            with self.assertRaises(oe_zip.ZipAbort):
                oe_zip.open_export(path, oe_zip.Limits(max_member_bytes=10))

            dup = oe_fixtures.build_zip(
                directory,
                [oe_fixtures.conversation("c", [oe_fixtures.visible_node("n", None, "a")])],
                extra_members={},
                seed=1,
                name="dup.zip",
            )
            with zipfile.ZipFile(dup, "a") as zf:
                info = zipfile.ZipInfo("conversations.json", (1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_STORED
                zf.writestr(info, b"[]")
            with self.assertRaises(oe_zip.ZipAbort):
                oe_zip.open_export(dup)

            encrypted = bytearray(self._stored_zip({"conversations.json": b"[]"}))
            sig = encrypted.find(SIG_CD)
            flags = struct.unpack_from("<H", encrypted, sig + 8)[0]
            struct.pack_into("<H", encrypted, sig + 8, flags | 0x1)
            enc_path = Path(directory) / "enc.zip"
            enc_path.write_bytes(encrypted)
            with self.assertRaises(oe_zip.ZipAbort):
                oe_zip.open_export(enc_path)

    def test_layout_precedence(self):
        counters = Counter()
        with self.assertRaises(oe_zip.ZipAbort) as both:
            oe_zip.select_layout(
                ["conversations.json", "conversations-000.json"], counters
            )
        self.assertEqual(both.exception.counter, "ambiguous_layout")
        with self.assertRaises(oe_zip.ZipAbort) as dup:
            oe_zip.select_layout(
                ["conversations-001.json", "conversations-0001.json"], counters
            )
        self.assertEqual(dup.exception.counter, "duplicate_shard")
        ordered = oe_zip.select_layout(
            ["conversations-010.json", "conversations-002.json"], counters
        )
        self.assertEqual(ordered, ["conversations-002.json", "conversations-010.json"])

    def test_sharded_equals_single(self):
        conversations = [
            oe_fixtures.conversation("c1", [oe_fixtures.visible_node("a", None, "one")]),
            oe_fixtures.conversation("c2", [oe_fixtures.visible_node("b", None, "two")]),
        ]
        with self._tmp() as directory:
            single = oe_fixtures.build_zip(
                directory, conversations, layout="single", extra_members={}, seed=4, name="s.zip"
            )
            sharded = oe_fixtures.build_zip(
                directory, conversations, layout="sharded", extra_members={}, seed=4, name="h.zip"
            )
            self.assertEqual(self._read_all(single), self._read_all(sharded))

            match = oe_fixtures.build_variant(directory, "manifest-match")
            counters = Counter()
            self._select_and_manifest(match, counters)
            self.assertEqual(counters["manifest_unrecognized"], 0)

            mismatch = oe_fixtures.build_variant(directory, "manifest-mismatch")
            counters = Counter()
            with self.assertRaises(oe_zip.ZipAbort) as caught:
                self._select_and_manifest(mismatch, counters)
            self.assertEqual(caught.exception.counter, "manifest_mismatch")

            unknown = oe_fixtures.build_variant(directory, "manifest-unrecognized")
            counters = Counter()
            self._select_and_manifest(unknown, counters)
            self.assertEqual(counters["manifest_unrecognized"], 1)

    def _read_all(self, path):
        found = []
        zf = oe_zip.open_export(path)
        try:
            names = oe_zip.select_layout([info.filename for info in zf.infolist()], Counter())
            state = oe_zip.ReadState()
            for name in names:
                found.extend(
                    oe_zip.read_member(zf, zf.getinfo(name), state, json.loads)
                )
        finally:
            zf.close()
        return found

    def _select_and_manifest(self, path, counters):
        zf = oe_zip.open_export(path)
        try:
            names = [info.filename for info in zf.infolist()]
            selected = oe_zip.select_layout(names, counters)
            if "export_manifest.json" in names:
                manifest = oe_zip.read_member(
                    zf, zf.getinfo("export_manifest.json"), oe_zip.ReadState(), json.loads
                )
                oe_zip.check_manifest(manifest, selected, counters)
            return selected
        finally:
            zf.close()

    def _rejects_before_zipfile(self, path) -> bool:
        with mock.patch("oe_zip.zipfile.ZipFile", wraps=zipfile.ZipFile) as spy:
            with self.assertRaises(oe_zip.ZipAbort):
                oe_zip.open_export(path)
        self.assertEqual(spy.call_count, 0)
        return True

    def _stored_zip(self, members: dict[str, bytes]) -> bytes:
        from io import BytesIO

        buf = BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            for name, data in members.items():
                info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_STORED
                zf.writestr(info, data)
        return buf.getvalue()

    def _patch_uncompressed(self, data: bytes, new_size: int) -> bytes:
        buf = bytearray(data)
        struct.pack_into("<I", buf, 22, new_size)
        sig = buf.find(SIG_CD)
        struct.pack_into("<I", buf, sig + 24, new_size)
        return bytes(buf)

    def _patch_eocd_entries(self, data: bytes, entries: int) -> bytes:
        buf = bytearray(data)
        rel = buf.rfind(SIG_EOCD)
        struct.pack_into("<HH", buf, rel + 8, entries, entries)
        return bytes(buf)

    def _patch_zip64_count(self, data, entries, cd_size, patch_eocd_counts=None):
        """Wrap a small zip in zip64 records, optionally lying about the 16-bit fields."""
        rel = data.rfind(SIG_EOCD)
        cd_rel = data.find(SIG_CD)
        real_entries = struct.unpack_from("<H", data, rel + 10)[0]
        real_size = struct.unpack_from("<I", data, rel + 12)[0]
        real_offset = struct.unpack_from("<I", data, rel + 16)[0]
        use_entries = real_entries if entries is None else entries
        use_size = real_size if cd_size is None else cd_size
        # Keep the original bytes up to the EOCD, then rewrite the tail as zip64.
        body = data[:rel]
        # The original CD stays where it is. Zip64 record follows the body only
        # when body already ends at the CD end, which it does for a comment-less zip.
        record_at = len(body)
        z = struct.pack(
            "<4sQHHLLQQQQ",
            SIG_ZIP64_EOCD,
            44,
            45,
            45,
            0,
            0,
            use_entries,
            use_entries,
            use_size,
            real_offset,
        )
        loc = struct.pack("<4sLQL", SIG_ZIP64_LOC, 0, record_at, 1)
        eocd_entries = 0xFFFF if use_entries > 0xFFFF else use_entries
        eocd_size = 0xFFFFFFFF if use_size > 0xFFFFFFFF else min(use_size, 0xFFFFFFFF)
        eocd_offset = min(real_offset, 0xFFFFFFFF)
        if patch_eocd_counts is not None:
            eocd_entries = patch_eocd_counts
            eocd_size = 1
            eocd_offset = 1
        eocd = struct.pack(
            "<IHHHHIIH",
            0x06054B50,
            0,
            0,
            eocd_entries,
            eocd_entries,
            eocd_size,
            eocd_offset,
            0,
        )
        del cd_rel
        return body + z + loc + eocd

    def _synthetic_cd(self, count, name_len, extra_len, tail_entries) -> bytes:
        name = b"x" * name_len
        if extra_len == 0:
            extra = b""
        elif extra_len < 4:
            raise AssertionError("extra must fit a header")
        else:
            extra = struct.pack("<HH", 0x9902, extra_len - 4) + (b"y" * (extra_len - 4))
        one = struct.pack(
            "<IHHHHHHIIIHHHHHII",
            0x02014B50,
            20,
            20,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            len(name),
            len(extra),
            0,
            0,
            0,
            0,
            0,
        ) + name + extra
        cd = one * count
        record_at = len(cd)
        z = struct.pack(
            "<4sQHHLLQQQQ",
            SIG_ZIP64_EOCD,
            44,
            45,
            45,
            0,
            0,
            tail_entries,
            tail_entries,
            len(cd),
            0,
        )
        loc = struct.pack("<4sLQL", SIG_ZIP64_LOC, 0, record_at, 1)
        eocd = struct.pack(
            "<IHHHHIIH",
            0x06054B50,
            0,
            0,
            1 if tail_entries > 0xFFFF else tail_entries,
            1 if tail_entries > 0xFFFF else tail_entries,
            0xFFFFFFFF,
            0xFFFFFFFF,
            0,
        )
        return cd + z + loc + eocd

    def _inflate_cd_size(self, data: bytes, extra: int) -> bytes:
        buf = bytearray(data)
        rel = buf.rfind(SIG_EOCD)
        size = struct.unpack_from("<I", buf, rel + 12)[0]
        struct.pack_into("<I", buf, rel + 12, size + extra)
        return bytes(buf[:rel] + b"\x00" * extra + buf[rel:])

    def _inflate_name_length(self, data: bytes) -> bytes:
        buf = bytearray(data)
        sig = buf.find(SIG_CD)
        struct.pack_into("<H", buf, sig + 28, 5000)
        return bytes(buf)

    def _tmp(self):
        import tempfile

        return tempfile.TemporaryDirectory()


if __name__ == "__main__":
    unittest.main()
