"""Modular strategy engine. Strategies see only COMPLETED candles and return a Signal (or None).

Add a new strategy by subclassing `Strategy` and registering it in `STRATEGIES`.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence


@dataclass
class Candle:
    time: int        # open time, epoch seconds
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0


@dataclass
class Signal:
    direction: str            # LONG | SHORT
    price: float              # close of the signal candle
    stop_distance: float      # price units, from ATR
    candle_time: int
    reason: str
    indicators: Dict[str, float] = field(default_factory=dict)


@dataclass
class Decision:
    signal: Optional[Signal]
    reason: str               # why no signal (or "signal")


# ---------------------------------------------------------------- indicators
def ema(values: Sequence[float], period: int) -> List[float]:
    """EMA seeded with the SMA of the first `period` values; earlier entries are NaN."""
    out = [float("nan")] * len(values)
    if len(values) < period or period < 1:
        return out
    k = 2.0 / (period + 1)
    prev = sum(values[:period]) / period
    out[period - 1] = prev
    for i in range(period, len(values)):
        prev = values[i] * k + prev * (1 - k)
        out[i] = prev
    return out


def rsi(values: Sequence[float], period: int = 14) -> List[float]:
    """Wilder's RSI."""
    out = [float("nan")] * len(values)
    if len(values) <= period:
        return out
    gains = losses = 0.0
    for i in range(1, period + 1):
        ch = values[i] - values[i - 1]
        gains += max(ch, 0)
        losses += max(-ch, 0)
    ag, al = gains / period, losses / period
    out[period] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    for i in range(period + 1, len(values)):
        ch = values[i] - values[i - 1]
        ag = (ag * (period - 1) + max(ch, 0)) / period
        al = (al * (period - 1) + max(-ch, 0)) / period
        out[i] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    return out


def atr(candles: Sequence[Candle], period: int = 14) -> List[float]:
    """Wilder's ATR."""
    out = [float("nan")] * len(candles)
    if len(candles) <= period:
        return out
    trs = []
    for i in range(1, len(candles)):
        c, p = candles[i], candles[i - 1]
        trs.append(max(c.high - c.low, abs(c.high - p.close), abs(c.low - p.close)))
    a = sum(trs[:period]) / period
    out[period] = a
    for i in range(period + 1, len(candles)):
        a = (a * (period - 1) + trs[i - 1]) / period
        out[i] = a
    return out


def validate_candles(candles: Sequence[Candle], tf_seconds: int) -> Optional[str]:
    """Return a problem description or None. Detects gaps, disorder, invalid OHLC."""
    for i, c in enumerate(candles):
        if not (c.high >= max(c.open, c.close, c.low) and c.low <= min(c.open, c.close, c.high)) or c.low <= 0:
            return f"invalid OHLC at {c.time}"
        if i and c.time - candles[i - 1].time != tf_seconds:
            return f"missing/out-of-order candle between {candles[i - 1].time} and {c.time}"
    return None


# ---------------------------------------------------------------- strategies
class Strategy:
    name = "base"

    def min_candles(self) -> int:
        raise NotImplementedError

    def evaluate(self, candles: Sequence[Candle], trend_candles: Sequence[Candle]) -> Decision:
        raise NotImplementedError


class EmaCrossStrategy(Strategy):
    name = "ema_cross"

    def __init__(self, cfg):
        self.cfg = cfg

    def min_candles(self) -> int:
        return max(self.cfg.ema_slow, self.cfg.rsi_period, self.cfg.atr_period) + 5

    def trend_direction(self, trend_candles: Sequence[Candle]) -> Optional[str]:
        closes = [c.close for c in trend_candles]
        e = ema(closes, self.cfg.ema_trend)
        if len(closes) < self.cfg.ema_trend or e[-1] != e[-1]:
            return None
        return "LONG" if closes[-1] > e[-1] else "SHORT"

    def evaluate(self, candles: Sequence[Candle], trend_candles: Sequence[Candle]) -> Decision:
        c = self.cfg
        if len(candles) < self.min_candles():
            return Decision(None, f"insufficient candles ({len(candles)}/{self.min_candles()})")
        closes = [x.close for x in candles]
        fast, slow = ema(closes, c.ema_fast), ema(closes, c.ema_slow)
        r, a = rsi(closes, c.rsi_period), atr(candles, c.atr_period)
        i = len(candles) - 1
        vals = (fast[i], fast[i - 1], slow[i], slow[i - 1], r[i], a[i])
        if any(v != v for v in vals):
            return Decision(None, "indicators not warmed up")
        crossed_up = fast[i - 1] <= slow[i - 1] and fast[i] > slow[i]
        crossed_dn = fast[i - 1] >= slow[i - 1] and fast[i] < slow[i]
        if not (crossed_up or crossed_dn):
            return Decision(None, "no EMA cross on the last completed candle")
        direction = "LONG" if crossed_up else "SHORT"
        if direction == "SHORT" and not c.allow_short:
            return Decision(None, "bearish cross ignored (ALLOW_SHORT=false)")
        trend = self.trend_direction(trend_candles)
        if trend is None:
            return Decision(None, "higher-timeframe trend unavailable (EMA200 not warmed up)")
        if trend != direction:
            return Decision(None, f"{direction} cross against higher-timeframe trend ({trend})")
        lo, hi = (c.rsi_long_min, c.rsi_long_max) if direction == "LONG" else (c.rsi_short_min, c.rsi_short_max)
        if not (lo <= r[i] <= hi):
            return Decision(None, f"RSI {r[i]:.1f} outside [{lo}, {hi}]")
        if c.min_volume and candles[-1].volume < c.min_volume:
            return Decision(None, f"volume {candles[-1].volume} below minimum")
        if a[i] <= 0:
            return Decision(None, "ATR is zero")
        sig = Signal(direction, candles[-1].close, a[i] * c.atr_stop_mult, candles[-1].time,
                     f"EMA{c.ema_fast}/{c.ema_slow} cross, trend {trend}, RSI {r[i]:.1f}",
                     {"ema_fast": fast[i], "ema_slow": slow[i], "rsi": r[i], "atr": a[i]})
        return Decision(sig, "signal")


STRATEGIES = {"ema_cross": EmaCrossStrategy}


def build_strategy(name: str, cfg) -> Strategy:
    return STRATEGIES[name](cfg)
