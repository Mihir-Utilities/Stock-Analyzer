#!/usr/bin/env python3
"""Safe Edition deny-list (SAF-01, SAF-02).

Fails when any non-binary file in the repository mentions a forbidden library, hostname or
order-placing method (docs/00-legal-and-safety.md section 1, CLAUDE.md 0.1).

Every file is scanned (not only known suffixes), including dotfiles, Dockerfiles, workflows,
lockfiles and `.env.example`. Not scanned: Markdown (specs and notes name the forbidden things on
purpose), tool/output directories (`.git`, `node_modules`, `.venv`, `.next`, caches), this script,
its own test file, and `config/research_links.json` (plain hyperlinks the app never requests).

Each file is checked in four views so simple obfuscation does not slip through:
  1. raw lines;
  2. adjacent string literals joined ("yfin" + "ance", implicit concatenation, line breaks);
  3. escapes decoded (\\uXXXX, \\xXX, %XX);
  4. base64-looking tokens decoded.
UTF-16 files are decoded. Static scanning cannot catch values built at runtime (environment
variables, network responses); the runtime egress allow-list (D01/B01) covers that.

Usage: python scripts/deny_list_check.py [root]
Exit status: 0 clean, 1 violations found.
"""

from __future__ import annotations

import base64
import binascii
import re
import sys
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote

# (rule id, compiled pattern, why it is forbidden)
RULES: list[tuple[str, re.Pattern[str], str]] = [
    (
        "yahoo-finance",
        re.compile(r"yfinance|yahoo[\s._-]?fin|yahooquery|finance\.yahoo", re.I),
        "Yahoo Finance",
    ),
    (
        "nse-library",
        re.compile(r"nsepython|nsepy|nsetools|jugaad[-_]?data|nselib|bsedata|stocksymbol", re.I),
        "NSE/BSE scraping library",
    ),
    (
        "nse-bse-host",
        re.compile(r"nseindia|bseindia|nsearchives|nse-india", re.I),
        "NSE/BSE website or endpoint",
    ),
    ("screener-host", re.compile(r"screener\.in\b", re.I), "Screener.in fetch path"),
    (
        "data-portal-host",
        re.compile(
            r"moneycontrol|trendlyne|tickertape|investing\.com|stooq|alphavantage|twelvedata"
            r"|finnhub|marketstack|eodhd|polygon\.io|pandas[-_]datareader|investpy",
            re.I,
        ),
        "market-data portal or vendor outside the allowed sources",
    ),
    (
        "news-rss",
        re.compile(
            r"feedparser|rss-parser|news\.google\.com|newspaper3k|googlenews|newsapi"
            r"|(?<![a-z])gnews(?![a-z])",
            re.I,
        ),
        "news / RSS access",
    ),
    (
        "scraping-lib",
        re.compile(
            r"beautifulsoup4?|(?<![a-z])bs4(?![a-z])|(?<![a-z])scrapy(?![a-z])"
            r"|(?<![a-z])cheerio(?![a-z])|mechanicalsoup|requests-html",
            re.I,
        ),
        "HTML scraping library",
    ),
    (
        "order-method",
        re.compile(
            r"((?<!re)(?<!dis)(?<!work)place|modify|cancel|slice)[_-]?(gtt[_-]?|bracket[_-]?|cover[_-]?|regular[_-]?|bo[_-]?|co[_-]?)?orders?"
            r"|(?<![a-z])(basket|bracket|cover)[_-]?orders?"
            r"|square[_-]?off|exit[_-]?position"
            r"|/orders?/(place|modify|cancel|regular|gtt|basket|slice|bracket|cover|sync)\b"
            r"|/v\d+/orders?(?![a-z])",
            re.I,
        ),
        "order placement/modification/cancellation (SAF-02: no trading code)",
    ),
]

# Directories never scanned, at any depth (tool output and dependency caches).
SKIP_DIRS = {
    ".git",
    "node_modules",
    ".venv",
    "venv",
    ".next",
    "__pycache__",
    ".mypy_cache",
    ".ruff_cache",
    ".pytest_cache",
}
# Files never scanned (extensions of Markdown prose and of binary assets).
SKIP_SUFFIXES = {
    ".md",
    ".mdx",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".svgz",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".pdf",
    ".zip",
    ".gz",
    ".age",
    ".exe",
    ".pyc",
}
# Paths (posix, relative to root) that are exempt from scanning. Keep this list minimal.
EXEMPT = {
    "config/research_links.json",
    "scripts/deny_list_check.py",
    "scripts/tests/test_deny_list.py",
}

_JOIN_LITERALS = re.compile(r"[\"'`]\s*(?:\+|\.\s*join\(\s*\[?)?\s*[\"'`]")
_UNICODE_ESC = re.compile(r"\\u([0-9a-fA-F]{4})")
_HEX_ESC = re.compile(r"\\x([0-9a-fA-F]{2})")
_B64_TOKEN = re.compile(r"[A-Za-z0-9+/_-]{16,}={0,2}")


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
        if "/".join(rel_parts) in EXEMPT or path.suffix.lower() in SKIP_SUFFIXES:
            continue
        yield path


def _decode(data: bytes) -> str | None:
    """Return the text of a file, or None for binary content."""
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16", errors="replace")
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:].decode("utf-8", errors="replace")
    if b"\x00" in data:
        sample = data[:4096]
        if sample[1::2].count(0) > len(sample) // 4:
            return data.decode("utf-16-le", errors="replace")
        if sample[0::2].count(0) > len(sample) // 4:
            return data.decode("utf-16-be", errors="replace")
        return None  # genuine binary
    return data.decode("utf-8", errors="replace")


def _views(text: str) -> Iterator[tuple[str, str]]:
    """Yield (view name, text) variants in which obfuscated names become visible."""
    joined = _JOIN_LITERALS.sub("", text)
    yield "split", joined
    unescaped = _HEX_ESC.sub(lambda m: chr(int(m.group(1), 16)), joined)
    unescaped = _UNICODE_ESC.sub(lambda m: chr(int(m.group(1), 16)), unescaped)
    unescaped = unquote(unescaped)
    if unescaped != joined:
        yield "escaped", unescaped
    decoded: list[str] = []
    for token in _B64_TOKEN.findall(text):
        padded = token.replace("-", "+").replace("_", "/")
        padded += "=" * (-len(padded) % 4)
        try:
            decoded.append(base64.b64decode(padded, validate=True).decode("utf-8", "ignore"))
        except (binascii.Error, ValueError):
            continue
    if decoded:
        yield "base64", "\n".join(decoded)


def scan_text(rel: str, text: str) -> list[Violation]:
    found: dict[tuple[int, str], Violation] = {}
    for number, line in enumerate(text.splitlines(), 1):
        for rule, pattern, _why in RULES:
            if pattern.search(line):
                found.setdefault((number, rule), Violation(rel, number, rule, line))
    raw_rules = {rule for _, rule in found}
    for view, variant in _views(text):
        for rule, pattern, _why in RULES:
            if rule in raw_rules:
                continue
            match = pattern.search(variant)
            if match:
                line_no = variant.count("\n", 0, match.start()) + 1
                found.setdefault(
                    (line_no, f"{rule}:{view}"),
                    Violation(rel, line_no, f"{rule}:{view}", match.group(0)),
                )
    return list(found.values())


def scan(root: Path) -> list[Violation]:
    """Return every violation under ``root``."""
    found: list[Violation] = []
    for path in _iter_files(root):
        rel = "/".join(path.relative_to(root).parts)
        try:
            text = _decode(path.read_bytes())
        except OSError as exc:  # unreadable file: fail closed
            found.append(Violation(rel, 0, "unreadable", str(exc)))
            continue
        if text is not None:
            found.extend(scan_text(rel, text))
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
