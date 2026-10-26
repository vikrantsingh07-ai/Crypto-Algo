import math

import pytest

from conftest import synth_candles
from market_data import MarketData, MarketDataError, WsFeed
from strategy import Candle, EmaCrossStrategy, atr, ema, rsi, validate_candles


def test_ema_known_values():
    e = ema([1, 2, 3, 4, 5], 3)
    assert math.isnan(e[1]) and e[2] == 2 and e[3] == pytest.approx(3) and e[4] == pytest.approx(4)


def test_rsi_extremes():
    assert rsi(list(range(1, 40)), 14)[-1] == 100
    assert rsi(list(range(40, 1, -1)), 14)[-1] == pytest.approx(0, abs=1e-9)


def test_atr_constant_range():
    cs = [Candle(i * 60, 10, 11, 9, 10) for i in range(30)]
    assert atr(cs, 14)[-1] == pytest.approx(2.0)


def _find_signals(cfg, direction=None):
    s = EmaCrossStrategy(cfg)
    cs = synth_candles(1500, seed=3)
    found = []
    for i in range(s.min_candles(), len(cs)):
        trend = cs[: i + 1][::1]     # reuse the same series as trend input (timeframe agnostic for logic test)
        d = s.evaluate(cs[: i + 1], trend)
        if d.signal and (direction is None or d.signal.direction == direction):
            found.append((i, d.signal))
    return found


def test_generates_long_signals_and_uses_only_given_candles(make_cfg):
    cfg = make_cfg(EMA_TREND=50)
    sigs = _find_signals(cfg, "LONG")
    assert sigs, "synthetic series should produce at least one LONG signal"
    i, sig = sigs[0]
    assert sig.stop_distance > 0 and 50 <= sig.indicators["rsi"] <= 70
    assert sig.indicators["ema_fast"] > sig.indicators["ema_slow"]


def test_signal_independent_of_future_candles(make_cfg):
    cfg = make_cfg(EMA_TREND=50)
    s = EmaCrossStrategy(cfg)
    cs = synth_candles(1500, seed=3)
    i, sig = _find_signals(cfg, "LONG")[0]
    again = s.evaluate(cs[: i + 1], cs[: i + 1])
    assert again.signal and again.signal.candle_time == sig.candle_time   # no look-ahead dependence


def test_short_disabled_by_default(make_cfg):
    assert not _find_signals(make_cfg(EMA_TREND=50), "SHORT")
    assert _find_signals(make_cfg(EMA_TREND=50, ALLOW_SHORT="true"), "SHORT")


def test_counter_trend_cross_rejected(make_cfg):
    cfg = make_cfg(EMA_TREND=50)
    s = EmaCrossStrategy(cfg)
    i, sig = _find_signals(cfg, "LONG")[0]
    cs = synth_candles(1500, seed=3)[: i + 1]
    bearish_trend = [Candle(c.time, 1000 - k, 1000 - k + 1, 1000 - k - 1, 1000 - k) for k, c in enumerate(cs)]
    d = s.evaluate(cs, bearish_trend)
    assert d.signal is None and "trend" in d.reason


def test_rsi_filter_blocks(make_cfg):
    cfg = make_cfg(EMA_TREND=50, RSI_LONG_MIN=99, RSI_LONG_MAX=100)
    assert not _find_signals(cfg, "LONG")


def test_insufficient_candles(cfg):
    assert EmaCrossStrategy(cfg).evaluate(synth_candles(5), []).signal is None


def test_not_every_candle_is_a_signal(make_cfg):
    cfg = make_cfg(EMA_TREND=50)
    assert len(_find_signals(cfg)) < 0.1 * 1500


def test_validate_candles_detects_gap_and_bad_ohlc():
    ok = [Candle(0, 1, 2, 1, 1.5), Candle(60, 1, 2, 1, 1.5)]
    assert validate_candles(ok, 60) is None
    assert "missing" in validate_candles([ok[0], Candle(180, 1, 2, 1, 1.5)], 60)
    assert "invalid" in validate_candles([Candle(0, 1, 0.5, 1, 1.5)], 60)


# ------------------------------------------------------------ market data safety
def test_incomplete_candle_dropped(cfg, stub, clock):
    tf = 900
    now = int(clock())
    base = now - now % tf
    stub.candles[("BTCUSD", "15m")] = [Candle(base - 3 * tf, 1, 2, 1, 1.5, 1), Candle(base - 2 * tf, 1, 2, 1, 1.5, 1),
                                       Candle(base - tf, 1, 2, 1, 1.5, 1), Candle(base, 1, 2, 1, 1.5, 1)]
    md = MarketData(stub, cfg, clock)
    got = md.completed_candles("BTCUSD", "15m", 10)
    assert got[-1].time == base - tf       # candle opened at `base` is still forming


def test_gap_in_candles_rejected(cfg, stub, clock):
    now = int(clock()); base = now - now % 900
    stub.candles[("BTCUSD", "15m")] = [Candle(base - 4 * 900, 1, 2, 1, 1.5), Candle(base - 900, 1, 2, 1, 1.5)]
    with pytest.raises(MarketDataError, match="missing"):
        MarketData(stub, cfg, clock).completed_candles("BTCUSD", "15m", 10)


def test_stale_candles_rejected(cfg, stub, clock):
    now = int(clock()); base = now - now % 900
    stub.candles[("BTCUSD", "15m")] = [Candle(base - 20 * 900, 1, 2, 1, 1.5), Candle(base - 19 * 900, 1, 2, 1, 1.5)]
    with pytest.raises(MarketDataError, match="stale"):
        MarketData(stub, cfg, clock).completed_candles("BTCUSD", "15m", 30)


def test_stale_and_crossed_quotes_rejected(cfg, stub, clock):
    md = MarketData(stub, cfg, clock)
    assert md.quote("BTCUSD").ask == 100010.0
    stub.bid, stub.ask = 100020.0, 100010.0
    with pytest.raises(MarketDataError, match="crossed"):
        md.quote("BTCUSD")
    stub.bid, stub.ask = 100000.0, 100010.0
    clock.advance(10_000)
    old = stub.get_ticker
    stub.get_ticker = lambda s: {**old(s), "timestamp": int((clock() - 10_000) * 1e6)}
    with pytest.raises(MarketDataError, match="stale"):
        md.quote("BTCUSD")


def test_malformed_candle_rejected(cfg, stub, clock):
    stub.get_candles = lambda *a: [{"time": 1, "open": "x"}]
    with pytest.raises(MarketDataError):
        MarketData(stub, cfg, clock).completed_candles("BTCUSD", "15m", 5)


# ------------------------------------------------------------ websocket
class FakeWs:
    def __init__(self, msgs):
        self.msgs, self.sent = list(msgs), []

    def send(self, m):
        self.sent.append(m)

    def recv(self):
        if not self.msgs:
            raise ConnectionError("dropped")
        return self.msgs.pop(0)


def test_ws_reconnects_with_exponential_backoff(clock):
    sleeps, attempts = [], []

    def connect(url):
        attempts.append(url)
        if len(attempts) in (1, 2):
            raise OSError("down")
        return FakeWs(['{"type":"mark_price","symbol":"MARK:BTCUSD","price":"100000"}'])

    feed = WsFeed("wss://x", ["BTCUSD"], connect=connect, sleep=sleeps.append, clock=clock)
    feed.run(max_cycles=4)
    assert feed.prices["BTCUSD"] == 100000.0
    assert feed.reconnects == 4 and len(attempts) == 4
    assert sleeps[1] > sleeps[0] * 1.4        # backoff grows (jitter-tolerant)


def test_ws_health_goes_false_without_messages(clock):
    feed = WsFeed("wss://x", ["BTCUSD"], connect=lambda u: FakeWs([]), sleep=lambda s: None, clock=clock)
    feed.run(max_cycles=1)
    assert not feed.healthy()
