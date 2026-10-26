import math
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from config import load_config  # noqa: E402
from database import Database  # noqa: E402
from fee_calculator import FeeSchedule  # noqa: E402
from instrument_selector import parse_product  # noqa: E402
from logger import setup_logging  # noqa: E402
from paper_exchange import PaperExchange  # noqa: E402
from risk_manager import RiskManager  # noqa: E402
from strategy import Candle  # noqa: E402

BTC_PRODUCT = {
    "id": 27, "symbol": "BTCUSD", "contract_type": "perpetual_futures", "contract_value": "0.001",
    "tick_size": "0.5", "state": "live", "initial_margin": "1", "notional_type": "vanilla",
    "maker_commission_rate": "0.0002", "taker_commission_rate": "0.0005",
    "underlying_asset": {"symbol": "BTC"}, "quoting_asset": {"symbol": "USD"}, "settling_asset": {"symbol": "USD"},
}


def make_env(tmp_path, **over):
    env = {"TRADING_MODE": "PAPER", "DATA_DIR": str(tmp_path / "data"), "LOG_DIR": str(tmp_path / "logs"),
           "COOLDOWN_MINUTES": "0", "LOOP_INTERVAL_SECONDS": "1"}
    env.update({k: str(v) for k, v in over.items()})
    return env


@pytest.fixture(autouse=True)
def _logging(tmp_path):
    setup_logging(str(tmp_path / "logs"), "DEBUG")


@pytest.fixture
def make_cfg(tmp_path):
    def _mk(**over):
        cfg = load_config(env=make_env(tmp_path, **over))
        cfg.validate(need_credentials=False)
        return cfg
    return _mk


@pytest.fixture
def cfg(make_cfg):
    return make_cfg()


@pytest.fixture
def big_cfg(make_cfg):
    """Limits large enough that 1 BTC contract (~$100) is tradable; used for order-flow tests."""
    return make_cfg(MAX_POSITION_NOTIONAL_INR=20000, MAX_RISK_PER_TRADE_INR=100, MAX_DAILY_LOSS_INR=500,
                    MAX_LEVERAGE=5)


@pytest.fixture
def db():
    d = Database(":memory:")
    yield d
    d.close()


@pytest.fixture
def inst():
    return parse_product(BTC_PRODUCT)


class Clock:
    def __init__(self, t=1_700_000_000.0):
        self.t = t

    def __call__(self):
        return self.t

    def advance(self, s):
        self.t += s


@pytest.fixture
def clock():
    return Clock()


class StubMarket:
    """Market-data delegate: tests set quote and candles directly."""
    def __init__(self, clock):
        self.clock = clock
        self.bid, self.ask = 100000.0, 100010.0
        self.candles = {}
        self.products = [BTC_PRODUCT]

    def get_products(self):
        return self.products

    def get_product(self, s):
        return [p for p in self.products if p["symbol"] == s][0]

    def get_ticker(self, s):
        return {"symbol": s, "mark_price": str((self.bid + self.ask) / 2), "funding_rate": "0.01",
                "timestamp": int(self.clock() * 1e6), "quotes": {"best_bid": str(self.bid), "best_ask": str(self.ask),
                                                                "bid_size": "100", "ask_size": "100"}}

    def get_candles(self, symbol, resolution, start, end):
        return [dict(time=c.time, open=c.open, high=c.high, low=c.low, close=c.close, volume=c.volume)
                for c in self.candles.get((symbol, resolution), []) if start <= c.time <= end]


@pytest.fixture
def stub(clock):
    return StubMarket(clock)


@pytest.fixture
def fees(cfg, inst):
    return FeeSchedule.resolve(cfg, inst)


@pytest.fixture
def paper(stub, fees, clock, inst):
    ex = PaperExchange(stub, fees, balance_usd=1000.0, clock=clock)
    ex.register_product(inst.product_id, inst.contract_value)
    ex.set_quote(inst.product_id, stub.bid, stub.ask)
    return ex


def synth_candles(n, tf=900, start=1_600_000_000, seed=1):
    import random
    r = random.Random(seed)
    price, out = 100.0, []
    for i in range(n):
        drift = 0.05 + 3 * math.sin(i / 25.0) * 0.1
        o = price
        c = max(1.0, o * (1 + (drift + r.uniform(-1, 1)) / 100))
        h, l = max(o, c) * (1 + r.uniform(0, 0.003)), min(o, c) * (1 - r.uniform(0, 0.003))
        out.append(Candle(start + i * tf, o, h, l, c, 100))
        price = c
    return out
