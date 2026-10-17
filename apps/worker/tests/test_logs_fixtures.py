"""SEC-08: secrets never reach logs, errors or fixtures; fixture recorder/loader."""

from __future__ import annotations

import io
import json
import logging
from pathlib import Path

import pytest

from worker.fixtures import FixtureRecorder, load_json, load_text
from worker.logs import REDACTED, JsonFormatter, scrub, scrub_value

BOT = "123456789:AAH-fake_telegram_token_value_0123456789abc"
DSN = "postgres://analyzer:s3cretPass@db.example.neon.tech/neondb?sslmode=require"


def test_scrubs_known_env_secret_values(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKER_HMAC_KEY", "hmac-key-value-xyz")
    monkeypatch.setenv("BROKER_TOKEN_KEY", "YnJva2VyLWtleS1iYXNlNjQ=")
    out = scrub("calling with hmac-key-value-xyz and YnJva2VyLWtleS1iYXNlNjQ=")
    assert "hmac-key-value-xyz" not in out and "YnJva2VyLWtleS1iYXNlNjQ=" not in out


@pytest.mark.parametrize(
    ("raw", "leak"),
    [
        (f"GET https://api.telegram.org/bot{BOT}/sendMessage", BOT),
        (f"connect failed for {DSN}", "s3cretPass"),
        ("Authorization: Bearer abcDEF123456789token", "abcDEF123456789token"),
        ("password=hunter2hunter2 user=x", "hunter2hunter2"),
        ('{"access_token": "tok_live_123456"}', "tok_live_123456"),
        ("X-Signature: 0a1b2c3d4e5f", "0a1b2c3d4e5f"),
        ("WORKER_HMAC_KEY=supersecretvalue", "supersecretvalue"),
    ],
)
def test_scrubs_secret_patterns(raw: str, leak: str) -> None:
    assert leak not in scrub(raw)
    assert REDACTED in scrub(raw)


def test_plain_text_is_untouched() -> None:
    text = "fetched 120 rows for TCS in 1.2 s (source mfapi)"
    assert scrub(text) == text


def test_scrub_value_redacts_sensitive_keys_recursively() -> None:
    data = {
        "job": "x",
        "headers": {"Authorization": "Bearer zzzzzzzzzz", "X-Timestamp": "1"},
        "items": [{"api_key": "k123456"}],
        "n": 3,
        "ok": True,
    }
    out = scrub_value(data)
    assert out["headers"]["Authorization"] == REDACTED
    assert out["items"][0]["api_key"] == REDACTED
    assert (
        out["job"] == "x"
        and out["n"] == 3
        and out["ok"] is True
        and out["headers"]["X-Timestamp"] == "1"
    )


def test_json_log_lines_are_scrubbed_including_exceptions(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", BOT)
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter())
    logger = logging.getLogger("test.sec08")
    logger.handlers[:] = [handler]
    logger.propagate = False
    logger.setLevel(logging.INFO)
    try:
        raise RuntimeError(f"failed {DSN} with {BOT}")
    except RuntimeError:
        logger.error(
            "job failed: %s",
            DSN,
            extra={"token": BOT, "job": "ingest_mf_navs", "detail": BOT},
            exc_info=True,
        )
    line = stream.getvalue()
    for leak in (BOT, "s3cretPass"):
        assert leak not in line
    record = json.loads(line)  # still one valid JSON object
    assert record["level"] == "error" and record["job"] == "ingest_mf_navs"
    assert record["token"] == REDACTED


def test_fixture_recorder_redacts_and_loader_round_trips(tmp_path: Path) -> None:
    rec = FixtureRecorder(True, root=tmp_path)
    rec.record_json(
        "mfapi", "scheme.json", {"meta": {"scheme_code": 1}, "token": BOT, "note": f"u {DSN}"}
    )
    text = (tmp_path / "mfapi" / "scheme.json").read_text()
    assert BOT not in text and "s3cretPass" not in text
    assert load_json("mfapi", "scheme.json", root=tmp_path)["meta"]["scheme_code"] == 1
    rec.record_text("amfi", "nav.txt", "Scheme Code;Name\n1;X\n")
    assert load_text("amfi", "nav.txt", root=tmp_path).startswith("Scheme Code")


def test_fixture_recorder_is_a_noop_unless_enabled(tmp_path: Path) -> None:
    assert FixtureRecorder(False, root=tmp_path).record_text("mfapi", "a.json", "{}") is None
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("name", ["../x", "a/b", "..", ".hidden", "", "a\\b"])
def test_fixture_names_cannot_escape_the_root(tmp_path: Path, name: str) -> None:
    with pytest.raises(ValueError):
        FixtureRecorder(True, root=tmp_path).record_text("mfapi", name, "x")
    with pytest.raises(ValueError):
        load_text("mfapi", name, root=tmp_path)
