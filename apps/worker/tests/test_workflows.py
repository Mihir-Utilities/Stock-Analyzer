"""D08 scheduled workflows vs docs/04 section 2 and 5: SYS-04 (keepalive), SYS-06 (Render plan B
in the runbook), BRK-14 (no broker workflows in manual mode), SYS-08 (restore drill checklist),
SYS-03 and SYS-05 at the workflow level (concurrency, dispatch)."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
WF = REPO / ".github" / "workflows"
JOBS = {
    # workflow file (= CLI job) -> (crons, timeout minutes)
    "process_queued_jobs": (["30 13 * * *"], 20),
    "ingest_mf_navs": (["30 16 * * *", "30 22 * * *"], 30),
    "sync_mf_schemes": (["30 23 * * 6"], 20),
    "evaluate_alerts": (["0 14 * * 1-5"], 8),
    "train_models": (["30 5 * * 6"], 90),
    "housekeeping": (["30 6 * * 0"], 20),
    "backup_user_data": (["0 7 * * 0"], 10),
    "keepalive": (["0 0 1 * *"], 2),
}


def text(name: str) -> str:
    return (WF / f"{name}.yml").read_text(encoding="utf-8")


def test_one_workflow_per_schedule_row_and_no_broker_workflows() -> None:
    names = {p.stem for p in WF.glob("*.yml")}
    assert set(JOBS) <= names
    # BRK-14 / manual mode: none of the removed jobs has a workflow
    for removed in (
        "sync_instruments",
        "broker_session_check",
        "ingest_prices_eod",
        "price_completeness_retry",
    ):
        assert removed not in names
    for p in WF.glob("*.yml"):
        body = p.read_text(encoding="utf-8")
        assert "BROKER_" not in body, p.name


@pytest.mark.parametrize("name", sorted(JOBS))
def test_workflow_matches_the_schedule_table(name: str) -> None:
    crons, timeout = JOBS[name]
    body = text(name)
    assert re.findall(r"- cron: '([^']+)'", body) == crons
    assert "workflow_dispatch:" in body
    assert f"timeout-minutes: {timeout}\n" in body
    assert re.search(r"concurrency:\n  group: \S+\n  cancel-in-progress: false", body)  # SYS-05
    assert "permissions:\n  contents:" in body


@pytest.mark.parametrize("name", sorted(JOBS))
def test_actions_are_sha_pinned_and_no_secret_is_printed(name: str) -> None:
    body = text(name)
    uses = re.findall(r"uses: (\S+)", body)
    assert uses
    for ref in uses:
        assert re.fullmatch(r"[\w./-]+@[0-9a-f]{40}", ref), ref
    assert "echo ${{ secrets" not in body and "set -x" not in body
    assert "pull_request" not in body  # a fork can never trigger a job with secrets


def test_schedule_table_in_docs_equals_the_workflows() -> None:
    doc = (REPO / "docs" / "04-worker-jobs.md").read_text(encoding="utf-8")
    section = doc.split("## 2. Schedules", 1)[1].split("Late-run tolerance", 1)[0]
    for name, (crons, _) in JOBS.items():
        row = next(ln for ln in section.splitlines() if ln.startswith(f"| `{name}`"))
        for cron in crons:
            assert f"`{cron}`" in row, (name, cron)


@pytest.mark.parametrize("name", [n for n in JOBS if n != "keepalive"])
def test_each_job_workflow_runs_its_cli_job(name: str) -> None:
    assert f"python -m worker run {name}" in text(name)


def test_sys04_keepalive_is_monthly_and_commits_to_the_heartbeat_branch() -> None:
    body = text("keepalive")
    assert "cron: '0 0 1 * *'" in body
    assert "permissions:\n  contents: write" in body
    assert "git commit --allow-empty" in body and "git push origin heartbeat" in body
    assert "origin main" not in body  # never pushes to the default branch


def test_sys04_runbook_has_the_schedule_checklist() -> None:
    rb = (REPO / "docs" / "RUNBOOK.md").read_text(encoding="utf-8")
    assert "keepalive" in rb and "heartbeat" in rb and "Schedules disabled" in rb


def test_backup_workflow_encrypts_and_keeps_30_days() -> None:
    body = text("backup_user_data")
    assert "AGE_PUBLIC_KEY: ${{ secrets.AGE_PUBLIC_KEY }}" in body
    assert "AGE_PRIVATE" not in body and "AGE-SECRET-KEY" not in body
    assert "retention-days: 30" in body
    assert "backup-out/*.age" in body  # only ciphertext is uploaded
    assert "if-no-files-found: error" in body


def test_sys06_and_sys08_runbook_sections() -> None:
    rb = (REPO / "docs" / "RUNBOOK.md").read_text(encoding="utf-8")
    section = rb.split("## 100.", 1)[1]
    for heading in (
        "Reconnect the broker daily",
        "Home-machine fallback",
        "Restore drill",
        "Plan B if Render hours are exhausted",
    ):
        assert heading in section, heading
    assert "BRK-14" in section  # static IP: not applicable in manual mode
