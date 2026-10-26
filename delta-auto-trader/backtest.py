"""Candle-replay backtester. No look-ahead: signals use candle i (closed), fills happen at candle i+1's
open (plus adverse slippage); stops/targets are checked on later candles, with the stop assumed to hit
first when both are touched inside one candle. Fees use the same FeeSchedule and sizer as live trading."""
from __future__ import annotations

import csv
import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from config import timeframe_seconds
from fee_calculator import FeeSchedule, gross_pnl
from instrument_selector import Instrument
from pnl_tracker import funding_intervals_crossed
from position_sizer import size_position
from strategy import Candle, Strategy


def load_csv(path: str) -> List[Candle]:
    out = []
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            out.append(Candle(int(float(r["time"])), float(r["open"]), float(r["high"]), float(r["low"]),
                              float(r["close"]), float(r.get("volume") or 0)))
    return sorted(out, key=lambda c: c.time)


def resample(candles: List[Candle], tf_seconds: int) -> List[Candle]:
    """Aggregate to a higher timeframe; only fully elapsed buckets are emitted via `completed_until`."""
    buckets: Dict[int, List[Candle]] = {}
    for c in candles:
        buckets.setdefault(c.time - c.time % tf_seconds, []).append(c)
    out = []
    for t in sorted(buckets):
        b = buckets[t]
        out.append(Candle(t, b[0].open, max(x.high for x in b), min(x.low for x in b), b[-1].close,
                          sum(x.volume for x in b)))
    return out


@dataclass
class BTTrade:
    side: str
    entry_time: int
    exit_time: int
    entry: float
    exit: float
    qty: int
    gross: float
    fees: float
    funding: float
    net: float
    reason: str


@dataclass
class BTResult:
    trades: List[BTTrade] = field(default_factory=list)
    skipped: Dict[str, int] = field(default_factory=dict)
    fee_source: str = ""

    def stats(self) -> dict:
        n = len(self.trades)
        wins = [t.net for t in self.trades if t.net > 0]
        losses = [t.net for t in self.trades if t.net <= 0]
        eq = peak = dd = 0.0
        for t in self.trades:
            eq += t.net
            peak = max(peak, eq)
            dd = max(dd, peak - eq)
        gl = abs(sum(losses))
        return {
            "trades": n, "win_rate": len(wins) / n if n else 0.0,
            "avg_win": sum(wins) / len(wins) if wins else 0.0,
            "avg_loss": sum(losses) / len(losses) if losses else 0.0,
            "profit_factor": (sum(wins) / gl) if gl > 0 else (math.inf if wins else 0.0),
            "max_drawdown": dd, "gross_pnl": sum(t.gross for t in self.trades),
            "fees": sum(t.fees for t in self.trades), "funding": sum(t.funding for t in self.trades),
            "net_pnl": sum(t.net for t in self.trades),
            "skipped": dict(self.skipped), "fee_source": self.fee_source,
        }


def run_backtest(cfg, strategy: Strategy, inst: Instrument, candles: List[Candle], fees: FeeSchedule,
                 funding_pct: float = 0.01, warmup: Optional[int] = None) -> BTResult:
    tf = timeframe_seconds(cfg.timeframe)
    ttf = timeframe_seconds(cfg.trend_timeframe)
    res = BTResult(fee_source=fees.source)
    trend_all = resample(candles, ttf)
    warmup = warmup or strategy.min_candles()
    i = warmup
    slip = cfg.slippage_bps / 10_000.0
    while i < len(candles) - 2:
        hist = candles[: i + 1]
        close_t = hist[-1].time + tf
        trend = [c for c in trend_all if c.time + ttf <= close_t]      # completed trend bars only
        dec = strategy.evaluate(hist[-(cfg.ema_trend + 50):], trend)
        if dec.signal is None:
            i += 1
            continue
        sig = dec.signal
        nxt = candles[i + 1]
        entry_ref = nxt.open * (1 + slip) if sig.direction == "LONG" else nxt.open * (1 - slip)
        plan = size_position(cfg, inst, sig.direction, entry_ref, sig.stop_distance, fees, None, funding_pct)
        if not plan.ok:
            key = plan.reason.split(":")[0][:60]
            res.skipped[key] = res.skipped.get(key, 0) + 1
            i += 1
            continue
        long_ = sig.direction == "LONG"
        exit_px, reason, j = None, "", i + 1
        entry_time = nxt.time
        deadline = entry_time + cfg.max_hold_minutes * 60
        for j in range(i + 1, len(candles)):
            c = candles[j]
            hit_sl = c.low <= plan.stop if long_ else c.high >= plan.stop
            hit_tp = c.high >= plan.take_profit if long_ else c.low <= plan.take_profit
            if hit_sl:           # conservative ordering; gap-through fills at the open if worse
                px = min(plan.stop, c.open) if long_ else max(plan.stop, c.open)
                exit_px, reason = px * (1 - slip if long_ else 1 + slip), "STOP_LOSS"
                break
            if hit_tp:
                exit_px, reason = plan.take_profit, "TAKE_PROFIT"
                break
            if c.time + tf >= deadline:
                exit_px, reason = c.close, "TIME_EXIT"
                break
        if exit_px is None:
            break
        exit_role = "maker" if reason == "TAKE_PROFIT" else "taker"
        q, cv = plan.qty, inst.contract_value
        fee = fees.fee(plan.entry * q * cv, "taker") + fees.fee(exit_px * q * cv, exit_role)
        gross = gross_pnl(sig.direction, plan.entry, exit_px, q, cv)
        n = funding_intervals_crossed(entry_time, candles[j].time + tf)
        fund = max(0.0, funding_pct / 100 * plan.entry * q * cv * n * (1 if long_ else -1))
        res.trades.append(BTTrade(sig.direction, entry_time, candles[j].time + tf, plan.entry, exit_px, q,
                                  gross, fee, fund, gross - fee - fund, reason))
        i = j + 1 + int(cfg.cooldown_minutes * 60 // tf)
    return res
