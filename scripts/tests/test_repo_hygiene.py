"""SAF-10 (.gitignore covers secrets/data/output) and SAF-11 (workflow hardening)."""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent.parent
WORKFLOWS = sorted((REPO / ".github" / "workflows").glob("*.yml"))

MUST_BE_IGNORED = [
    ".env",
    ".env.local",
    "apps/worker/.env",
    "apps/api/data.db",
    "local.sqlite",
    "apps/web/dist/x",
    "apps/web/build/x",
    "apps/web/out/x",
    "coverage/x",
    "fixtures/real/prices.csv",
    "fixtures/private/x.csv",
    "fixtures/a/prices.local.csv",
    "server.key",
    "x.pem",
    "x.p12",
    "backup.age",
    "dump.sql",
    ".vercel/x",
    ".idea/x",
    ".vscode/settings.json",
    ".DS_Store",
]
MUST_BE_TRACKABLE = [
    ".env.example",
    "db/migrations/0001_init.sql",
    "fixtures/sample/prices.csv",
    "apps/web/src/app/page.tsx",
]


@pytest.mark.skipif(shutil.which("git") is None, reason="git not available")
@pytest.mark.parametrize("path", MUST_BE_IGNORED)
def test_sensitive_and_generated_paths_are_ignored(path: str) -> None:
    result = subprocess.run(["git", "check-ignore", "-q", path], cwd=REPO)
    assert result.returncode == 0, f"{path} is not ignored"


@pytest.mark.skipif(shutil.which("git") is None, reason="git not available")
@pytest.mark.parametrize("path", MUST_BE_TRACKABLE)
def test_source_paths_are_not_ignored(path: str) -> None:
    result = subprocess.run(["git", "check-ignore", "-q", path], cwd=REPO)
    assert result.returncode == 1, f"{path} must not be ignored"


def test_gitignore_has_no_byte_order_mark() -> None:
    assert not (REPO / ".gitignore").read_bytes().startswith(b"\xef\xbb\xbf")


@pytest.mark.parametrize("workflow", WORKFLOWS, ids=lambda p: p.name)
def test_actions_are_pinned_by_commit_sha(workflow: Path) -> None:
    for line in workflow.read_text(encoding="utf-8").splitlines():
        match = re.match(r"\s*-?\s*uses:\s*(\S+)", line)
        if match and not match.group(1).startswith("./"):
            assert re.search(r"@[0-9a-f]{40}$", match.group(1)), f"not SHA-pinned: {line.strip()}"


@pytest.mark.parametrize("workflow", WORKFLOWS, ids=lambda p: p.name)
def test_workflow_is_least_privilege_and_fork_safe(workflow: Path) -> None:
    text = workflow.read_text(encoding="utf-8")
    assert re.search(r"^permissions:", text, re.M), "top-level permissions missing"
    assert "pull_request_target" not in text, "forks would get secrets"
    assert not re.search(r"echo\s+.*\$\{\{\s*secrets\.", text), "secret printed"
    assert "write-all" not in text
    for block in re.findall(r"^ {4}permissions:\n((?: {6}[a-z-]+: \w+\n)+)", text, re.M):
        assert "write" not in block, f"job-level write permission: {block}"
