"""Fixture builders for the synthetic OpenAI export."""

import json
import unittest
import zipfile
from pathlib import Path

import oe_fixtures


class FixtureZipTests(unittest.TestCase):
    def test_fixture_zips_are_deterministic_and_share_conversations(self):
        conversations = [
            oe_fixtures.conversation(
                "c1", [oe_fixtures.visible_node("n1", None, "alpha")]
            ),
            oe_fixtures.conversation(
                "c2", [oe_fixtures.visible_node("n2", None, "beta")]
            ),
        ]
        with self._tmp() as directory:
            first = oe_fixtures.build_zip(directory, conversations, seed=7)
            second = oe_fixtures.build_zip(
                directory, conversations, seed=7, name="again.zip"
            )
            self.assertEqual(first.read_bytes(), second.read_bytes())
            single = self._conversations(first)
            sharded_path = oe_fixtures.build_zip(
                directory, conversations, layout="sharded", seed=7, name="shards.zip"
            )
            shards = self._conversations(sharded_path)
            self.assertEqual(single, shards)
            with zipfile.ZipFile(first) as zf:
                names = zf.namelist()
                for required in ("user.json", "sites/x/env", "chat.html", "file-..x"):
                    self.assertIn(required, names)
                    self.assertIn(oe_fixtures.CANARY, zf.read(required).decode())

    def test_fixture_zips_variants_use_the_listed_names(self):
        expected = {
            "both": {
                "conversations.json",
                "conversations-000.json",
                "user.json",
                "sites/x/env",
                "chat.html",
                "file-..x",
            },
            "duplicate-shard": {
                "conversations-000.json",
                "conversations-0001.json",
                "user.json",
                "sites/x/env",
                "chat.html",
                "file-..x",
            },
            "manifest-match": {
                "conversations-000.json",
                "export_manifest.json",
                "user.json",
                "sites/x/env",
                "chat.html",
                "file-..x",
            },
            "manifest-mismatch": {
                "conversations-000.json",
                "export_manifest.json",
                "user.json",
                "sites/x/env",
                "chat.html",
                "file-..x",
            },
            "manifest-unrecognized": {
                "conversations-000.json",
                "export_manifest.json",
                "user.json",
                "sites/x/env",
                "chat.html",
                "file-..x",
            },
            "arabic-digits": {
                "conversations.json",
                "conversations-\u0660\u0660\u0661.json",
                "user.json",
                "sites/x/env",
                "chat.html",
                "file-..x",
            },
            "trailing-newline": {
                "conversations.json",
                "conversations-001.json\n",
                "user.json",
                "sites/x/env",
                "chat.html",
                "file-..x",
            },
            "dotdot": {
                "conversations.json",
                "user.json",
                "sites/x/env",
                "chat.html",
                "file-..x",
                "file-../../x",
            },
        }
        with self._tmp() as directory:
            for kind, names in expected.items():
                path = oe_fixtures.build_variant(directory, kind)
                with zipfile.ZipFile(path) as zf, self.subTest(kind=kind):
                    self.assertEqual(set(zf.namelist()), names)

    def test_fixture_content_shapes_are_present(self):
        shapes = {
            "null-root": oe_fixtures.active_path_with_null_root(),
            "side": oe_fixtures.side_branch_conversation(),
            "cycle": oe_fixtures.cycle_conversation(),
            "missing": oe_fixtures.missing_parent_conversation(),
            "hidden": oe_fixtures.hidden_messages_conversation(),
            "newline": oe_fixtures.newline_id_conversation(),
        }
        again = {
            "null-root": oe_fixtures.active_path_with_null_root(),
            "side": oe_fixtures.side_branch_conversation(),
            "cycle": oe_fixtures.cycle_conversation(),
            "missing": oe_fixtures.missing_parent_conversation(),
            "hidden": oe_fixtures.hidden_messages_conversation(),
            "newline": oe_fixtures.newline_id_conversation(),
        }
        self.assertEqual(shapes, again)
        hidden = shapes["hidden"]["mapping"]
        roles = [
            hidden["sys"]["message"]["author"]["role"],
            hidden["tool"]["message"]["author"]["role"],
            hidden["py"]["message"]["author"]["role"],
            hidden["hid"]["message"]["author"]["role"],
        ]
        self.assertEqual(roles, ["system", "tool", "assistant", "assistant"])
        self.assertEqual(hidden["py"]["message"]["recipient"], "python")
        self.assertTrue(
            hidden["hid"]["message"]["metadata"]["is_visually_hidden_from_conversation"]
        )
        self.assertIn(oe_fixtures.CANARY, hidden["hid"]["message"]["content"]["parts"][0])
        self.assertIsNone(shapes["null-root"]["mapping"]["root"]["message"])
        self.assertIn("side", shapes["side"]["mapping"])
        self.assertEqual(shapes["cycle"]["mapping"]["a"]["parent"], "b")
        self.assertEqual(shapes["missing"]["mapping"]["leaf"]["parent"], "missing")
        self.assertIn("\n", shapes["newline"]["mapping"]["bad\nid"]["id"])

    def test_fixture_content_raw_literals_and_no_secret_in_source(self):
        secret = oe_fixtures.fake_secret()
        source = Path(oe_fixtures.__file__).read_text(encoding="utf-8")
        self.assertNotIn(secret, source)
        document = oe_fixtures.numbers_document()
        self.assertIn(secret, document)
        for literal in (
            "1e400",
            "-1e400",
            "4" * 400,
            "5" * 5000,
            "NaN",
            "Infinity",
            "-Infinity",
            "\\ud800",
            "1.5",
        ):
            self.assertIn(literal, document)
        self.assertIn('"\\ud800":', document)
        self.assertIn("slug-\\ud800", document)
        self.assertIn("text-\\ud800", document)
        self.assertIn("id-\\ud800", document)

    def _conversations(self, path: Path):
        found = []
        with zipfile.ZipFile(path) as zf:
            names = [
                name
                for name in zf.namelist()
                if name == "conversations.json" or name.startswith("conversations-")
            ]
            for name in sorted(names):
                found.extend(json.loads(zf.read(name)))
        return found

    def _tmp(self):
        return __import__("tempfile").TemporaryDirectory()


if __name__ == "__main__":
    unittest.main()
