"""Surrogate repair and JSON number parsing that matches JavaScript."""

import json
import math


def finite(value, counters):
    if isinstance(value, float) and math.isfinite(value):
        return value
    counters["non_finite"] += 1
    return None


def fix_surrogates(value, counters):
    """Replace lone surrogates in every string and every dict key."""
    if isinstance(value, str):
        fixed = value.encode("utf-16", "surrogatepass").decode("utf-16", "replace")
        if fixed != value:
            counters["lone_surrogate"] += 1
        return fixed
    if isinstance(value, list):
        return [fix_surrogates(item, counters) for item in value]
    if isinstance(value, dict):
        repaired = {}
        for key, item in value.items():
            new_key = fix_surrogates(key, counters) if isinstance(key, str) else key
            repaired[new_key] = fix_surrogates(item, counters)
        return repaired
    return value


def loads(text, counters):
    def parse_int(raw):
        if len(raw.lstrip("-")) <= 16 and abs(int(raw)) <= 2**53 - 1:
            return int(raw)
        return finite(float(raw), counters)

    def parse_float(raw):
        return finite(float(raw), counters)

    def parse_constant(_raw):
        counters["non_finite"] += 1
        return None

    return json.loads(
        text,
        parse_int=parse_int,
        parse_float=parse_float,
        parse_constant=parse_constant,
    )
