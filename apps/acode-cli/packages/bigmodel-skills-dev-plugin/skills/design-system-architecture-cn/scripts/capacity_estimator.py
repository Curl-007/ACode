#!/usr/bin/env python3
"""Transparent order-of-magnitude capacity calculator."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path


def need(spec: dict, key: str) -> float:
    value = spec.get(key)
    if not isinstance(value, (int, float)) or value < 0:
        raise ValueError(f"缺少非负数值: {key}")
    return float(value)


def positive(spec: dict, key: str) -> float:
    value = need(spec, key)
    if value == 0:
        raise ValueError(f"数值必须大于 0: {key}")
    return value


def main() -> int:
    if len(sys.argv) != 2:
        print("用法: capacity_estimator.py assumptions.json", file=sys.stderr)
        return 2
    try:
        spec = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
        dau = need(spec, "daily_active_users")
        actions = need(spec, "actions_per_user_per_day")
        peak = need(spec, "peak_to_average_ratio")
        payload = need(spec, "average_payload_bytes")
        retention = need(spec, "retention_days")
        headroom = positive(spec, "headroom_ratio")
        safe_rps = positive(spec, "safe_rps_per_instance")
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        return 2

    daily = dau * actions
    average_rps = daily / 86400
    peak_rps = average_rps * peak
    design_peak_rps = peak_rps * headroom
    raw_storage = daily * payload * retention
    design_storage = raw_storage * headroom
    result = {
        "formulae": {
            "daily_requests": "DAU × actions_per_user_per_day",
            "peak_rps": "daily_requests ÷ 86400 × peak_to_average_ratio",
            "design_peak_rps": "peak_rps × headroom_ratio",
            "raw_storage_bytes": "daily_requests × payload_bytes × retention_days",
            "design_storage_bytes": "raw_storage_bytes × headroom_ratio",
            "minimum_design_instances": "ceil(design_peak_rps ÷ safe_rps_per_instance)",
        },
        "daily_requests": round(daily),
        "average_rps": round(average_rps, 2),
        "peak_rps": round(peak_rps, 2),
        "design_peak_rps": round(design_peak_rps, 2),
        "raw_storage_gib": round(raw_storage / (1024 ** 3), 2),
        "design_storage_gib": round(design_storage / (1024 ** 3), 2),
        "minimum_raw_peak_instances": math.ceil(peak_rps / safe_rps) if peak_rps else 0,
        "minimum_design_instances": math.ceil(design_peak_rps / safe_rps) if design_peak_rps else 0,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
