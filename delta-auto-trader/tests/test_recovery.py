import pytest

from helpers import make_plan, make_stack, open_trade
from fee_calculator import FeeSchedule
from recovery import reconcile


@pytest.fixture
def stack(big_cfg, db, paper, clock):
    return make_stack(big_cfg, db, paper, clock)


@pytest.fixture
def opened(stack, db, paper, inst, big_cfg, fees):
    risk, om, pm = stack
    plan = make_plan(big_cfg, inst, fees)
    tid = open_trade(om, inst, plan)
    return tid, plan


def test_stop_loss_hit_is_finalized_with_actual_fees(stack, db, paper, inst, fees, opened, clock):
    _, _, pm = stack
    tid, plan = opened
    paper.set_quote(inst.product_id, plan.stop - 50, plan.stop - 40)        # gaps through the stop
    assert pm.tick(db.get_trade(tid), inst, fees, plan.stop - 45) == "closed"
    t = db.get_trade(tid)
    assert t["status"] == "CLOSED" and t["exit_reason"] == "STOP_LOSS"
    assert t["net_pnl"] < 0 and t["fees"] > 0 and t["fee_source"] == "ACTUAL"
    assert t["net_pnl"] == pytest.approx(t["gross_pnl"] - t["fees"] - t["funding"])
    assert paper.get_open_orders(inst.product_id) == []          # sibling TP cancelled


def test_gap_slippage_can_exceed_planned_loss(stack, db, paper, inst, fees, opened):
    """Documented limitation: a stop is not a guaranteed price."""
    _, _, pm = stack
    tid, plan = opened
    paper.set_quote(inst.product_id, plan.stop - 500, plan.stop - 490)
    pm.tick(db.get_trade(tid), inst, fees)
    assert -db.get_trade(tid)["net_pnl"] > plan.econ.net_loss


def test_take_profit_hit(stack, db, paper, inst, fees, opened):
    _, _, pm = stack
    tid, plan = opened
    paper.set_quote(inst.product_id, plan.take_profit + 10, plan.take_profit + 20)
    pm.tick(db.get_trade(tid), inst, fees)
    t = db.get_trade(tid)
    assert t["status"] == "CLOSED" and t["exit_reason"] == "TAKE_PROFIT"
    assert t["exit_price"] == plan.take_profit
    expected_gross = (plan.take_profit - float(t["entry_price"])) * t["quantity"] * inst.contract_value
    assert t["gross_pnl"] == pytest.approx(expected_gross)
    assert t["net_pnl"] > 0


def test_open_position_stays_open_and_protected(stack, db, paper, inst, fees, opened):
    _, _, pm = stack
    tid, plan = opened
    assert pm.tick(db.get_trade(tid), inst, fees, 100005.0) == "open"
    assert db.get_trade(tid)["status"] == "PROTECTED"


def test_missing_stop_is_reinstalled(stack, db, paper, inst, fees, opened):
    _, _, pm = stack
    tid, plan = opened
    stop = [o for o in paper.get_open_orders(inst.product_id) if o["stop_order_type"]][0]
    paper.cancel_order(stop["id"], inst.product_id)           # someone cancels the stop
    pm.tick(db.get_trade(tid), inst, fees, 100005.0)
    assert [o for o in paper.get_open_orders(inst.product_id) if o["stop_order_type"]]


def test_time_exit(stack, db, paper, inst, fees, opened, clock, big_cfg):
    _, _, pm = stack
    tid, plan = opened
    clock.advance(big_cfg.max_hold_minutes * 60 + 5)
    pm.tick(db.get_trade(tid), inst, fees, 100005.0)
    assert paper.get_position(inst.product_id)["size"] == 0
    pm.tick(db.get_trade(tid), inst, fees, 100005.0)
    assert db.get_trade(tid)["exit_reason"] == "TIME_EXIT" and db.get_trade(tid)["status"] == "CLOSED"


def test_unexpected_flat_position_without_fills_halts(stack, db, paper, inst, fees, opened):
    risk, _, pm = stack
    tid, plan = opened
    paper.positions[inst.product_id]["size"] = 0                 # vanished without any fills
    paper.fills.clear()
    pm.tick(db.get_trade(tid), inst, fees)
    assert db.get_trade(tid)["status"] == "NEEDS_RECONCILIATION" and risk.halt_reason()


def test_position_direction_mismatch_halts(stack, db, paper, inst, fees, opened):
    risk, _, pm = stack
    tid, plan = opened
    paper.positions[inst.product_id]["size"] = -3
    pm.tick(db.get_trade(tid), inst, fees)
    assert risk.halt_reason() and db.get_trade(tid)["status"] == "NEEDS_RECONCILIATION"


# ------------------------------------------------------------------ recovery
def new_process(big_cfg, db, paper, clock):
    return make_stack(big_cfg, db, paper, clock)       # fresh managers == restart; DB + exchange persist


def test_restart_resumes_protected_trade_without_new_orders(big_cfg, db, paper, inst, clock, opened, fees):
    tid, plan = opened
    n = len(paper.placed_payloads)
    risk, om, pm = new_process(big_cfg, db, paper, clock)
    rep = reconcile(paper, db, big_cfg, om, risk, {inst.product_id: inst})
    assert rep.clean and tid in rep.resumed
    assert len(paper.placed_payloads) == n and not risk.halt_reason()
    paper.set_quote(inst.product_id, plan.take_profit + 5, plan.take_profit + 15)     # exit while "down"
    assert pm.tick(db.get_trade(tid), inst, fees) == "closed"


def test_restart_after_crash_between_fill_and_protection(big_cfg, db, paper, inst, clock, fees):
    """Process died after the entry filled but before stop/TP were placed."""
    risk, om, pm = new_process(big_cfg, db, paper, clock)
    plan = make_plan(big_cfg, inst, fees)
    tid = db.new_trade_id()
    db.create_trade(trade_id=tid, environment="DEMO", symbol="BTCUSD", product_id=inst.product_id, side="LONG",
                    status="PENDING_ENTRY", quantity=plan.qty, stop_price=plan.stop, take_profit_price=plan.take_profit,
                    entry_client_id=om.cid(tid, "e"), stop_client_id=om.cid(tid, "s"), tp_client_id=om.cid(tid, "t"))
    db.log_order(om.cid(tid, "e"), trade_id=tid, purpose="ENTRY", state="SENDING")
    paper.place_order({"product_id": inst.product_id, "size": plan.qty, "side": "buy", "order_type": "limit_order",
                       "limit_price": str(plan.entry), "time_in_force": "ioc", "client_order_id": om.cid(tid, "e")})
    risk, om, pm = new_process(big_cfg, db, paper, clock)           # restart
    rep = reconcile(paper, db, big_cfg, om, risk, {inst.product_id: inst})
    assert rep.clean and db.get_trade(tid)["status"] == "PROTECTED"
    assert len(paper.get_open_orders(inst.product_id)) == 2


def test_restart_pending_entry_never_sent_is_aborted(big_cfg, db, paper, inst, clock):
    risk, om, pm = new_process(big_cfg, db, paper, clock)
    tid = db.create_trade(environment="DEMO", symbol="BTCUSD", product_id=inst.product_id, side="LONG",
                          status="PENDING_ENTRY", quantity=1, entry_client_id="never")
    rep = reconcile(paper, db, big_cfg, om, risk, {inst.product_id: inst})
    assert tid in rep.aborted and db.get_trade(tid)["status"] == "ABORTED" and not risk.halt_reason()


def test_pending_entry_with_unexplained_position_needs_reconciliation(big_cfg, db, paper, inst, clock):
    risk, om, pm = new_process(big_cfg, db, paper, clock)
    paper.positions[inst.product_id] = {"size": 2, "entry_price": 1.0, "product_id": inst.product_id}
    tid = db.create_trade(environment="DEMO", symbol="BTCUSD", product_id=inst.product_id, side="LONG",
                          status="PENDING_ENTRY", quantity=2, entry_client_id="ghost")
    rep = reconcile(paper, db, big_cfg, om, risk, {inst.product_id: inst})
    assert not rep.clean and risk.halt_reason()
    assert db.get_trade(tid)["status"] == "NEEDS_RECONCILIATION"


def test_unexpected_exchange_position_disables_entries(big_cfg, db, paper, inst, clock):
    risk, om, pm = new_process(big_cfg, db, paper, clock)
    paper.positions[inst.product_id] = {"size": 5, "entry_price": 1.0, "product_id": inst.product_id}
    rep = reconcile(paper, db, big_cfg, om, risk, {inst.product_id: inst})
    assert not rep.clean and "unexpected open position" in rep.problems[0]
    assert not risk.can_open(0).allowed


def test_conflicting_open_orders_disable_entries(big_cfg, db, paper, inst, clock):
    risk, om, pm = new_process(big_cfg, db, paper, clock)
    paper.place_order({"product_id": inst.product_id, "size": 1, "side": "buy", "order_type": "limit_order",
                       "limit_price": "50000", "time_in_force": "gtc", "client_order_id": "stray"})
    rep = reconcile(paper, db, big_cfg, om, risk, {inst.product_id: inst})
    assert not rep.clean and risk.halt_reason()


def test_clean_exchange_clean_reconcile(big_cfg, db, paper, inst, clock):
    risk, om, pm = new_process(big_cfg, db, paper, clock)
    assert reconcile(paper, db, big_cfg, om, risk, {inst.product_id: inst}).clean
