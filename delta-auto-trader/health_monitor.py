"""Tracks API / market-data health and prints the concise status block."""
from __future__ import annotations

import time

from logger import say


class HealthMonitor:
    def __init__(self, cfg, clock=time.time):
        self.cfg, self._clock = cfg, clock
        self.api_ok_at = 0.0
        self.data_ok_at = 0.0
        self.consecutive_errors = 0
        self.last_error = ""

    def api_ok(self):
        self.api_ok_at = self._clock()
        self.consecutive_errors = 0

    def data_ok(self):
        self.data_ok_at = self._clock()

    def error(self, msg: str):
        self.consecutive_errors += 1
        self.last_error = msg

    def api_connected(self) -> bool:
        return self._clock() - self.api_ok_at < max(60, self.cfg.loop_interval * 4)

    def data_healthy(self) -> bool:
        return self._clock() - self.data_ok_at < self.cfg.stale_data_seconds + self.cfg.loop_interval * 2

    def too_many_errors(self, limit: int = 10) -> bool:
        return self.consecutive_errors >= limit

    def print_status(self, position: str, daily_pnl_inr: float, halt: str = ""):
        say("STATUS", f"Environment: {self.cfg.environment} (mode {self.cfg.trading_mode})")
        say("STATUS", f"Exchange connection: {'CONNECTED' if self.api_connected() else 'DISCONNECTED'}")
        say("STATUS", f"Market data: {'HEALTHY' if self.data_healthy() else 'STALE'}")
        say("STATUS", f"Strategy: {'READY' if not halt else 'ENTRIES DISABLED'}")
        say("STATUS", f"Position: {position}")
        say("STATUS", f"Daily net P&L: {daily_pnl_inr:.2f} INR")
        say("STATUS", "Risk limits: " + ("ACTIVE" if not halt else f"HALTED ({halt})"))
