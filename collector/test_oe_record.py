import json
import unittest

import oe_fixtures
import oe_record


class RecordTests(unittest.TestCase):
    def test_record_stable_fields(self):
        node = oe_fixtures.visible_node("n", "p", "hello", model_slug="synthetic")
        classified = {
            "visibility": "visible",
            "text": "hello",
            "role": "user",
            "content_type": "text",
            "recipient": None,
            "model_slug": "synthetic",
            "content": None,
        }
        record = oe_record.build_record("c", node, classified, "2020-01-01T00:00:00.000Z")
        self.assertEqual(
            set(record),
            {
                "source",
                "node_id",
                "parent_id",
                "role",
                "content_type",
                "model_slug",
                "create_time",
                "visibility",
                "recipient",
            },
        )
        self.assertNotIn("content", record)
        hidden = dict(classified, visibility="hidden", content={"content_type": "text", "parts": ["x"]})
        hidden_record = oe_record.build_record("c", node, hidden, "2020-01-01T00:00:00.000Z")
        self.assertIn("content", hidden_record)
        self.assertNotIn("redactions", hidden_record)

    def test_record_stable_ignores_children_title_and_status(self):
        node = oe_fixtures.visible_node("n", None, "hello")
        classified = {
            "visibility": "visible",
            "role": "user",
            "content_type": "text",
            "recipient": None,
            "model_slug": None,
        }
        before = oe_record.build_record("c", node, classified, "2020-01-01T00:00:00.000Z")
        grown = json.loads(json.dumps(node))
        grown["children"] = ["x", "y", "z"]
        after = oe_record.build_record("c", grown, classified, "2020-01-01T00:00:00.000Z")
        self.assertEqual(
            json.dumps(before, sort_keys=True),
            json.dumps(after, sort_keys=True),
        )
        conversation = oe_fixtures.conversation("c", [node], title="other", update_time=9, status="x")
        again = oe_record.build_record(
            conversation["id"], node, classified, "2020-01-01T00:00:00.000Z"
        )
        self.assertEqual(json.dumps(before, sort_keys=True), json.dumps(again, sort_keys=True))
        self.assertNotIn("title", json.dumps(again))
        self.assertNotIn("children", json.dumps(again))


if __name__ == "__main__":
    unittest.main()
