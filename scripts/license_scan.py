#!/usr/bin/env python3
"""Licence scan for Go, Python and npm dependencies (SAF-04) and THIRD_PARTY_NOTICES.md generator.

Policy (docs/00-legal-and-safety.md section 1.7): permissive licences only; fail on GPL/AGPL and on
unknown licences (exactly as written). Weak-copyleft or otherwise unusual non-GPL licences (MPL-2.0,
LGPL) do not fail the scan; they are listed under "Review" in the notices so the owner can see them
(docs/OPEN_QUESTIONS.md OQ-8).

Usage:
  python scripts/license_scan.py            # scan, fail on violations, fail if notices are stale
  python scripts/license_scan.py --write    # scan, fail on violations, rewrite THIRD_PARTY_NOTICES.md

Collectors read: apps/web/package-lock.json and packages/api-types/package-lock.json (npm); apps/worker/uv.lock (Python: the package list
comes from the lockfile so it is the same on every OS; licence text comes from the installed
environment, with `uv sync --all-groups --all-extras`, or, for packages that only install on another
platform such as colorama on Windows, from the row already committed in THIRD_PARTY_NOTICES.md);
and `go list -m -json all` in apps/api (Go; LICENSE file text is classified, so run
`go mod download` first).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tomllib
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NOTICES = ROOT / "THIRD_PARTY_NOTICES.md"

# Permissive licences accepted without review (SPDX ids).
PERMISSIVE = {
    "MIT",
    "MIT-0",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "BSD",
    "ISC",
    "0BSD",
    "OFL-1.1",
    "Unlicense",
    "CC0-1.0",
    "Zlib",
    "BlueOak-1.0.0",
    "Python-2.0",
    "PSF-2.0",
    "CC-BY-4.0",
    "WTFPL",
}
# Not GPL/AGPL and not unknown, but worth a human look: listed, does not fail (LGPL handled in classify).
REVIEW = {"MPL-2.0", "EPL-2.0", "CDDL-1.0"}

_ALIASES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^(the )?mit( license)?$|^mit license", re.I), "MIT"),
    (re.compile(r"^apache[- ]?(software )?(license)?[- ,]*(version |v)?1", re.I), "Apache-1.1"),
    (re.compile(r"apache", re.I), "Apache-2.0"),
    (re.compile(r"^bsd[- ]?4|advertising", re.I), "BSD-4-Clause"),
    (re.compile(r"^bsd[- ]?2", re.I), "BSD-2-Clause"),
    (re.compile(r"^bsd[- ]?3|new bsd|modified bsd", re.I), "BSD-3-Clause"),
    (re.compile(r"^bsd", re.I), "BSD"),
    (re.compile(r"^isc", re.I), "ISC"),
    (re.compile(r"python software foundation|^psf", re.I), "PSF-2.0"),
    (re.compile(r"mozilla public license.*2|^mpl[- ]?2", re.I), "MPL-2.0"),
    (re.compile(r"open font|^ofl", re.I), "OFL-1.1"),
    (re.compile(r"^unlicense|the unlicense", re.I), "Unlicense"),
    (re.compile(r"^cc0", re.I), "CC0-1.0"),
]
_COPYLEFT = re.compile(r"\ba?gpl\b|\ba?gpl[-v0-9]|gnu (affero )?general public", re.I)
_LGPL = re.compile(r"\blgpl|gnu (lesser|library) general public", re.I)


def normalize(token: str) -> str:
    token = token.strip().strip("()").strip()
    for pattern, spdx in _ALIASES:
        if pattern.search(token):
            return spdx
    return token


def classify(expression: str | None) -> str:
    """Return 'ok', 'review', 'copyleft' or 'unknown' for an SPDX-ish expression.

    ``A OR B``: best alternative wins. ``A AND B``: worst part wins.
    """
    if (
        not expression
        or not expression.strip()
        or expression.strip().upper()
        in {
            "UNKNOWN",
            "UNLICENSED",
            "NONE",
            "SEE LICENSE IN LICENSE",
        }
    ):
        return "unknown"
    order = {"ok": 0, "review": 1, "unknown": 2, "copyleft": 3}
    expr = expression.strip()
    if " OR " in expr:
        return min((classify(part) for part in re.split(r"\s+OR\s+", expr)), key=order.__getitem__)
    if " AND " in expr:
        return max((classify(part) for part in re.split(r"\s+AND\s+", expr)), key=order.__getitem__)
    if _COPYLEFT.search(expr):
        return "copyleft"
    if _LGPL.search(expr):
        return "review"
    spdx = normalize(expr)
    if spdx in PERMISSIVE:
        return "ok"
    if spdx in REVIEW:
        return "review"
    return "unknown"


@dataclass(frozen=True)
class Entry:
    ecosystem: str
    name: str
    version: str
    license: str
    scope: str  # runtime | dev

    @property
    def status(self) -> str:
        return classify(self.license)


# ------------------------------------------------------------------ collectors
def npm_entries(lockfile: Path) -> list[Entry]:
    if not lockfile.exists():
        return []
    data = json.loads(lockfile.read_text(encoding="utf-8"))
    out: list[Entry] = []
    for key, pkg in data.get("packages", {}).items():
        if not key:  # the root project itself
            continue
        name = pkg.get("name") or key.split("node_modules/")[-1]
        lic = pkg.get("license")
        if isinstance(lic, dict):
            lic = lic.get("type")
        if isinstance(lic, list):
            lic = " OR ".join(str(x.get("type", x)) if isinstance(x, dict) else str(x) for x in lic)
        out.append(
            Entry(
                "npm",
                name,
                pkg.get("version", "?"),
                str(lic or "UNKNOWN"),
                "dev" if pkg.get("dev") else "runtime",
            )
        )
    return out


_PY_PROBE = r"""
import importlib.metadata as md, json
out = []
for d in md.distributions():
    m = d.metadata
    name = m["Name"]
    if not name or name.lower() == "india-analyzer-worker":
        continue
    lic = m.get("License-Expression") or ""
    if not lic:
        cls = [c.split("::")[-1].strip() for c in (m.get_all("Classifier") or []) if c.startswith("License ::")]
        cls = [c for c in cls if c.lower() not in ("osi approved",)]
        lic = " OR ".join(cls)
    if not lic:
        raw = (m.get("License") or "").strip()
        lic = raw if 0 < len(raw) < 80 and "\n" not in raw else ""
    out.append({"name": name, "version": d.version, "license": lic})
print(json.dumps(out))
"""


def normalize_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def lock_packages(lockfile: Path) -> list[tuple[str, str]]:
    """(normalised name, version) of every package in uv.lock except the project itself."""
    data = tomllib.loads(lockfile.read_text(encoding="utf-8"))
    out = []
    for pkg in data.get("package", []):
        source = pkg.get("source", {})
        if "editable" in source or "virtual" in source:
            continue
        out.append((normalize_name(pkg["name"]), pkg["version"]))
    return sorted(out)


def previous_python_licenses(notices: str) -> dict[tuple[str, str], str]:
    """Python rows already committed in THIRD_PARTY_NOTICES.md: (name, version) -> licence."""
    rows: dict[tuple[str, str], str] = {}
    for line in notices.splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) >= 6 and cells[0] == "python":
            rows[(normalize_name(cells[1]), cells[2])] = cells[3]
    return rows


def python_entries_from(
    locked: list[tuple[str, str]],
    installed: dict[tuple[str, str], str],
    previous: dict[tuple[str, str], str],
) -> list[Entry]:
    entries = []
    for name, version in locked:
        lic = installed.get((name, version)) or previous.get((name, version)) or "UNKNOWN"
        entries.append(Entry("python", name, version, lic, "runtime/dev"))
    return entries


def python_entries(project: Path, notices: str = "") -> list[Entry]:
    lockfile = project / "uv.lock"
    if not lockfile.exists():
        return []
    result = subprocess.run(
        [
            "uv",
            "run",
            "--frozen",
            "--all-groups",
            "--all-extras",
            "--project",
            str(project),
            "python",
            "-c",
            _PY_PROBE,
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    rows = json.loads(result.stdout.strip().splitlines()[-1])
    installed = {(normalize_name(r["name"]), r["version"]): r["license"] for r in rows}
    return python_entries_from(
        lock_packages(lockfile), installed, previous_python_licenses(notices)
    )


def go_entries(module_dir: Path) -> list[Entry]:
    if not (module_dir / "go.mod").exists():
        return []
    # Modules that actually provide a built package (including test-only packages). `go list -m all`
    # also lists modules that only appear in dependencies' go.mod files and are never compiled or
    # downloaded (e.g. testcontainers pulls hundreds), which cannot be classified and are not shipped.
    result = subprocess.run(
        ["go", "list", "-deps", "-test", "-json=Module", "./..."],
        cwd=module_dir,
        capture_output=True,
        text=True,
        check=True,
        # Fixed target so the module list (and the notices file) is identical on every machine.
        env={**os.environ, "GOOS": "linux", "GOARCH": "amd64", "CGO_ENABLED": "0"},
    )
    decoder = json.JSONDecoder()
    text, pos = result.stdout, 0
    seen: dict[tuple[str, str], Entry] = {}
    while pos < len(text):
        while pos < len(text) and text[pos].isspace():
            pos += 1
        if pos >= len(text):
            break
        pkg, pos = decoder.raw_decode(text, pos)
        obj = pkg.get("Module")
        if not obj or obj.get("Main"):
            continue
        key = (obj["Path"], obj.get("Version", "?"))
        if key not in seen:
            seen[key] = Entry(
                "go",
                key[0],
                key[1],
                _go_license(Path(obj["Dir"])) if obj.get("Dir") else "UNKNOWN",
                "runtime",
            )
    return sorted(seen.values(), key=lambda e: (e.name, e.version))


_LICENSE_NAMES = {
    "license",
    "license.md",
    "license.txt",
    "licence",
    "licence.md",
    "licence.txt",
    "copying",
    "copying.md",
    "copying.txt",
}


def _license_files(directory: Path) -> list[Path]:
    """Licence files in ``directory``, matched case-insensitively (some modules ship license.md;
    Windows hides that difference, Linux CI does not)."""
    if not directory.is_dir():
        return []
    files = [f for f in directory.iterdir() if f.is_file() and f.name.lower() in _LICENSE_NAMES]
    return sorted(files, key=lambda f: (f.name.lower(), f.name))


def _go_license(directory: Path) -> str:
    for file in _license_files(directory):
        text = file.read_text(encoding="utf-8", errors="replace")[:4000]
        if _COPYLEFT.search(text):
            return "GPL-family"
        for needle, spdx in (
            ("Apache License", "Apache-2.0"),
            ("MIT License", "MIT"),
            ("Permission is hereby granted, free of charge", "MIT"),
            ("Mozilla Public License", "MPL-2.0"),
            ("ISC License", "ISC"),
            ("Redistribution and use in source and binary forms", "BSD-3-Clause"),
        ):
            if needle in text:
                return spdx
    return "UNKNOWN"


# ------------------------------------------------------------------ notices
def render_notices(entries: list[Entry]) -> str:
    rows = sorted(
        {(e.ecosystem, e.name.lower(), e.name, e.version, e.license, e.scope) for e in entries}
    )
    lines = [
        "# Third-party notices",
        "",
        "Generated by `scripts/license_scan.py --write`. Do not edit by hand.",
        "Policy: permissive licences only; the scan fails on GPL/AGPL and unknown licences; MPL/LGPL are listed as Review.",
        "",
        f"Packages: {len(rows)}",
        "",
        "| Ecosystem | Package | Version | Licence | Scope | Status |",
        "|---|---|---|---|---|---|",
    ]
    for eco, _key, name, version, lic, scope in rows:
        status = {"ok": "ok", "review": "Review", "copyleft": "FAIL", "unknown": "FAIL"}[
            classify(lic)
        ]
        lines.append(
            f"| {eco} | {name} | {version} | {lic.replace('|', '/')} | {scope} | {status} |"
        )
    lines.append("")
    return "\n".join(lines)


def violations(entries: list[Entry]) -> list[Entry]:
    return [e for e in entries if e.status in {"copyleft", "unknown"}]


def collect() -> list[Entry]:
    notices = NOTICES.read_text(encoding="utf-8") if NOTICES.exists() else ""
    return (
        npm_entries(ROOT / "apps/web/package-lock.json")
        + npm_entries(ROOT / "packages/api-types/package-lock.json")
        + python_entries(ROOT / "apps/worker", notices)
        + go_entries(ROOT / "apps/api")
    )


def main(argv: list[str]) -> int:
    entries = collect()
    bad = violations(entries)
    for e in bad:
        print(
            f"LICENCE VIOLATION: {e.ecosystem} {e.name}@{e.version}: {e.license} ({e.status})",
            file=sys.stderr,
        )
    for e in entries:
        if e.status == "review":
            print(f"review: {e.ecosystem} {e.name}@{e.version}: {e.license}")
    if bad:
        return 1
    text = render_notices(entries)
    if "--write" in argv:
        NOTICES.write_text(text, encoding="utf-8", newline="\n")
        print(f"wrote {NOTICES.name}: {len(entries)} packages")
        return 0
    current = NOTICES.read_text(encoding="utf-8") if NOTICES.exists() else ""
    if current.replace("\r\n", "\n") != text:
        print(
            "THIRD_PARTY_NOTICES.md is missing or stale: run scripts/license_scan.py --write",
            file=sys.stderr,
        )
        return 1
    print(f"licence scan passed: {len(entries)} packages")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
