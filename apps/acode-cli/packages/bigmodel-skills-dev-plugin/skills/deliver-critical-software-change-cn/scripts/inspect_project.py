#!/usr/bin/env python3
"""Read-only multi-language project inspector for delivery planning."""

from __future__ import annotations

import json
import sys
from pathlib import Path


MARKERS = {
    "node": ["package.json"],
    "java-maven": ["pom.xml"],
    "java-gradle": ["build.gradle", "build.gradle.kts"],
    "python": ["pyproject.toml", "requirements.txt"],
    "go": ["go.mod"],
    "rust": ["Cargo.toml"],
    "docker": ["Dockerfile", "docker-compose.yml", "compose.yml"],
}


IGNORED = {
    "node_modules", ".git", "dist", "build", ".next", "target", ".venv",
    "artifacts", "deliverables", "comparisons", "upstream-cache",
}


def files_matching(root: Path, names: tuple[str, ...], limit: int = 30) -> list[str]:
    found = []
    for path in root.rglob("*"):
        relative = path.relative_to(root)
        if any(part in IGNORED for part in relative.parts):
            continue
        inside_named_directory = any(name in relative.parts for name in names if "*" not in name)
        if path.is_file() and (inside_named_directory or path.name in names or any(path.match(pattern) for pattern in names if "*" in pattern)):
            found.append(str(path.relative_to(root)))
            if len(found) >= limit:
                break
    return found


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    if not root.is_dir():
        print(json.dumps({"error": "项目目录不存在", "root": str(root)}, ensure_ascii=False))
        return 2
    stacks = {name: [marker for marker in markers if (root / marker).exists()] for name, markers in MARKERS.items()}
    result = {
        "root": str(root),
        "detected": {name: markers for name, markers in stacks.items() if markers},
        "ci": files_matching(root / ".github", ("*.yml", "*.yaml"), 20) if (root / ".github").exists() else [],
        "migrations": files_matching(root, ("migrations", "migration", "V*.sql", "*.prisma"), 30),
        "tests": files_matching(root, ("*.test.*", "*.spec.*", "test_*.py", "*_test.go"), 30),
        "instructions": [name for name in ("AGENTS.md", "README.md", "CONTRIBUTING.md") if (root / name).exists()],
    }
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
