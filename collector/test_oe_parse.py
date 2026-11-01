import json
import unittest
from collections import Counter

import oe_fixtures
import oe_parse


class ParseTests(unittest.TestCase):
    def test_numbers_and_surrogates(self):
        counters = Counter()
        raw = {
            "\ud800": "text-\ud800",
            "id": "id-\ud800",
            "model_slug": "slug-\ud800",
            "emoji": "😀",
        }
        fixed = oe_parse.fix_surrogates(raw, counters)
        self.assertEqual(fixed["\ufffd"], "text-\ufffd")
        self.assertEqual(fixed["id"], "id-\ufffd")
        self.assertEqual(fixed["model_slug"], "slug-\ufffd")
        self.assertEqual(fixed["emoji"], "😀")
        self.assertEqual(counters["lone_surrogate"], 4)
        self.assertNotIn("\ud800", json.dumps(fixed))

        counters = Counter()
        parsed = oe_parse.fix_surrogates(
            oe_parse.loads(oe_fixtures.numbers_document(), counters), counters
        )
        message = parsed[0]["mapping"]["\ufffd"]["message"]
        parts = message["content"]["parts"]
        self.assertIsNone(parts[2])
        self.assertIsNone(parts[3])
        self.assertIsNone(parts[4])
        self.assertIsNone(parts[5])
        self.assertGreaterEqual(counters["non_finite"], 4)
        # The four overflow cases are 1e400, -1e400, the 400-digit int and the 5000-digit int.
        document = (
            "[1e400,-1e400," + ("8" * 400) + "," + ("9" * 5000) + "]"
        )
        counters = Counter()
        self.assertEqual(oe_parse.loads(document, counters), [None, None, None, None])
        self.assertEqual(counters["non_finite"], 4)
        counters = Counter()
        self.assertIsInstance(oe_parse.loads(str(2**53), counters) , float)
        self.assertEqual(oe_parse.loads(str(2**53 - 1), counters), 2**53 - 1)
        counters = Counter()
        self.assertIsNone(oe_parse.loads("NaN", counters))
        self.assertEqual(counters["non_finite"], 1)
        encoded = json.dumps(oe_parse.loads("[1e400]", Counter()))
        self.assertIn("null", encoded)
        self.assertNotIn("Infinity", encoded)


if __name__ == "__main__":
    unittest.main()
