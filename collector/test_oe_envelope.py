import json
import unittest
from pathlib import Path

import oe_envelope

CASES = Path(__file__).resolve().parent / "fixtures" / "oe_envelope_cases.json"
RECORD_ID = "b" * 64
RECORD = {"source": "pad"}
TIMESTAMP = "2020-01-02T03:04:05.000Z"


class EnvelopeTests(unittest.TestCase):
    def test_numbers_and_surrogates_canonical(self):
        encoded = oe_envelope.canonical({"\U0001f600": 1, "\uff61": 2, "plain": "héllo"})
        self.assertLess(encoded.index("\U0001f600"), encoded.index("\uff61"))
        self.assertNotIn("\\u", encoded)
        self.assertNotIn(" ", encoded)
        self.assertEqual(oe_envelope.canonical({"b": True, "a": None, "c": False}), '{"a":null,"b":true,"c":false}')

    def test_numbers_and_surrogates_js_number(self):
        expected = {
            1.0: "1",
            -0.0: "0",
            0.1: "0.1",
            1e-7: "1e-7",
            1e-6: "0.000001",
            1.23e-19: "1.23e-19",
            1e21: "1e+21",
            1e20: "100000000000000000000",
            1.5e300: "1.5e+300",
            5e-324: "5e-324",
            123.456: "123.456",
            -2.5e-5: "-0.000025",
            1e16: "10000000000000000",
            float(9007199254740993): "9007199254740992",
            0.000123: "0.000123",
        }
        for value, text in expected.items():
            self.assertEqual(oe_envelope.js_number(value), text)

    def test_envelope_limit(self):
        text = oe_envelope.pad_text(RECORD_ID, RECORD, TIMESTAMP, "a", oe_envelope.CAP)
        self.assertFalse(oe_envelope.is_oversized(RECORD_ID, RECORD, text, TIMESTAMP))
        self.assertTrue(
            oe_envelope.is_oversized(RECORD_ID, RECORD, text + "a", TIMESTAMP)
        )
        for case in json.loads(CASES.read_text(encoding="utf-8")):
            padded = oe_envelope.pad_text(
                RECORD_ID, RECORD, TIMESTAMP, case["unit"], case["target_bytes"]
            )
            self.assertEqual(
                oe_envelope.envelope_bytes(RECORD_ID, RECORD, padded, TIMESTAMP),
                case["target_bytes"],
            )

    def test_envelope_limit_revision(self):
        left = {"z": 1, "a": {"q": 2, "b": 3}}
        right = {"a": {"b": 3, "q": 2}, "z": 1}
        self.assertEqual(
            oe_envelope.revision(left, "t", TIMESTAMP),
            oe_envelope.revision(right, "t", TIMESTAMP),
        )
        one = {"redactions": [{"fp": "a" * 32, "path": "/text#0", "rule": "generic"}]}
        two = {"redactions": [{"fp": "b" * 32, "path": "/text#0", "rule": "generic"}]}
        self.assertNotEqual(
            oe_envelope.revision(one, "", TIMESTAMP),
            oe_envelope.revision(two, "", TIMESTAMP),
        )


if __name__ == "__main__":
    unittest.main()
