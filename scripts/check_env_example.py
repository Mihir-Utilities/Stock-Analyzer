#!/usr/bin/env python3
"""`.env.example` must list every config key of MASTER_PLAN section 5 plus the core variables,
and must not contain secret values (CLAUDE.md 0.7).

Usage: python scripts/check_env_example.py [root]
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

CORE = [
    "DATABASE_URL",
    "BROKER_TOKEN_KEY",
    "WORKER_HMAC_KEY",
    "LOG_LEVEL",
    "PORT",
    "APP_BASE_URL",
    "API_PUBLIC_URL",
    "INITIAL_PASSWORD_HASH",
    "WORKER_BASE_URL",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_WEBHOOK_SECRET",
    "TELEGRAM_BOT_USERNAME",
    "BROKER_ENABLED",
    "SCREENER_IMPORT_ENABLED",
    "AGE_PUBLIC_KEY",
    "API_BASE_URL",
]
# app_setting keys that are deliberately NOT env-overridable (owner choice in the UI).
NOT_ENV = {"PRICES_ALREADY_ADJUSTED"}
SECRETISH = re.compile(r"KEY|SECRET|TOKEN|PASSWORD|HASH|URL|DSN|CLIENT_ID", re.I)
ASSIGN = re.compile(r"^\s*#?\s*([A-Z][A-Z0-9_]+)=(.*)$")


def master_plan_keys(text: str) -> list[str]:
    section = text.split("## 5. Configuration constants", 1)[1].split("\n## ", 1)[0]
    return re.findall(r"^\| `([A-Z][A-Z0-9_]+)` \|", section, re.M)


def check(root: Path) -> list[str]:
    problems: list[str] = []
    env_text = (root / ".env.example").read_text(encoding="utf-8")
    listed: dict[str, str] = {}
    for line in env_text.splitlines():
        match = ASSIGN.match(line)
        if match:
            listed[match.group(1)] = re.sub(r"\s+#.*$", "", match.group(2)).strip()
    plan_keys = master_plan_keys((root / "MASTER_PLAN.md").read_text(encoding="utf-8"))
    wanted = CORE + [key for key in plan_keys if key not in NOT_ENV]
    for key in wanted:
        if key not in listed:
            problems.append(f"missing from .env.example: {key}")
    for key, value in listed.items():
        if value and SECRETISH.search(key):
            problems.append(f"secret-like variable has a value in .env.example: {key}")
    return problems


def main(argv: list[str]) -> int:
    root = Path(argv[1]) if len(argv) > 1 else Path(__file__).resolve().parent.parent
    problems = check(root)
    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        return 1
    print(".env.example check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
