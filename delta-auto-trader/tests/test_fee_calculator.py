import pytest
from fee_calculator import FeeSchedule, estimate_trade, funding_cost, gross_pnl


def test_fee_includes_gst():
    f = FeeSchedule(0.0002, 0.0005, 0.18, "CONFIG")
    assert f.fee(1000, "taker") == pytest.approx(1000 * 0.0005 * 1.18)
    assert f.fee(1000, "maker") == pytest.approx(1000 * 0.0002 * 1.18)


def test_option_fee_capped_by_premium():
    f = FeeSchedule(0.0002, 0.0005, 0.0, "CONFIG")
    assert f.fee(100000, "taker", premium_notional=10) == pytest.approx(1.0)   # 10% of premium, not 50


def test_resolve_prefers_config_then_exchange_then_estimated(make_cfg, inst):
    assert FeeSchedule.resolve(make_cfg(MAKER_FEE_RATE=0.0001, TAKER_FEE_RATE=0.0003), inst).source == "CONFIG"
    assert FeeSchedule.resolve(make_cfg(), inst).source == "EXCHANGE"
    inst.maker_fee_rate = None
    s = FeeSchedule.resolve(make_cfg(), inst)
    assert s.source == "ESTIMATED" and not s.exact


def test_gross_and_net_long():
    f = FeeSchedule(0.0002, 0.0005, 0.0, "CONFIG")
    e = estimate_trade(f, "LONG", 100000, 99000, 102000, 10, 0.001)
    assert e.gross_reward == pytest.approx(20.0) and e.gross_loss == pytest.approx(10.0)
    assert e.entry_fee == pytest.approx(1000 * 0.0005)
    assert e.net_reward == pytest.approx(20 - 0.5 - 1020 * 0.0002)
    assert e.net_loss > e.gross_loss and e.net_rr < e.gross_rr


def test_short_pnl_sign():
    assert gross_pnl("SHORT", 100, 90, 10, 1) == 100
    assert gross_pnl("SHORT", 100, 110, 10, 1) == -100


def test_funding_only_counts_costs():
    assert funding_cost("LONG", 1000, 0.01, 8) == pytest.approx(0.1)
    assert funding_cost("SHORT", 1000, 0.01, 8) == 0.0       # would receive; ignored (conservative)
    assert funding_cost("LONG", 1000, 0.01, 9) == pytest.approx(0.2)   # intervals round up
