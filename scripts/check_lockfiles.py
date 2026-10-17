#!/usr/bin/env python3
"""SYS-11 (dependency drift): every app that declares dependencies must commit its lockfile,
and automated dependency PRs must be configured.

Usage: python scripts/check_lockfiles.py [root]
"""

from __future__ import annotations

import re
import sys
from pathlib import Path


def check(root: Path) -> list[str]:
    problems: list[str] = []
    web = root / "apps/web"
    if (web / "package.json").exists() and not (web / "package-lock.json").exists():
        problems.append("apps/web: package-lock.json is missing")
    types_pkg = root / "packages/api-types"
    if (types_pkg / "package.json").exists() and not (types_pkg / "package-lock.json").exists():
        problems.append("packages/api-types: package-lock.json is missing")
    worker = root / "apps/worker"
    if (worker / "pyproject.toml").exists() and not (worker / "uv.lock").exists():
        problems.append("apps/worker: uv.lock is missing")
    api = root / "apps/api"
    gomod = api / "go.mod"
    if gomod.exists():
        text = gomod.read_text(encoding="utf-8")
        if re.search(r"^\s*require\b", text, re.M) and not (api / "go.sum").exists():
            problems.append("apps/api: go.sum is missing")
    if not (root / ".github/renovate.json").exists():
        problems.append(".github/renovate.json is missing (dependency PRs must be automated)")
    return problems


def main(argv: list[str]) -> int:
    root = Path(argv[1]) if len(argv) > 1 else Path(__file__).resolve().parent.parent
    problems = check(root)
    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        return 1
    print("lockfile check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
