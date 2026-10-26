"""In-memory simulated exchange with the same trading interface as DeltaClient.

Used for TRADING_MODE=PAPER and for tests. Market data comes from a delegate (real public endpoints
or a test stub); fills, positions, stop/limit triggering and fees are simulated locally. Nothing here
can reach a real order book.
"""
from __future__ import annotations

import itertools
import time
from typing import Any, Dict, List, Optional

from exchange_client import ExchangeReject


class PaperExchange:
    def __init__(self, market, fees, balance_usd: float = 1000.0, clock=time.time):
        self.market, self.fees, self.clock = market, fees, clock
        self.balance = balance_usd
        self.orders: Dict[int, dict] = {}
        self.by_client: Dict[str, int] = {}
        self.fills: List[dict] = []
        self.positions: Dict[int, dict] = {}
        self.contract_values: Dict[int, float] = {}
        self.quotes: Dict[int, tuple] = {}     # product_id -> (bid, ask, mark)
        self._ids = itertools.count(1000)
        self.faults: Dict[str, List[Exception]] = {}
        self.fill_cap: Optional[int] = None     # test hook: force partial fills
        self.placed_payloads: List[dict] = []

    # --- market data delegation
    def __getattr__(self, name):
        if name in ("get_products", "get_product", "get_ticker", "get_orderbook", "get_candles"):
            return getattr(self.market, name)
        raise AttributeError(name)

    def _maybe_fault(self, name):
        if self.faults.get(name):
            raise self.faults[name].pop(0)

    def register_product(self, product_id: int, contract_value: float):
        self.contract_values[product_id] = contract_value

    def set_quote(self, product_id: int, bid: float, ask: float, mark: Optional[float] = None):
        self.quotes[product_id] = (bid, ask, mark or (bid + ask) / 2)
        self._process_resting(product_id)

    # --- account
    def get_balances(self):
        self._maybe_fault("get_balances")
        return [{"asset_symbol": "USD", "available_balance": str(self.balance), "balance": str(self.balance)}]

    def get_position(self, product_id: int) -> dict:
        self._maybe_fault("get_position")
        p = self.positions.get(product_id)
        return dict(p) if p else {"size": 0, "entry_price": None, "product_id": product_id}

    def get_open_orders(self, product_id: Optional[int] = None) -> List[dict]:
        self._maybe_fault("get_open_orders")
        return [dict(o) for o in self.orders.values()
                if o["state"] == "open" and (product_id is None or o["product_id"] == product_id)]

    def get_order(self, order_id) -> dict:
        self._maybe_fault("get_order")
        if int(order_id) not in self.orders:
            raise ExchangeReject("not found", "order_not_found")
        return dict(self.orders[int(order_id)])

    def get_order_by_client_id(self, client_order_id: str) -> Optional[dict]:
        self._maybe_fault("get_order_by_client_id")
        oid = self.by_client.get(client_order_id)
        return dict(self.orders[oid]) if oid else None

    def get_fills(self, product_id: Optional[int] = None, start_time_us: Optional[int] = None) -> List[dict]:
        self._maybe_fault("get_fills")
        return [dict(f) for f in self.fills if product_id is None or f["product_id"] == product_id]

    def set_leverage(self, product_id: int, leverage: float) -> dict:
        return {"leverage": str(leverage)}

    # --- trading
    def place_order(self, payload: dict) -> dict:
        self.placed_payloads.append(dict(payload))
        fault = self.faults.get("place_order")
        if fault:
            exc = fault.pop(0)
            # an "ambiguous" fault means the order DID reach the exchange but the response was lost
            if getattr(exc, "_executed", False):
                self._do_place(payload)
            raise exc
        return self._do_place(payload)

    def _do_place(self, p: dict) -> dict:
        cid = p.get("client_order_id")
        if cid and cid in self.by_client:
            raise ExchangeReject("duplicate client_order_id", "duplicate_client_order_id")
        pid = int(p["product_id"])
        if pid not in self.quotes:
            raise ExchangeReject("no market", "no_market")
        size = int(p["size"])
        if size <= 0:
            raise ExchangeReject("bad size", "invalid_size")
        oid = next(self._ids)
        reduce_only = str(p.get("reduce_only", False)).lower() == "true" or p.get("reduce_only") is True
        order = {"id": oid, "client_order_id": cid, "product_id": pid, "side": p["side"], "size": size,
                 "unfilled_size": size, "order_type": p["order_type"], "limit_price": p.get("limit_price"),
                 "stop_price": p.get("stop_price"), "stop_order_type": p.get("stop_order_type"),
                 "time_in_force": p.get("time_in_force", "gtc"), "reduce_only": reduce_only,
                 "state": "open", "average_fill_price": None, "paid_commission": "0",
                 "created_at": self.clock()}
        pos = self.positions.get(pid, {}).get("size", 0)
        if reduce_only:
            closing = (p["side"] == "sell" and pos > 0) or (p["side"] == "buy" and pos < 0)
            if not closing:
                raise ExchangeReject("reduce-only order would increase position", "reduce_only_rejected")
        self.orders[oid] = order
        if cid:
            self.by_client[cid] = oid
        if order["stop_order_type"]:
            return dict(order)          # rests until triggered
        self._try_fill(order)
        if order["state"] == "open" and order["time_in_force"] == "ioc":
            order["state"] = "closed" if order["unfilled_size"] < order["size"] else "cancelled"
        return dict(order)

    def cancel_order(self, order_id: int, product_id: int) -> dict:
        self._maybe_fault("cancel_order")
        o = self.orders.get(int(order_id))
        if not o or o["state"] != "open":
            raise ExchangeReject("order not open", "order_not_open")
        o["state"] = "cancelled"
        return dict(o)

    # --- matching
    def _try_fill(self, o: dict, resting: bool = False):
        bid, ask, _ = self.quotes[o["product_id"]]
        buy = o["side"] == "buy"
        px, role = (ask if buy else bid), "taker"
        if o["order_type"] == "limit_order":
            lp = float(o["limit_price"])
            if (buy and lp < ask) or (not buy and lp > bid):
                return          # not marketable: keeps resting
            if resting:
                px, role = lp, "maker"   # a resting order fills at its own price
        qty = o["unfilled_size"]
        if self.fill_cap is not None:
            qty = min(qty, self.fill_cap)
        if o["reduce_only"]:
            qty = min(qty, abs(self.positions.get(o["product_id"], {}).get("size", 0)))
        if qty > 0:
            self._fill(o, qty, px, role)

    def _fill(self, o: dict, qty: int, price: float, role: str):
        pid, cv = o["product_id"], self.contract_values.get(o["product_id"], 1.0)
        signed = qty if o["side"] == "buy" else -qty
        pos = self.positions.setdefault(pid, {"size": 0, "entry_price": None, "product_id": pid})
        old = pos["size"]
        new = old + signed
        if old == 0 or (old > 0) == (signed > 0):
            tot = abs(old) + qty
            pos["entry_price"] = ((pos["entry_price"] or 0) * abs(old) + price * qty) / tot
        elif new == 0:
            pos["entry_price"] = None
        elif (new > 0) != (old > 0):
            pos["entry_price"] = price
        pos["size"] = new
        fee = self.fees.fee(price * qty * cv, role)
        prev = o["size"] - o["unfilled_size"]
        o["average_fill_price"] = ((float(o["average_fill_price"] or 0) * prev) + price * qty) / (prev + qty)
        o["unfilled_size"] -= qty
        o["paid_commission"] = str(float(o["paid_commission"]) + fee)
        if o["unfilled_size"] == 0:
            o["state"] = "closed"
        self.fills.append({"id": f"f{len(self.fills) + 1}", "order_id": o["id"], "client_order_id": o["client_order_id"],
                           "product_id": pid, "side": o["side"], "size": qty, "price": str(price),
                           "commission": str(fee), "role": role, "created_at": self.clock()})
        if new == 0:
            for other in self.orders.values():
                if other["product_id"] == pid and other["state"] == "open" and other["reduce_only"]:
                    other["state"] = "cancelled"

    def _process_resting(self, pid: int):
        bid, ask, mark = self.quotes[pid]
        for o in list(self.orders.values()):
            if o["product_id"] != pid or o["state"] != "open":
                continue
            if o.get("stop_order_type"):
                sp = float(o["stop_price"])
                trig = (o["side"] == "sell" and mark <= sp) or (o["side"] == "buy" and mark >= sp)
                if trig:
                    o["stop_order_type"] = None
                    o["order_type"] = "market_order"
                    self._try_fill(o)
            elif o["order_type"] == "limit_order":
                self._try_fill(o, resting=True)
