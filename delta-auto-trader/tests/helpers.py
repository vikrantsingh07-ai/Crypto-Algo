from exchange_client import AmbiguousOrderError, ExchangeReject, TransientError
from fee_calculator import FeeSchedule
from order_manager import OrderManager
from paper_exchange import PaperExchange
from position_manager import PositionManager
from position_sizer import size_position
from risk_manager import RiskManager


def ambiguous(executed: bool):
    e = AmbiguousOrderError("timeout")
    e._executed = executed
    return e


def make_stack(cfg, db, paper, clock):
    risk = RiskManager(cfg, db, clock)
    om = OrderManager(paper, db, cfg, risk, clock, sleep=lambda s: None, resolve_attempts=3, resolve_delay=0)
    pm = PositionManager(paper, db, cfg, om, risk, clock)
    return risk, om, pm


def make_plan(cfg, inst, fees, entry=100010.0, stop_dist=200.0, side="LONG", margin=1000.0):
    plan = size_position(cfg, inst, side, entry, stop_dist, fees, margin)
    assert plan.ok, plan.reason
    return plan


def open_trade(om, inst, plan, quote=None):
    return om.open_position(inst, plan, "test-signal", quote, "EXCHANGE", 0.0)
