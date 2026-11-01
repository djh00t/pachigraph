import unittest
import uuid
from collections import Counter

import oe_identity


class IdentityTests(unittest.TestCase):
    def test_identity_golden(self):
        self.assertEqual(str(oe_identity.NAMESPACE), "3bc4a14a-bc67-4a13-9072-ef542523c620")
        thread = oe_identity.thread_id("conversation-alpha")
        self.assertEqual(thread, "078c606a-cc39-5515-9d4b-746e270967ab")
        self.assertEqual(uuid.UUID(thread).version, 5)
        self.assertEqual(
            oe_identity.record_id("conversation-alpha", "node-1"),
            "e8c2478ecb00e458cc4aad6b6c6e0116b946975784da154245c13b0be0eb1a7f",
        )
        self.assertEqual(
            oe_identity.chunk_id("conversation-alpha", "node-1", 0),
            "4a82f98fb8023082eabdf95a0fc407ff78924e60324ad1111a6c082d903906dd",
        )
        counters = Counter()
        with self.assertRaises(oe_identity.BadId):
            oe_identity.thread_id("bad\nid")
        with self.assertRaises(oe_identity.BadId):
            oe_identity.record_id("ok", "bad\nid")
        self.assertEqual(counters["bad_id"], 0)


if __name__ == "__main__":
    unittest.main()
