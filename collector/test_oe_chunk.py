import unittest

import oe_chunk
from oe_envelope import envelope_bytes


class ChunkTests(unittest.TestCase):
    def test_chunks_cost(self):
        self.assertEqual(oe_chunk.code_point_cost('"'), 2)
        self.assertEqual(oe_chunk.code_point_cost("\\"), 2)
        self.assertEqual(oe_chunk.code_point_cost("\n"), 2)
        self.assertEqual(oe_chunk.code_point_cost("\u0001"), 6)
        self.assertEqual(oe_chunk.code_point_cost("a"), 1)
        self.assertEqual(oe_chunk.code_point_cost("é"), 2)
        self.assertEqual(oe_chunk.code_point_cost("你"), 3)
        self.assertEqual(oe_chunk.code_point_cost("😀"), 4)
        record = {"visibility": "visible", "role": "user"}
        budget = oe_chunk.chunk_budget(record, "2020-01-02T03:04:05.000Z")
        self.assertGreater(budget, 0)
        self.assertLess(budget, 393216)

    def test_chunks_split(self):
        budget = 8
        parts = oe_chunk.split_text("a" * (budget + 1), budget)
        self.assertEqual(parts, ["a" * budget, "a"])
        self.assertEqual("".join(parts), "a" * (budget + 1))
        emoji = "a" * budget + "😀"
        # The emoji does not fit in the first budget of 1-byte units when the
        # budget is the cost of the a's only if we size it that way.
        sized = oe_chunk.split_text("a" * 4 + "😀", 4)
        self.assertEqual(sized[0], "aaaa")
        self.assertEqual(sized[1], "😀")
        self.assertEqual("".join(sized), "a" * 4 + "😀")
        # A paragraph break is preferred when it keeps at least half the budget.
        text = "aaaa\n\nbbbbbbbb"
        split = oe_chunk.split_text(text, 10)
        self.assertTrue(split[0].endswith("\n\n"))
        self.assertGreaterEqual(oe_chunk.text_cost(split[0]), 5)
        self.assertEqual("".join(split), text)

    def test_chunks_records(self):
        record = {
            "visibility": "visible",
            "role": "user",
            "redactions": [{"rule": "generic", "path": "/text#0", "fp": "ab" * 16}],
        }
        timestamp = "2020-01-02T03:04:05.000Z"
        budget = oe_chunk.chunk_budget(record, timestamp)
        text = "a" * (budget + 1)
        chunks = oe_chunk.chunk_node("conversation-alpha", "node-1", record, text, timestamp, "visible")
        self.assertEqual(len(chunks), 2)
        self.assertEqual("".join(item["text"] for item in chunks), text)
        for index, item in enumerate(chunks):
            self.assertLessEqual(
                envelope_bytes(item["id"], item["record"], item["text"], item["timestamp"]),
                393216,
            )
            self.assertEqual(item["record"]["redactions"], record["redactions"])
            self.assertEqual(item["record"]["chunk"]["index"], index)
            self.assertEqual(item["record"]["chunk"]["count"], 2)
        hidden = oe_chunk.chunk_node(
            "conversation-alpha", "node-1", record, text, timestamp, "hidden"
        )
        self.assertIsNone(hidden)

    def test_chunks_replay_uploads_nothing(self):
        import tempfile
        from collections import Counter
        from pathlib import Path
        from unittest import mock

        import oe_fixtures
        import openai_export

        record = {"visibility": "visible", "role": "user"}
        timestamp = "2020-01-02T03:04:05.000Z"
        budget = oe_chunk.chunk_budget(record, timestamp)
        text = "a" * (budget + 1)
        conversation = oe_fixtures.conversation(
            "conversation-alpha",
            [oe_fixtures.visible_node("node-1", None, text)],
        )
        uploads = []

        def upload(_url, _token, payload):
            uploads.append(payload)
            return 200, {"stored": len(payload["records"]), "duplicate": 0}

        whoami = mock.Mock(
            return_value={
                "tenant": "t-aaaaaaaaaaaaaaaa",
                "scope": "ingest",
                "expires_at": "2099-01-01T00:00:00.000Z",
            }
        )
        with tempfile.TemporaryDirectory() as directory:
            path = oe_fixtures.build_zip(
                directory, [conversation], extra_members={}, seed=9, name="chunk.zip"
            )
            state = Path(directory) / "state.sqlite3"
            counters = Counter()
            self.assertEqual(
                openai_export.run(
                    path, "http://127.0.0.1:9", "t", state,
                    counters=counters, scanner=lambda _text: [], upload=upload, whoami=whoami,
                ),
                0,
            )
            self.assertEqual(counters["chunked"], 1)
            self.assertEqual(counters["oversized"], 0)
            self.assertEqual(len(uploads), 1)
            self.assertEqual(len(uploads[0]["records"]), 2)
            self.assertEqual(
                "".join(item["text"] for item in uploads[0]["records"]), text
            )
            uploads.clear()
            again = Counter()
            self.assertEqual(
                openai_export.run(
                    path, "http://127.0.0.1:9", "t", state,
                    counters=again, scanner=lambda _text: [], upload=upload, whoami=whoami,
                ),
                0,
            )
            self.assertEqual(uploads, [])
            self.assertEqual(again["uploads"], 0)


if __name__ == "__main__":
    unittest.main()
