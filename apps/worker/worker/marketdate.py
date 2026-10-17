"""Market dates are IST calendar dates (CLAUDE.md section 3); timestamps are UTC."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30), "IST")


def ist_date(moment: datetime) -> date:
    """The IST calendar date of an instant. A naive datetime is taken to be UTC."""
    aware = moment if moment.tzinfo is not None else moment.replace(tzinfo=UTC)
    return aware.astimezone(IST).date()


def ist_today(now: datetime | None = None) -> date:
    return ist_date(now or datetime.now(UTC))
