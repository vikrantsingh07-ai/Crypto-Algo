import pytest

from exchange_client import ExchangeReject, TransientError
from helpers import ambiguous, make_plan, make_stack, open_trade
from order_manager import EntryAborted
from fee_calculator import FeeSchedule


@pytest.fixture
def stack(big_cfg, db, paper, clock):
    return make_stack(big_cfg, db, paper, clock)


@pytest.fixture
def plan(big_cfg, inst, fees):
    return make_plan(big_cfg, inst, fees)


def test_happy_path_entry_with_verified_protection(stack, db, paper, inst, plan):
    risk, om, pm = stack
    assert plan.qty == 2
    tid = open_trade(om, inst, plan)
    t = db.get_trade(tid)
    assert t["status"] == "PROTECTED" and t["quantity"] == plan.qty
    assert paper.get_position(inst.product_id)["size"] == plan.qty
    open_orders = paper.get_open_orders(inst.product_id)
    stop = [o for o in open_orders if o["stop_order_type"] == "stop_loss_order"][0]
    tp = [o for o in open_orders if not o["stop_order_type"]][0]
    assert stop["reduce_only"] and stop["side"] == "sell" and float(stop["stop_price"]) == plan.stop
    assert tp["reduce_only"] and float(tp["limit_price"]) == plan.take_profit and tp["size"] == plan.qty
    assert t["stop_order_id"] == str(stop["id"]) and t["tp_order_id"] == str(tp["id"])


def test_entry_is_ioc_limit_capped_at_plan_price(stack, paper, inst, plan):
    _, om, _ = stack
    open_trade(om, inst, plan)
    e = paper.placed_payloads[0]
    assert e["order_type"] == "limit_order" and e["time_in_force"] == "ioc" and e["reduce_only"] is False
    assert float(e["limit_price"]) == plan.entry and len(e["client_order_id"]) <= 32


def test_no_position_stacking(stack, db, paper, inst, plan):
    _, om, _ = stack
    open_trade(om, inst, plan)
    n = len(paper.placed_payloads)
    with pytest.raises(EntryAborted):
        open_trade(om, inst, plan)
    assert len(paper.placed_payloads) == n and paper.get_position(inst.product_id)["size"] == plan.qty


def test_refuses_when_exchange_already_has_position(stack, db, paper, inst, plan):
    _, om, _ = stack
    paper.positions[inst.product_id] = {"size": 1, "entry_price": 1.0, "product_id": inst.product_id}
    with pytest.raises(EntryAborted, match="already holds"):
        open_trade(om, inst, plan)
    assert paper.placed_payloads == []


def test_duplicate_client_order_id_never_resubmitted(stack, db, paper, inst, plan):
    _, om, _ = stack
    tid = open_trade(om, inst, plan)
    cid = db.get_trade(tid)["entry_client_id"]
    with pytest.raises(EntryAborted, match="duplicate"):
        om._submit(tid, "e", inst, {"client_order_id": cid, "side": "buy", "size": 1, "order_type": "market_order",
                                   "product_id": inst.product_id}, "ENTRY")


def test_partial_fill_protects_only_filled_quantity(stack, db, paper, inst, plan):
    _, om, _ = stack
    paper.fill_cap = 1
    tid = open_trade(om, inst, plan)
    t = db.get_trade(tid)
    assert t["quantity"] == 1 and t["status"] == "PROTECTED"
    assert all(o["size"] == 1 for o in paper.get_open_orders(inst.product_id))
    assert not [o for o in paper.get_open_orders(inst.product_id) if not o["reduce_only"]]


def test_timeout_but_order_executed_is_detected_not_duplicated(stack, db, paper, inst, plan):
    _, om, _ = stack
    paper.faults["place_order"] = [ambiguous(executed=True)]
    tid = open_trade(om, inst, plan)
    entries = [p for p in paper.placed_payloads if not p.get("reduce_only")]
    assert len(entries) == 1                                   # entry NOT retried
    assert db.get_trade(tid)["status"] == "PROTECTED"
    assert paper.get_position(inst.product_id)["size"] == plan.qty


def test_timeout_and_order_not_executed_aborts_cleanly(stack, db, paper, inst, plan):
    _, om, _ = stack
    paper.faults["place_order"] = [ambiguous(executed=False)]
    with pytest.raises(EntryAborted, match="not found"):
        open_trade(om, inst, plan)
    assert paper.get_position(inst.product_id)["size"] == 0
    assert db.all_trades()[0]["status"] == "ABORTED"
    assert len([p for p in paper.placed_payloads]) == 1


def test_timeout_and_lookup_unavailable_halts_for_reconciliation(stack, db, paper, inst, plan):
    risk, om, _ = stack
    paper.faults["place_order"] = [ambiguous(executed=True)]
    paper.faults["get_order_by_client_id"] = [TransientError("down")] * 5
    with pytest.raises(EntryAborted, match="ambiguous"):
        open_trade(om, inst, plan)
    assert db.all_trades()[0]["status"] == "NEEDS_RECONCILIATION"
    assert risk.halt_reason() and not risk.can_open(0).allowed


def test_exchange_rejection_aborts_without_position(stack, db, paper, inst, plan):
    _, om, _ = stack
    paper.faults["place_order"] = [ExchangeReject("no margin", "insufficient_margin")]
    with pytest.raises(EntryAborted, match="rejected"):
        open_trade(om, inst, plan)
    t = db.all_trades()[0]
    assert t["status"] == "ABORTED" and "insufficient_margin" in t["error"]


def test_ioc_not_filled_aborts(stack, db, paper, inst, plan):
    _, om, _ = stack
    paper.set_quote(inst.product_id, 100000.0, 200000.0)       # ask above our limit cap
    with pytest.raises(EntryAborted, match="did not fill"):
        open_trade(om, inst, plan)
    assert db.all_trades()[0]["status"] == "ABORTED"


def test_stop_cannot_be_placed_flattens_and_halts(stack, db, paper, inst, plan):
    risk, om, _ = stack
    orig = paper.place_order

    def po(p):
        if p.get("stop_order_type"):
            raise ExchangeReject("stop rejected", "bad_stop")
        return orig(p)

    paper.place_order = po
    tid = open_trade(om, inst, plan)
    t = db.get_trade(tid)
    assert paper.get_position(inst.product_id)["size"] == 0           # flattened
    assert t["exit_reason"] == "PROTECTION_FAILURE"
    assert risk.halt_reason() and "stop" in risk.halt_reason()
    assert any(i["severity"] == "CRITICAL" for i in db.incidents())


def test_take_profit_rejected_keeps_stop_and_warns(stack, db, paper, inst, plan):
    _, om, _ = stack
    orig = paper.place_order

    def po(p):
        if p["order_type"] == "limit_order" and p.get("reduce_only") and not p.get("stop_order_type"):
            raise ExchangeReject("tp rejected", "bad")
        return orig(p)

    paper.place_order = po
    tid = open_trade(om, inst, plan)
    t = db.get_trade(tid)
    assert t["status"] == "PROTECTED" and t["stop_order_id"] and not t["tp_order_id"]
    assert any(i["severity"] == "WARNING" for i in db.incidents())


def test_leverage_failure_aborts_before_any_order(stack, db, paper, inst, plan):
    _, om, _ = stack
    paper.set_leverage = lambda *a: (_ for _ in ()).throw(ExchangeReject("x", "bad"))
    with pytest.raises(EntryAborted):
        open_trade(om, inst, plan)
    assert paper.placed_payloads == []


def test_close_position_is_reduce_only_and_cancels_protection(stack, db, paper, inst, plan):
    _, om, _ = stack
    tid = open_trade(om, inst, plan)
    assert om.close_position(tid, inst, "MANUAL")
    assert paper.get_position(inst.product_id)["size"] == 0
    assert paper.get_open_orders(inst.product_id) == []
    assert paper.placed_payloads[-1]["reduce_only"] is True
