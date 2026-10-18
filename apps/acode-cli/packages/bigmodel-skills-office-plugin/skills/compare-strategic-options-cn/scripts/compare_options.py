#!/usr/bin/env python3
"""Validate and calculate a weighted option comparison from a JSON file."""
import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    args = parser.parse_args()
    data = json.loads(args.input.read_text(encoding="utf-8"))
    options = data["options"]
    criteria = data["criteria"]
    weight = sum(float(item["weight"]) for item in criteria if not item.get("hard_constraint"))
    if abs(weight - 1.0) > 1e-9:
        raise SystemExit(f"soft weights must sum to 1.0, got {weight}")
    result = {}
    for option in options:
        failed = []
        low = high = 0.0
        for item in criteria:
            score = item.get("scores", {}).get(option)
            if item.get("hard_constraint"):
                if score is not True:
                    failed.append(item["name"])
                continue
            if score is None:
                low += 0.0
                high += float(item["weight"]) * 4.0
            else:
                value = float(score)
                if not 0 <= value <= 4:
                    raise SystemExit(f"{option}/{item['name']}: score must be 0..4")
                low += float(item["weight"]) * value
                high += float(item["weight"]) * value
        result[option] = {"eligible": not failed, "failed_constraints": failed, "score_range": [round(low, 4), round(high, 4)]}
    print(json.dumps({"options": result}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
