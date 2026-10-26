"""Position sizing. Never silently grows size or risk to satisfy exchange minimums."""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

from fee_calculator import FeeSchedule, TradeEconomics, estimate_trade
from instrument_selector import Instrument


@dataclass
class SizingResult:
    ok: bool
    reason: str = ""
    qty: int = 0
    side: str = ""
    entry: float = 0.0
    stop: float = 0.0
    take_profit: float = 0.0
    leverage: float = 1.0
    notional: float = 0.0
    margin: float = 0.0
    econ: Optional[TradeEconomics] = None


def _round_dist(dist: float, tick: float) -> float:
    return max(tick, math.ceil(round(dist / tick, 9)) * tick)


def _round_px(px: float, tick: float) -> float:
    return round(round(px / tick) * tick, 10)


def size_position(cfg, inst: Instrument, side: str, entry: float, stop_distance: float, fees: FeeSchedule,
                  available_margin: Optional[float], funding_pct: float = 0.0,
                  underlying_price: Optional[float] = None) -> SizingResult:
    """entry = expected fill price (already includes slippage); stop_distance in price units."""
    sgn = 1 if (side == "LONG" or inst.is_option) else -1
    if entry <= 0 or stop_distance <= 0:
        return SizingResult(False, "invalid entry/stop distance")
    if inst.inverse:
        return SizingResult(False, "inverse contracts unsupported")
    tick, cv = inst.tick_size, inst.contract_value
    entry = _round_px(entry, tick)
    d = _round_dist(stop_distance, tick)
    stop = _round_px(entry - sgn * d, tick)
    if stop <= 0:
        return SizingResult(False, "stop price would be <= 0")
    # option positions are long premium: a "SHORT" signal buys a put, so P&L math is always long
    pnl_side = "LONG" if inst.is_option else side
    max_notional = cfg.max_position_notional_usd
    ref_price = underlying_price if (inst.is_option and underlying_price) else entry
    per_contract_notional = ref_price * cv
    max_by_notional = int(max_notional // per_contract_notional)

    hold_h = cfg.max_hold_minutes / 60.0
    risk_budget = cfg.max_risk_usd

    def econ_for(n: int, tp_px: float) -> TradeEconomics:
        return estimate_trade(fees, pnl_side, entry, stop, tp_px, n, cv, funding_pct, hold_h,
                              cfg.slippage_bps, option=inst.is_option)

    # provisional TP (gross RR) only to size the loss side; loss does not depend on TP
    prov_tp = _round_px(entry + sgn * d * cfg.risk_reward_ratio, tick)
    e1 = econ_for(1, prov_tp)
    if e1.net_loss <= 0:
        return SizingResult(False, "cannot compute loss per contract")
    max_by_risk = int(risk_budget // e1.net_loss)
    qty = min(max_by_notional, max_by_risk)
    # exchange minimum (documented as 1 contract; size increment 1)
    if max_by_notional < inst.min_size:
        return SizingResult(False, (
            f"Minimum order size exceeds configured limit: 1 contract = ${per_contract_notional:,.2f} "
            f"(₹{per_contract_notional * cfg.usd_inr_rate:,.0f}) notional vs limit "
            f"${max_notional:,.4f} (₹{cfg.max_position_notional_inr:g})."), side=side)
    if max_by_risk < inst.min_size:
        return SizingResult(False, (
            f"Risk budget cannot be met at minimum size: 1 contract risks ${e1.net_loss:,.4f} "
            f"(₹{e1.net_loss * cfg.usd_inr_rate:,.2f}) after fees/slippage vs budget "
            f"${risk_budget:,.4f} (₹{cfg.max_risk_per_trade_inr:g})."), side=side)
    qty = (qty // inst.size_increment) * inst.size_increment
    if inst.position_size_limit:
        qty = min(qty, inst.position_size_limit)
    if qty < inst.min_size:
        return SizingResult(False, "quantity below minimum after increment rounding", side=side)

    # re-verify at the final quantity (fees may be non-linear for options)
    while qty >= inst.min_size and econ_for(qty, prov_tp).net_loss > risk_budget:
        qty -= inst.size_increment
    if qty < inst.min_size:
        return SizingResult(False, "risk budget cannot be met at any permitted size", side=side)

    # take-profit
    if cfg.rr_mode == "GROSS_RR":
        tp_dist = _round_dist(d * cfg.risk_reward_ratio, tick)
        tp = _round_px(entry + sgn * tp_dist, tick)
    else:
        e = econ_for(qty, prov_tp)
        fixed_costs = e.entry_fee + e.funding
        # net_reward = qty*cv*t - entry_fee - exit_fee(tp) - funding ; solve t for RR*net_loss
        # exit fee depends weakly on t; iterate to converge.
        t = d * cfg.risk_reward_ratio
        for _ in range(20):
            tp_try = entry + sgn * t
            ee = econ_for(qty, _round_px(tp_try, tick))
            target = cfg.risk_reward_ratio * ee.net_loss
            need = target + ee.entry_fee + ee.exit_fee_tp + ee.funding
            t_new = need / (qty * cv)
            if abs(t_new - t) < tick / 100:
                t = t_new
                break
            t = t_new
        tp_dist = _round_dist(t, tick)
        if tp_dist > d * cfg.max_tp_r_multiple:
            return SizingResult(False, (
                f"NET_RR needs a take-profit {tp_dist / d:.1f}R away (> {cfg.max_tp_r_multiple}R cap): "
                "fees are too large relative to the position."), side=side)
        tp = _round_px(entry + sgn * tp_dist, tick)

    econ = econ_for(qty, tp)
    if econ.net_reward <= 0:
        return SizingResult(False, f"expected net reward {econ.net_reward:.4f} <= 0 after fees/funding", side=side,
                            econ=econ)
    if cfg.rr_mode == "NET_RR" and econ.net_rr + 1e-9 < cfg.risk_reward_ratio * 0.98:
        return SizingResult(False, f"NET_RR {econ.net_rr:.2f} below required {cfg.risk_reward_ratio}", side=side,
                            econ=econ)
    if econ.net_loss > risk_budget + 1e-12:
        return SizingResult(False, "risk budget exceeded", side=side, econ=econ)

    notional = ref_price * qty * cv
    if notional > max_notional + 1e-12:
        return SizingResult(False, "notional limit exceeded", side=side, econ=econ)
    lev = max(1.0, min(cfg.max_leverage, inst.max_leverage))
    margin = (entry * qty * cv) if inst.is_option else notional / lev
    if available_margin is not None and margin > available_margin:
        return SizingResult(False, f"required margin ${margin:.4f} exceeds available ${available_margin:.4f}",
                            side=side, econ=econ)
    return SizingResult(True, "ok", qty, side, entry, stop, tp, lev, notional, margin, econ)
