"""Timestamp window and the millisecond formatter from spec §2."""

import math
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_FLOOR

MIN_SECONDS = -62135596800
MAX_SECONDS = 253402300799.999


def format_timestamp(value, counters):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        counters["no_timestamp"] += 1
        return None
    if not math.isfinite(value) or value < MIN_SECONDS or value > MAX_SECONDS:
        counters["no_timestamp"] += 1
        return None
    ms = int((Decimal(repr(value)) * 1000).to_integral_value(ROUND_FLOOR))
    iso = (
        datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(milliseconds=ms)
    ).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return iso
