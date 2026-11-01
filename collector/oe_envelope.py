"""Canonical JSON, JavaScript number formatting, envelope size and revision.

``revision`` matches ``server/history.ts``:

    const revision = digest(
      `{"record":${record},"text":${JSON.stringify(item.text)},"timestamp":${JSON.stringify(item.timestamp)}}`,
    );

where ``record`` is already ``canonical(item.record)``.
"""

import hashlib
import json
import math

CAP = 393_216


def js_number(value: float) -> str:
    """ECMA-262 Number::toString(10) from the shortest digits in ``repr``."""
    if value == 0.0:
        return "0"
    negative = math.copysign(1.0, value) < 0
    digits, exponent = _digits_and_exponent(abs(value))
    body = _format(digits, exponent)
    return "-" + body if negative else body


def _digits_and_exponent(value: float) -> tuple[str, int]:
    text = repr(value)
    power = 0
    if "e" in text:
        text, power_text = text.split("e")
        power = int(power_text)
    if "." in text:
        whole, frac = text.split(".")
        frac = frac.rstrip("0")
        if whole in {"0", ""}:
            zeros = len(text.split(".")[1]) - len(frac)
            digits = frac or "0"
            last = -(zeros + len(digits)) + power
        else:
            digits = whole + frac
            last = -len(frac) + power
    else:
        digits = text
        last = power
    return digits, last + len(digits)


def _format(digits: str, exponent: int) -> str:
    count = len(digits)
    if count <= exponent <= 21:
        return digits + "0" * (exponent - count)
    if 0 < exponent <= 21:
        return digits[:exponent] + "." + digits[exponent:]
    if -6 < exponent <= 0:
        return "0." + "0" * (-exponent) + digits
    scientific = exponent - 1
    mantissa = digits if count == 1 else digits[0] + "." + digits[1:]
    sign = "+" if scientific >= 0 else "-"
    return f"{mantissa}e{sign}{abs(scientific)}"


def canonical(value, depth: int = 0) -> str:
    if depth > 64:
        raise ValueError("record nesting exceeds 64 levels")
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("non-finite number")
        return js_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(canonical(item, depth + 1) for item in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value, key=lambda key: key.encode("utf-16-be"))
        return (
            "{"
            + ",".join(
                json.dumps(key, ensure_ascii=False, separators=(",", ":"))
                + ":"
                + canonical(value[key], depth + 1)
                for key in keys
            )
            + "}"
        )
    raise TypeError("unsupported value")


def _envelope(record_json: str, text: str, timestamp: str, record_id: str | None) -> str:
    body = (
        '"record":'
        + record_json
        + ',"text":'
        + json.dumps(text, ensure_ascii=False, separators=(",", ":"))
        + ',"timestamp":'
        + json.dumps(timestamp, ensure_ascii=False, separators=(",", ":"))
    )
    if record_id is None:
        return "{" + body + "}"
    return '{"id":' + json.dumps(record_id) + "," + body + "}"


def envelope_bytes(record_id, record, text, timestamp) -> int:
    return len(_envelope(canonical(record), text, timestamp, record_id).encode())


def revision(record, text, timestamp) -> str:
    form = _envelope(canonical(record), text, timestamp, None)
    return hashlib.sha256(form.encode()).hexdigest()


def is_oversized(record_id, record, text, timestamp) -> bool:
    return envelope_bytes(record_id, record, text, timestamp) > CAP


def pad_text(record_id, record, timestamp, unit: str, target: int) -> str:
    """Repeat ``unit`` until the envelope is exactly ``target`` bytes."""
    if unit == "":
        raise ValueError("empty unit")
    one = envelope_bytes(record_id, record, unit, timestamp)
    zero = envelope_bytes(record_id, record, "", timestamp)
    cost = one - zero
    if cost <= 0 or (target - zero) % cost != 0:
        raise ValueError("target is not reachable")
    count = (target - zero) // cost
    text = unit * count
    if envelope_bytes(record_id, record, text, timestamp) != target:
        raise ValueError("padding missed the target")
    return text
