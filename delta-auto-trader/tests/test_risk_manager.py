from risk_manager import RiskManager


def add_closed(db, cfg, net, exit_time, status="CLOSED"):
    return db.create_trade(environment=cfg.environment, symbol="BTCUSD", side="LONG", status=status,
                           net_pnl=net, exit_time=exit_time)


def test_allows_when_clean(big_cfg, db, clock):
    assert RiskManager(big_cfg, db, clock).can_open(0).allowed


def test_max_open_positions(big_cfg, db, clock):
    assert not RiskManager(big_cfg, db, clock).can_open(1).allowed


def test_daily_loss_limit_blocks(big_cfg, db, clock):
    r = RiskManager(big_cfg, db, clock)
    add_closed(db, big_cfg, -(big_cfg.max_daily_loss_usd + 0.01), clock() - 60)
    d = r.can_open(0)
    assert not d.allowed and "daily loss" in d.reason


def test_planned_loss_cannot_breach_daily_limit(big_cfg, db, clock):
    r = RiskManager(big_cfg, db, clock)
    add_closed(db, big_cfg, -(big_cfg.max_daily_loss_usd - 0.1), clock() - 60)
    assert not r.can_open(0, planned_net_loss=0.5).allowed
    assert r.can_open(0, planned_net_loss=0.05).allowed


def test_daily_loss_survives_restart(big_cfg, db, clock):
    add_closed(db, big_cfg, -(big_cfg.max_daily_loss_usd + 1), clock() - 60)
    fresh = RiskManager(big_cfg, db, clock)       # simulates a process restart: no in-memory state
    assert not fresh.can_open(0).allowed


def test_daily_counter_resets_next_day(big_cfg, db, clock):
    r = RiskManager(big_cfg, db, clock)
    add_closed(db, big_cfg, -100, clock() - 60)
    assert not r.can_open(0).allowed
    clock.advance(26 * 3600)
    assert r.can_open(0).allowed


def test_consecutive_losses_pause(make_cfg, db, clock):
    cfg = make_cfg(MAX_CONSECUTIVE_LOSSES=2, MAX_DAILY_LOSS_INR=100000, MAX_TRADES_PER_DAY=10)
    r = RiskManager(cfg, db, clock)
    add_closed(db, cfg, -0.01, clock() - 300)
    assert r.can_open(0).allowed
    add_closed(db, cfg, -0.01, clock() - 200)
    d = r.can_open(0)
    assert not d.allowed and "consecutive" in d.reason


def test_win_resets_consecutive_losses(make_cfg, db, clock):
    cfg = make_cfg(MAX_CONSECUTIVE_LOSSES=2, MAX_DAILY_LOSS_INR=100000)
    r = RiskManager(cfg, db, clock)
    add_closed(db, cfg, -0.01, clock() - 300)
    add_closed(db, cfg, 0.05, clock() - 250)
    add_closed(db, cfg, -0.01, clock() - 200)
    assert r.can_open(0).allowed


def test_daily_trade_limit(make_cfg, db, clock):
    cfg = make_cfg(MAX_TRADES_PER_DAY=2, MAX_DAILY_LOSS_INR=100000, MAX_CONSECUTIVE_LOSSES=9)
    r = RiskManager(cfg, db, clock)
    add_closed(db, cfg, 0.1, clock() - 300)
    add_closed(db, cfg, 0.1, clock() - 200)
    assert "trade limit" in r.can_open(0).reason


def test_cooldown(make_cfg, db, clock):
    cfg = make_cfg(COOLDOWN_MINUTES=30, MAX_DAILY_LOSS_INR=100000)
    r = RiskManager(cfg, db, clock)
    add_closed(db, cfg, 0.1, clock() - 600)
    assert "cooldown" in r.can_open(0).reason
    clock.advance(1500)
    assert r.can_open(0).allowed


def test_halt_persists_and_clears(big_cfg, db, clock):
    r = RiskManager(big_cfg, db, clock)
    r.halt("test")
    assert "disabled" in RiskManager(big_cfg, db, clock).can_open(0).reason
    r.clear_halt()
    assert r.can_open(0).allowed


def test_emergency_file_blocks_entries(big_cfg, db, clock):
    import os
    os.makedirs(big_cfg.data_dir, exist_ok=True)
    open(big_cfg.emergency_file, "w").close()
    assert "emergency" in RiskManager(big_cfg, db, clock).can_open(0).reason


def test_order_placement_flag(make_cfg, db, clock):
    assert "ALLOW_ORDER_PLACEMENT" in RiskManager(make_cfg(ALLOW_ORDER_PLACEMENT="false"), db, clock).can_open(0).reason
