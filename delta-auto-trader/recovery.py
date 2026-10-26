"""Startup (and on-demand) reconciliation between the database and the exchange.

Rules:
  * PENDING_ENTRY trades are resolved by looking the entry order up by client_order_id.
  * OPEN trades (filled, protection unknown) get protection installed/verified.
  * PROTECTED trades are left to the position manager (which detects a closed position).
  * Any exchange position/open order not explained by an active DB trade disables new entries.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List

from exchange_client import ExchangeError
from logger import get_logger, say
from order_manager import EntryAborted

log = get_logger("recovery")


@dataclass
class RecoveryReport:
    resumed: List[str] = field(default_factory=list)
    aborted: List[str] = field(default_factory=list)
    problems: List[str] = field(default_factory=list)

    @property
    def clean(self) -> bool:
        return not self.problems


def reconcile(client, db, cfg, orders, risk, instruments_by_pid: Dict[int, object]) -> RecoveryReport:
    rep = RecoveryReport()
    active = db.active_trades(cfg.environment)
    known_pids = set()
    for t in active:
        inst = instruments_by_pid.get(t["product_id"])
        known_pids.add(t["product_id"])
        if inst is None:
            rep.problems.append(f"trade {t['trade_id']}: instrument {t['symbol']} not discoverable")
            continue
        try:
            if t["status"] == "PENDING_ENTRY":
                o = client.get_order_by_client_id(t["entry_client_id"])
                pos = client.get_position(t["product_id"])
                has_pos = abs(float(pos.get("size") or 0)) > 0
                if o is not None and int(o["size"]) - int(o.get("unfilled_size") or 0) > 0:
                    say("RECOVERY", f"Entry for {t['symbol']} was filled; completing protection")
                    orders.complete_entry(t["trade_id"], inst, o)
                    rep.resumed.append(t["trade_id"])
                elif has_pos:
                    db.update_trade(t["trade_id"], status="NEEDS_RECONCILIATION",
                                    error="position exists but entry order unknown")
                    rep.problems.append(f"{t['symbol']}: position without matching entry order")
                else:
                    db.update_trade(t["trade_id"], status="ABORTED", error="entry never filled (found at restart)")
                    rep.aborted.append(t["trade_id"])
            elif t["status"] == "OPEN":
                pos = client.get_position(t["product_id"])
                if abs(float(pos.get("size") or 0)) > 0:
                    orders.ensure_protection(t["trade_id"], inst)
                    rep.resumed.append(t["trade_id"])
                else:
                    rep.resumed.append(t["trade_id"])   # position manager will finalize
            elif t["status"] == "PROTECTED":
                rep.resumed.append(t["trade_id"])
            else:   # NEEDS_RECONCILIATION
                rep.problems.append(f"trade {t['trade_id']} still needs manual reconciliation")
        except EntryAborted as e:
            rep.problems.append(f"{t['symbol']}: {e}")
        except ExchangeError as e:
            rep.problems.append(f"{t['symbol']}: exchange error during recovery: {e}")

    # unexpected exposure on any instrument we could trade
    active_pids = {t["product_id"] for t in db.active_trades(cfg.environment)}
    for pid, inst in instruments_by_pid.items():
        if pid in active_pids:
            continue
        try:
            pos = client.get_position(pid)
            if abs(float(pos.get("size") or 0)) > 0:
                rep.problems.append(f"unexpected open position on {inst.symbol} (size {pos.get('size')})")
            oo = client.get_open_orders(pid)
            if oo:
                rep.problems.append(f"unexpected open orders on {inst.symbol}: {[o.get('id') for o in oo]}")
        except ExchangeError as e:
            rep.problems.append(f"{inst.symbol}: could not verify exchange state ({e})")
    if rep.problems:
        risk.halt("reconciliation: " + "; ".join(rep.problems)[:400])
        say("SAFETY", "New entries disabled")
        for p in rep.problems:
            say("RECOVERY", p)
    return rep
