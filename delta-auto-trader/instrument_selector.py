"""Instrument discovery and deterministic, auditable selection.

Product field names follow the Delta v2 `GET /v2/products` response (contract_type, contract_value,
tick_size, initial_margin, maker/taker_commission_rate, strike_price, settlement_time, state, ...).
Anything not present is left None and the instrument is rejected where the missing field matters.
"""
from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass, field
from typing import List, Optional

from logger import get_logger

log = get_logger("instruments")


def _fl(v, default=None):
    try:
        return float(v) if v not in (None, "") else default
    except (TypeError, ValueError):
        return default


@dataclass
class Instrument:
    symbol: str
    product_id: int
    kind: str                       # PERP | CALL | PUT | OTHER
    underlying: str
    contract_value: float           # underlying units per contract
    tick_size: float
    min_size: int = 1
    size_increment: int = 1
    max_leverage: float = 1.0
    maker_fee_rate: Optional[float] = None
    taker_fee_rate: Optional[float] = None
    inverse: bool = False
    state: str = "live"
    quote_asset: str = "USD"
    settle_asset: str = ""
    strike: Optional[float] = None
    expiry: Optional[dt.datetime] = None
    position_size_limit: Optional[int] = None

    @property
    def is_option(self) -> bool:
        return self.kind in ("CALL", "PUT")


def parse_product(p: dict) -> Optional[Instrument]:
    ct = str(p.get("contract_type", "")).lower()
    kind = {"perpetual_futures": "PERP", "call_options": "CALL", "put_options": "PUT"}.get(ct, "OTHER")
    cv, tick = _fl(p.get("contract_value")), _fl(p.get("tick_size"))
    if cv is None or tick is None or cv <= 0 or tick <= 0 or not p.get("symbol") or p.get("id") is None:
        return None
    im = _fl(p.get("initial_margin"))
    max_lev = _fl(p.get("default_leverage"), 1.0)
    if im and im > 0:
        max_lev = max(1.0, 100.0 / im)  # initial_margin is a percentage of notional
    expiry = None
    st = p.get("settlement_time")
    if st:
        try:
            expiry = dt.datetime.fromisoformat(str(st).replace("Z", "+00:00"))
        except ValueError:
            expiry = None
    return Instrument(
        symbol=p["symbol"], product_id=int(p["id"]), kind=kind,
        underlying=str((p.get("underlying_asset") or {}).get("symbol", "")).upper(),
        contract_value=cv, tick_size=tick, max_leverage=max_lev,
        maker_fee_rate=_fl(p.get("maker_commission_rate")), taker_fee_rate=_fl(p.get("taker_commission_rate")),
        inverse=str(p.get("notional_type", "vanilla")).lower() == "inverse",
        state=str(p.get("state", "")).lower(),
        quote_asset=str((p.get("quoting_asset") or {}).get("symbol", "USD")),
        settle_asset=str((p.get("settling_asset") or {}).get("symbol", "")),
        strike=_fl(p.get("strike_price")), expiry=expiry,
        position_size_limit=int(p["position_size_limit"]) if p.get("position_size_limit") else None,
    )


def discover(products: List[dict]) -> List[Instrument]:
    out = []
    for p in products:
        inst = parse_product(p)
        if inst:
            out.append(inst)
    return sorted(out, key=lambda i: i.symbol)


@dataclass
class Selection:
    instrument: Optional[Instrument]
    reason: str
    audit: List[str] = field(default_factory=list)


class InstrumentSelector:
    def __init__(self, cfg, option_min_hours: float = 24.0, option_max_spread_pct: float = 10.0):
        self.cfg = cfg
        self.option_min_hours = option_min_hours
        self.option_max_spread_pct = option_max_spread_pct

    def eligible_basic(self, inst: Instrument) -> Optional[str]:
        """Return a rejection reason or None."""
        if inst.state != "live":
            return f"{inst.symbol}: state is '{inst.state}', not live"
        if inst.inverse:
            return f"{inst.symbol}: inverse contracts are not supported"
        if inst.kind == "OTHER" and not self.cfg.allow_other_contracts:
            return f"{inst.symbol}: other contract types require ALLOW_OTHER_CONTRACTS=true"
        if inst.kind == "OTHER":
            return f"{inst.symbol}: other contract types are not implemented"
        if inst.kind == "PERP" and self.cfg.market_type == "OPTIONS":
            return f"{inst.symbol}: MARKET_TYPE=OPTIONS"
        if inst.is_option and self.cfg.market_type == "PERPETUAL":
            return f"{inst.symbol}: MARKET_TYPE=PERPETUAL"
        return None

    def select(self, instruments: List[Instrument], direction: str, spot_by_underlying: dict,
               now: Optional[dt.datetime] = None, bases: Optional[List[str]] = None) -> Selection:
        """`bases` restricts the search to specific underlyings (e.g. the one that produced the signal)."""
        now = now or dt.datetime.now(dt.timezone.utc)
        by_symbol = {i.symbol: i for i in instruments}
        audit: List[str] = []
        if self.cfg.explicit_symbols:
            # Deterministic: first explicitly configured symbol that is suitable, in configured order.
            for sym in self.cfg.explicit_symbols:
                inst = by_symbol.get(sym)
                if inst is not None and bases and inst.underlying not in bases:
                    continue
                if inst is None:
                    audit.append(f"{sym}: not found on exchange")
                    continue
                r = self._reject(inst, direction, now, explicit=True)
                if r:
                    audit.append(r)
                    continue
                return Selection(inst, f"explicit symbol {sym}", audit)
            return Selection(None, "no explicitly configured symbol is available/suitable", audit)

        for base in (bases or self.cfg.watchlist):
            if self.cfg.market_type in ("PERPETUAL",):
                cands = [i for i in instruments if i.kind == "PERP" and i.symbol == f"{base}USD"]
            elif self.cfg.market_type == "OPTIONS":
                want = "CALL" if direction == "LONG" else "PUT"
                spot = spot_by_underlying.get(base)
                cands = [i for i in instruments if i.kind == want and i.underlying == base and i.strike
                         and i.expiry and spot]
                cands = [i for i in cands if (i.expiry - now).total_seconds() / 3600 >= self.option_min_hours]
                # nearest expiry, then strike closest to spot (ATM), then symbol for a total order
                cands.sort(key=lambda i: (i.expiry, abs(i.strike - spot), i.symbol))
            else:
                cands = []
            for inst in cands:
                r = self._reject(inst, direction, now)
                if r:
                    audit.append(r)
                    continue
                return Selection(inst, f"{self.cfg.market_type} rule for {base}", audit)
            audit.append(f"{base}: no suitable {self.cfg.market_type} contract")
        return Selection(None, "no suitable instrument for the configured market type/watchlist", audit)

    def _reject(self, inst: Instrument, direction: str, now, explicit: bool = False) -> Optional[str]:
        if inst.kind == "PERP" and self.cfg.market_type == "OPTIONS" and not explicit:
            return f"{inst.symbol}: not an option"
        r = self.eligible_basic(inst) if not explicit else self._basic_explicit(inst)
        if r:
            return r
        if inst.is_option:
            if inst.expiry is None or inst.strike is None:
                return f"{inst.symbol}: option missing expiry/strike"
            hrs = (inst.expiry - now).total_seconds() / 3600
            if hrs < self.option_min_hours:
                return f"{inst.symbol}: expires in {hrs:.1f}h (< {self.option_min_hours}h)"
            if direction == "LONG" and inst.kind == "PUT" or direction == "SHORT" and inst.kind == "CALL":
                # long premium only: bullish -> call, bearish -> put
                return f"{inst.symbol}: {inst.kind} does not match direction {direction}"
        return None

    def _basic_explicit(self, inst: Instrument) -> Optional[str]:
        if inst.state != "live":
            return f"{inst.symbol}: state is '{inst.state}', not live"
        if inst.inverse:
            return f"{inst.symbol}: inverse contracts are not supported"
        if inst.kind == "OTHER":
            return f"{inst.symbol}: contract type not supported"
        return None


def option_quote_ok(bid: Optional[float], ask: Optional[float], bid_size: float, ask_size: float,
                    max_spread_pct: float, min_size: float = 1) -> Optional[str]:
    if not bid or not ask or bid <= 0 or ask <= 0 or ask < bid:
        return "no valid two-sided quote"
    spread = (ask - bid) / ((ask + bid) / 2) * 100
    if spread > max_spread_pct:
        return f"option spread {spread:.1f}% exceeds {max_spread_pct}%"
    if bid_size < min_size or ask_size < min_size:
        return "insufficient displayed liquidity"
    return None
