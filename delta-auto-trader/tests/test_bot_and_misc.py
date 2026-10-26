import datetime as dt
import os
import sqlite3

import pytest

from backtest import resample, run_backtest
from conftest import BTC_PRODUCT, StubMarket, synth_candles
from database import Database
from fee_calculator import FeeSchedule
from instrument_selector import InstrumentSelector, discover, option_quote_ok, parse_product
from logger import RedactingFilter
from main import Bot, main
from paper_exchange import PaperExchange
from strategy import Candle, EmaCrossStrategy

SCALE = 1000.0


def _signal_series(cfg, seed=3):
    """Find a prefix of a synthetic series whose last completed candle triggers a LONG signal."""
    s = EmaCrossStrategy(cfg)
    cs = [Candle(c.time, c.open * SCALE, c.high * SCALE, c.low * SCALE, c.close * SCALE, 100)
          for c in synth_candles(1500, seed=seed)]
    for i in range(s.min_candles(), len(cs)):
        d = s.evaluate(cs[: i + 1], cs[: i + 1])
        if d.signal and d.signal.direction == "LONG":
            return cs[: i + 1]
    raise AssertionError("no signal found")


def build_bot(make_cfg, db, clock, **over):
    kw = dict(EMA_TREND=50, MAX_POSITION_NOTIONAL_INR=200000, MAX_RISK_PER_TRADE_INR=2000,
              MAX_DAILY_LOSS_INR=100000, MAX_LEVERAGE=5)
    kw.update(over)
    cfg = make_cfg(**kw)
    stub = StubMarket(clock)
    series = _signal_series(cfg)
    shift = int(clock()) // 900 * 900 - 900 - series[-1].time          # last candle = last completed one
    primary = [Candle(c.time + shift, c.open, c.high, c.low, c.close, c.volume) for c in series]
    # trend: steadily rising hourly candles => bullish
    tb = int(clock()) // 3600 * 3600 - 3600
    trend = [Candle(tb - (119 - k) * 3600, 50000 + k * 10, 50000 + k * 10 + 5, 50000 + k * 10 - 5, 50000 + k * 10 + 2, 1)
             for k in range(120)]
    stub.candles[("BTCUSD", "15m")] = primary
    stub.candles[("BTCUSD", "1h")] = trend
    last = primary[-1].close
    stub.bid, stub.ask = last - 5, last + 5
    inst = parse_product(BTC_PRODUCT)
    paper = PaperExchange(stub, FeeSchedule.resolve(cfg, inst), 100000.0, clock)
    bot = Bot(cfg, paper, db, clock=clock, sleep=lambda s: None, market=None)
    bot.market.client = stub          # market data from the stub
    return bot, paper, stub, cfg


@pytest.fixture
def now(clock):
    clock.t = 1_700_000_000.0 + 450
    return clock


def test_end_to_end_signal_to_protected_position(make_cfg, db, now):
    bot, paper, stub, cfg = build_bot(make_cfg, db, now)
    bot.startup()
    bot.tick()
    trades = db.all_trades()
    assert len(trades) == 1 and trades[0]["status"] == "PROTECTED" and trades[0]["side"] == "LONG"
    assert "EMA9/21 cross" in trades[0]["signal"]
    oo = paper.get_open_orders(27)
    assert len(oo) == 2 and all(o["reduce_only"] for o in oo)
    # same candle is not traded twice; no stacking while the position is open
    bot.tick()
    assert len(db.all_trades()) == 1


def test_default_inr_limits_skip_with_reason_and_no_orders(make_cfg, db, now, capsys):
    bot, paper, stub, cfg = build_bot(make_cfg, db, now, MAX_POSITION_NOTIONAL_INR=10, MAX_RISK_PER_TRADE_INR=2)
    bot.startup()
    bot.tick()
    out = capsys.readouterr().out
    assert "[SIGNAL] LONG" in out and "[SKIP] Reason: Minimum order size exceeds configured limit" in out
    assert paper.placed_payloads == [] and db.all_trades() == []


def test_order_placement_disabled_means_signal_only(make_cfg, db, now, capsys):
    bot, paper, *_ = build_bot(make_cfg, db, now, ALLOW_ORDER_PLACEMENT="false")
    bot.startup(); bot.tick()
    assert paper.placed_payloads == [] and "ALLOW_ORDER_PLACEMENT" in capsys.readouterr().out


def test_stale_market_data_blocks_entry(make_cfg, db, now, capsys):
    bot, paper, stub, cfg = build_bot(make_cfg, db, now)
    bot.startup()
    now.advance(3 * 3600)           # candles now old
    bot.tick()
    assert paper.placed_payloads == [] and "market data unusable" in capsys.readouterr().out


def test_wide_spread_blocks_entry(make_cfg, db, now, capsys):
    bot, paper, stub, cfg = build_bot(make_cfg, db, now)
    bot.startup()
    stub.ask = stub.bid * 1.01
    bot.tick()
    assert paper.placed_payloads == [] and "spread" in capsys.readouterr().out


def test_daily_loss_limit_stops_new_entries(make_cfg, db, now):
    bot, paper, stub, cfg = build_bot(make_cfg, db, now)
    db.create_trade(environment=cfg.environment, symbol="BTCUSD", side="LONG", status="CLOSED",
                    net_pnl=-cfg.max_daily_loss_usd - 1, exit_time=now() - 5)
    bot.startup(); bot.tick()
    assert paper.placed_payloads == []


def test_emergency_stop_flattens_and_disables_entries(make_cfg, db, now):
    bot, paper, stub, cfg = build_bot(make_cfg, db, now)
    bot.startup(); bot.tick()
    assert paper.get_position(27)["size"] > 0
    assert main_emergency(cfg)
    assert bot.tick() == "stop"
    assert paper.get_position(27)["size"] == 0 and paper.get_open_orders(27) == []
    t = db.all_trades()[0]
    assert t["status"] == "CLOSED" and t["exit_reason"] == "EMERGENCY_STOP"
    assert not bot.risk.can_open(0).allowed


def main_emergency(cfg):
    from main import cmd_emergency
    cmd_emergency(cfg)
    return os.path.exists(cfg.emergency_file)


def test_bot_startup_with_unexpected_position_disables_entries(make_cfg, db, now):
    bot, paper, stub, cfg = build_bot(make_cfg, db, now)
    paper.positions[27] = {"size": 3, "entry_price": 1.0, "product_id": 27}
    rep = bot.startup()
    assert not rep.clean
    bot.tick()
    assert paper.placed_payloads == []


def test_main_refuses_live_without_gates(monkeypatch, capsys):
    monkeypatch.setenv("TRADING_MODE", "LIVE")
    monkeypatch.delenv("ENABLE_LIVE_TRADING", raising=False)
    assert main(["check"]) == 1
    assert "refused" in capsys.readouterr().out


def test_demo_smoke_refuses_outside_demo(monkeypatch):
    monkeypatch.setenv("TRADING_MODE", "PAPER")
    assert main(["demo-smoke", "--i-understand-demo"]) == 2


# ----------------------------------------------------------------- database
def test_duplicate_trade_record_prevented(db):
    db.create_trade(trade_id="abc", environment="DEMO", symbol="X", side="LONG", status="OPEN")
    with pytest.raises(sqlite3.IntegrityError):
        db.create_trade(trade_id="abc", environment="DEMO", symbol="X", side="LONG", status="OPEN")


def test_database_persists_across_connections(tmp_path):
    p = str(tmp_path / "t.db")
    d1 = Database(p)
    d1.create_trade(trade_id="a", environment="DEMO", symbol="X", side="LONG", status="OPEN")
    d1.kv_set("k", {"v": 1})
    d1.close()
    d2 = Database(p)
    assert d2.get_trade("a")["status"] == "OPEN" and d2.kv_get("k") == {"v": 1}


def test_log_redacts_secrets():
    import logging
    rec = logging.LogRecord("x", logging.INFO, "", 0, "api_key=ABCDEF123456 signature: deadbeefcafe", (), None)
    RedactingFilter().filter(rec)
    assert "ABCDEF123456" not in rec.msg and "deadbeefcafe" not in rec.msg


# ----------------------------------------------------------------- instruments
_BASE = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def _opt(sym, kind, strike, days, **kw):
    exp = (_BASE + dt.timedelta(days=days)).isoformat()   # same-day expiries share one timestamp
    p = dict(BTC_PRODUCT, id=hash(sym) % 10000, symbol=sym,
             contract_type="call_options" if kind == "C" else "put_options", strike_price=str(strike),
             settlement_time=exp, tick_size="5", contract_value="0.001")
    p.update(kw)
    return p


def test_discover_parses_and_skips_bad_products():
    got = discover([BTC_PRODUCT, {"id": 1, "symbol": "BAD"}, dict(BTC_PRODUCT, id=2, symbol="B2", tick_size="0")])
    assert [i.symbol for i in got] == ["BTCUSD"]
    assert got[0].max_leverage == pytest.approx(100.0)


def test_default_selection_is_perpetual_for_watchlist(cfg):
    insts = discover([BTC_PRODUCT, dict(BTC_PRODUCT, id=9, symbol="BTCUSDT")])
    sel = InstrumentSelector(cfg).select(insts, "LONG", {})
    assert sel.instrument.symbol == "BTCUSD"


def test_explicit_symbol_unavailable_means_skip_not_alternative(make_cfg):
    cfg = make_cfg(MARKET_TYPE="CONFIGURABLE", EXPLICIT_SYMBOLS="ETHUSD")
    sel = InstrumentSelector(cfg).select(discover([BTC_PRODUCT]), "LONG", {})
    assert sel.instrument is None and "ETHUSD" in sel.audit[0]


def test_option_selection_is_deterministic_atm_nearest_expiry(make_cfg):
    cfg = make_cfg(MARKET_TYPE="OPTIONS", WATCHLIST="BTC")
    products = [_opt("C-BTC-90000-A", "C", 90000, 7), _opt("C-BTC-100000-A", "C", 100000, 7),
                _opt("C-BTC-100000-B", "C", 100000, 30), _opt("P-BTC-100000-A", "P", 100000, 7),
                _opt("C-BTC-99000-SOON", "C", 99000, 0.1)]
    insts = discover(products)
    sel = InstrumentSelector(cfg)
    a = sel.select(insts, "LONG", {"BTC": 100500})
    b = sel.select(list(reversed(insts)), "LONG", {"BTC": 100500})
    assert a.instrument.symbol == b.instrument.symbol == "C-BTC-100000-A"   # not the <24h one
    assert sel.select(insts, "SHORT", {"BTC": 100500}).instrument.kind == "PUT"


def test_inverse_and_non_live_rejected(cfg):
    insts = discover([dict(BTC_PRODUCT, notional_type="inverse"), dict(BTC_PRODUCT, id=5, symbol="ETHUSD",
                                                                      state="expired", underlying_asset={"symbol": "ETH"})])
    assert InstrumentSelector(cfg).select(insts, "LONG", {}).instrument is None


def test_option_quote_checks():
    assert option_quote_ok(100, 101, 5, 5, 10) is None
    assert "spread" in option_quote_ok(100, 150, 5, 5, 10)
    assert option_quote_ok(None, 101, 5, 5, 10)
    assert "liquidity" in option_quote_ok(100, 101, 0, 5, 10)


# ----------------------------------------------------------------- backtest
def test_resample_only_aggregates_known_candles():
    cs = [Candle(i * 900, 1, 2 + i, 0.5, 1 + i, 1) for i in range(8)]
    r = resample(cs, 3600)
    assert len(r) == 2 and r[0].high == 5 and r[0].open == 1 and r[0].close == 4


def test_backtest_runs_with_fees_and_no_overlap(make_cfg, inst):
    cfg = make_cfg(EMA_TREND=50, MAX_POSITION_NOTIONAL_INR=200000, MAX_RISK_PER_TRADE_INR=2000, COOLDOWN_MINUTES=15)
    cs = [Candle(c.time, c.open * SCALE, c.high * SCALE, c.low * SCALE, c.close * SCALE, 100)
          for c in synth_candles(3000, seed=5)]
    res = run_backtest(cfg, EmaCrossStrategy(cfg), inst, cs, FeeSchedule.resolve(cfg, inst))
    s = res.stats()
    assert s["trades"] > 0 and s["fees"] > 0
    assert s["net_pnl"] == pytest.approx(s["gross_pnl"] - s["fees"] - s["funding"])
    ts = res.trades
    assert all(ts[i].exit_time <= ts[i + 1].entry_time for i in range(len(ts) - 1))
    assert all(t.entry_time > 0 and t.exit_time > t.entry_time for t in ts)
    assert 0 <= s["win_rate"] <= 1 and s["max_drawdown"] >= 0


def test_backtest_with_default_inr_limits_trades_nothing(cfg, inst):
    cs = [Candle(c.time, c.open * SCALE, c.high * SCALE, c.low * SCALE, c.close * SCALE, 100)
          for c in synth_candles(1500, seed=5)]
    res = run_backtest(cfg, EmaCrossStrategy(cfg), inst, cs, FeeSchedule.resolve(cfg, inst))
    assert res.stats()["trades"] == 0 and res.skipped


# ----------------------------------------------------------------- XRP / DOGE
XRP_PRODUCT = dict(BTC_PRODUCT, id=101, symbol="XRPUSD", contract_value="1", tick_size="0.0001",
                   underlying_asset={"symbol": "XRP"})
DOGE_PRODUCT = dict(BTC_PRODUCT, id=102, symbol="DOGEUSD", contract_value="10", tick_size="0.00001",
                    underlying_asset={"symbol": "DOGE"})


def test_default_watchlist_is_xrp_doge_and_selected(make_cfg):
    from config import load_config
    assert load_config(env={}).watchlist == ["XRP", "DOGE"]
    cfg = make_cfg(WATCHLIST="XRP,DOGE")
    insts = discover([BTC_PRODUCT, XRP_PRODUCT, DOGE_PRODUCT])
    sel = InstrumentSelector(cfg)
    assert sel.select(insts, "LONG", {}, bases=["DOGE"]).instrument.symbol == "DOGEUSD"
    assert sel.select(insts, "LONG", {}).instrument.symbol == "XRPUSD"


@pytest.mark.parametrize("prod,price,stop", [(XRP_PRODUCT, 2.5, 0.05), (DOGE_PRODUCT, 0.25, 0.004)])
def test_sizing_and_price_formatting_for_low_priced_coins(make_cfg, prod, price, stop):
    from order_manager import fmt
    from position_sizer import size_position
    cfg = make_cfg(MAX_POSITION_NOTIONAL_INR=20000, MAX_RISK_PER_TRADE_INR=100)
    inst = parse_product(prod)
    p = size_position(cfg, inst, "LONG", price, stop, FeeSchedule.resolve(cfg, inst), 1000)
    assert p.ok and p.qty >= 1 and p.stop < p.entry < p.take_profit
    assert p.notional <= cfg.max_position_notional_usd and p.econ.net_loss <= cfg.max_risk_usd + 1e-9
    assert abs(float(fmt(p.stop, inst.tick_size)) - p.stop) < inst.tick_size / 2
    assert len(fmt(p.take_profit, inst.tick_size).split(".")[1]) == (4 if prod is XRP_PRODUCT else 5)


def test_default_inr_limits_explain_skip_for_xrp(cfg):
    from position_sizer import size_position
    inst = parse_product(XRP_PRODUCT)
    p = size_position(cfg, inst, "LONG", 2.5, 0.05, FeeSchedule.resolve(cfg, inst), 1000)
    assert not p.ok and "Minimum order size" in p.reason
