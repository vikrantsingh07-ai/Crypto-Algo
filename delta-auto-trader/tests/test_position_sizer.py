from fee_calculator import FeeSchedule
from position_sizer import size_position


def test_default_inr_limits_reject_with_explanation(cfg, inst, fees):
    r = size_position(cfg, inst, "LONG", 100000, 500, fees, 1000)
    assert not r.ok and "Minimum order size exceeds configured limit" in r.reason


def test_risk_budget_rejection(make_cfg, inst, fees):
    cfg = make_cfg(MAX_POSITION_NOTIONAL_INR=100000, MAX_RISK_PER_TRADE_INR=2)
    r = size_position(cfg, inst, "LONG", 100000, 500, fees, 1000)   # 1 contract risks ~$0.5+ > $0.0227
    assert not r.ok and "Risk budget" in r.reason


def test_ok_respects_limits(big_cfg, inst, fees):
    r = size_position(big_cfg, inst, "LONG", 100000, 500, fees, 1000)
    assert r.ok and r.qty >= 1
    assert r.notional <= big_cfg.max_position_notional_usd
    assert r.econ.net_loss <= big_cfg.max_risk_usd + 1e-9
    assert r.stop < r.entry < r.take_profit
    assert r.leverage <= big_cfg.max_leverage
    assert r.econ.gross_rr >= 1.99


def test_prices_on_tick_and_stop_not_tighter_than_requested(big_cfg, inst, fees):
    r = size_position(big_cfg, inst, "LONG", 100000.3, 501.1, fees, 1000)
    assert (r.stop * 2) % 1 == 0 and (r.take_profit * 2) % 1 == 0
    assert r.entry - r.stop >= 501.1 - 1e-9


def test_short_geometry(big_cfg, inst, fees):
    r = size_position(big_cfg, inst, "SHORT", 100000, 500, fees, 1000)
    assert r.ok and r.take_profit < r.entry < r.stop


def test_net_rr_mode_achieves_ratio_or_skips(make_cfg, inst, fees):
    cfg = make_cfg(MAX_POSITION_NOTIONAL_INR=20000, MAX_RISK_PER_TRADE_INR=100, RR_MODE="NET_RR")
    r = size_position(cfg, inst, "LONG", 100000, 500, fees, 1000)
    assert r.ok and r.econ.net_rr >= 2 * 0.98
    assert r.take_profit - r.entry > 2 * (r.entry - r.stop) - 1e-9    # TP further than gross 2R


def test_net_rr_skips_when_fees_dominate(make_cfg, inst):
    cfg = make_cfg(MAX_POSITION_NOTIONAL_INR=20000, MAX_RISK_PER_TRADE_INR=100, RR_MODE="NET_RR")
    huge = FeeSchedule(0.01, 0.01, 0.18, "CONFIG")
    r = size_position(cfg, inst, "LONG", 100000, 50, huge, 1000)
    assert not r.ok


def test_insufficient_margin(big_cfg, inst, fees):
    r = size_position(big_cfg, inst, "LONG", 100000, 500, fees, 0.01)
    assert not r.ok and "margin" in r.reason


def test_never_increases_risk_to_meet_minimum(big_cfg, inst, fees):
    r = size_position(big_cfg, inst, "LONG", 100000, 5000, fees, 1e9)   # 1 contract would risk ~$5 > budget
    assert not r.ok and "Risk budget" in r.reason
