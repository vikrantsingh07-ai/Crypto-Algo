"""Order lifecycle: entry, protective orders, verification, safe close.

Key safety properties
  * The trade row (with deterministic client_order_ids) is persisted BEFORE any order is sent.
  * An order write is never blindly retried. On timeout / 5xx the exchange is queried by
    client_order_id to learn whether the order exists (`_resolve_ambiguous`).
  * Protective orders are exchange-native (reduce-only stop-market + reduce-only limit target) and are
    verified against the open-orders list. If the stop cannot be confirmed the position is flattened
    and new entries are disabled.
"""
from __future__ import annotations

import time
from typing import Optional

from database import Database
from exchange_client import (AmbiguousOrderError, AuthError, ExchangeError, ExchangeReject,
                             RateLimitError, TransientError)
from instrument_selector import Instrument
from logger import get_logger, say
from position_sizer import SizingResult

log = get_logger("orders")


class EntryAborted(Exception):
    pass


def fmt(px: float, tick: float) -> str:
    frac = f"{tick:.10f}".rstrip("0").split(".")[1] if tick < 1 else ""
    return f"{px:.{len(frac)}f}"


class OrderManager:
    def __init__(self, client, db: Database, cfg, risk, clock=time.time, sleep=time.sleep,
                 resolve_attempts: int = 4, resolve_delay: float = 1.0):
        self.client, self.db, self.cfg, self.risk = client, db, cfg, risk
        self._clock, self._sleep = clock, sleep
        self.resolve_attempts, self.resolve_delay = resolve_attempts, resolve_delay

    # ------------------------------------------------------------ id helpers
    @staticmethod
    def cid(trade_id: str, role: str) -> str:
        return f"{trade_id}{role}"[:32]

    # ------------------------------------------------------------ submission
    def _submit(self, trade_id: str, role: str, inst: Instrument, payload: dict, purpose: str) -> Optional[dict]:
        """Send one order exactly once. Returns the exchange order dict, or None if (after querying)
        the order demonstrably does not exist. Raises on rejection / unresolvable ambiguity."""
        cid = payload["client_order_id"]
        if self.db.order_exists(cid):
            raise EntryAborted(f"duplicate order prevented: client_order_id {cid} already used")
        self.db.log_order(cid, trade_id=trade_id, purpose=purpose, symbol=inst.symbol, side=payload["side"],
                          size=payload["size"], order_type=payload["order_type"],
                          price=float(payload.get("limit_price") or payload.get("stop_price") or 0), state="SENDING")
        try:
            order = self.client.place_order(payload)
        except AmbiguousOrderError as e:
            say("ERROR", "API timeout")
            say("RECOVERY", "Reconciling order status")
            order = self._resolve_ambiguous(trade_id, cid)
            if order is None:
                self.db.log_order(cid, state="NOT_FOUND")
                return None
        except RateLimitError:
            # a 429 means the request was refused before processing
            self.db.log_order(cid, state="REJECTED_429")
            raise
        except ExchangeReject as e:
            self.db.log_order(cid, state="REJECTED")
            raise
        self.db.log_order(cid, exchange_order_id=str(order.get("id")), state=str(order.get("state")))
        return order

    def _resolve_ambiguous(self, trade_id: str, cid: str) -> Optional[dict]:
        for i in range(self.resolve_attempts):
            try:
                o = self.client.get_order_by_client_id(cid)
                if o is not None:
                    return o
                if i + 1 < self.resolve_attempts:
                    self._sleep(self.resolve_delay)   # allow for matching-engine lag
                    continue
                return None
            except (TransientError, RateLimitError, ExchangeError) as e:
                log.warning("order lookup failed (%s), attempt %d", e, i + 1)
                self._sleep(self.resolve_delay * (i + 1))
        self.db.update_trade(trade_id, status="NEEDS_RECONCILIATION",
                             error="ambiguous order response and exchange lookup failed")
        self.risk.halt("ambiguous order state; manual reconciliation required")
        say("SAFETY", "New entries disabled")
        raise EntryAborted("ambiguous order state could not be resolved")

    # ------------------------------------------------------------ entry
    def open_position(self, inst: Instrument, plan: SizingResult, signal_text: str, quote, econ_fee_source: str,
                      est_fees: float) -> Optional[str]:
        # --- duplicate / stacking guards (DB and exchange)
        if self.db.active_trades(self.cfg.environment):
            raise EntryAborted("an active trade already exists")
        pos = self.client.get_position(inst.product_id)
        if abs(float(pos.get("size") or 0)) > 0:
            raise EntryAborted(f"exchange already holds a position in {inst.symbol}")
        if self.client.get_open_orders(inst.product_id):
            raise EntryAborted(f"open orders already exist on {inst.symbol}")

        tid = self.db.new_trade_id()
        side_word = "buy" if (plan.side == "LONG" or inst.is_option) else "sell"
        self.db.create_trade(
            trade_id=tid, environment=self.cfg.environment, symbol=inst.symbol, product_id=inst.product_id,
            side=plan.side, status="PENDING_ENTRY", quantity=plan.qty, leverage=plan.leverage,
            stop_price=plan.stop, take_profit_price=plan.take_profit, signal=signal_text,
            entry_client_id=self.cid(tid, "e"), stop_client_id=self.cid(tid, "s"),
            tp_client_id=self.cid(tid, "t"), exit_client_id=self.cid(tid, "x"),
            fee_source=econ_fee_source, estimated_fees=est_fees,
            estimated_net_reward=plan.econ.net_reward, estimated_net_loss=plan.econ.net_loss)

        try:
            self.client.set_leverage(inst.product_id, plan.leverage)
        except (ExchangeError, AuthError) as e:
            self.db.update_trade(tid, status="ABORTED", error=f"set_leverage failed: {e}")
            raise EntryAborted(f"could not set leverage: {e}")

        payload = {"product_id": inst.product_id, "size": plan.qty, "side": side_word,
                   "order_type": "limit_order", "limit_price": fmt(plan.entry, inst.tick_size),
                   "time_in_force": "ioc", "reduce_only": False, "client_order_id": self.cid(tid, "e")}
        say("ORDER", "Submitted")
        try:
            order = self._submit(tid, "e", inst, payload, "ENTRY")
        except (ExchangeReject, RateLimitError) as e:
            detail = f"{e} [{getattr(e, 'code', '')}]"
            self.db.update_trade(tid, status="ABORTED", error=detail)
            raise EntryAborted(f"entry rejected: {detail}")
        except AuthError as e:
            self.db.update_trade(tid, status="ABORTED", error=str(e))
            self.risk.halt(f"authentication failure: {e}")
            raise EntryAborted(str(e))
        if order is None:
            # order did not reach the exchange; verify there is no position before declaring it dead
            pos = self.client.get_position(inst.product_id)
            if abs(float(pos.get("size") or 0)) > 0:
                self.db.update_trade(tid, status="NEEDS_RECONCILIATION", error="position without order record")
                self.risk.halt("position exists but entry order not found")
                raise EntryAborted("position exists although the entry order was not found")
            self.db.update_trade(tid, status="ABORTED", error="entry order not found on exchange after timeout")
            raise EntryAborted("entry order not found after timeout (not placed)")
        return self.complete_entry(tid, inst, order)

    def complete_entry(self, tid: str, inst: Instrument, order: dict) -> Optional[str]:
        """Given the entry order (fresh, or discovered during recovery) finish the entry: determine the
        filled quantity, then install and verify protection."""
        order = self._settle_entry(order, inst)
        filled = int(order["size"]) - int(order.get("unfilled_size") or 0)
        if filled <= 0:
            self.db.update_trade(tid, status="ABORTED", error="entry not filled (IOC expired)")
            raise EntryAborted("entry order did not fill")
        trade = self.db.get_trade(tid)
        avg = float(order.get("average_fill_price") or trade["stop_price"])
        self.db.update_trade(tid, status="OPEN", quantity=filled, entry_price=avg, entry_time=self._clock(),
                             entry_order_id=str(order.get("id")))
        if filled < int(order["size"]):
            say("ORDER", f"Partial fill {filled}/{order['size']}; protecting filled quantity")
        say("ORDER", "Exchange acceptance confirmed")
        self.ensure_protection(tid, inst)
        return tid

    def _settle_entry(self, order: dict, inst: Instrument) -> dict:
        if order.get("state") == "open" and int(order.get("unfilled_size") or 0) > 0:
            try:
                self.client.cancel_order(order["id"], inst.product_id)
            except ExchangeError:
                pass
            order = self.client.get_order(order["id"])
        return order

    # ------------------------------------------------------------ protection
    def ensure_protection(self, tid: str, inst: Instrument) -> bool:
        """Place (if absent) and verify stop-loss + take-profit. Returns True when the stop is confirmed.
        On failure to confirm the stop: flatten, halt entries, log CRITICAL."""
        trade = self.db.get_trade(tid)
        qty = int(trade["quantity"])
        exit_side = "sell" if (trade["side"] == "LONG" or inst.is_option) else "buy"
        open_orders = self.client.get_open_orders(inst.product_id)
        have_stop = self._find_stop(open_orders, trade)
        have_tp = self._find_tp(open_orders, trade)

        if not have_stop:
            have_stop = self._place_protective(tid, inst, "s", qty, exit_side, stop=True)
        if not have_tp:
            have_tp = self._place_protective(tid, inst, "t", qty, exit_side, stop=False)

        open_orders = self.client.get_open_orders(inst.product_id)
        stop_ok = self._find_stop(open_orders, trade_now := self.db.get_trade(tid)) is not None
        tp_ok = self._find_tp(open_orders, trade_now) is not None
        if stop_ok:
            say("PROTECTION", "Stop-loss verified")
            if tp_ok:
                say("PROTECTION", "Take-profit verified")
            else:
                say("PROTECTION", "Take-profit NOT active on exchange; software monitor will enforce it")
                self.db.log_incident("WARNING", "take-profit order not active; software TP in force", tid)
            self.db.update_trade(tid, status="PROTECTED")
            return True
        say("ERROR", "Stop-loss could not be confirmed")
        self.db.log_incident("CRITICAL", "stop-loss could not be confirmed; flattening", tid)
        self.close_position(tid, inst, "PROTECTION_FAILURE")
        self.risk.halt("protective stop could not be established")
        say("SAFETY", "New entries disabled")
        return False

    def _place_protective(self, tid: str, inst: Instrument, role: str, qty: int, exit_side: str, stop: bool,
                          attempts: int = 3) -> Optional[dict]:
        trade = self.db.get_trade(tid)
        for n in range(attempts):
            cid = self.cid(tid, role) if n == 0 else self.cid(tid, f"{role}{n}")
            if stop:
                payload = {"product_id": inst.product_id, "size": qty, "side": exit_side,
                           "order_type": "market_order", "stop_order_type": "stop_loss_order",
                           "stop_price": fmt(trade["stop_price"], inst.tick_size),
                           "stop_trigger_method": "mark_price", "reduce_only": True, "client_order_id": cid}
            else:
                payload = {"product_id": inst.product_id, "size": qty, "side": exit_side,
                           "order_type": "limit_order", "limit_price": fmt(trade["take_profit_price"], inst.tick_size),
                           "time_in_force": "gtc", "reduce_only": True, "client_order_id": cid}
            try:
                o = self._submit(tid, role, inst, payload, "STOP" if stop else "TAKE_PROFIT")
            except (ExchangeReject, RateLimitError, EntryAborted) as e:
                log.warning("protective order %s attempt %d failed: %s", role, n + 1, e)
                self._sleep(0.5 * (n + 1))
                continue
            except AuthError:
                return None
            if o is not None and o.get("state") in ("open", "pending"):
                col = ("stop_order_id", "stop_client_id") if stop else ("tp_order_id", "tp_client_id")
                self.db.update_trade(tid, **{col[0]: str(o["id"]), col[1]: cid})
                return o
            if o is not None and o.get("state") == "closed":   # triggered/filled immediately
                self.db.update_trade(tid, **{("stop_order_id" if stop else "tp_order_id"): str(o["id"])})
                return o
        return None

    @staticmethod
    def _find_stop(orders, trade) -> Optional[dict]:
        for o in orders:
            if o.get("stop_order_type") == "stop_loss_order" and (
                    str(o.get("id")) == str(trade.get("stop_order_id"))
                    or o.get("client_order_id") == trade.get("stop_client_id")):
                return o
        return None

    @staticmethod
    def _find_tp(orders, trade) -> Optional[dict]:
        for o in orders:
            if not o.get("stop_order_type") and o.get("order_type") == "limit_order" and o.get("reduce_only") and (
                    str(o.get("id")) == str(trade.get("tp_order_id"))
                    or o.get("client_order_id") == trade.get("tp_client_id")):
                return o
        return None

    # ------------------------------------------------------------ closing
    def close_position(self, tid: str, inst: Instrument, reason: str) -> bool:
        """Reduce-only market close of whatever the exchange holds, then cancel leftover orders."""
        trade = self.db.get_trade(tid)
        pos = self.client.get_position(inst.product_id)
        size = float(pos.get("size") or 0)
        self.db.update_trade(tid, exit_reason=trade.get("exit_reason") or reason)
        if size != 0:
            side = "sell" if size > 0 else "buy"
            for attempt in range(3):
                cid = self.cid(tid, "x" if attempt == 0 else f"x{attempt}")
                payload = {"product_id": inst.product_id, "size": int(abs(size)), "side": side,
                           "order_type": "market_order", "reduce_only": True, "client_order_id": cid}
                try:
                    o = self._submit(tid, "x", inst, payload, "EXIT")
                    if o is not None:
                        self.db.update_trade(tid, exit_order_id=str(o.get("id")), exit_client_id=cid)
                        break
                except (ExchangeReject, EntryAborted, RateLimitError) as e:
                    log.warning("close attempt %d failed: %s", attempt + 1, e)
                    if attempt == 0:   # a resting stop may block the close on some venues: cancel and retry
                        self.cancel_protective(tid, inst)
                    self._sleep(0.5)
            else:
                self.db.log_incident("CRITICAL", "could not close position", tid)
                self.risk.halt("position could not be closed automatically")
                return False
        self.cancel_protective(tid, inst)
        return True

    def cancel_protective(self, tid: str, inst: Instrument) -> None:
        try:
            for o in self.client.get_open_orders(inst.product_id):
                try:
                    self.client.cancel_order(o["id"], inst.product_id)
                except ExchangeError as e:
                    log.warning("cancel %s failed: %s", o.get("id"), e)
        except ExchangeError as e:
            log.warning("could not list open orders to cancel: %s", e)
