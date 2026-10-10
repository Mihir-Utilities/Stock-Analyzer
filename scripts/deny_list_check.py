#!/usr/bin/env python3
"""Safe Edition deny-list (SAF-01, SAF-02).

Fails when source code, dependency manifests or lockfiles mention a forbidden library,
hostname or order-placing method name (docs/00-legal-and-safety.md section 1, CLAUDE.md 0.1).

Scanned: code and dependency files only. Not scanned: specs (docs/, tasks/, *.md), tool output
directories, this script and its tests, and config/research_links.json (plain hyperlinks the
app never requests; T00 scope).

Usage: python scripts/deny_list_check.py [root]
Exit status: 0 clean, 1 violations found.
"""

from __future__ import annotations

import re
import sys
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

# (rule id, compiled pattern, why it is forbidden)
RULES: list[tuple[str, re.Pattern[str], str]] = [
    (
        "yahoo-finance",
        re.compile(r"\byfinance\b|finance\.yahoo|yahoofinance", re.I),
        "Yahoo Finance",
    ),
    (
        "nse-library",
        re.compile(r"\b(nsepython|nsepy|nsetools|jugaad[-_]data)\b", re.I),
        "NSE scraping library",
    ),
    (
        "nse-bse-host",
        re.compile(r"(nseindia|bseindia)\.com|\bbsedata\b", re.I),
        "NSE/BSE website or endpoint",
    ),
    ("screener-host", re.compile(r"screener\.in", re.I), "Screener.in fetch path"),
    (
        "news-rss",
        re.compile(
            r"\bfeedparser\b|news\.google\.com|\bnewspaper3k\b|\bgooglenews\b|\bgnews\b", re.I
        ),
        "news / RSS access",
    ),
    (
        "order-method",
        re.compile(r"\b(place|modify|cancel|slice)[_-]?orders?\b", re.I),
        "order placement/modification/cancellation (SAF-02: no trading code)",
    ),
]

CODE_SUFFIXES = {
    ".py",
    ".go",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".json",
    ".yml",
    ".yaml",
    ".toml",
    ".txt",
    ".lock",
    ".sum",
    ".mod",
    ".sql",
    ".sh",
    ".cfg",
    ".ini",
}
CODE_NAMES = {"Dockerfile", "Makefile", "uv.lock", "go.sum", "go.mod", "package-lock.json"}
SKIP_DIRS = {
    ".git",
    "node_modules",
    ".venv",
    "venv",
    ".next",
    "__pycache__",
    "dist",
    "build",
    "vendor",
    ".mypy_cache",
    ".ruff_cache",
    ".pytest_cache",
    "coverage",
    "docs",
    "tasks",
}
# Paths (posix, relative to root) that are exempt from scanning.
EXEMPT = {
    "config/research_links.json",
    "scripts/deny_list_check.py",
}
EXEMPT_PREFIXES = ("scripts/tests/",)


@dataclass(frozen=True)
class Violation:
    path: str
    line: int
    rule: str
    text: str

    def __str__(self) -> str:
        return f"{self.path}:{self.line}: [{self.rule}] {self.text.strip()[:140]}"


def _iter_files(root: Path) -> Iterator[Path]:
    for path in sorted(root.rglob("*")):
        rel_parts = path.relative_to(root).parts
        if any(part in SKIP_DIRS for part in rel_parts[:-1]):
            continue
        if not path.is_file():
            continue
        rel = "/".join(rel_parts)
        if rel in EXEMPT or rel.startswith(EXEMPT_PREFIXES):
            continue
        if path.suffix in CODE_SUFFIXES or path.name in CODE_NAMES:
            yield path


def scan(root: Path) -> list[Violation]:
    """Return every violation under ``root``."""
    found: list[Violation] = []
    for path in _iter_files(root):
        rel = "/".join(path.relative_to(root).parts)
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError as exc:  # unreadable file: fail closed
            found.append(Violation(rel, 0, "unreadable", str(exc)))
            continue
        for number, line in enumerate(lines, 1):
            for rule, pattern, _why in RULES:
                if pattern.search(line):
                    found.append(Violation(rel, number, rule, line))
    return found


def main(argv: list[str]) -> int:
    root = Path(argv[1]) if len(argv) > 1 else Path(__file__).resolve().parent.parent
    violations = scan(root)
    if violations:
        print(f"deny-list check FAILED: {len(violations)} violation(s)", file=sys.stderr)
        for violation in violations:
            print(f"  {violation}", file=sys.stderr)
        return 1
    print("deny-list check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
