"""Feature builder with leakage guards (docs/05 10.2, 10.3).

Everything here is causal: the value at row ``t`` depends only on bars up to and including ``t``
(test ML-01). Labels use the stock's own row ``t + h`` (holidays and gaps never shift it, ML-02).
Missing feature values drop the row (no imputation) except market-series gaps, which are filled
forward by at most one calendar row. A market group (Nifty, VIX) that has no series at all is
omitted for every row (ML-08).
"""

from __future__ import annotations

import hashlib
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from numpy.typing import NDArray

from worker.analytics import indicators as ind
from worker.analytics.snapshot import Bars

F64 = NDArray[np.float64]
I64 = NDArray[np.int64]

FEATURE_VERSION = 1
HORIZONS = (5, 21)
EWMA_LAMBDA = 0.94
EWMA_SEED_ROWS = 20
BETA_WINDOW = 252
WEEK52 = 252

# Order matters: it is the model's column order and part of the feature hash.
PRICE_FEATURES = (
    "ret_1",
    "ret_5",
    "ret_10",
    "ret_21",
    "ret_63",
    "ret_126",
    "vol_20",
    "vol_60",
    "vol_ratio",
    "rsi14",
    "macd_hist_c",
    "bb_pos",
    "atr14_c",
    "adx14",
    "dist_52w_high",
    "dist_52w_low",
    "vol_z",
    "adv_value_60_log",
)
NIFTY_FEATURES = ("beta_252", "rel_strength_21", "mkt_ret_5", "mkt_ret_21", "mkt_vol_20")
VIX_FEATURES = ("vix_level", "vix_chg_5")
RANK_FEATURES = ("rank_ret_21", "rank_vol_20", "rank_adv_value_60")
CATEGORICAL = ("dow",)


def feature_names(*, nifty: bool, vix: bool) -> list[str]:
    names = list(PRICE_FEATURES)
    if nifty:
        names += NIFTY_FEATURES
    if vix:
        names += VIX_FEATURES
    return [*names, *RANK_FEATURES, *CATEGORICAL]


def feature_hash(names: Sequence[str]) -> str:
    """Stable hash of the feature list and builder version (docs/05 10.8)."""
    blob = f"v{FEATURE_VERSION}|" + ",".join(names)
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


@dataclass(frozen=True)
class StockInput:
    symbol: str
    bars: Bars  # valid (non-suspect) bars, ascending


@dataclass(frozen=True)
class MarketInput:
    """Reserved ``market_series`` codes; ``None`` = the series is absent (ML-08)."""

    nifty: Mapping[date, float] | None = None
    vix: Mapping[date, float] | None = None


@dataclass
class StockFrame:
    """Per-stock features before cross-sectional ranks, aligned to the stock's own rows."""

    symbol: str
    dates: list[date]
    cal_idx: I64  # index of each row's date on the panel calendar
    values: dict[str, F64]
    sigma: F64  # EWMA daily volatility at t (log returns)
    ref: F64  # adj_close at t
    label_end: dict[int, I64] = field(default_factory=dict)  # h -> calendar idx of row t+h, -1 none
    y_ret: dict[int, F64] = field(default_factory=dict)  # h -> ln(C_{t+h}/C_t), nan if none


def _nan(n: int) -> F64:
    return np.full(n, np.nan, dtype=np.float64)


def log_ratio(x: F64, n: int) -> F64:
    """``ln(x_t / x_{t-n})``; nan for the first ``n`` rows."""
    out = _nan(len(x))
    if len(x) > n:
        with np.errstate(all="ignore"):
            out[n:] = np.log(x[n:] / x[:-n])
    return out


def simple_ratio(x: F64) -> F64:
    out = _nan(len(x))
    if len(x) > 1:
        with np.errstate(all="ignore"):
            out[1:] = x[1:] / x[:-1] - 1.0
    return out


def rolling_std(x: F64, n: int) -> F64:
    """Sample std (ddof=1) of the ``n`` values ending at ``t``; nan when fewer or any nan."""
    out = _nan(len(x))
    if len(x) >= n:
        out[n - 1 :] = sliding_window_view(x, n).std(axis=1, ddof=1)
    return out


def ewma_sigma(lr: F64) -> F64:
    """EWMA daily volatility (lambda 0.94) of 1-day log returns ``lr`` (``lr[0]`` is nan).

    Seeded with the sample variance of the first 20 returns; first value at row 20.
    """
    out = _nan(len(lr))
    first = 1 + EWMA_SEED_ROWS
    if len(lr) < first:
        return out
    var = float(np.var(lr[1:first], ddof=1))
    out[first - 1] = math.sqrt(var)
    for t in range(first, len(lr)):
        var = EWMA_LAMBDA * var + (1.0 - EWMA_LAMBDA) * float(lr[t]) ** 2
        out[t] = math.sqrt(var)
    return out


def _rolling_extreme(x: F64, n: int, fn: str) -> F64:
    out = _nan(len(x))
    if len(x) >= n:
        view = sliding_window_view(x, n)
        out[n - 1 :] = view.max(axis=1) if fn == "max" else view.min(axis=1)
    return out


def rolling_beta(rs: F64, rb: F64, n: int) -> F64:
    """OLS slope of ``rs`` on ``rb`` over the ``n`` returns ending at each row; nan when the
    market variance is zero or any input in the window is nan."""
    out = _nan(len(rs))
    if len(rs) < n:
        return out
    ws, wb = sliding_window_view(rs, n), sliding_window_view(rb, n)
    ms, mb = ws.mean(axis=1), wb.mean(axis=1)
    cov = ((ws - ms[:, None]) * (wb - mb[:, None])).sum(axis=1)
    var = ((wb - mb[:, None]) ** 2).sum(axis=1)
    with np.errstate(all="ignore"):
        out[n - 1 :] = np.where(var > 0, cov / var, np.nan)
    return out


def fill_one_row(x: F64) -> F64:
    """One-row forward fill: a nan right after a real value takes it; longer gaps stay nan."""
    out = x.copy()
    for i in range(1, len(out)):
        if np.isnan(x[i]) and not np.isnan(x[i - 1]):
            out[i] = x[i - 1]
    return out


def on_calendar(series: Mapping[date, float] | None, calendar: Sequence[date]) -> F64 | None:
    """The series on the panel calendar (inner join on dates), gaps filled forward by at most one
    row (docs/05 10.3). ``None`` when the series is absent or never meets the calendar."""
    if series is None:
        return None
    raw = np.array([series.get(d, np.nan) for d in calendar], dtype=np.float64)
    raw[~(raw > 0)] = np.nan  # non-positive / nan values are not usable
    if not np.isfinite(raw).any():
        return None
    return fill_one_row(raw)


@dataclass(frozen=True)
class NiftyFrame:
    level: F64  # calendar-aligned index level
    ret_5: F64
    ret_21: F64
    vol_20: F64


@dataclass(frozen=True)
class VixFrame:
    level: F64
    chg_5: F64


@dataclass(frozen=True)
class MarketFrame:
    nifty: NiftyFrame | None
    vix: VixFrame | None


def build_market(calendar: Sequence[date], market: MarketInput) -> MarketFrame:
    level = on_calendar(market.nifty, calendar)
    vix = on_calendar(market.vix, calendar)
    nifty_frame: NiftyFrame | None = None
    vix_frame: VixFrame | None = None
    if level is not None:
        nifty_frame = NiftyFrame(
            level,
            log_ratio(level, 5),
            log_ratio(level, 21),
            rolling_std(log_ratio(level, 1), 20),
        )
    if vix is not None:
        chg = _nan(len(vix))
        chg[5:] = vix[5:] - vix[:-5]
        vix_frame = VixFrame(vix, chg)
    return MarketFrame(nifty_frame, vix_frame)


def stock_frame(
    stock: StockInput,
    calendar_index: Mapping[date, int],
    mkt: MarketFrame,
    horizons: Sequence[int] = HORIZONS,
) -> StockFrame:
    """All causal features of one stock plus its labels."""
    b = stock.bars
    n = len(b.dates)
    c = b.adj_close
    k = b.adj_close / b.close
    hi, lo = b.high * k, b.low * k
    cal_idx = np.array([calendar_index[d] for d in b.dates], dtype=np.int64)
    lr1 = log_ratio(c, 1)
    vols20, vols60 = rolling_std(lr1, 20), rolling_std(lr1, 60)
    with np.errstate(all="ignore"):
        macd_h = ind.macd(c).hist / c
        atr = ind.atr(hi, lo, c, 14) / c
        h52 = _rolling_extreme(hi, WEEK52, "max")
        l52 = _rolling_extreme(lo, WEEK52, "min")
        adv = _nan(n)
        if n >= 60:
            adv[59:] = sliding_window_view(b.close * b.volume, 60).mean(axis=1)
        adv_log = np.where(adv > 0, np.log(adv), np.nan)
        vals: dict[str, F64] = {
            "ret_1": lr1,
            "ret_5": log_ratio(c, 5),
            "ret_10": log_ratio(c, 10),
            "ret_21": log_ratio(c, 21),
            "ret_63": log_ratio(c, 63),
            "ret_126": log_ratio(c, 126),
            "vol_20": vols20,
            "vol_60": vols60,
            "vol_ratio": np.where(vols60 > 0, vols20 / vols60, np.nan),
            "rsi14": ind.rsi(c, 14),
            "macd_hist_c": macd_h,
            "bb_pos": ind.bollinger(c).position,
            "atr14_c": atr,
            "adx14": ind.adx(hi, lo, c, 14).adx,
            "dist_52w_high": c / h52 - 1.0,
            "dist_52w_low": c / l52 - 1.0,
            "vol_z": ind.volume_zscore(b.volume, 20),
            "adv_value_60_log": adv_log,
        }
    if mkt.nifty is not None:
        level = mkt.nifty.level[cal_idx]
        vals["beta_252"] = rolling_beta(simple_ratio(c), simple_ratio(level), BETA_WINDOW)
        vals["rel_strength_21"] = vals["ret_21"] - log_ratio(level, 21)
        vals["mkt_ret_5"] = mkt.nifty.ret_5[cal_idx]
        vals["mkt_ret_21"] = mkt.nifty.ret_21[cal_idx]
        vals["mkt_vol_20"] = mkt.nifty.vol_20[cal_idx]
    if mkt.vix is not None:
        vals["vix_level"] = mkt.vix.level[cal_idx]
        vals["vix_chg_5"] = mkt.vix.chg_5[cal_idx]
    vals["dow"] = np.array([float(d.weekday()) for d in b.dates], dtype=np.float64)
    frame = StockFrame(stock.symbol, list(b.dates), cal_idx, vals, ewma_sigma(lr1), c.copy())
    for h in horizons:
        end = np.full(n, -1, dtype=np.int64)
        yr = _nan(n)
        if n > h:
            end[: n - h] = cal_idx[h:]
            yr[: n - h] = np.log(c[h:] / c[:-h])
        frame.label_end[h] = end
        frame.y_ret[h] = yr
    return frame


@dataclass
class Panel:
    """Stacked feature rows of all stocks (complete rows only), sorted by (date, stock)."""

    names: list[str]
    X: F64
    stock: I64  # index into ``symbols``
    date_idx: I64  # calendar index
    symbols: list[str]
    calendar: list[date]
    sigma: F64
    ref: F64
    row_in_stock: I64  # row index within the stock's own bars
    y_ret: dict[int, F64]
    label_end: dict[int, I64]

    def __len__(self) -> int:
        return len(self.date_idx)

    def column(self, name: str) -> F64:
        out: F64 = self.X[:, self.names.index(name)]
        return out

    def labeled(self, h: int) -> NDArray[np.bool_]:
        out: NDArray[np.bool_] = np.isfinite(self.y_ret[h]) & (self.label_end[h] >= 0)
        return out

    def y_dir(self, h: int) -> F64:
        return (self.y_ret[h] > 0).astype(np.float64)


def cross_sectional_ranks(date_idx: I64, values: F64) -> F64:
    """Per-date percentile rank ``rank / n`` over the stocks present on that date only
    (docs/05 10.2: never uses another date). Ties rank in stock order (stable sort)."""
    out = _nan(len(values))
    order = np.argsort(date_idx, kind="stable")
    bounds = np.flatnonzero(np.diff(date_idx[order])) + 1
    for grp in np.split(order, bounds):
        ok = np.isfinite(values[grp])
        n = int(ok.sum())
        if n < 2:
            continue  # a rank among one stock carries no information; the row is dropped
        idx = grp[ok]
        rk = np.empty(n, dtype=np.float64)
        rk[np.argsort(values[idx], kind="stable")] = np.arange(1, n + 1)
        out[idx] = rk / n
    return out


def build_panel(
    stocks: Sequence[StockInput],
    market: MarketInput,
    horizons: Sequence[int] = HORIZONS,
) -> Panel:
    """Features and labels for every stock-date with complete features (no imputation)."""
    calendar = sorted({d for s in stocks for d in s.bars.dates})
    cal_index = {d: i for i, d in enumerate(calendar)}
    mkt = build_market(calendar, market)
    names = feature_names(nifty=mkt.nifty is not None, vix=mkt.vix is not None)
    frames = [stock_frame(s, cal_index, mkt, horizons) for s in stocks]
    cols = [n for n in names if n not in RANK_FEATURES]

    def cat_f(xs: Sequence[F64]) -> F64:
        return np.concatenate(xs) if xs else _nan(0)

    def cat_i(xs: Sequence[I64]) -> I64:
        return np.concatenate(xs) if xs else np.zeros(0, dtype=np.int64)

    didx = cat_i([f.cal_idx for f in frames])
    stock_ids = cat_i([np.full(len(f.dates), i, dtype=np.int64) for i, f in enumerate(frames)])
    rows = cat_i([np.arange(len(f.dates), dtype=np.int64) for f in frames])
    base = {n: cat_f([f.values[n] for f in frames]) for n in cols}
    base["rank_ret_21"] = cross_sectional_ranks(didx, base["ret_21"])
    base["rank_vol_20"] = cross_sectional_ranks(didx, base["vol_20"])
    base["rank_adv_value_60"] = cross_sectional_ranks(didx, base["adv_value_60_log"])
    mat = np.column_stack([base[n] for n in names]) if len(didx) else np.empty((0, len(names)))
    sigma = cat_f([f.sigma for f in frames])
    keep = np.isfinite(mat).all(axis=1) & np.isfinite(sigma) & (sigma > 0)
    order = np.lexsort((stock_ids[keep], didx[keep]))

    def pick_f(a: F64) -> F64:
        out: F64 = a[keep][order]
        return out

    def pick_i(a: I64) -> I64:
        out: I64 = a[keep][order]
        return out

    return Panel(
        names=names,
        X=mat[keep][order],
        stock=pick_i(stock_ids),
        date_idx=pick_i(didx),
        symbols=[f.symbol for f in frames],
        calendar=calendar,
        sigma=pick_f(sigma),
        ref=pick_f(cat_f([f.ref for f in frames])),
        row_in_stock=pick_i(rows),
        y_ret={h: pick_f(cat_f([f.y_ret[h] for f in frames])) for h in horizons},
        label_end={h: pick_i(cat_i([f.label_end[h] for f in frames])) for h in horizons},
    )
