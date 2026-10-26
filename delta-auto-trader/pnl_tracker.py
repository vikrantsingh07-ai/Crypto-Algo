"""Realized P&L from exchange fills (actual fees) with explicit ESTIMATED labelling."""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import List, Optional

from fee_calculator import FeeSchedule, funding_cost, gross_pnl


@dataclass
class TradeResult:
    entry_price: float
    exit_price: float
    qty: int
    gross: float
    fees: float
    funding: float
    net: float
    fees_actual: bool
    funding_estimated: bool
    exit_time: float
    actual_rr: Optional[float] = None


def funding_intervals_crossed(entry_ts: float, exit_ts: float, interval_hours: float = 8.0) -> int:
    i = interval_hours * 3600
    return int(exit_ts // i - entry_ts // i)


def compute_result(trade: dict, fills: List[dict], contract_value: float, fees: FeeSchedule,
                   funding_pct: float = 0.0, option: bool = False, interval_hours: float = 8.0) -> Optional[TradeResult]:
    """`fills` must already be restricted to this trade's orders."""
    side = trade["side"]
    entry_side = "buy" if (side == "LONG" or option) else "sell"
    ent = [f for f in fills if f["side"] == entry_side]
    ext = [f for f in fills if f["side"] != entry_side]
    if not ent or not ext:
        return None
    eq = sum(int(f["size"]) for f in ent)
    xq = sum(int(f["size"]) for f in ext)
    qty = min(eq, xq)
    ep = sum(float(f["price"]) * int(f["size"]) for f in ent) / eq
    xp = sum(float(f["price"]) * int(f["size"]) for f in ext) / xq
    pnl_side = "LONG" if (side == "LONG" or option) else "SHORT"
    g = gross_pnl(pnl_side, ep, xp, qty, contract_value)
    have = all(f.get("commission") not in (None, "") for f in fills)
    if have:
        fee_total = sum(float(f["commission"]) for f in fills)
    else:   # fall back to a labelled estimate
        fee_total = fees.fee(ep * qty * contract_value, "taker") + fees.fee(xp * qty * contract_value, "taker")
    exit_ts = max(float(f.get("created_at") or 0) for f in ext)
    n = funding_intervals_crossed(float(trade["entry_time"] or exit_ts), exit_ts, interval_hours) if not option else 0
    fund = max(0.0, (funding_pct / 100.0) * ep * qty * contract_value * n * (1 if pnl_side == "LONG" else -1))
    net = g - fee_total - fund
    risk = abs(ep - float(trade["stop_price"])) * qty * contract_value + fee_total + fund
    rr = (net / risk) if risk > 0 else None
    return TradeResult(ep, xp, qty, g, fee_total, fund, net, have, True, exit_ts, rr)
