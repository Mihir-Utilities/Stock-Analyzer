"""Technical indicators (docs/05 section 3). Pure numpy: no database, clock or network.

Every function takes float64 arrays aligned on the stock's own valid bars and returns an array of
the same length with ``nan`` at warm-up positions (never partial-window values, docs/05 1). The
``nan`` markers stay inside this module family; ``snapshot`` converts them to ``None`` plus
a reason.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from numpy.typing import NDArray

F64 = NDArray[np.float64]

NAN = float("nan")


def _full(n: int) -> F64:
    return np.full(n, NAN, dtype=np.float64)


def sma(x: F64, n: int) -> F64:
    """Mean of the last ``n`` values; positions with fewer than ``n`` (or any nan) are nan."""
    out = _full(len(x))
    if n < 1 or len(x) < n:
        return out
    out[n - 1 :] = sliding_window_view(x, n).mean(axis=1)
    return out


def ema(x: F64, n: int) -> F64:
    """``EMA_t = alpha*x_t + (1-alpha)*EMA_{t-1}``, ``alpha = 2/(n+1)``, seeded with the SMA of the
    first ``n`` valid values. ``x`` may start with nan (warm-up of an upstream indicator)."""
    out = _full(len(x))
    valid = np.flatnonzero(~np.isnan(x))
    if len(valid) == 0:
        return out
    start = int(valid[0])
    seed_at = start + n - 1
    if n < 1 or seed_at >= len(x):
        return out
    alpha = 2.0 / (n + 1)
    prev = float(np.mean(x[start : seed_at + 1]))
    out[seed_at] = prev
    for t in range(seed_at + 1, len(x)):
        prev = alpha * float(x[t]) + (1.0 - alpha) * prev
        out[t] = prev
    return out


def rsi(close: F64, n: int = 14) -> F64:
    """Wilder RSI. avg_loss == 0 -> 100 (both zero -> 50)."""
    out = _full(len(close))
    if len(close) <= n:
        return out
    d = np.diff(close)
    gains = np.where(d > 0, d, 0.0)
    losses = np.where(d < 0, -d, 0.0)
    avg_gain = float(gains[:n].mean())
    avg_loss = float(losses[:n].mean())
    out[n] = _rsi_value(avg_gain, avg_loss)
    for t in range(n, len(d)):
        avg_gain = (avg_gain * (n - 1) + float(gains[t])) / n
        avg_loss = (avg_loss * (n - 1) + float(losses[t])) / n
        out[t + 1] = _rsi_value(avg_gain, avg_loss)
    return out


def _rsi_value(avg_gain: float, avg_loss: float) -> float:
    if avg_loss == 0.0:
        return 50.0 if avg_gain == 0.0 else 100.0
    return 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)


@dataclass(frozen=True)
class Macd:
    macd: F64
    signal: F64
    hist: F64


def macd(close: F64, fast: int = 12, slow: int = 26, signal_n: int = 9) -> Macd:
    """``macd = EMA12 - EMA26``, ``signal = EMA9(macd)``, ``hist = macd - signal`` (valid from bar
    26 + 9 - 1, i.e. after 34 bars)."""
    line = ema(close, fast) - ema(close, slow)
    sig = ema(line, signal_n)
    return Macd(line, sig, line - sig)


@dataclass(frozen=True)
class Bollinger:
    middle: F64
    upper: F64
    lower: F64
    position: F64  # (C - lower) / (upper - lower); nan when the band has zero width


def bollinger(close: F64, n: int = 20, k: float = 2.0) -> Bollinger:
    """Middle SMA(n), bands ``k * population std`` (ddof=0)."""
    mid = sma(close, n)
    std = _full(len(close))
    if len(close) >= n:
        std[n - 1 :] = sliding_window_view(close, n).std(axis=1, ddof=0)
    upper = mid + k * std
    lower = mid - k * std
    width = upper - lower
    pos = _full(len(close))
    ok = width > 0
    pos[ok] = (close[ok] - lower[ok]) / width[ok]
    return Bollinger(mid, upper, lower, pos)


def true_range(high: F64, low: F64, close: F64) -> F64:
    """``max(H-L, |H-C_prev|, |L-C_prev|)``; the first bar has no previous close -> nan."""
    tr = _full(len(close))
    if len(close) < 2:
        return tr
    prev = close[:-1]
    tr[1:] = np.maximum(
        high[1:] - low[1:], np.maximum(np.abs(high[1:] - prev), np.abs(low[1:] - prev))
    )
    return tr


def atr(high: F64, low: F64, close: F64, n: int = 14) -> F64:
    """Wilder ATR: first = mean of the first ``n`` TRs, then ``(prev*(n-1) + TR)/n``."""
    out = _full(len(close))
    tr = true_range(high, low, close)
    if len(close) <= n:
        return out
    prev = float(tr[1 : n + 1].mean())
    out[n] = prev
    for t in range(n + 1, len(close)):
        prev = (prev * (n - 1) + float(tr[t])) / n
        out[t] = prev
    return out


@dataclass(frozen=True)
class Adx:
    adx: F64
    plus_di: F64
    minus_di: F64


def adx(high: F64, low: F64, close: F64, n: int = 14) -> Adx:
    """Wilder ADX (docs/05 3). ``+DI + -DI == 0`` gives DX 0 (no directional movement)."""
    size = len(close)
    adx_out, plus_out, minus_out = _full(size), _full(size), _full(size)
    if size < 2 * n:  # first ADX sits at index 2n-1, so exactly 2n bars suffice
        return Adx(adx_out, plus_out, minus_out)
    up = high[1:] - high[:-1]
    down = low[:-1] - low[1:]
    plus_dm = np.where((up > down) & (up > 0), up, 0.0)
    minus_dm = np.where((down > up) & (down > 0), down, 0.0)
    tr = true_range(high, low, close)[1:]
    s_tr = float(tr[:n].sum())
    s_plus = float(plus_dm[:n].sum())
    s_minus = float(minus_dm[:n].sum())
    dx = _full(size)
    for t in range(n, size):  # position t in the full series; DM/TR index is t - 1
        if t > n:
            s_tr = s_tr - s_tr / n + float(tr[t - 1])
            s_plus = s_plus - s_plus / n + float(plus_dm[t - 1])
            s_minus = s_minus - s_minus / n + float(minus_dm[t - 1])
        pdi = 100.0 * s_plus / s_tr if s_tr > 0 else 0.0
        mdi = 100.0 * s_minus / s_tr if s_tr > 0 else 0.0
        plus_out[t], minus_out[t] = pdi, mdi
        total = pdi + mdi
        dx[t] = 100.0 * abs(pdi - mdi) / total if total > 0 else 0.0
    first = 2 * n - 1  # n DX values exist at positions n .. 2n-1
    prev = float(dx[n : first + 1].mean())
    adx_out[first] = prev
    for t in range(first + 1, size):
        prev = (prev * (n - 1) + float(dx[t])) / n
        adx_out[t] = prev
    return Adx(adx_out, plus_out, minus_out)


@dataclass(frozen=True)
class Stochastic:
    k: F64
    d: F64


def stochastic(high: F64, low: F64, close: F64, n: int = 14, d_n: int = 3) -> Stochastic:
    """``%K = 100 (C - LL)/(HH - LL)`` (denominator 0 -> 50), ``%D = SMA(%K, 3)``."""
    size = len(close)
    k = _full(size)
    if size >= n:
        hh = sliding_window_view(high, n).max(axis=1)
        ll = sliding_window_view(low, n).min(axis=1)
        c = close[n - 1 :]
        span = hh - ll
        with np.errstate(divide="ignore", invalid="ignore"):
            raw = 100.0 * (c - ll) / span
        k[n - 1 :] = np.where(span > 0, raw, 50.0)
    return Stochastic(k, sma(k, d_n))


def obv(close: F64, volume: F64) -> F64:
    """``OBV_t = OBV_{t-1} + sign(C_t - C_{t-1}) * V_t``, starting at 0 on the first bar."""
    out = np.zeros(len(close), dtype=np.float64)
    if len(close) > 1:
        out[1:] = np.cumsum(np.sign(np.diff(close)) * volume[1:])
    return out


def volume_zscore(volume: F64, n: int = 20) -> F64:
    """``(V_t - mean(V_{t-n..t-1})) / std(...)`` over the prior ``n`` days (today excluded),
    sample std (ddof=1, docs/05 1); nan when the std is 0."""
    out = _full(len(volume))
    if len(volume) <= n:
        return out
    win = sliding_window_view(volume, n)[:-1]  # window ending at t-1 for t = n .. len-1
    mean = win.mean(axis=1)
    std = win.std(axis=1, ddof=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        z = (volume[n:] - mean) / std
    out[n:] = np.where(std > 0, z, NAN)
    return out


@dataclass(frozen=True)
class Range52:
    high: float
    low: float


def week52(high: F64, low: F64, window: int = 252) -> Range52 | None:
    """High/low over the last ``window`` rows of (k-scaled) H/L; None with fewer rows."""
    if len(high) < window:
        return None
    return Range52(float(np.max(high[-window:])), float(np.min(low[-window:])))


@dataclass(frozen=True)
class Level:
    price: float
    touches: int


def support_resistance(
    high: F64,
    low: F64,
    close_now: float,
    *,
    window: int = 250,
    wing: int = 5,
    cluster_pct: float = 1.5,
    top: int = 3,
) -> tuple[list[Level], list[Level]]:
    """Swing highs/lows (``H_t == max(H_{t-5..t+5})``, analog for lows) among the last ``window``
    rows, excluding the last ``wing`` rows (unconfirmed). Levels within 1.5% are averaged; up to
    ``top`` supports below and ``top`` resistances above the price, nearest first.

    The swing highs and lows are pooled before clustering (docs/OPEN_QUESTIONS D05a-A3).
    """
    n = len(high)
    first = max(wing, n - window)
    levels: list[float] = []
    for t in range(first, n - wing):
        lo_i, hi_i = t - wing, t + wing + 1
        if high[t] == np.max(high[lo_i:hi_i]):
            levels.append(float(high[t]))
        if low[t] == np.min(low[lo_i:hi_i]):
            levels.append(float(low[t]))
    clusters: list[list[float]] = []
    for lv in sorted(levels):
        if clusters and lv / (sum(clusters[-1]) / len(clusters[-1])) - 1.0 <= cluster_pct / 100.0:
            clusters[-1].append(lv)
        else:
            clusters.append([lv])
    merged = [Level(sum(c) / len(c), len(c)) for c in clusters]
    supports = sorted((m for m in merged if m.price < close_now), key=lambda m: close_now - m.price)
    resistances = sorted(
        (m for m in merged if m.price > close_now), key=lambda m: m.price - close_now
    )
    return supports[:top], resistances[:top]


@dataclass(frozen=True)
class Crosses:
    golden: bool
    death: bool
    last_cross: str | None  # 'golden' | 'death' | None


def crosses(sma_fast: F64, sma_slow: F64, lookback: int = 20) -> Crosses | None:
    """SMA50 vs SMA200 crossings within the last ``lookback`` bars.

    Golden: fast <= slow on the previous bar and fast > slow now. Death: fast >= slow before and
    fast < slow now.
    None when the slow SMA has no value on the bar before the first examined bar.
    """
    n = len(sma_fast)
    if n < lookback + 1:
        return None
    start = n - lookback
    if np.isnan(sma_slow[start - 1]) or np.isnan(sma_fast[start - 1]):
        return None
    golden = death = False
    last: str | None = None
    for t in range(start, n):
        if sma_fast[t - 1] <= sma_slow[t - 1] and sma_fast[t] > sma_slow[t]:
            golden, last = True, "golden"
        elif sma_fast[t - 1] >= sma_slow[t - 1] and sma_fast[t] < sma_slow[t]:
            death, last = True, "death"
    return Crosses(golden, death, last)
