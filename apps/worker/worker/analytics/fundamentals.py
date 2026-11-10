"""Derived fundamentals, ratios and valuation (docs/05 section 5), D05b.

Pure: owner-entered rows in, the ``analysis_snapshot.indicators.fundamentals`` tree out (the shape
the API reads, decision B05-4: ``{basis: {Q|A: {periods, derived, ratios, valuation}}}``).

Conventions: percent values are percent numbers (12.34); money is INR crore except per-share
values (INR); every scalar goes through ``_n`` so NaN/inf never reach jsonb; every null has a
reason in the node's ``null_reasons`` (the API's ``ratios`` and ``valuation`` maps must hold only
numbers, so reasons live next to them, not inside them).
"""

from __future__ import annotations

import calendar
import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any, NamedTuple

import numpy as np
from numpy.typing import NDArray

from worker.analytics.scores import percentile_of, quality_score, trend_score

VERSION = "d05b-1"
TOL_DAYS = 20  # docs/05 section 5 "matching periods" tolerance
CRORE = 1e7
PE_HISTORY_YEARS = 5
PE_MIN_POINTS = 750
FILED_FALLBACK_DAYS = 45  # docs/05: EPS available from filed_on, else period_end + 45 days

SOURCE_RANK = {"manual": 0, "csv_import": 1, "screener_import": 2}
CANONICAL_UNIT = {"pnl.eps": "INR", "bs.shares_outstanding": "SHARES"}  # all others INR_CR

REV, EBITDA, OPINC = "pnl.revenue", "pnl.ebitda", "pnl.operating_income"
INTEREST, PBT, NETP, EPS, NII = "pnl.interest", "pnl.pbt", "pnl.net_profit", "pnl.eps", "pnl.nii"
EQUITY, ASSETS, CURLIAB = "bs.equity", "bs.total_assets", "bs.current_liabilities"
BORROW, CASH, SHARES = "bs.borrowings", "bs.cash", "bs.shares_outstanding"
CFO, CAPEX = "cf.cfo", "cf.capex"

DERIVED_KEYS = ("revenue_yoy", "net_profit_yoy", "op_margin", "net_margin")
FINANCIAL_DERIVED = ("net_profit_yoy", "net_profit_qoq", "nii_yoy")
NOT_APPLICABLE = "not_applicable_financial"

F64 = NDArray[np.float64]


def _n(v: float | None) -> float | None:
    """JSON-safe number (D05aR-2): None, NaN and inf become None."""
    if v is None:
        return None
    f = float(v)
    return f if math.isfinite(f) else None


# --- inputs -------------------------------------------------------------------------------------


@dataclass(frozen=True)
class FundRow:
    basis: str
    period_type: str
    period_end: date
    key: str
    value: float | None
    unit: str
    source: str
    filed_on: date | None
    fetched_at: datetime


@dataclass(frozen=True)
class Multiplier:
    """A confirmed split/bonus: ``mult`` = qty multiplier (docs/05 8.2)."""

    ex_date: date
    mult: float


@dataclass(frozen=True)
class Dividend:
    ex_date: date
    amount: float  # INR per share


@dataclass(frozen=True)
class HoldingRow:
    quarter_end: date
    promoter_pct: float | None
    fii_pct: float | None
    dii_pct: float | None
    mf_pct: float | None
    promoter_pledged_pct: float | None  # None = unknown, never 0 (SHP-02)


@dataclass(frozen=True)
class FundInputs:
    rows: Sequence[FundRow]
    as_of: date  # last price bar date
    close: float  # last stored close (today's units)
    price_dates: Sequence[date]  # valid bars, ascending
    price_close: F64  # stored close per bar (raw per docs/05: C_t_raw)
    multipliers: Sequence[Multiplier] = ()
    dividends: Sequence[Dividend] = ()
    holdings: Sequence[HoldingRow] = ()
    financial: bool = False
    top_pb: tuple[float, str] | None = None  # fallback P/B and its source (docs/05)


class Cell(NamedTuple):
    value: float
    source: str
    filed_on: date | None
    fetched_at: datetime


Metrics = dict[str, dict[date, Cell]]

# --- dates --------------------------------------------------------------------------------------


def shift_months(d: date, months: int) -> date:
    """``d`` moved by whole months, the day clamped to the target month's length."""
    idx = d.year * 12 + (d.month - 1) + months
    year, month = divmod(idx, 12)
    return date(year, month + 1, min(d.day, calendar.monthrange(year, month + 1)[1]))


def fiscal_label(period_end: date, period_type: str) -> str:
    """India FY ends 31 March: Sep 2026 -> ``Q2 FY27``; annual Mar 2026 -> ``FY26`` (FND-01)."""
    fy = (period_end.year + (1 if period_end.month >= 4 else 0)) % 100
    if period_type == "A":
        return f"FY{fy:02d}"
    quarter = ((period_end.month - 4) % 12) // 3 + 1
    return f"Q{quarter} FY{fy:02d}"


def _match(series: dict[date, Cell], target: date) -> date | None:
    """The period within +/-20 days of ``target`` (nearest wins), else None (FND-07)."""
    best: date | None = None
    best_gap = TOL_DAYS + 1
    for d in series:
        gap = abs((d - target).days)
        if gap <= TOL_DAYS and (gap < best_gap or (gap == best_gap and best and d > best)):
            best, best_gap = d, gap
    return best


# --- series selection ---------------------------------------------------------------------------


def _rank(source: str) -> int:
    return SOURCE_RANK.get(source, 99)


def build_metrics(
    rows: Iterable[FundRow], basis: str, period_type: str
) -> tuple[Metrics, set[str]]:
    """Winning value per (metric, period): best source, then newest entry (docs/05 section 2).

    NULL values are ignored, so a lower-priority real value can show (B05-5); ``derived`` rows
    are never used; a row whose unit differs from the metric's canonical unit is dropped and its
    key reported (mixed units never reach a formula).
    """
    best: dict[tuple[str, date], FundRow] = {}
    bad_unit: set[str] = set()
    for r in rows:
        if r.basis != basis or r.period_type != period_type or r.source == "derived":
            continue
        if r.value is None or _n(r.value) is None:
            continue
        if r.unit != CANONICAL_UNIT.get(r.key, "INR_CR"):
            bad_unit.add(r.key)
            continue
        k = (r.key, r.period_end)
        cur = best.get(k)
        if (
            cur is None
            or _rank(r.source) < _rank(cur.source)
            or (_rank(r.source) == _rank(cur.source) and r.fetched_at > cur.fetched_at)
        ):
            best[k] = r
    out: Metrics = {}
    for (key, pe), r in best.items():
        if r.value is None:
            continue
        out.setdefault(key, {})[pe] = Cell(float(r.value), r.source, r.filed_on, r.fetched_at)
    return out, bad_unit


def _val(m: Metrics, key: str, period: date) -> float | None:
    cell = m.get(key, {}).get(period)
    return None if cell is None else cell.value


def _req(m: Metrics, key: str, period: date) -> float:
    """A value that ``_latest_with`` guarantees exists."""
    return m[key][period].value


def _latest_with(m: Metrics, keys: Sequence[str]) -> date | None:
    """Latest period at which every key has a value."""
    common: set[date] | None = None
    for k in keys:
        periods = set(m.get(k, {}))
        common = periods if common is None else common & periods
    return max(common) if common else None


def divisor(period_end: date, mults: Sequence[Multiplier], as_of: date) -> float:
    """Product of confirmed multipliers with ``period_end < ex_date <= as_of`` (FND-09)."""
    d = 1.0
    for m in mults:
        if period_end < m.ex_date <= as_of and m.mult > 0:
            d *= m.mult
    return d


# --- reasons ------------------------------------------------------------------------------------


class _Reasons:
    def __init__(self) -> None:
        self.derived: dict[str, dict[str, str]] = {}
        self.ratios: dict[str, str] = {}
        self.valuation: dict[str, str] = {}


def _growth(cur: float | None, prev: float | None) -> tuple[float | None, str | None]:
    if cur is None:
        return None, "missing_input"
    if prev is None or prev <= 0:
        return None, "n/m"
    return _n((cur / prev - 1.0) * 100.0), None


# --- derived arrays -----------------------------------------------------------------------------


def derived_arrays(
    m: Metrics, periods: Sequence[date], period_type: str, financial: bool, reasons: _Reasons
) -> dict[str, Any]:
    """YoY/QoQ growth and margins aligned to ``periods`` (null with a reason per cell)."""
    out: dict[str, Any] = {}
    keys: list[str] = list(DERIVED_KEYS)
    if period_type == "Q":
        keys += ["revenue_qoq", "net_profit_qoq"]
    if NII in m:
        keys.append("nii_yoy")
    op_source: list[str | None] = []
    for key in keys:
        out[key] = []
        reasons.derived[key] = {}
    for p in periods:
        iso = p.isoformat()
        prior_year = _match(m.get(REV, {}), shift_months(p, -12))
        prior_year_np = _match(m.get(NETP, {}), shift_months(p, -12))
        prior_q = _match(m.get(REV, {}), shift_months(p, -3))
        prior_q_np = _match(m.get(NETP, {}), shift_months(p, -3))
        prior_nii = _match(m.get(NII, {}), shift_months(p, -12))
        cells: dict[str, tuple[float | None, str | None]] = {
            "revenue_yoy": _growth(
                _val(m, REV, p), None if prior_year is None else _val(m, REV, prior_year)
            ),
            "net_profit_yoy": _growth(
                _val(m, NETP, p), None if prior_year_np is None else _val(m, NETP, prior_year_np)
            ),
            "revenue_qoq": _growth(
                _val(m, REV, p), None if prior_q is None else _val(m, REV, prior_q)
            ),
            "net_profit_qoq": _growth(
                _val(m, NETP, p), None if prior_q_np is None else _val(m, NETP, prior_q_np)
            ),
            "nii_yoy": _growth(
                _val(m, NII, p), None if prior_nii is None else _val(m, NII, prior_nii)
            ),
        }
        rev = _val(m, REV, p)
        num, src = _val(m, OPINC, p), "operating_income"
        if num is None:
            num, src = _val(m, EBITDA, p), "ebitda"  # fallback labelled EBITDA margin
        cells["op_margin"] = _margin(num, rev)
        op_source.append(src if num is not None else None)
        cells["net_margin"] = _margin(_val(m, NETP, p), rev)
        for key in keys:
            value, why = cells[key]
            if financial and key not in FINANCIAL_DERIVED:
                value, why = None, NOT_APPLICABLE
            out[key].append(value)
            if value is None and why:
                reasons.derived[key][iso] = why
    out["op_margin_source"] = op_source
    return out


def _margin(num: float | None, rev: float | None) -> tuple[float | None, str | None]:
    if num is None or rev is None:
        return None, "missing_input"
    if rev <= 0:
        return None, "n/m"
    return _n(num / rev * 100.0), None


# --- ratios (latest annual) ---------------------------------------------------------------------


@dataclass
class RatioOut:
    values: dict[str, float | None] = field(default_factory=dict)
    meta: dict[str, Any] = field(default_factory=dict)
    no_debt: bool = False


def _cagr(
    m: Metrics, key: str, years: int, adj: dict[date, float] | None = None
) -> tuple[float | None, str | None, date | None]:
    series = m.get(key, {})
    if not series:
        return None, "missing_input", None
    end = max(series)
    start = _match(series, shift_months(end, -12 * years))
    if start is None:
        return None, "insufficient_history", end
    x1, x0 = series[end].value, series[start].value
    if adj:
        x1, x0 = x1 / adj.get(end, 1.0), x0 / adj.get(start, 1.0)
    if x1 <= 0 or x0 <= 0:
        return None, "n/m", end
    return _n(((x1 / x0) ** (1.0 / years) - 1.0) * 100.0), None, end


def annual_ratios(
    a: Metrics,
    financial: bool,
    mults: Sequence[Multiplier],
    as_of: date,
    reasons: _Reasons,
) -> RatioOut:
    """docs/05 section 5 ratios from the latest annual period with the needed inputs."""
    out = RatioOut()
    r = out.values
    rs = reasons.ratios
    periods: dict[str, str] = {}

    def put(key: str, value: float | None, why: str | None, at: date | None) -> None:
        r[key] = _n(value)
        if r[key] is None:
            rs[key] = why or "missing_input"
        elif at is not None:
            periods[key] = at.isoformat()

    def na(*keys: str) -> None:
        for k in keys:
            r[k] = None
            rs[k] = NOT_APPLICABLE

    # ROE: average equity, ending equity when the prior year is missing (S16: pinned by test).
    t = _latest_with(a, [NETP, EQUITY])
    if t is None:
        put("roe", None, "missing_input", None)
    else:
        eq, np_ = _req(a, EQUITY, t), _req(a, NETP, t)
        if eq <= 0:
            put("roe", None, "negative_equity", t)
        else:
            prev = _match(a.get(EQUITY, {}), shift_months(t, -12))
            eq_prev = None if prev is None else _val(a, EQUITY, prev)
            if eq_prev is not None and eq_prev > 0:
                put("roe", np_ / ((eq + eq_prev) / 2.0) * 100.0, None, t)
                out.meta["roe_basis"] = "average"
            else:
                put("roe", np_ / eq * 100.0, None, t)
                out.meta["roe_basis"] = "ending"
    # growth (CAGR from annual values exactly N fiscal years apart)
    for name, key in (("revenue", REV), ("net_profit", NETP)):
        for years in (3, 5):
            v, why, at = _cagr(a, key, years)
            if financial and name == "revenue":
                na(f"{name}_cagr_{years}y")
            else:
                put(f"{name}_cagr_{years}y", v, why, at)
    if financial:
        na(
            "roce",
            "debt_equity",
            "interest_coverage",
            "cfo_to_pat",
            "cfo_to_pat_avg",
            "fcf",
            "eps_cagr_3y",
        )
        out.meta["ratio_period"] = periods
        return out

    # ROCE = EBIT / average capital employed. Primary basis follows Screener's published
    # definition (share capital + reserves + borrowings); total assets - current liabilities is
    # the fallback when equity or borrowings is missing. roce_basis records which was used so
    # bases are never mixed.
    # A missing interest row counts as no interest (EBIT = PBT), as in interest coverage below.
    def _ce(t: date, basis: str) -> float | None:
        if basis == "equity_plus_debt":
            eq, bor = _val(a, EQUITY, t), _val(a, BORROW, t)
            return None if eq is None or bor is None else eq + bor
        ta, cl = _val(a, ASSETS, t), _val(a, CURLIAB, t)
        return None if ta is None or cl is None else ta - cl

    t = _latest_with(a, [PBT])
    if t is None:
        put("roce", None, "missing_input", None)
    else:
        ebit = (_val(a, PBT, t) or 0.0) + (_val(a, INTEREST, t) or 0.0)
        prev = _match({**a.get(ASSETS, {}), **a.get(EQUITY, {})}, shift_months(t, -12))
        bases = ("equity_plus_debt", "assets_less_cl")
        basis = next(
            (
                b
                for b in bases
                if _ce(t, b) is not None and prev is not None and _ce(prev, b) is not None
            ),
            None,
        )
        if basis is None:
            has_now = any(_ce(t, b) is not None for b in bases)
            reason = "no_prior_period" if has_now else "missing_input"
            put("roce", None, reason, t if has_now else None)
        else:
            ce, ce_prev = _ce(t, basis), _ce(prev, basis)  # type: ignore[arg-type]
            if ce is None or ce_prev is None:  # not reachable: basis needs both years
                put("roce", None, "missing_input", t)
            elif (ce + ce_prev) / 2.0 <= 0:
                put("roce", None, "n/m", t)
            else:
                put("roce", ebit / ((ce + ce_prev) / 2.0) * 100.0, None, t)
                out.meta["roce_basis"] = basis
    # D/E
    t = _latest_with(a, [BORROW, EQUITY])
    if t is None:
        put("debt_equity", None, "missing_input", None)
    else:
        eq, bor = _req(a, EQUITY, t), _req(a, BORROW, t)
        out.no_debt = bor == 0
        if eq <= 0:
            put("debt_equity", None, "negative_equity", t)
        else:
            put("debt_equity", bor / eq, None, t)
    # interest coverage (interest 0 or missing -> no_interest)
    pbt_periods = a.get(PBT, {})
    if not pbt_periods:
        put("interest_coverage", None, "missing_input", None)
    else:
        t = max(pbt_periods)
        interest = _val(a, INTEREST, t)
        if interest is None or interest <= 0:
            put("interest_coverage", None, "no_interest", t)
        else:
            put("interest_coverage", ((_val(a, PBT, t) or 0.0) + interest) / interest, None, t)
    # CFO/PAT and its average over up to 5 annual years (needs >= 3)
    t = _latest_with(a, [CFO, NETP])
    if t is None:
        put("cfo_to_pat", None, "missing_input", None)
    else:
        np_, cfo = _req(a, NETP, t), _req(a, CFO, t)
        put("cfo_to_pat", None if np_ <= 0 else cfo / np_, "n/m", t)
    both = sorted(set(a.get(CFO, {})) & set(a.get(NETP, {})))[-5:]
    ratios = [
        (_val(a, CFO, p) or 0.0) / (_val(a, NETP, p) or 1.0)
        for p in both
        if (_val(a, NETP, p) or 0.0) > 0
    ]
    if len(ratios) >= 3:
        put("cfo_to_pat_avg", sum(ratios) / len(ratios), None, both[-1])
    else:
        put("cfo_to_pat_avg", None, "insufficient_history", None)
    # FCF = cfo - capex
    t = _latest_with(a, [CFO, CAPEX])
    if t is None:
        put("fcf", None, "missing_input", None)
    else:
        put("fcf", (_val(a, CFO, t) or 0.0) - (_val(a, CAPEX, t) or 0.0), None, t)
    # EPS CAGR 3Y on split-adjusted annual EPS (feeds PEG)
    adj = {p: divisor(p, mults, as_of) for p in a.get(EPS, {})}
    v, why, at = _cagr(a, EPS, 3, adj)
    put("eps_cagr_3y", v, why, at)
    out.meta["ratio_period"] = periods
    return out


# --- TTM EPS ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class TtmWindow:
    end: date
    avail: date
    value: float
    source: str


def ttm_windows(
    q_rows: Iterable[FundRow], basis: str, mults: Sequence[Multiplier] | None, as_of: date
) -> list[TtmWindow]:
    """Every run of 4 consecutive quarterly EPS values (each ~3 months apart +/-20 days) of one
    basis and ONE source. ``mults`` given: EPS is split/bonus adjusted (today's units)."""
    per_source: dict[str, dict[date, FundRow]] = {}
    for r in q_rows:
        if (
            r.basis != basis
            or r.period_type != "Q"
            or r.key != EPS
            or r.value is None
            or _n(r.value) is None
            or r.unit != "INR"
            or r.source == "derived"
        ):
            continue
        cur = per_source.setdefault(r.source, {}).get(r.period_end)
        if cur is None or r.fetched_at > cur.fetched_at:
            per_source[r.source][r.period_end] = r
    out: list[TtmWindow] = []
    for source, by_end in per_source.items():
        ends = sorted(by_end)
        for i in range(3, len(ends)):
            run = ends[i - 3 : i + 1]
            if any(abs((run[j + 1] - shift_months(run[j], 3)).days) > TOL_DAYS for j in range(3)):
                continue
            total = 0.0
            for e in run:
                v = float(by_end[e].value or 0.0)
                total += v / divisor(e, mults, as_of) if mults is not None else v
            avail = max(by_end[e].filed_on or e + timedelta(days=FILED_FALLBACK_DAYS) for e in run)
            out.append(TtmWindow(run[-1], avail, total, source))
    return out


def _best(windows: Iterable[TtmWindow]) -> TtmWindow | None:
    """Latest-ending window; ties go to the better source."""
    best: TtmWindow | None = None
    for w in windows:
        if (
            best is None
            or w.end > best.end
            or (w.end == best.end and _rank(w.source) < _rank(best.source))
        ):
            best = w
    return best


def pe_percentile(
    windows: Sequence[TtmWindow],
    dates: Sequence[date],
    close: F64,
    today_pe: float,
    as_of: date,
) -> tuple[float | None, str | None, int]:
    """docs/05: percentile (0-100) of today's P/E among ``C_t_raw / TTM EPS available at t`` over
    the last 5 years, EPS > 0 only; needs >= 750 points. Returns (value, reason, points)."""
    start = shift_months(as_of, -12 * PE_HISTORY_YEARS)
    by_avail = sorted(windows, key=lambda w: w.avail)
    pes: list[float] = []
    chosen: TtmWindow | None = None
    j = 0
    for d, c in zip(dates, close, strict=True):
        while j < len(by_avail) and by_avail[j].avail <= d:
            chosen = _best([w for w in (chosen, by_avail[j]) if w is not None])
            j += 1
        if d <= start or chosen is None or not math.isfinite(float(c)) or c <= 0:
            continue
        if chosen.value > 0:
            pes.append(float(c) / chosen.value)
    if len(pes) < PE_MIN_POINTS:
        return None, "insufficient_history", len(pes)
    pct = percentile_of(today_pe, pes)
    return _n(pct), None if pct is not None else "insufficient_history", len(pes)


# --- valuation ----------------------------------------------------------------------------------


def valuation(
    inp: FundInputs,
    a: Metrics,
    q: Metrics,
    basis: str,
    ratios: RatioOut,
    reasons: _Reasons,
) -> dict[str, Any]:
    """P/E, P/B, dividend yield, EV/EBITDA, PEG, P/E percentile (docs/05 section 5)."""
    v: dict[str, Any] = {}
    rv = reasons.valuation
    close, as_of, mults = inp.close, inp.as_of, inp.multipliers
    v["close"] = _n(close)

    def null(key: str, why: str) -> None:
        v[key] = None
        rv[key] = why

    # TTM EPS, else latest annual EPS (pe_basis)
    adj_windows = ttm_windows(inp.rows, basis, mults, as_of)
    best = _best(adj_windows)
    eps: float | None
    if best is not None:
        eps, v["pe_basis"], v["eps_period_end"] = best.value, "ttm", best.end.isoformat()
    elif a.get(EPS):
        t = max(a[EPS])
        eps = a[EPS][t].value / divisor(t, mults, as_of)
        v["pe_basis"], v["eps_period_end"] = "latest_annual", t.isoformat()
    else:
        eps = None
        v["pe_basis"], v["eps_period_end"] = "n/a", None
    v["eps_ttm"] = _n(eps)
    pe: float | None = None
    if eps is None:
        null("pe_ttm", "missing_input")
    elif eps <= 0:
        null("pe_ttm", "loss_making")
    elif not (_n(close) is not None and close > 0):
        null("pe_ttm", "missing_input")
    else:
        pe = _n(close / eps)
        v["pe_ttm"] = pe
    if pe is None and "pe_ttm" not in rv:
        rv["pe_ttm"] = "missing_input"

    # shares / market cap (latest shares of either period type, in today's units)
    shares_cells = [(p, c) for src in (a, q) for p, c in src.get(SHARES, {}).items()]
    mcap: float | None = None
    if shares_cells:
        p, c = max(shares_cells, key=lambda x: x[0])
        if c.value > 0:
            mcap = _n(close * c.value * divisor(p, mults, as_of) / CRORE)
    v["market_cap_cr"] = mcap
    if mcap is None:
        rv["market_cap_cr"] = "missing_shares_outstanding"

    # P/B
    t_pb = _latest_with(a, [EQUITY])
    pb: float | None = None
    v["pb_source"] = None
    if t_pb is not None and (_val(a, EQUITY, t_pb) or 0.0) <= 0:
        null("pb", "negative_equity")
    else:
        shares_t = None
        if t_pb is not None:
            sp = _match(a.get(SHARES, {}), t_pb) or _match(q.get(SHARES, {}), t_pb)
            shares_t = (
                None if sp is None else (a.get(SHARES, {}).get(sp) or q.get(SHARES, {}).get(sp))
            )
        if t_pb is not None and shares_t is not None and shares_t.value > 0:
            eq = _val(a, EQUITY, t_pb) or 0.0
            bvps = eq * CRORE / shares_t.value / divisor(t_pb, mults, as_of)
            v["bvps"] = _n(bvps)
            pb = _n(close / bvps) if bvps > 0 else None
            v["pb_source"] = "computed"
        if pb is None and inp.top_pb is not None and _n(inp.top_pb[0]) is not None:
            pb = float(inp.top_pb[0])
            v["pb_source"] = f"top_ratio ({inp.top_pb[1]})"
        if pb is None:
            null("pb", "missing_input")
        else:
            v["pb"] = pb

    # dividend yield: dividends with ex_date in the last 365 days, split-adjusted
    window_start = as_of - timedelta(days=365)
    paid = [d for d in inp.dividends if window_start < d.ex_date <= as_of]
    if not paid:
        null("div_yield", "no_dividend_data")
    elif not close > 0:
        null("div_yield", "missing_input")
    else:
        total = sum(d.amount / divisor(d.ex_date, mults, as_of) for d in paid)
        v["div_yield"] = _n(total / close * 100.0)
    if inp.financial:
        for k in ("ev_ebitda", "peg", "pe_percentile_5y"):
            null(k, NOT_APPLICABLE)
        return v
    # EV/EBITDA
    t_ev = _latest_with(a, [EBITDA, BORROW, CASH])
    if t_ev is None:
        null("ev_ebitda", "missing_input")
    elif mcap is None:
        null("ev_ebitda", "missing_market_cap")
    elif (_val(a, EBITDA, t_ev) or 0.0) <= 0:
        null("ev_ebitda", "n/m")
    else:
        ev = mcap + (_val(a, BORROW, t_ev) or 0.0) - (_val(a, CASH, t_ev) or 0.0)
        v["ev_ebitda"] = _n(ev / (_val(a, EBITDA, t_ev) or 1.0))
    # PEG
    growth = ratios.values.get("eps_cagr_3y")
    if pe is None:
        null("peg", rv.get("pe_ttm", "missing_input"))
    elif growth is None:
        null("peg", "missing_input")
    elif growth <= 0:
        null("peg", "n/m")
    else:
        v["peg"] = _n(pe / growth)
    # PE percentile (5Y)
    if pe is None:
        null("pe_percentile_5y", rv.get("pe_ttm", "missing_input"))
    else:
        raw_windows = ttm_windows(inp.rows, basis, None, as_of)
        pct, why, points = pe_percentile(raw_windows, inp.price_dates, inp.price_close, pe, as_of)
        v["pe_percentile_points"] = points
        if pct is None:
            null("pe_percentile_5y", why or "insufficient_history")
        else:
            v["pe_percentile_5y"] = pct
    for k in ("pe_ttm", "pb", "div_yield", "ev_ebitda", "peg", "pe_percentile_5y"):
        v.setdefault(k, None)
    return v


# --- shareholding -------------------------------------------------------------------------------


def shareholding_metrics(rows: Sequence[HoldingRow]) -> tuple[dict[str, float], float | None]:
    """Screener keys from the latest quarter (unknown means the key is absent, never 0; SHP-02,
    SHP-03) and the promoter change over ~1 year in points (None when unknown)."""
    if not rows:
        return {}, None
    rs = sorted(rows, key=lambda r: r.quarter_end)
    last = rs[-1]
    out: dict[str, float] = {}
    for key, val in (
        ("promoter_pct", last.promoter_pct),
        ("promoter_pledged_pct", last.promoter_pledged_pct),
        ("fii_pct", last.fii_pct),
        ("dii_pct", last.dii_pct),
        ("mf_pct", last.mf_pct),
    ):
        if _n(val) is not None:
            out[key] = float(val)  # type: ignore[arg-type]
    if len(rs) >= 2:  # SHP-04: a single quarter has no QoQ
        prev = rs[-2]
        if 70 <= (last.quarter_end - prev.quarter_end).days <= 111:  # B05-7
            for key, a, b in (
                ("fii_change_qoq", last.fii_pct, prev.fii_pct),
                ("mf_change_qoq", last.mf_pct, prev.mf_pct),
            ):
                if _n(a) is not None and _n(b) is not None:
                    out[key] = float(a) - float(b)  # type: ignore[arg-type]
    change: float | None = None
    target = shift_months(last.quarter_end, -12)
    cands = [r for r in rs[:-1] if abs((r.quarter_end - target).days) <= TOL_DAYS]
    if cands and _n(last.promoter_pct) is not None:
        old = min(cands, key=lambda r: abs((r.quarter_end - target).days))
        if _n(old.promoter_pct) is not None:
            change = float(last.promoter_pct) - float(old.promoter_pct)  # type: ignore[arg-type]
    return out, change


# --- orchestration ------------------------------------------------------------------------------


@dataclass
class FundamentalsResult:
    tree: dict[str, dict[str, Any]]
    screener: dict[str, float]
    quality: dict[str, Any]
    auto_basis: str | None
    inputs_fetched_at: datetime | None


def _last(values: Sequence[float | None]) -> float | None:
    return values[-1] if values else None


def build_fundamentals(inp: FundInputs) -> FundamentalsResult:
    """The ``indicators.fundamentals`` tree plus the fundamental screener keys and the quality
    score of the auto basis (consolidated when entered, else standalone)."""
    bases = sorted({r.basis for r in inp.rows if r.source != "derived" and r.value is not None})
    tree: dict[str, dict[str, Any]] = {}
    screener: dict[str, float] = {}
    quality: dict[str, Any] = quality_score({}, financial=inp.financial, no_debt=False)
    auto = "consolidated" if "consolidated" in bases else (bases[0] if bases else None)
    fetched = [r.fetched_at for r in inp.rows if r.source != "derived" and r.value is not None]
    hold_metrics, promoter_change = shareholding_metrics(inp.holdings)
    for basis in bases:
        a, bad_a = build_metrics(inp.rows, basis, "A")
        q, bad_q = build_metrics(inp.rows, basis, "Q")
        reasons = _Reasons()
        ratios = annual_ratios(a, inp.financial, inp.multipliers, inp.as_of, reasons)
        val = valuation(inp, a, q, basis, ratios, reasons)
        nodes: dict[str, Any] = {}
        derived_a: dict[str, Any] = {}
        for pt, m in (("Q", q), ("A", a)):
            periods = sorted({p for cells in m.values() for p in cells})
            node_reasons = _Reasons()
            derived = derived_arrays(m, periods, pt, inp.financial, node_reasons)
            if pt == "A":
                derived_a = derived
            nodes[pt] = {
                "periods": [p.isoformat() for p in periods],
                "labels": [fiscal_label(p, pt) for p in periods],
                "derived": derived,
                "ratios": ratios.values,
                "ratio_meta": ratios.meta,
                "valuation": val,
                "null_reasons": {
                    "derived": node_reasons.derived,
                    "ratios": reasons.ratios,
                    "valuation": reasons.valuation,
                },
                "warnings": sorted(f"UNIT_MISMATCH:{k}" for k in (bad_a if pt == "A" else bad_q)),
                "version": VERSION,
            }
        tree[basis] = nodes
        if basis != auto:
            continue
        rv = ratios.values
        pairs: dict[str, float | None] = {
            "pe": val.get("pe_ttm"),
            "pb": val.get("pb"),
            "ev_ebitda": val.get("ev_ebitda"),
            "div_yield": val.get("div_yield"),
            "market_cap_cr": val.get("market_cap_cr"),
            "roe": rv.get("roe"),
            "roce": rv.get("roce"),
            "debt_equity": rv.get("debt_equity"),
            "interest_coverage": rv.get("interest_coverage"),
            "cfo_to_pat": rv.get("cfo_to_pat"),
            "op_margin": _last(derived_a.get("op_margin", [])),
            "net_margin": _last(derived_a.get("net_margin", [])),
            "rev_growth_1y": _last(derived_a.get("revenue_yoy", [])),
            "rev_growth_3y": rv.get("revenue_cagr_3y"),
            "rev_growth_5y": rv.get("revenue_cagr_5y"),
            "profit_growth_1y": _last(derived_a.get("net_profit_yoy", [])),
            "profit_growth_3y": rv.get("net_profit_cagr_3y"),
            "profit_growth_5y": rv.get("net_profit_cagr_5y"),
        }
        screener = {k: float(x) for k, x in pairs.items() if _n(x) is not None}  # type: ignore[arg-type]
        quality = quality_score(
            {
                "roe": rv.get("roe"),
                "roce": rv.get("roce"),
                "revenue_cagr_3y": rv.get("revenue_cagr_3y"),
                "net_profit_cagr_3y": rv.get("net_profit_cagr_3y"),
                "debt_equity": rv.get("debt_equity"),
                "interest_coverage": rv.get("interest_coverage"),
                "cfo_to_pat_avg": rv.get("cfo_to_pat_avg"),
                "promoter_pledged_pct": hold_metrics.get("promoter_pledged_pct"),
                "promoter_change_1y": promoter_change,
            },
            financial=inp.financial,
            no_debt=ratios.no_debt,
        )
        quality["basis"] = basis
    for k, x in hold_metrics.items():
        screener[k] = x  # shareholding keys exist even without results data
    if not bases and quality["reason"] != NOT_APPLICABLE:
        quality["reason"] = "no_data_entered"
    return FundamentalsResult(
        tree=tree,
        screener=screener,
        quality=quality,
        auto_basis=auto,
        inputs_fetched_at=max(fetched) if fetched else None,
    )


# Screener keys written by the fundamentals part (docs/03 section 9 whitelist), for coverage and
# for replacing exactly the keys this task owns.
FUNDAMENTAL_SCREENER_KEYS = (
    "market_cap_cr",
    "pe",
    "pb",
    "ev_ebitda",
    "div_yield",
    "roe",
    "roce",
    "debt_equity",
    "interest_coverage",
    "op_margin",
    "net_margin",
    "rev_growth_1y",
    "rev_growth_3y",
    "rev_growth_5y",
    "profit_growth_1y",
    "profit_growth_3y",
    "profit_growth_5y",
    "cfo_to_pat",
    "promoter_pct",
    "promoter_pledged_pct",
    "fii_pct",
    "dii_pct",
    "mf_pct",
    "fii_change_qoq",
    "mf_change_qoq",
)
SCORE_SCREENER_KEYS = ("quality_score", "trend_score", "risk_score")


def attach_fundamentals(
    snap: dict[str, Any], inp: FundInputs, computed_at: datetime
) -> dict[str, Any]:
    """Add the D05b blocks to a price snapshot and return the ``scores`` jsonb (trend, quality).

    ``indicators.fundamentals`` is the B05-4 tree; ``fundamentals_screener`` and
    ``fundamentals_meta`` are siblings (the API reader ignores unknown top-level keys, whereas an
    extra key inside ``fundamentals`` would break its typed decoding).
    """
    res = build_fundamentals(inp)
    snap["fundamentals"] = res.tree
    snap["fundamentals_screener"] = res.screener
    snap["fundamentals_meta"] = {
        "version": VERSION,
        "computed_at": computed_at.isoformat(),
        "inputs_fetched_at": None
        if res.inputs_fetched_at is None
        else res.inputs_fetched_at.isoformat(),
        "auto_basis": res.auto_basis,
        "reason": None if res.tree else "no_data_entered",
        "screener_metrics_available": sum(
            1 for k in FUNDAMENTAL_SCREENER_KEYS if k in res.screener
        ),
        "screener_metrics_total": len(FUNDAMENTAL_SCREENER_KEYS),
    }
    return {"version": VERSION, "trend": trend_score(snap), "quality": res.quality}
