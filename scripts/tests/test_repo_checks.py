"""SYS-11 (lockfiles + renovate) and the .env.example completeness check."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import check_env_example as env  # noqa: E402
import check_lockfiles as locks  # noqa: E402

REPO = Path(env.__file__).resolve().parent.parent


def touch(root: Path, rel: str, text: str = "x") -> None:
    target = root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")


# ---------------------------------------------------------------- SYS-11
def test_real_repo_has_lockfiles() -> None:
    assert locks.check(REPO) == []


def test_missing_lockfiles_are_reported(tmp_path: Path) -> None:
    touch(tmp_path, "apps/web/package.json")
    touch(tmp_path, "apps/worker/pyproject.toml")
    touch(tmp_path, "apps/api/go.mod", "module x\n\ngo 1.22\n\nrequire github.com/a/b v1.0.0\n")
    problems = locks.check(tmp_path)
    assert any("package-lock.json" in p for p in problems)
    assert any("uv.lock" in p for p in problems)
    assert any("go.sum" in p for p in problems)
    assert any("renovate" in p for p in problems)


def test_go_without_dependencies_needs_no_go_sum(tmp_path: Path) -> None:
    touch(tmp_path, "apps/api/go.mod", "module x\n\ngo 1.22\n")
    touch(tmp_path, ".github/renovate.json", "{}")
    assert locks.check(tmp_path) == []


# ---------------------------------------------------------------- .env.example
def test_real_env_example_is_complete_and_secret_free() -> None:
    assert env.check(REPO) == []


def test_missing_keys_and_secret_values_are_reported(tmp_path: Path) -> None:
    touch(
        tmp_path,
        "MASTER_PLAN.md",
        "## 5. Configuration constants\n| Key | Default |\n|---|---|\n| `SESSION_DAYS` | 30 |\n\n## 6. x\n",
    )
    touch(tmp_path, ".env.example", "DATABASE_URL=postgres://user:pw@host/db\nBROKER_TOKEN_KEY=\n")
    problems = env.check(tmp_path)
    assert "missing from .env.example: SESSION_DAYS" in problems
    assert "missing from .env.example: WORKER_HMAC_KEY" in problems
    assert any("DATABASE_URL" in p and "secret-like" in p for p in problems)
    assert not any("BROKER_TOKEN_KEY" in p and "secret-like" in p for p in problems)
