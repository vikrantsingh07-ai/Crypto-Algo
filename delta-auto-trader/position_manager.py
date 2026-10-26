"""Monitors the open trade: detects exits, finalizes P&L, re-verifies protection, enforces time exit."""
from __future__ import annotations

import time
from typing import Optional

from exchange_client import ExchangeError
from fee_calculator import FeeSchedule
from instrument_selector import Instrument
from logger import get_logger, say
from pnl_tracker import compute_result

log = get_logger("positions")


class PositionManager:
    def __init__(self, client, db, cfg, orders, risk, clock=time.time):
        self.client, self.db, self.cfg, self.orders, self.risk = client, db, cfg, orders, risk
        self._clock = clock

    def tick(self, trade: dict, inst: Instrument, fees: FeeSchedule, mark: Optional[float] = None,
             funding_pct: float = 0.0) -> str:
        """Returns a short state string: 'open' | 'closed' | 'error'."""
        tid = trade["trade_id"]
        try:
            pos = self.client.get_position(inst.product_id)
        except ExchangeError as e:
            log.warning("position fetch failed: %s", e)
            return "error"
        size = float(pos.get("size") or 0)
        expected_sign = 1 if (trade["side"] == "LONG" or inst.is_option) else -1

        if trade["status"] == "PENDING_ENTRY":
            return "open"       # recovery owns this state
        if size == 0:
            return "closed" if self.finalize(trade, inst, fees, funding_pct) else "error"
        if (size > 0) != (expected_sign > 0):
            self.db.update_trade(tid, status="NEEDS_RECONCILIATION", error="position direction differs from record")
            self.risk.halt(f"unexpected position direction on {inst.symbol}")
            say("SAFETY", "New entries disabled")
            return "error"
        if int(abs(size)) != int(trade["quantity"]):
            self.db.update_trade(tid, quantity=int(abs(size)))
            trade = self.db.get_trade(tid)

        # protection must still be present (also installs it if a previous attempt left it incomplete)
        try:
            if not self.orders.ensure_protection(tid, inst):
                return "closed" if self.client.get_position(inst.product_id).get("size") in (0, "0", None) else "error"
        except ExchangeError as e:
            log.warning("protection check failed: %s", e)
            return "error"

        trade = self.db.get_trade(tid)
        # software take-profit backstop when the exchange-side target is absent
        open_orders = self.client.get_open_orders(inst.product_id)
        if mark and not self.orders._find_tp(open_orders, trade):
            tp = trade["take_profit_price"]
            if (expected_sign > 0 and mark >= tp) or (expected_sign < 0 and mark <= tp):
                self.orders.close_position(tid, inst, "TAKE_PROFIT_SOFTWARE")
                return "open"
        # time exit
        if trade["entry_time"] and self._clock() - trade["entry_time"] > self.cfg.max_hold_minutes * 60:
            say("EXIT", "Maximum hold time reached; closing")
            self.orders.close_position(tid, inst, "TIME_EXIT")
        return "open"

    def finalize(self, trade: dict, inst: Instrument, fees: FeeSchedule, funding_pct: float = 0.0) -> bool:
        tid = trade["trade_id"]
        try:
            self.orders.cancel_protective(tid, inst)
            cids, oids = self.db.trade_order_refs(tid)
            fills = [f for f in self.client.get_fills(inst.product_id)
                     if str(f.get("order_id")) in oids or f.get("client_order_id") in cids]
        except ExchangeError as e:
            log.warning("could not fetch fills yet: %s", e)
            return False
        res = compute_result(trade, fills, inst.contract_value, fees, funding_pct, option=inst.is_option)
        if res is None:
            self.db.update_trade(tid, status="NEEDS_RECONCILIATION",
                                 error="position flat but fills for entry/exit not found")
            self.risk.halt("flat position without matching fills; reconcile manually")
            return False
        fill_orders = {str(f.get("order_id")) for f in fills if f["side"] != ("buy" if trade["side"] == "LONG" or inst.is_option else "sell")}
        reason = trade.get("exit_reason")
        if not reason:
            if trade.get("stop_order_id") in fill_orders:
                reason = "STOP_LOSS"
            elif trade.get("tp_order_id") in fill_orders:
                reason = "TAKE_PROFIT"
            else:
                reason = "EXTERNAL_OR_UNKNOWN"
        self.db.update_trade(tid, status="CLOSED", exit_time=res.exit_time, exit_price=res.exit_price,
                             entry_price=res.entry_price, quantity=res.qty, gross_pnl=res.gross, fees=res.fees,
                             funding=res.funding, net_pnl=res.net, exit_reason=reason,
                             fee_source="ACTUAL" if res.fees_actual else "ESTIMATED")
        say("TRADE", f"CLOSED {inst.symbol} {trade['side']} reason={reason} gross={res.gross:.4f} "
                     f"fees={res.fees:.4f} funding~{res.funding:.4f} net={res.net:.4f} "
                     f"({'actual' if res.fees_actual else 'ESTIMATED'} fees)")
        return True
