"""Fee, funding and net P&L calculation. All amounts in the contract's quote currency (USD)."""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

# Used only when neither the exchange product nor the config supplies a rate. Values are the
# sample rates in Delta's docs and are labelled ESTIMATED everywhere they are used.
DEFAULT_MAKER = 0.0002
DEFAULT_TAKER = 0.0005
OPTION_FEE_PREMIUM_CAP = 0.10   # option fee is capped at 10% of premium (assumption; verify on exchange)


@dataclass
class FeeSchedule:
    maker: float
    taker: float
    gst: float = 0.18
    source: str = "ESTIMATED"        # EXCHANGE | CONFIG | ESTIMATED
    option_premium_cap: float = OPTION_FEE_PREMIUM_CAP

    @property
    def exact(self) -> bool:
        return self.source in ("EXCHANGE", "CONFIG")

    @classmethod
    def resolve(cls, cfg, inst=None) -> "FeeSchedule":
        if cfg.maker_fee_rate is not None and cfg.taker_fee_rate is not None:
            return cls(cfg.maker_fee_rate, cfg.taker_fee_rate, cfg.gst_rate, "CONFIG")
        if inst is not None and inst.maker_fee_rate is not None and inst.taker_fee_rate is not None:
            # Product rates are fractions (docs sample 0.0002 / 0.0005). A value > 0.01 is
            # implausible as a fraction (would be 1%+) so treat it as unreliable -> ESTIMATED.
            if inst.maker_fee_rate <= 0.01 and inst.taker_fee_rate <= 0.01:
                return cls(inst.maker_fee_rate, inst.taker_fee_rate, cfg.gst_rate, "EXCHANGE")
        return cls(DEFAULT_MAKER, DEFAULT_TAKER, cfg.gst_rate, "ESTIMATED")

    def fee(self, notional: float, role: str, premium_notional: Optional[float] = None) -> float:
        rate = self.maker if role == "maker" else self.taker
        base = notional * rate
        if premium_notional is not None:
            base = min(base, premium_notional * self.option_premium_cap)
        return base * (1.0 + self.gst)


def notional(price: float, qty: int, contract_value: float) -> float:
    return price * qty * contract_value


def gross_pnl(side: str, entry: float, exit_: float, qty: int, contract_value: float) -> float:
    d = (exit_ - entry) if side == "LONG" else (entry - exit_)
    return d * qty * contract_value


def funding_cost(side: str, notional_usd: float, rate_pct_per_interval: float, hold_hours: float,
                 interval_hours: float = 8.0) -> float:
    """Conservative funding estimate: only costs are counted (receiving funding is ignored).
    rate_pct_per_interval is a percentage (0.01 == 0.01%). Intervals are rounded up."""
    if hold_hours <= 0 or interval_hours <= 0:
        return 0.0
    intervals = math.ceil(hold_hours / interval_hours)
    signed = rate_pct_per_interval / 100.0 * notional_usd * intervals
    cost = signed if side == "LONG" else -signed
    return max(0.0, cost)


@dataclass
class TradeEconomics:
    entry_notional: float
    exit_notional_tp: float
    exit_notional_sl: float
    entry_fee: float
    exit_fee_tp: float
    exit_fee_sl: float
    funding: float
    slippage_allowance: float
    gross_reward: float
    gross_loss: float
    net_reward: float
    net_loss: float
    net_rr: float
    gross_rr: float
    fee_source: str
    estimated: bool


def estimate_trade(fees: FeeSchedule, side: str, entry: float, stop: float, tp: float, qty: int,
                   contract_value: float, funding_pct: float = 0.0, hold_hours: float = 0.0,
                   slippage_bps: float = 0.0, entry_role: str = "taker", tp_role: str = "maker",
                   sl_role: str = "taker", option: bool = False) -> TradeEconomics:
    en = notional(entry, qty, contract_value)
    ex_tp = notional(tp, qty, contract_value)
    ex_sl = notional(stop, qty, contract_value)
    prem = (lambda n: n) if option else (lambda n: None)
    f_en = fees.fee(en, entry_role, prem(en))
    f_tp = fees.fee(ex_tp, tp_role, prem(ex_tp))
    f_sl = fees.fee(ex_sl, sl_role, prem(ex_sl))
    fund = funding_cost(side, en, funding_pct, hold_hours) if not option else 0.0
    slip = en * slippage_bps / 10_000.0   # allowance on the stop leg (market exit)
    g_reward = gross_pnl(side, entry, tp, qty, contract_value)
    g_loss = -gross_pnl(side, entry, stop, qty, contract_value)
    net_reward = g_reward - f_en - f_tp - fund
    net_loss = g_loss + f_en + f_sl + fund + slip
    return TradeEconomics(en, ex_tp, ex_sl, f_en, f_tp, f_sl, fund, slip, g_reward, g_loss,
                          net_reward, net_loss,
                          net_reward / net_loss if net_loss > 0 else 0.0,
                          g_reward / g_loss if g_loss > 0 else 0.0,
                          fees.source, not fees.exact)
