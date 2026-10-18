#!/usr/bin/env python3
"""Estimate average/peak RPS and minimum throughput instances."""
import argparse
import json
import math


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--daily-requests", type=float, required=True)
    parser.add_argument("--peak-ratio", type=float, required=True)
    parser.add_argument("--safe-rps-per-instance", type=float, required=True)
    parser.add_argument("--growth", type=float, default=1.0)
    parser.add_argument("--headroom", type=float, default=1.0)
    args = parser.parse_args()
    values = vars(args)
    if any(value <= 0 for value in values.values()):
        raise SystemExit("all inputs must be > 0")
    average = args.daily_requests / 86400
    peak = average * args.peak_ratio * args.growth * args.headroom
    instances = math.ceil(peak / args.safe_rps_per_instance)
    print(json.dumps({
        "average_rps": round(average, 4),
        "planned_peak_rps": round(peak, 4),
        "throughput_instances": instances,
        "formula": "daily_requests/86400*peak_ratio*growth*headroom",
        "note": "availability replicas and failure-domain constraints are additional",
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
