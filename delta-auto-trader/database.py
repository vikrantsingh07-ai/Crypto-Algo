"""SQLite persistence: trades, order log, key/value state (risk counters), incidents.

No credentials are ever written here.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import uuid
from typing import Any, Dict, List, Optional

SCHEMA = """
CREATE TABLE IF NOT EXISTS trades (
  trade_id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  symbol TEXT NOT NULL,
  product_id INTEGER,
  side TEXT NOT NULL,
  status TEXT NOT NULL,             -- PENDING_ENTRY, OPEN, PROTECTED, CLOSED, ABORTED, NEEDS_RECONCILIATION
  quantity INTEGER,                 -- contracts
  leverage REAL,
  entry_time REAL, exit_time REAL,
  entry_price REAL, exit_price REAL,
  stop_price REAL, take_profit_price REAL,
  entry_order_id TEXT, stop_order_id TEXT, tp_order_id TEXT, exit_order_id TEXT,
  entry_client_id TEXT, stop_client_id TEXT, tp_client_id TEXT, exit_client_id TEXT,
  gross_pnl REAL, fees REAL, funding REAL, net_pnl REAL,
  fee_source TEXT,
  estimated_fees REAL, estimated_net_reward REAL, estimated_net_loss REAL,
  signal TEXT, exit_reason TEXT, error TEXT, plan_json TEXT,
  created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE TABLE IF NOT EXISTS orders (
  client_order_id TEXT PRIMARY KEY,
  trade_id TEXT, exchange_order_id TEXT, purpose TEXT, symbol TEXT, side TEXT,
  size INTEGER, order_type TEXT, price REAL, state TEXT, created_at REAL, raw TEXT
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, severity TEXT, message TEXT, trade_id TEXT
);
"""

TRADE_COLUMNS = None


class Database:
    def __init__(self, path: str):
        if path != ":memory:":
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self.path = path
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def close(self):
        with self._lock:
            self.conn.close()

    # ---- trades ----
    def new_trade_id(self) -> str:
        return uuid.uuid4().hex[:20]

    def create_trade(self, **fields) -> str:
        fields.setdefault("trade_id", self.new_trade_id())
        fields.setdefault("created_at", time.time())
        cols = ",".join(fields)
        ph = ",".join("?" for _ in fields)
        with self._lock:
            # primary key makes a duplicate trade record impossible
            self.conn.execute(f"INSERT INTO trades ({cols}) VALUES ({ph})", list(fields.values()))
            self.conn.commit()
        return fields["trade_id"]

    def update_trade(self, trade_id: str, **fields) -> None:
        if not fields:
            return
        sets = ",".join(f"{k}=?" for k in fields)
        with self._lock:
            self.conn.execute(f"UPDATE trades SET {sets} WHERE trade_id=?", list(fields.values()) + [trade_id])
            self.conn.commit()

    def get_trade(self, trade_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            r = self.conn.execute("SELECT * FROM trades WHERE trade_id=?", (trade_id,)).fetchone()
        return dict(r) if r else None

    def active_trades(self, environment: Optional[str] = None) -> List[Dict[str, Any]]:
        q = "SELECT * FROM trades WHERE status IN ('PENDING_ENTRY','OPEN','PROTECTED','NEEDS_RECONCILIATION')"
        args: list = []
        if environment:
            q += " AND environment=?"
            args.append(environment)
        with self._lock:
            return [dict(r) for r in self.conn.execute(q + " ORDER BY created_at", args)]

    def closed_trades(self, since: float = 0.0, environment: Optional[str] = None) -> List[Dict[str, Any]]:
        q = "SELECT * FROM trades WHERE status='CLOSED' AND exit_time>=?"
        args: list = [since]
        if environment:
            q += " AND environment=?"
            args.append(environment)
        with self._lock:
            return [dict(r) for r in self.conn.execute(q + " ORDER BY exit_time", args)]

    def all_trades(self, limit: int = 50) -> List[Dict[str, Any]]:
        with self._lock:
            return [dict(r) for r in self.conn.execute(
                "SELECT * FROM trades ORDER BY created_at DESC LIMIT ?", (limit,))]

    # ---- orders ----
    def log_order(self, client_order_id: str, **fields) -> None:
        with self._lock:
            row = self.conn.execute("SELECT 1 FROM orders WHERE client_order_id=?", (client_order_id,)).fetchone()
            if row:
                if fields:
                    sets = ",".join(f"{k}=?" for k in fields)
                    self.conn.execute(f"UPDATE orders SET {sets} WHERE client_order_id=?",
                                      list(fields.values()) + [client_order_id])
            else:
                fields.setdefault("created_at", time.time())
                cols = ",".join(["client_order_id"] + list(fields))
                ph = ",".join("?" for _ in range(len(fields) + 1))
                self.conn.execute(f"INSERT INTO orders ({cols}) VALUES ({ph})", [client_order_id] + list(fields.values()))
            self.conn.commit()

    def trade_order_refs(self, trade_id: str):
        with self._lock:
            rows = self.conn.execute("SELECT client_order_id, exchange_order_id FROM orders WHERE trade_id=?",
                                     (trade_id,)).fetchall()
        return {r["client_order_id"] for r in rows}, {str(r["exchange_order_id"]) for r in rows if r["exchange_order_id"]}

    def order_exists(self, client_order_id: str) -> bool:
        with self._lock:
            return self.conn.execute("SELECT 1 FROM orders WHERE client_order_id=?", (client_order_id,)).fetchone() is not None

    # ---- kv ----
    def kv_get(self, key: str, default: Any = None) -> Any:
        with self._lock:
            r = self.conn.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
        return json.loads(r["value"]) if r else default

    def kv_set(self, key: str, value: Any) -> None:
        with self._lock:
            self.conn.execute("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                              (key, json.dumps(value)))
            self.conn.commit()

    # ---- incidents ----
    def log_incident(self, severity: str, message: str, trade_id: Optional[str] = None) -> None:
        with self._lock:
            self.conn.execute("INSERT INTO incidents(ts,severity,message,trade_id) VALUES(?,?,?,?)",
                              (time.time(), severity, message, trade_id))
            self.conn.commit()

    def incidents(self, limit: int = 20) -> List[Dict[str, Any]]:
        with self._lock:
            return [dict(r) for r in self.conn.execute("SELECT * FROM incidents ORDER BY id DESC LIMIT ?", (limit,))]
