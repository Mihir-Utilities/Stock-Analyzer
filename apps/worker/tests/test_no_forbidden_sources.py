"""docs/04 section 1 rule 10: no module under apps/worker uses a forbidden library or host (SAF-01/02).

Reuses the repository-wide scanner so there is one definition of "forbidden".
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]


def _load_scanner():  # type: ignore[no-untyped-def]
    spec = importlib.util.spec_from_file_location(
        "deny_list_check", REPO / "scripts" / "deny_list_check.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclasses need the module registered
    spec.loader.exec_module(module)
    return module


def test_worker_package_has_no_forbidden_sources() -> None:
    scanner = _load_scanner()
    violations = [v for v in scanner.scan(REPO) if v.path.startswith("apps/worker/")]
    assert violations == [], [str(v) for v in violations]
