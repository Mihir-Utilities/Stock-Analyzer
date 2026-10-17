"""Shared exception types (no third-party imports)."""

from __future__ import annotations


class EgressDenied(Exception):  # noqa: N818 - name fixed by the D-N spec and SAF-13
    """A request targeted a host, scheme or port outside the egress allow-list."""


class SourceDisabled(Exception):  # noqa: N818 - name fixed by docs/01 section 1 rule 5
    """The circuit breaker for a source is open (docs/01 section 1 rule 5)."""

    def __init__(self, source: str, disabled_until: object) -> None:
        super().__init__(f"source {source} disabled until {disabled_until}")
        self.source = source
        self.disabled_until = disabled_until


class RetryableError(Exception):
    """A transient failure (network error, 5xx, 429); ``retry_after`` is in seconds, if sent."""

    def __init__(self, message: str, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after
