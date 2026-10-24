"""Alert evaluation, pure part (docs/04 3.9, manual price mode, decisions D-D / D06-*).

No database, clock or network: callers pass the data and ``now``. Bar-based kinds look only at
bars **newer than** ``last_state.last_bar_date`` (a NULL state, as after a params edit, means "no
bar evaluated yet": only the latest bar is looked at, never history), so the same bar never fires
twice; the dedupe key always carries the bar date (or the event / period / quarter it is about).
Money and thresholds are ``Decimal``; every dynamic string in a message is HTML-escaped.
"""

from __future__ import annotations

import html
from bisect import bisect_right
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

import numpy as np

from worker.analytics import indicators as ind
from worker.analytics.snapshot import Bars

HYSTERESIS = Decimal("0.005")  # docs/04 3.9: re-arm after moving back across T by 0.5%
WK52_WINDOW = 252  # prior bars the 52-week extreme is taken over (docs/05 week52)
RSI_PERIOD = 14

BAR_KINDS = (
    "price_above",
    "price_below",
    "day_change_pct",
    "wk52_high",
    "wk52_low",
    "ma_cross",
    "rsi_above",
    "rsi_below",
    "nav_above",
    "nav_below",
)
HOLDER_COLUMNS = {
    "promoter": "promoter_pct",
    "fii": "fii_pct",
    "dii": "dii_pct",
    "mf": "mf_pct",
}

_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


# --------------------------------------------------------------------------- formatting
def fmt_date(d: date) -> str:
    """``09 Oct 2026`` (no locale dependence)."""
    return f"{d.day:02d} {_MONTHS[d.month - 1]} {d.year}"


def _group_indian(digits: str) -> str:
    if len(digits) <= 3:
        return digits
    head, tail = digits[:-3], digits[-3:]
    parts: list[str] = []
    while len(head) > 2:
        parts.append(head[-2:])
        head = head[:-2]
    if head:
        parts.append(head)
    return ",".join([*reversed(parts), tail])


def fmt_num(value: Decimal, dp: int = 2, *, strip: bool = False, sign: bool = False) -> str:
    """Indian digit grouping (the default display preference); ``strip`` drops trailing zeros."""
    q = Decimal(1).scaleb(-dp)
    v = value.quantize(q, rounding=ROUND_HALF_UP)
    neg = v < 0
    whole, _, frac = f"{abs(v):f}".partition(".")
    if strip:
        frac = frac.rstrip("0")
    text = _group_indian(whole) + (f".{frac}" if frac else "")
    if neg:
        return f"-{text}"
    return f"+{text}" if sign else text


def esc(text: str) -> str:
    """Telegram HTML: escape ``& < >`` in every dynamic string."""
    return html.escape(text, quote=False)


def dec(x: Any) -> Decimal:
    """Decimal from a float/int/str without binary noise."""
    return Decimal(repr(x)) if isinstance(x, float) else Decimal(str(x))


def _parse_date(raw: Any) -> date | None:
    if isinstance(raw, str):
        try:
            return date.fromisoformat(raw)
        except ValueError:
            return None
    return None


# --------------------------------------------------------------------------- types
@dataclass(frozen=True)
class AlertRow:
    id: int
    kind: str
    params: dict[str, Any]
    one_shot: bool
    cooldown_minutes: int
    label: str  # symbol (stock) or scheme name (mf), unescaped
    last_fired_at: datetime | None = None
    last_state: dict[str, Any] | None = None


@dataclass(frozen=True)
class Fire:
    dedupe_key: str
    text: str  # HTML message, ends with "Alert #id"
    payload: dict[str, Any]


@dataclass
class EvalResult:
    fires: list[Fire] = field(default_factory=list)
    state: dict[str, Any] | None = None
    final: bool = False  # a one-shot alert fired


@dataclass(frozen=True)
class Trigger:
    key_part: str  # dedupe discriminator (threshold / parameters)
    text: str  # message body without the "as of" tail and alert id
    value: Decimal
    threshold: Decimal | None = None


def _tail(alert: AlertRow, bar_date: date) -> str:
    if _is_nav(alert.kind):  # AMFI/mfapi NAVs are not a price import (D06-6)
        return f"as of the latest NAV ({fmt_date(bar_date)}). Alert #{alert.id}"
    return f"as of the last price import ({fmt_date(bar_date)}). Alert #{alert.id}"


def _fire(alert: AlertRow, bar_date: date, trig: Trigger, tail: str | None = None) -> Fire:
    text = f"<b>{esc(alert.label)}</b> {trig.text}, {tail or _tail(alert, bar_date)}"
    payload: dict[str, Any] = {
        "kind": alert.kind,
        "label": alert.label,
        "bar_date": bar_date.isoformat(),
        "value": format(trig.value, "f"),
        "threshold": None if trig.threshold is None else format(trig.threshold, "f"),
        "message": text,
    }
    return Fire(f"{alert.id}|{alert.kind}|{bar_date.isoformat()}|{trig.key_part}", text, payload)


def _cooldown_ok(alert: AlertRow, last_fired: datetime | None, now: datetime) -> bool:
    if alert.one_shot or last_fired is None:
        return True
    return now - last_fired >= timedelta(minutes=alert.cooldown_minutes)


# --------------------------------------------------------------------------- bar kinds
def _is_nav(kind: str) -> bool:
    return kind.startswith("nav_")


def _level_trigger(alert: AlertRow, bars: Bars) -> tuple[Callable[[int], Trigger | None], Any]:
    above = alert.kind.endswith("_above")
    nav = _is_nav(alert.kind)
    threshold = dec(alert.params["nav" if nav else "price"])
    word = "NAV" if nav else "close"

    def met(t: int) -> Trigger | None:
        v = dec(float(bars.close[t]))
        if (v >= threshold) if above else (v <= threshold):
            word_dir = "above" if above else "below"
            return Trigger(
                format(threshold, "f"),
                f"{word_dir} {fmt_num(threshold, strip=True)} | {word} {fmt_num(v)}",
                v,
                threshold,
            )
        return None

    def rearm(t: int) -> bool:
        v = dec(float(bars.close[t]))
        return v <= threshold * (1 - HYSTERESIS) if above else v >= threshold * (1 + HYSTERESIS)

    return met, rearm


def _day_change_trigger(alert: AlertRow, bars: Bars) -> Callable[[int], Trigger | None]:
    pct = dec(alert.params["pct"])
    direction = str(alert.params["direction"])

    def met(t: int) -> Trigger | None:
        if t < 1:
            return None
        prev = dec(float(bars.adj_close[t - 1]))
        cur = dec(float(bars.adj_close[t]))
        chg = (cur / prev - 1) * 100
        ok = {"up": chg >= pct, "down": chg <= -pct, "either": abs(chg) >= pct}.get(direction)
        if not ok:
            return None
        return Trigger(
            f"{direction}|{pct}",
            f"day change {fmt_num(chg, sign=True)}% "
            f"(alert: {direction} {fmt_num(pct, strip=True)}%)"
            f" | close {fmt_num(dec(float(bars.close[t])))}",
            chg,
            pct,
        )

    return met


def _wk52_trigger(alert: AlertRow, bars: Bars) -> Callable[[int], Trigger | None]:
    high = alert.kind == "wk52_high"
    k = bars.adj_close / bars.close  # docs/05 1: H/L scaled by adj_close / close

    def met(t: int) -> Trigger | None:
        if t < WK52_WINDOW:  # fewer than a year of prior bars: never alert on a thin window
            return None
        lo_i = t - WK52_WINDOW
        prior = (
            float(np.max((bars.high * k)[lo_i:t]))
            if high
            else float(np.min((bars.low * k)[lo_i:t]))
        )
        latest = float(bars.adj_close[t])
        if (latest >= prior) if high else (latest <= prior):
            word = "high" if high else "low"
            return Trigger(
                "-",
                f"new 52-week {word} | close {fmt_num(dec(float(bars.close[t])))}",
                dec(latest),
                dec(prior),
            )
        return None

    return met


def _ma_cross_trigger(alert: AlertRow, bars: Bars) -> Callable[[int], Trigger | None]:
    fast_n, slow_n = int(alert.params["fast"]), int(alert.params["slow"])
    direction = str(alert.params["direction"])
    fast, slow = ind.sma(bars.adj_close, fast_n), ind.sma(bars.adj_close, slow_n)

    def met(t: int) -> Trigger | None:
        if t < 1 or np.isnan(slow[t - 1]) or np.isnan(slow[t]):
            return None
        pf, ps, cf, cs = fast[t - 1], slow[t - 1], fast[t], slow[t]
        golden = pf <= ps and cf > cs
        death = pf >= ps and cf < cs
        if (direction == "golden" and golden) or (direction == "death" and death):
            return Trigger(
                f"{fast_n}/{slow_n}/{direction}",
                f"{direction} cross SMA{fast_n}/SMA{slow_n} | close "
                f"{fmt_num(dec(float(bars.close[t])))}",
                dec(float(cf)),
                dec(float(cs)),
            )
        return None

    return met


def _rsi_trigger(alert: AlertRow, bars: Bars) -> Callable[[int], Trigger | None]:
    above = alert.kind == "rsi_above"
    level = dec(alert.params["level"])
    lv = float(level)
    series = ind.rsi(bars.adj_close, RSI_PERIOD)

    def met(t: int) -> Trigger | None:
        if t < 1 or np.isnan(series[t - 1]) or np.isnan(series[t]):
            return None
        prev, cur = float(series[t - 1]), float(series[t])
        if (prev <= lv < cur) if above else (prev >= lv > cur):
            word = "above" if above else "below"
            return Trigger(
                format(level, "f"),
                f"RSI({RSI_PERIOD}) crossed {word} {fmt_num(level, strip=True)} | RSI "
                f"{fmt_num(dec(round(cur, 2)))}",
                dec(round(cur, 2)),
                level,
            )
        return None

    return met


def evaluate_bar_alert(alert: AlertRow, bars: Bars, now: datetime) -> EvalResult:
    """Bar-based kinds (price, day change, 52-week, MA cross, RSI, NAV)."""
    state: dict[str, Any] = dict(alert.last_state or {})
    n = len(bars.dates)
    if n == 0:
        return EvalResult(state=alert.last_state)
    last = _parse_date(state.get("last_bar_date"))
    idxs = [n - 1] if last is None else list(range(bisect_right(bars.dates, last), n))
    if not idxs:
        return EvalResult(state=alert.last_state)

    rearm: Callable[[int], bool] | None = None
    kind = alert.kind
    if kind in ("price_above", "price_below", "nav_above", "nav_below"):
        trigger, rearm = _level_trigger(alert, bars)
    elif kind == "day_change_pct":
        trigger = _day_change_trigger(alert, bars)
    elif kind in ("wk52_high", "wk52_low"):
        trigger = _wk52_trigger(alert, bars)
    elif kind == "ma_cross":
        trigger = _ma_cross_trigger(alert, bars)
    elif kind in ("rsi_above", "rsi_below"):
        trigger = _rsi_trigger(alert, bars)
    else:
        raise ValueError(f"not a bar-based alert kind: {kind}")

    armed = bool(state.get("armed", True))
    last_fired = alert.last_fired_at
    result = EvalResult()
    processed = idxs[-1]
    for t in idxs:
        if rearm is not None and not armed and rearm(t):
            armed = True
        trig = trigger(t)
        if trig is None or not armed or not _cooldown_ok(alert, last_fired, now):
            continue
        result.fires.append(_fire(alert, bars.dates[t], trig))
        last_fired = now
        if rearm is not None:
            armed = False
        if alert.one_shot:
            result.final = True
            processed = t
            break
    state["last_bar_date"] = bars.dates[processed].isoformat()
    if rearm is not None:
        state["armed"] = armed
    result.state = state
    return result


# --------------------------------------------------------------------------- calendar / owner data
def evaluate_results_upcoming(
    alert: AlertRow, events: Sequence[tuple[int, date]], today: date
) -> EvalResult:
    """Owner-entered ``results`` events with ``0 <= days_to_event <= days_before``; once per row.
    No event, no alert (ALR-17)."""
    days_before = int(alert.params["days_before"])
    result = EvalResult(state=alert.last_state)
    for event_id, event_date in sorted(events, key=lambda e: (e[1], e[0])):
        days = (event_date - today).days
        if not 0 <= days <= days_before:
            continue
        when = "today" if days == 0 else f"in {days} day{'s' if days != 1 else ''}"
        text = (
            f"<b>{esc(alert.label)}</b> results on {fmt_date(event_date)} ({when}) | "
            f"from your events calendar. Alert #{alert.id}"
        )
        payload: dict[str, Any] = {
            "kind": alert.kind,
            "label": alert.label,
            "event_date": event_date.isoformat(),
            "days_to_event": days,
            "message": text,
        }
        result.fires.append(Fire(f"{alert.id}|{alert.kind}|event:{event_id}", text, payload))
        if alert.one_shot:
            result.final = True
            break
    return result


def evaluate_results_declared(alert: AlertRow, latest_period: date | None) -> EvalResult:
    """A quarterly ``period_end`` newer than ``last_state.latest_period``. A NULL state records the
    current latest period without firing (results that already existed are not news); when there
    were none yet it records ``initialised`` so the first results ever entered do fire."""
    prior = alert.last_state or {}
    if not prior:
        state = {"latest_period": latest_period.isoformat()} if latest_period else {}
        return EvalResult(state={**state, "initialised": True})
    if latest_period is None:
        return EvalResult(state=alert.last_state)
    known = _parse_date(prior.get("latest_period")) or date.min
    state = {**prior, "latest_period": latest_period.isoformat()}
    if latest_period <= known:
        return EvalResult(state=alert.last_state)
    text = (
        f"<b>{esc(alert.label)}</b> new quarterly results entered for the quarter ended "
        f"{fmt_date(latest_period)} | from your imported data. Alert #{alert.id}"
    )
    payload: dict[str, Any] = {
        "kind": alert.kind,
        "label": alert.label,
        "period_end": latest_period.isoformat(),
        "message": text,
    }
    fire = Fire(f"{alert.id}|{alert.kind}|period:{latest_period.isoformat()}", text, payload)
    return EvalResult([fire], state, alert.one_shot)


def evaluate_holding_change(
    alert: AlertRow, quarters: Sequence[tuple[date, dict[str, float | None]]]
) -> EvalResult:
    """``quarters`` newest first. A quarter newer than ``last_state.latest_quarter`` fires when the
    chosen holder moved by >= ``delta_pct`` points against the previous quarter."""
    prior = alert.last_state or {}
    if not prior:  # first look: remember where we are, never fire on what already exists
        state = {"latest_quarter": quarters[0][0].isoformat()} if quarters else {}
        return EvalResult(state={**state, "initialised": True})
    if not quarters:
        return EvalResult(state=alert.last_state)
    newest_end, newest = quarters[0]
    known = _parse_date(prior.get("latest_quarter")) or date.min
    state = {**prior, "latest_quarter": newest_end.isoformat()}
    if newest_end <= known:
        return EvalResult(state=alert.last_state)
    result = EvalResult(state=state)
    if len(quarters) < 2:
        return result
    holder = str(alert.params["holder"])
    column = HOLDER_COLUMNS[holder]
    cur, prev = newest.get(column), quarters[1][1].get(column)
    if cur is None or prev is None:  # unknown is not zero: no comparison, no alert
        return result
    delta = dec(round(cur, 4)) - dec(round(prev, 4))
    if abs(delta) < dec(alert.params["delta_pct"]):
        return result
    text = (
        f"<b>{esc(alert.label)}</b> {esc(holder)} holding changed {fmt_num(delta, sign=True)} "
        f"points to {fmt_num(dec(round(cur, 4)))}% in the quarter ended {fmt_date(newest_end)} | "
        f"from your imported data. Alert #{alert.id}"
    )
    payload: dict[str, Any] = {
        "kind": alert.kind,
        "label": alert.label,
        "quarter_end": newest_end.isoformat(),
        "holder": holder,
        "delta_points": format(delta, "f"),
        "message": text,
    }
    result.fires.append(
        Fire(f"{alert.id}|{alert.kind}|quarter:{newest_end.isoformat()}|{holder}", text, payload)
    )
    result.final = alert.one_shot
    return result
