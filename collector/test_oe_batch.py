import unittest

import oe_batch


class BatchTests(unittest.TestCase):
    def test_batches_split_on_count_size_and_thread(self):
        small = {"id": "a" * 64, "timestamp": "2020-01-01T00:00:00.000Z", "text": "x", "record": {}}
        items = [("thread-a", dict(small)) for _ in range(101)]
        batches = oe_batch.build_batches(items)
        self.assertEqual(len(batches), 2)
        self.assertEqual(len(batches[0]["records"]), 100)
        self.assertEqual(len(batches[1]["records"]), 1)
        self.assertTrue(all(batch["thread_id"] == "thread-a" for batch in batches))

        wide = dict(small, text="y" * 20000)
        sized = oe_batch.build_batches([("thread-a", dict(wide)) for _ in range(40)])
        self.assertGreater(len(sized), 1)
        for batch in sized:
            import json

            raw = json.dumps(batch, ensure_ascii=False, separators=(",", ":")).encode()
            self.assertLessEqual(len(raw), 512 * 1024)

        mixed = oe_batch.build_batches(
            [("thread-a", dict(small)), ("thread-b", dict(small))]
        )
        self.assertEqual([batch["thread_id"] for batch in mixed], ["thread-a", "thread-b"])
        again = oe_batch.build_batches(items)
        self.assertEqual(again, batches)


if __name__ == "__main__":
    unittest.main()
