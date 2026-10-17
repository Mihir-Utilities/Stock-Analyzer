"""Structured JSON logging with a secret scrubber (CLAUDE.md 0.7, SEC-08)."""

from __future__ import annotations

import json
import logging
import os
import re
import sys
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

REDACTED = "[REDACTED]"

# Environment variables whose values must never appear in logs, fixtures or errors.
SECRET_ENV_NAMES = (
    "DATABASE_URL",
    "BROKER_TOKEN_KEY",
    "WORKER_HMAC_KEY",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_WEBHOOK_SECRET",
    "BROKER_CLIENT_SECRET",
    "INITIAL_PASSWORD_HASH",
)
_MIN_SECRET_LEN = 6

_SENSITIVE_KEY = re.compile(
    r"(key|secret|token|password|passwd|signature|authorization|cookie|hmac|credential)", re.I
)
_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    # Telegram bot token, bare or inside /bot<token>/method
    (re.compile(r"(?<!\d)\d{6,}:[A-Za-z0-9_-]{30,}"), REDACTED),
    # credentials inside connection strings: scheme://user:password@host
    (
        re.compile(r"(?P<head>[a-z][a-z0-9+.-]*://[^\s:/@]*:)[^\s@/]+(?=@)", re.I),
        r"\g<head>" + REDACTED,
    ),
    # Authorization-style values
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}"), r"\1 " + REDACTED),
    # key=value, key: value, "key": "value" for sensitive key names
    (
        re.compile(
            r"(?i)(?P<k>[\w-]*(?:key|secret|token|password|passwd|signature|authorization|cookie|hmac)[\w-]*"
            r"[\"']?\s*[:=]\s*[\"']?)(?P<v>[^\s\"',;&}]+)"
        ),
        r"\g<k>" + REDACTED,
    ),
]


def _env_secret_values() -> list[str]:
    values = [os.environ.get(name, "") for name in SECRET_ENV_NAMES]
    return sorted({v for v in values if len(v) >= _MIN_SECRET_LEN}, key=len, reverse=True)


def scrub(text: str) -> str:
    """Mask known secret values and secret-looking patterns in ``text``."""
    for secret in _env_secret_values():
        text = text.replace(secret, REDACTED)
    for pattern, repl in _PATTERNS:
        text = pattern.sub(repl, text)
    return text


def scrub_value(value: Any, key: str | None = None) -> Any:
    """Recursively scrub strings in dicts, lists and tuples; redact values of sensitive keys."""
    if key is not None and _SENSITIVE_KEY.search(key) and value not in (None, "", False):
        return REDACTED
    if isinstance(value, str):
        return scrub(value)
    if isinstance(value, Mapping):
        return {str(k): scrub_value(v, str(k)) for k, v in value.items()}
    if isinstance(value, list | tuple | set | frozenset):
        return [scrub_value(v) for v in value]
    if value is None or isinstance(value, bool | int | float):
        return value
    return scrub(str(value))


_RESERVED = set(logging.makeLogRecord({}).__dict__) | {"message", "asctime"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for k, v in record.__dict__.items():
            if k not in _RESERVED and not k.startswith("_"):
                payload[k] = v
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(scrub_value(payload), default=str, separators=(",", ":"))


def configure_logging(level: str | None = None) -> None:
    """JSON lines on stderr; level from LOG_LEVEL (default info)."""
    name = (level or os.environ.get("LOG_LEVEL") or "info").upper()
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(getattr(logging, name, logging.INFO))
