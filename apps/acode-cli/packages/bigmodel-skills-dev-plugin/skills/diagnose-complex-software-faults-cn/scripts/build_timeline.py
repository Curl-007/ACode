#!/usr/bin/env python3
"""Normalize timestamped JSONL evidence into a correlation-aware timeline."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path


DEFAULT_MAX_EVENTS = 200_000


def parse_time(value: str) -> datetime:
    normalized = value.replace("Z", "+00:00")
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        raise ValueError("timestamp 必须包含时区")
    return parsed.astimezone(timezone.utc)


def main() -> int:
    if len(sys.argv) not in (2, 3):
        print("用法: build_timeline.py events.jsonl [max_events]", file=sys.stderr)
        return 2
    try:
        max_events = int(sys.argv[2]) if len(sys.argv) == 3 else DEFAULT_MAX_EVENTS
        if max_events <= 0:
            raise ValueError
    except ValueError:
        print(json.dumps({"error": "max_events 必须为正整数"}, ensure_ascii=False))
        return 2
    events, errors = [], []
    try:
        source = Path(sys.argv[1]).open("r", encoding="utf-8")
    except OSError as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        return 2
    with source:
        for number, line in enumerate(source, 1):
            if not line.strip():
                continue
            try:
                event = json.loads(line)
                utc = parse_time(event["timestamp"])
                if len(events) >= max_events:
                    print(json.dumps({
                        "error": f"有效事件超过上限 {max_events}；请按事故时间窗、关联 ID 或实体只读切片后重试",
                        "processed_lines": number - 1,
                        "parse_errors": errors,
                    }, ensure_ascii=False))
                    return 3
                events.append({
                    **event,
                    "timestamp_utc": utc.isoformat(timespec="microseconds").replace("+00:00", "Z"),
                    "_sort_epoch": utc.timestamp(),
                })
            except (json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
                errors.append({"line": number, "error": str(error)})
    events.sort(key=lambda item: item["_sort_epoch"])
    for event in events:
        event.pop("_sort_epoch", None)
    groups = {}
    for event in events:
        key = event.get("correlation_id", "无关联 ID")
        groups.setdefault(key, []).append(event)
    print(json.dumps({"events": events, "groups": groups, "parse_errors": errors}, ensure_ascii=False, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
