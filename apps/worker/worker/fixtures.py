"""Fixture recorder and loader (docs/01 section 1 rule 7).

Fixtures live in ``fixtures/<source>/<name>`` at the repository root. Recording happens only with
``--record-fixtures``; everything written is passed through the log scrubber, so tokens, keys and
passwords never reach the repository (CLAUDE.md 0.7). Tests only ever load.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from worker.logs import scrub, scrub_value

FIXTURES_ROOT = Path(__file__).resolve().parents[3] / "fixtures"
_SAFE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def _path(root: Path, source: str, name: str) -> Path:
    if not _SAFE.match(source) or not _SAFE.match(name) or ".." in name or ".." in source:
        raise ValueError("fixture source/name must be a plain file name (letters, digits, . _ -)")
    return root / source / name


def load_text(source: str, name: str, *, root: Path = FIXTURES_ROOT) -> str:
    return _path(root, source, name).read_text(encoding="utf-8")


def load_bytes(source: str, name: str, *, root: Path = FIXTURES_ROOT) -> bytes:
    return _path(root, source, name).read_bytes()


def load_json(source: str, name: str, *, root: Path = FIXTURES_ROOT) -> Any:
    return json.loads(load_text(source, name, root=root))


class FixtureRecorder:
    """Writes redacted fixtures when ``enabled``; otherwise every call is a no-op."""

    def __init__(self, enabled: bool, *, root: Path = FIXTURES_ROOT) -> None:
        self.enabled = enabled
        self._root = root

    def record_text(self, source: str, name: str, text: str) -> Path | None:
        if not self.enabled:
            return None
        target = _path(self._root, source, name)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(scrub(text), encoding="utf-8", newline="\n")
        return target

    def record_json(self, source: str, name: str, data: Any) -> Path | None:
        if not self.enabled:
            return None
        return self.record_text(
            source, name, json.dumps(scrub_value(data), indent=2, ensure_ascii=False) + "\n"
        )
