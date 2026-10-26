"""Mandatory risk controls. State is persisted in SQLite so restarts never reset counters."""
from __future__ import annotations

import datetime as dt
import os
import time
from dataclasses import dataclass
from typing import Optional, Tuple
from zoneinfo import ZoneInfo

from database import Database


@dataclass
class RiskDecision:
    allowed: bool
    reason: str = ""


class RiskManager:
    def __init__(self, cfg, db: Database, clock=time.time):
        self.cfg, self.db, self._clock = cfg, db, clock
        self.tz = ZoneInfo(cfg.daily_reset_tz)

    # ---- helpers
    def day_start(self, now: Optional[float] = None) -> float:
        now = now or self._clock()
        local = dt.datetime.fromtimestamp(now, self.tz)
        return local.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()

    def today_closed(self, now: Optional[float] = None):
        return self.db.closed_trades(self.day_start(now), self.cfg.environment)

    def daily_net_pnl(self, now: Optional[float] = None) -> float:
        return sum(t["net_pnl"] or 0.0 for t in self.today_closed(now))

    def consecutive_losses(self) -> int:
        n = 0
        # counted per trading day so the pause lifts at the daily reset (never lifts by restart)
        for t in reversed(self.today_closed()):
            if (t["net_pnl"] or 0) < 0:
                n += 1
            else:
                break
        return n

    # ---- halts
    def halt_reason(self) -> Optional[str]:
        return self.db.kv_get(f"halt:{self.cfg.environment}")

    def halt(self, reason: str) -> None:
        self.db.kv_set(f"halt:{self.cfg.environment}", reason)
        self.db.log_incident("CRITICAL", f"entries disabled: {reason}")

    def clear_halt(self) -> None:
        self.db.kv_set(f"halt:{self.cfg.environment}", None)

    def emergency_stop_requested(self) -> bool:
        return os.path.exists(self.cfg.emergency_file)

    # ---- gate
    def can_open(self, open_positions: int, planned_net_loss: float = 0.0,
                 now: Optional[float] = None) -> RiskDecision:
        now = now or self._clock()
        c = self.cfg
        if self.emergency_stop_requested():
            return RiskDecision(False, "emergency stop active")
        h = self.halt_reason()
        if h:
            return RiskDecision(False, f"entries disabled: {h}")
        if not c.orders_enabled:
            return RiskDecision(False, "ALLOW_ORDER_PLACEMENT=false (signal-only mode)")
        if open_positions >= c.max_open_positions:
            return RiskDecision(False, f"open position limit reached ({open_positions}/{c.max_open_positions})")
        today = self.today_closed(now)
        pnl = sum(t["net_pnl"] or 0.0 for t in today)
        if -pnl >= c.max_daily_loss_usd:
            return RiskDecision(False, f"daily loss limit reached (net {pnl:.4f} USD)")
        if -(pnl - planned_net_loss) > c.max_daily_loss_usd + 1e-12:
            return RiskDecision(False, "planned worst-case loss would breach the daily loss limit")
        if len(today) + len(self.db.active_trades(c.environment)) >= c.max_trades_per_day:
            return RiskDecision(False, f"daily trade limit reached ({c.max_trades_per_day})")
        if self.consecutive_losses() >= c.max_consecutive_losses:
            return RiskDecision(False, f"{c.max_consecutive_losses} consecutive losses: entries paused")
        closed = self.db.closed_trades(0, c.environment)
        if closed and c.cooldown_minutes > 0:
            since = (now - (closed[-1]["exit_time"] or 0)) / 60.0
            if since < c.cooldown_minutes:
                return RiskDecision(False, f"cooldown: {c.cooldown_minutes - since:.0f} min remaining")
        return RiskDecision(True)
