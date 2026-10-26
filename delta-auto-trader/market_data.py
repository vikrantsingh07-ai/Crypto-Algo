"""Market data: completed candles, quotes, staleness checks, and a reconnecting WebSocket feed."""
from __future__ import annotations

import json
import random
import threading
import time
from typing import Callable, List, Optional

from config import timeframe_seconds
from logger import get_logger
from strategy import Candle, validate_candles

log = get_logger("market")


class MarketDataError(Exception):
    pass


class Quote:
    def __init__(self, bid, ask, mark, ts, funding_pct=0.0, bid_size=0.0, ask_size=0.0):
        self.bid, self.ask, self.mark, self.ts = bid, ask, mark, ts
        self.funding_pct, self.bid_size, self.ask_size = funding_pct, bid_size, ask_size

    @property
    def spread_pct(self) -> float:
        return (self.ask - self.bid) / ((self.ask + self.bid) / 2) * 100


class MarketData:
    def __init__(self, client, cfg, clock=time.time, ws_feed: Optional["WsFeed"] = None):
        self.client, self.cfg, self._clock, self.ws = client, cfg, clock, ws_feed

    def completed_candles(self, symbol: str, tf: str, count: int) -> List[Candle]:
        secs = timeframe_seconds(tf)
        now = int(self._clock())
        raw = self.client.get_candles(symbol, tf, now - secs * (count + 3), now)
        candles = []
        for r in raw:
            try:
                candles.append(Candle(int(r["time"]), float(r["open"]), float(r["high"]),
                                      float(r["low"]), float(r["close"]), float(r.get("volume") or 0)))
            except (KeyError, TypeError, ValueError):
                raise MarketDataError(f"malformed candle for {symbol}: {r!r}")
        candles.sort(key=lambda c: c.time)
        # drop the in-progress candle: a candle is complete only when its period has fully elapsed
        candles = [c for c in candles if c.time + secs <= now]
        candles = candles[-count:]
        if not candles:
            raise MarketDataError(f"no candles for {symbol}")
        problem = validate_candles(candles, secs)
        if problem:
            raise MarketDataError(f"{symbol} {tf}: {problem}")
        if now - (candles[-1].time + secs) > secs * 2 + self.cfg.stale_data_seconds:
            raise MarketDataError(f"{symbol} {tf}: latest completed candle is stale")
        return candles

    def quote(self, symbol: str) -> Quote:
        t = self.client.get_ticker(symbol)
        try:
            q = t.get("quotes") or {}
            bid, ask = float(q.get("best_bid")), float(q.get("best_ask"))
            mark = float(t.get("mark_price") or (bid + ask) / 2)
        except (TypeError, ValueError):
            raise MarketDataError(f"{symbol}: ticker has no valid bid/ask")
        if bid <= 0 or ask <= 0 or ask < bid:
            raise MarketDataError(f"{symbol}: crossed or non-positive quote {bid}/{ask}")
        ts = float(t.get("timestamp") or 0) / 1e6 or self._clock()   # docs: microseconds
        if abs(self._clock() - ts) > self.cfg.stale_data_seconds:
            raise MarketDataError(f"{symbol}: stale quote ({self._clock() - ts:.0f}s old)")
        fr = float(t.get("funding_rate") or 0)
        return Quote(bid, ask, mark, ts, fr, float(q.get("bid_size") or 0), float(q.get("ask_size") or 0))


class WsFeed:
    """Public WebSocket price feed with exponential-backoff reconnect. REST remains the fallback:
    `healthy()` is False when no message arrived recently and callers poll REST instead."""

    def __init__(self, url: str, symbols: List[str], connect: Optional[Callable] = None,
                 sleep=time.sleep, clock=time.time, max_backoff: float = 60.0):
        self.url, self.symbols = url, symbols
        self._connect = connect
        self._sleep, self._clock, self.max_backoff = sleep, clock, max_backoff
        self.last_msg = 0.0
        self.prices = {}
        self.reconnects = 0
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self):
        self._thread = threading.Thread(target=self.run, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def healthy(self, max_age: float = 30.0) -> bool:
        return self._clock() - self.last_msg < max_age

    def run(self, max_cycles: Optional[int] = None):
        backoff, cycles = 1.0, 0
        while not self._stop.is_set() and (max_cycles is None or cycles < max_cycles):
            cycles += 1
            try:
                ws = self._connect(self.url) if self._connect else self._default_connect()
                ws.send(json.dumps({"type": "subscribe", "payload": {"channels": [
                    {"name": "mark_price", "symbols": [f"MARK:{s}" for s in self.symbols]}]}}))
                backoff = 1.0
                while not self._stop.is_set():
                    raw = ws.recv()
                    if not raw:
                        raise ConnectionError("empty frame / closed")
                    self._on_message(raw)
            except Exception as e:  # noqa: BLE001 - any failure -> reconnect
                self.reconnects += 1
                log.warning("ws disconnected (%s); reconnect in %.1fs", type(e).__name__, backoff)
                self._sleep(backoff + random.uniform(0, 0.25 * backoff))
                backoff = min(backoff * 2, self.max_backoff)

    def _default_connect(self):  # pragma: no cover - needs network
        import websocket
        return websocket.create_connection(self.url, timeout=35)

    def _on_message(self, raw):
        self.last_msg = self._clock()
        try:
            m = json.loads(raw)
            if m.get("type") == "mark_price" and "symbol" in m:
                self.prices[m["symbol"].replace("MARK:", "")] = float(m["price"])
        except (ValueError, KeyError, TypeError):
            pass
