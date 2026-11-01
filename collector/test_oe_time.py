import math
import unittest
from collections import Counter

import oe_time


class TimeTests(unittest.TestCase):
    def test_timestamps(self):
        for value in (None, True, math.nan, math.inf, -62135596801, 253402300800):
            counters = Counter()
            self.assertIsNone(oe_time.format_timestamp(value, counters))
            self.assertEqual(counters["no_timestamp"], 1)
        counters = Counter()
        self.assertIsNone(oe_time.format_timestamp(None, counters))
        missing = {}
        counters = Counter()
        self.assertIsNone(oe_time.format_timestamp(missing.get("create_time"), counters))
        self.assertEqual(counters["no_timestamp"], 1)
        self.assertEqual(
            oe_time.format_timestamp(-62135596800, Counter()),
            "0001-01-01T00:00:00.000Z",
        )
        self.assertEqual(
            oe_time.format_timestamp(253402300799.999, Counter()),
            "9999-12-31T23:59:59.999Z",
        )
        self.assertEqual(
            oe_time.format_timestamp(1.5, Counter()),
            "1970-01-01T00:00:01.500Z",
        )
        self.assertEqual(
            oe_time.format_timestamp(-0.0005, Counter()),
            "1969-12-31T23:59:59.999Z",
        )


if __name__ == "__main__":
    unittest.main()
