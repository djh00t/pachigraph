import unittest
from collections import Counter

import oe_fixtures
import oe_walk


class WalkTests(unittest.TestCase):
    def test_non_string_parent_and_node_id_are_bad_trees(self):
        for field, value in (("parent", []), ("id", [])):
            conversation = oe_fixtures.active_path_with_null_root()
            node = conversation["mapping"]["leaf"]
            node[field] = value
            counters = Counter()
            with self.assertRaises(oe_walk.BadTree):
                oe_walk.active_path(conversation, counters)
            self.assertEqual(counters["bad_tree"], 1)
            path = oe_walk.active_path(oe_fixtures.active_path_with_null_root(), counters)
            self.assertEqual(path[0]["id"], "leaf")

    def test_active_path_skips_null_root_and_counts_side_branches(self):
        counters = Counter()
        path = oe_walk.active_path(oe_fixtures.active_path_with_null_root(), counters)
        self.assertEqual([node["id"] for node in path], ["leaf"])
        self.assertEqual(counters["side_branch"], 0)

        counters = Counter()
        path = oe_walk.active_path(oe_fixtures.side_branch_conversation(), counters)
        self.assertEqual([node["id"] for node in path], ["root", "leaf"])
        self.assertEqual(counters["side_branch"], 1)

        counters = Counter()
        with self.assertRaises(oe_walk.BadTree):
            oe_walk.active_path(oe_fixtures.cycle_conversation(), counters)
        self.assertEqual(counters["bad_tree"], 1)

        counters = Counter()
        with self.assertRaises(oe_walk.BadTree):
            oe_walk.active_path(oe_fixtures.missing_parent_conversation(), counters)
        self.assertEqual(counters["bad_tree"], 1)

        # A bad tree does not stop the caller from walking another conversation.
        counters = Counter()
        try:
            oe_walk.active_path(oe_fixtures.cycle_conversation(), counters)
        except oe_walk.BadTree:
            pass
        path = oe_walk.active_path(oe_fixtures.active_path_with_null_root(), counters)
        self.assertEqual(path[0]["id"], "leaf")


if __name__ == "__main__":
    unittest.main()
