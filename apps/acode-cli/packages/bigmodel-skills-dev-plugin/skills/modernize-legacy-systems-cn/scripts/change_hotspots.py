#!/usr/bin/env python3
"""Rank Git change hotspots without modifying the repository."""

from __future__ import annotations

import collections
import json
import subprocess
import sys
from pathlib import Path


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    try:
        days = int(sys.argv[2]) if len(sys.argv) > 2 else 180
        if days <= 0:
            raise ValueError("天数必须大于 0")
    except ValueError as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        return 2
    command = [
        "git", "log", f"--since={days} days ago", "--numstat",
        "--format=COMMIT%x09%H%x09%an", "--", ".",
    ]
    try:
        result = subprocess.run(command, cwd=root, text=True, capture_output=True, check=True)
    except (OSError, subprocess.CalledProcessError, ValueError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        return 2

    stats = collections.defaultdict(lambda: {"commits": set(), "authors": set(), "churn": 0})
    commit = author = None
    for line in result.stdout.splitlines():
        if line.startswith("COMMIT\t"):
            _, commit, author = line.split("\t", 2)
            continue
        parts = line.split("\t")
        if len(parts) != 3 or commit is None:
            continue
        added, deleted, filename = parts
        churn = (int(added) + int(deleted)) if added.isdigit() and deleted.isdigit() else 0
        stats[filename]["commits"].add(commit)
        stats[filename]["authors"].add(author)
        stats[filename]["churn"] += churn
    rows = [{
        "file": filename, "commits": len(value["commits"]),
        "authors": len(value["authors"]), "churn": value["churn"],
        "score": len(value["commits"]) * max(1, len(value["authors"])),
    } for filename, value in stats.items()]
    rows.sort(key=lambda item: (item["score"], item["churn"]), reverse=True)
    print(json.dumps({"window_days": days, "hotspots": rows[:50]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
