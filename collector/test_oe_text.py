import io
import unittest
from collections import Counter
from contextlib import redirect_stderr, redirect_stdout

import oe_fixtures
import oe_text
import oe_walk


class ClassifyTests(unittest.TestCase):
    def test_classify_hidden_and_visible(self):
        counters = Counter()
        nodes = oe_walk.active_path(oe_fixtures.hidden_messages_conversation(), counters)
        stdout, stderr = io.StringIO(), io.StringIO()
        classified = []
        with redirect_stdout(stdout), redirect_stderr(stderr):
            for node in nodes:
                classified.append(oe_text.classify(node, counters))
        self.assertEqual(
            [item["visibility"] for item in classified],
            ["hidden", "hidden", "hidden", "hidden"],
        )
        self.assertTrue(all(item["text"] == "" for item in classified))
        self.assertEqual(counters["hidden"], 4)
        self.assertEqual(classified[0]["content"]["parts"], ["system line"])
        self.assertNotIn(oe_fixtures.CANARY, stdout.getvalue())
        self.assertNotIn(oe_fixtures.CANARY, stderr.getvalue())
        self.assertNotIn("system line", stdout.getvalue())

        counters = Counter()
        visible = oe_text.classify(
            oe_fixtures.visible_node("n", None, "alpha"), counters
        )
        self.assertEqual(visible["visibility"], "visible")
        self.assertEqual(visible["text"], "alpha")
        self.assertIsNone(visible["content"])

        multimodal = oe_fixtures.node(
            "mm", None, [],
            oe_fixtures.message("mm", "assistant", ["caption"], content_type="multimodal_text"),
        )
        self.assertEqual(oe_text.classify(multimodal, Counter())["visibility"], "visible")

    def test_non_string_role_and_recipient_are_hidden(self):
        for role, recipient in (([], None), ("assistant", {})):
            node = oe_fixtures.node(
                "n", None, [], oe_fixtures.message("m", role, ["text"], recipient=recipient)
            )
            self.assertEqual(oe_text.classify(node, Counter())["visibility"], "hidden")

        mixed = oe_fixtures.node(
            "m",
            None,
            [],
            oe_fixtures.message("m", "assistant", ["a", {"x": 1}, "b"], recipient="all"),
        )
        counters = Counter()
        got = oe_text.classify(mixed, counters)
        self.assertEqual(got["text"], "a\nb")
        self.assertEqual(counters["non_text_part"], 1)

        empty = oe_fixtures.node(
            "e",
            None,
            [],
            oe_fixtures.message("e", "user", [1]),
        )
        counters = Counter()
        self.assertIsNone(oe_text.classify(empty, counters))
        self.assertEqual(counters["empty_text"], 1)
        self.assertEqual(counters["non_text_part"], 1)


if __name__ == "__main__":
    unittest.main()
