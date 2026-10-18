#!/usr/bin/env python3
"""Calculate earliest finish and critical path for a DAG of work packages."""
import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    args = parser.parse_args()
    tasks = json.loads(args.input.read_text(encoding="utf-8"))["tasks"]
    by_id = {task["id"]: task for task in tasks}
    if len(by_id) != len(tasks):
        raise SystemExit("duplicate task id")
    pending = set(by_id)
    finish, path_to = {}, {}
    while pending:
        ready = sorted(task_id for task_id in pending if all(dep in finish for dep in by_id[task_id].get("depends_on", [])))
        if not ready:
            unknown = sorted({dep for task_id in pending for dep in by_id[task_id].get("depends_on", []) if dep not in by_id})
            raise SystemExit(f"cycle or unknown dependencies: {unknown}")
        for task_id in ready:
            task = by_id[task_id]
            deps = task.get("depends_on", [])
            predecessor = max(deps, key=lambda dep: finish[dep]) if deps else None
            start = finish[predecessor] if predecessor else 0.0
            finish[task_id] = start + float(task["duration_days"])
            path_to[task_id] = (path_to[predecessor] if predecessor else []) + [task_id]
            pending.remove(task_id)
    end = max(finish, key=finish.get)
    print(json.dumps({"duration_days": finish[end], "critical_path": path_to[end], "earliest_finish": finish}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
