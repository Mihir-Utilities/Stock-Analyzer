"""SAF-04: the licence scan fails on GPL/AGPL/unknown and passes permissive licences."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import license_scan as ls  # noqa: E402


@pytest.mark.parametrize(
    ("expr", "expected"),
    [
        ("MIT", "ok"),
        ("MIT License", "ok"),
        ("Apache-2.0", "ok"),
        ("Apache Software License", "ok"),
        ("BSD-3-Clause", "ok"),
        ("BSD License", "ok"),
        ("ISC", "ok"),
        ("OFL-1.1", "ok"),
        ("MIT OR GPL-3.0-only", "ok"),
        ("(MIT OR CC0-1.0)", "ok"),
        ("MIT AND Apache-2.0", "ok"),
        ("MPL-2.0", "review"),
        ("GPL-3.0-only", "copyleft"),
        ("GPL-2.0-or-later", "copyleft"),
        ("AGPL-3.0", "copyleft"),
        ("LGPL-3.0-or-later", "review"),
        ("Apache-2.0 AND LGPL-3.0-or-later AND MIT", "review"),
        ("GNU General Public License v3 (GPLv3)", "copyleft"),
        ("MIT AND GPL-3.0-only", "copyleft"),
        ("UNKNOWN", "unknown"),
        ("", "unknown"),
        (None, "unknown"),
        ("UNLICENSED", "unknown"),
        ("Some Proprietary Thing", "unknown"),
        ("BSD-4-Clause", "unknown"),
        ("BSD with advertising clause", "unknown"),
        ("Apache-1.1", "unknown"),
        ("Apache-2.0 WITH LLVM-exception", "ok"),
        ("SSPL-1.0", "unknown"),
        ("CC-BY-NC-4.0", "unknown"),
        ("BUSL-1.1", "unknown"),
        ("GPL-2.0-only WITH Classpath-exception-2.0", "copyleft"),
    ],
)
def test_classify(expr: str | None, expected: str) -> None:
    assert ls.classify(expr) == expected


def test_violations_lists_only_copyleft_and_unknown() -> None:
    entries = [
        ls.Entry("npm", "a", "1", "MIT", "runtime"),
        ls.Entry("npm", "b", "1", "AGPL-3.0", "runtime"),
        ls.Entry("python", "c", "1", "UNKNOWN", "runtime/dev"),
        ls.Entry("go", "d", "1", "MPL-2.0", "runtime"),
    ]
    assert [e.name for e in ls.violations(entries)] == ["b", "c"]


def test_npm_collector_reads_lockfile(tmp_path: Path) -> None:
    lock = tmp_path / "package-lock.json"
    lock.write_text(
        json.dumps(
            {
                "packages": {
                    "": {"name": "root"},
                    "node_modules/x": {"version": "1.0.0", "license": "MIT"},
                    "node_modules/y": {"version": "2.0.0", "license": "GPL-3.0", "dev": True},
                    "node_modules/z": {"version": "3.0.0"},
                }
            }
        ),
        encoding="utf-8",
    )
    entries = {e.name: e for e in ls.npm_entries(lock)}
    assert set(entries) == {"x", "y", "z"}
    assert [e.name for e in ls.violations(list(entries.values()))] == ["y", "z"]
    assert entries["y"].scope == "dev"


def test_notices_are_deterministic_and_flag_failures() -> None:
    entries = [
        ls.Entry("npm", "b", "1", "MIT", "runtime"),
        ls.Entry("npm", "a", "1", "GPL-3.0", "dev"),
    ]
    text = ls.render_notices(entries)
    assert text == ls.render_notices(list(reversed(entries)))
    assert "| npm | a | 1 | GPL-3.0 | dev | FAIL |" in text
    assert "Packages: 2" in text


def test_go_license_text_classification(tmp_path: Path) -> None:
    (tmp_path / "LICENSE").write_text(
        "MIT License\n\nPermission is hereby granted, free of charge", encoding="utf-8"
    )
    assert ls._go_license(tmp_path) == "MIT"
    gpl = tmp_path / "g"
    gpl.mkdir()
    (gpl / "LICENSE").write_text("GNU GENERAL PUBLIC LICENSE Version 3", encoding="utf-8")
    assert ls.classify(ls._go_license(gpl)) == "copyleft"
    empty = tmp_path / "e"
    empty.mkdir()
    assert ls.classify(ls._go_license(empty)) == "unknown"


def test_python_list_comes_from_the_lockfile_not_the_platform(tmp_path: Path) -> None:
    """SAF-04: a Windows-only package (colorama) must appear on Linux too, with its licence taken
    from the committed notices row; a locked package with no licence anywhere fails closed."""
    lock = tmp_path / "uv.lock"
    lock.write_text(
        """
[[package]]
name = "india-analyzer-worker"
version = "0.1.0"
source = { editable = "." }

[[package]]
name = "Colorama"
version = "0.4.6"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "typing_extensions"
version = "4.16.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "newpkg"
version = "1.0"
source = { registry = "https://pypi.org/simple" }
""",
        encoding="utf-8",
    )
    locked = ls.lock_packages(lock)
    assert locked == [("colorama", "0.4.6"), ("newpkg", "1.0"), ("typing-extensions", "4.16.0")]
    previous = ls.previous_python_licenses(
        "| python | colorama | 0.4.6 | BSD License | runtime/dev | ok |\n"
    )
    installed = {("typing-extensions", "4.16.0"): "PSF-2.0"}  # what a Linux runner has
    entries = {e.name: e for e in ls.python_entries_from(locked, installed, previous)}
    assert entries["colorama"].license == "BSD License"
    assert entries["typing-extensions"].license == "PSF-2.0"
    assert [e.name for e in ls.violations(list(entries.values()))] == ["newpkg"]


def test_locked_package_with_a_gpl_licence_fails() -> None:
    entries = ls.python_entries_from([("x", "1")], {("x", "1"): "GPL-3.0-only"}, {})
    assert [e.name for e in ls.violations(entries)] == ["x"]


def test_go_module_without_a_downloaded_dir_fails_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A module whose Dir is empty must be UNKNOWN even when ./LICENSE (MIT) exists in the cwd."""
    (tmp_path / "go.mod").write_text("module x\n\ngo 1.22\n", encoding="utf-8")
    (tmp_path / "LICENSE").write_text(
        "MIT License\n\nPermission is hereby granted, free of charge", encoding="utf-8"
    )
    monkeypatch.chdir(tmp_path)

    class Result:
        stdout = json.dumps({"Path": "example.com/dep", "Version": "v1.0.0"})

    monkeypatch.setattr(ls.subprocess, "run", lambda *a, **k: Result())
    entries = ls.go_entries(tmp_path)
    assert [(e.name, e.license) for e in entries] == [("example.com/dep", "UNKNOWN")]
    assert [e.name for e in ls.violations(entries)] == ["example.com/dep"]
