"""D08 scheduled workflows vs docs/04 section 2 and 5: SYS-04 (keepalive), SYS-06 (Render plan B
in the runbook), BRK-14 (no broker workflows in manual mode), SYS-08 (restore drill checklist),
SYS-03 and SYS-05 at the workflow level (concurrency, dispatch). The YAML is parsed (structure),
not grepped."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest
from miniyaml import load

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
# secrets each workflow may reference (everything else must be absent)
ALLOWED_SECRETS = {
    "process_queued_jobs": {"DATABASE_URL", "TELEGRAM_BOT_TOKEN"},
    "ingest_mf_navs": {"DATABASE_URL"},
    "sync_mf_schemes": {"DATABASE_URL"},
    "evaluate_alerts": {"DATABASE_URL", "TELEGRAM_BOT_TOKEN"},
    "train_models": {"DATABASE_URL"},
    "housekeeping": {"DATABASE_URL", "TELEGRAM_BOT_TOKEN"},
    "backup_user_data": {"DATABASE_URL", "AGE_PUBLIC_KEY"},
    "keepalive": set(),
}


def text(name: str) -> str:
    return (WF / f"{name}.yml").read_text(encoding="utf-8")


def doc(name: str) -> dict[str, Any]:
    return load(text(name))


def steps(name: str) -> list[dict[str, Any]]:
    out = doc(name)["jobs"]["run"]["steps"]
    assert isinstance(out, list)
    return out


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
def test_workflow_structure_matches_the_schedule_table(name: str) -> None:
    crons, timeout = JOBS[name]
    wf = doc(name)
    triggers = wf["on"]
    assert [s["cron"] for s in triggers["schedule"]] == crons
    assert "workflow_dispatch" in triggers
    assert set(triggers) == {"schedule", "workflow_dispatch"}  # SYS: no other trigger
    assert wf["jobs"]["run"]["timeout-minutes"] == timeout
    assert wf["concurrency"]["cancel-in-progress"] is False  # SYS-05
    assert wf["concurrency"]["group"]
    expected = {"contents": "write" if name == "keepalive" else "read"}
    assert wf["permissions"] == expected


@pytest.mark.parametrize("name", sorted(JOBS))
def test_no_pull_request_trigger_and_actions_pinned_and_no_secret_echo(name: str) -> None:
    wf = doc(name)
    for forbidden in ("pull_request", "pull_request_target", "push", "workflow_run"):
        assert forbidden not in wf["on"], forbidden  # a fork can never trigger a job with secrets
    uses = [s["uses"] for s in steps(name) if "uses" in s]
    assert uses
    for ref in uses:
        assert re.fullmatch(r"[\w./-]+@[0-9a-f]{40}", ref), ref
    for step in steps(name):
        run = str(step.get("run", ""))
        assert "echo ${{ secrets" not in run and "set -x" not in run


@pytest.mark.parametrize("name", [n for n in JOBS if n != "keepalive"])
def test_setup_uv_version_is_pinned(name: str) -> None:
    setup = [s for s in steps(name) if str(s.get("uses", "")).startswith("astral-sh/setup-uv@")]
    assert len(setup) == 1
    assert re.fullmatch(r"\d+\.\d+\.\d+", str(setup[0]["with"]["version"]))


@pytest.mark.parametrize("name", sorted(JOBS))
def test_secrets_are_only_the_ones_the_job_needs(name: str) -> None:
    used = set(re.findall(r"secrets\.([A-Z_]+)", text(name)))
    assert used <= ALLOWED_SECRETS[name], (name, used - ALLOWED_SECRETS[name])


def test_schedule_table_in_docs_equals_the_workflows() -> None:
    doc_text = (REPO / "docs" / "04-worker-jobs.md").read_text(encoding="utf-8")
    section = doc_text.split("## 2. Schedules", 1)[1].split("Late-run tolerance", 1)[0]
    for name, (crons, _) in JOBS.items():
        row = next(ln for ln in section.splitlines() if ln.startswith(f"| `{name}`"))
        for cron in crons:
            assert f"`{cron}`" in row, (name, cron)


@pytest.mark.parametrize("name", [n for n in JOBS if n != "keepalive"])
def test_each_job_workflow_runs_its_cli_job(name: str) -> None:
    runs = [str(s.get("run", "")) for s in steps(name)]
    assert any(f"python -m worker run {name}" in r for r in runs)


def test_sys04_keepalive_is_monthly_and_commits_to_the_heartbeat_branch() -> None:
    wf = doc("keepalive")
    assert wf["permissions"] == {"contents": "write"}
    body = "\n".join(str(s.get("run", "")) for s in steps("keepalive"))
    assert "git commit --allow-empty" in body and "git push origin heartbeat" in body
    assert "origin main" not in body  # never pushes to the default branch


def test_sys04_runbook_has_the_schedule_checklist() -> None:
    rb = (REPO / "docs" / "RUNBOOK.md").read_text(encoding="utf-8")
    assert "keepalive" in rb and "heartbeat" in rb and "Schedules disabled" in rb
    assert "GITHUB_TOKEN" in rb  # the manual check that a token push counts as activity


def test_housekeeping_workflow_passes_the_same_limit_the_api_reads() -> None:
    env = next(s for s in steps("housekeeping") if "env" in s)["env"]
    assert env["DB_SOFT_LIMIT_MB"] == "${{ vars.DB_SOFT_LIMIT_MB }}"


def test_backup_workflow_encrypts_and_uploads_ciphertext_only() -> None:
    all_steps = steps("backup_user_data")
    export = next(s for s in all_steps if "AGE_PUBLIC_KEY" in str(s.get("env", {})))
    assert export["env"]["AGE_PUBLIC_KEY"] == "${{ secrets.AGE_PUBLIC_KEY }}"
    assert "AGE_PRIVATE" not in text("backup_user_data")
    assert "AGE-SECRET-KEY" not in text("backup_user_data")
    uploads = [
        s for s in all_steps if str(s.get("uses", "")).startswith("actions/upload-artifact@")
    ]
    assert len(uploads) == 1
    upload = uploads[0]
    assert "if" not in upload  # never always(): a failed export must not upload a stale file
    assert upload["with"]["path"] == "backup-out/*.age"  # only ciphertext
    assert upload["with"]["name"] == "user-data-backup"
    assert upload["with"]["retention-days"] == 14
    assert upload["with"]["if-no-files-found"] == "error"
    assert all("if" not in s for s in all_steps)  # no step is conditional (no always())


def test_artifact_upload_and_age_key_exist_only_in_the_backup_workflow() -> None:
    for p in WF.glob("*.yml"):
        if p.stem == "backup_user_data":
            continue
        body = p.read_text(encoding="utf-8")
        assert "upload-artifact" not in body, p.name
        assert "AGE_PUBLIC_KEY" not in body, p.name
        assert "user-data-backup" not in body, p.name


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
