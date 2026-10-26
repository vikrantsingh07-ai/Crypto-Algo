#!/usr/bin/env python3
"""Delta Exchange autonomous trading bot — entry point and trading loop.

Commands:  run | check | discover | status | trades | emergency-stop | clear-halt | backtest | demo-smoke
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import signal
import sys
import time
from typing import Dict, List, Optional

import config as config_mod
from config import Config, ConfigError, load_config, timeframe_seconds
from database import Database
from exchange_client import (AmbiguousOrderError, AuthError, DeltaClient, ExchangeError, ExchangeReject)
from fee_calculator import FeeSchedule
from health_monitor import HealthMonitor
from instrument_selector import Instrument, InstrumentSelector, discover, option_quote_ok
from logger import get_logger, say, setup_logging
from market_data import MarketData, MarketDataError
from order_manager import EntryAborted, OrderManager
from paper_exchange import PaperExchange
from pnl_tracker import TradeResult
from position_manager import PositionManager
from position_sizer import size_position
from recovery import reconcile
from risk_manager import RiskManager
from strategy import build_strategy

log = get_logger("main")


def build_clients(cfg: Config):
    """Return (trading_client, market_client). PAPER uses a credential-less public client for data and a
    local simulated exchange for orders."""
    if cfg.trading_mode == "PAPER":
        public = DeltaClient(cfg.rest_url)
        return None, public           # PaperExchange is created once instruments/fees are known
    return DeltaClient(cfg.rest_url, cfg.api_key, cfg.api_secret), None


class Bot:
    def __init__(self, cfg: Config, client, db: Database, clock=time.time, sleep=time.sleep, market=None):
        self.cfg, self.client, self.db, self._clock, self._sleep = cfg, client, db, clock, sleep
        self.market = market or MarketData(client, cfg, clock)
        self.risk = RiskManager(cfg, db, clock)
        self.orders = OrderManager(client, db, cfg, self.risk, clock, sleep)
        self.positions = PositionManager(client, db, cfg, self.orders, self.risk, clock)
        self.selector = InstrumentSelector(cfg)
        self.strategy = build_strategy("ema_cross", cfg)
        self.health = HealthMonitor(cfg, clock)
        self.instruments: List[Instrument] = []
        self.by_pid: Dict[int, Instrument] = {}
        self._skip_seen = set()
        self.stop_requested = False
        self.last_status = 0.0

    # ---------------------------------------------------------------- setup
    def load_instruments(self) -> None:
        self.instruments = discover(self.market.client.get_products() if hasattr(self.market, "client")
                                    else self.client.get_products())
        want = {f"{b}USD" for b in self.cfg.watchlist} | set(self.cfg.explicit_symbols)
        universe = [i for i in self.instruments if i.symbol in want]
        self.by_pid = {i.product_id: i for i in universe}
        for t in self.db.active_trades(self.cfg.environment):      # always know about instruments with trades
            for i in self.instruments:
                if i.product_id == t["product_id"]:
                    self.by_pid[i.product_id] = i
        self.health.api_ok()
        say("STATUS", f"Instruments discovered: {len(self.instruments)} (tradeable universe: "
                      f"{', '.join(sorted(i.symbol for i in self.by_pid.values())) or 'none'})")

    def startup(self):
        self.load_instruments()
        rep = reconcile(self.client, self.db, self.cfg, self.orders, self.risk, self.by_pid)
        if rep.clean:
            say("STATUS", "Reconciliation: CLEAN")
        return rep

    # ---------------------------------------------------------------- helpers
    def skip(self, key, reason: str) -> None:
        k = (key, reason)
        if k not in self._skip_seen:
            if len(self._skip_seen) > 500:
                self._skip_seen.clear()
            self._skip_seen.add(k)
            say("SKIP", f"Reason: {reason}")

    def available_margin_usd(self) -> Optional[float]:
        for b in self.client.get_balances():
            sym = str(b.get("asset_symbol") or (b.get("asset") or {}).get("symbol", "")).upper()
            try:
                v = float(b.get("available_balance"))
            except (TypeError, ValueError):
                continue
            if sym in ("USD", "USDT", "USDC"):
                return v
            if sym == "INR":
                return v / self.cfg.usd_inr_rate
        return None

    def _feed_paper(self, inst: Instrument, q) -> None:
        if isinstance(self.client, PaperExchange):
            self.client.register_product(inst.product_id, inst.contract_value)
            self.client.set_quote(inst.product_id, q.bid, q.ask, q.mark)

    def daily_pnl_inr(self) -> float:
        return self.risk.daily_net_pnl() * self.cfg.usd_inr_rate

    # ---------------------------------------------------------------- tick
    def tick(self) -> str:
        """One iteration. Returns 'ok' | 'stop'."""
        cfg = self.cfg
        if self.risk.emergency_stop_requested():
            self.emergency_shutdown()
            return "stop"
        active = self.db.active_trades(cfg.environment)
        for t in active:
            inst = self.by_pid.get(t["product_id"])
            if inst is None:
                continue
            try:
                q = self.market.quote(inst.symbol)
                self.health.data_ok()
                self._feed_paper(inst, q)
                fees = FeeSchedule.resolve(cfg, inst)
                self.positions.tick(t, inst, fees, q.mark, q.funding_pct)
                self.health.api_ok()
            except MarketDataError as e:
                self.health.error(str(e))
                say("ERROR", f"market data: {e}")
            except ExchangeError as e:
                self.health.error(str(e))
                say("ERROR", f"{type(e).__name__}: {e}")
        if not self.db.active_trades(cfg.environment):
            self.look_for_entry()
        if self._clock() - self.last_status > 300:
            self.last_status = self._clock()
            act = self.db.active_trades(cfg.environment)
            pos = ", ".join(f"{t['symbol']} {t['side']} x{t['quantity']}" for t in act) or "NONE"
            self.health.print_status(pos, self.daily_pnl_inr(), self.risk.halt_reason() or "")
        return "ok"

    # ---------------------------------------------------------------- entries
    def look_for_entry(self) -> None:
        cfg = self.cfg
        d = self.risk.can_open(0)
        if not d.allowed:
            self.skip("risk", d.reason)
            return
        tf = timeframe_seconds(cfg.timeframe)
        for base in cfg.watchlist:
            sym = f"{base}USD"
            try:
                candles = self.market.completed_candles(sym, cfg.timeframe, 260)
                last_key = f"last_eval:{cfg.environment}:{sym}:{cfg.timeframe}"
                if self.db.kv_get(last_key) == candles[-1].time:
                    continue                      # this completed candle was already evaluated
                trend = self.market.completed_candles(sym, cfg.trend_timeframe, cfg.ema_trend + 20)
                self.health.data_ok()
            except MarketDataError as e:
                self.health.error(str(e))
                self.skip(sym, f"{sym}: market data unusable: {e}")
                continue
            except ExchangeError as e:
                self.health.error(str(e))
                say("ERROR", f"{type(e).__name__}: {e}")
                continue
            self.db.kv_set(last_key, candles[-1].time)
            dec = self.strategy.evaluate(candles, trend)
            if dec.signal is None:
                log.info("%s: no signal: %s", sym, dec.reason)
                continue
            sig = dec.signal
            if self._clock() - (sig.candle_time + tf) > tf:
                self.skip(sym, f"{sym}: signal candle too old to act on")
                continue
            say("SIGNAL", f"{sig.direction} {sym} ({sig.reason})")
            if self.try_open(base, sym, sig):
                return

    def try_open(self, base: str, signal_symbol: str, sig) -> bool:
        cfg = self.cfg
        try:
            spot_q = self.market.quote(signal_symbol)
            sel = self.selector.select(self.instruments, sig.direction, {base: spot_q.mark}, bases=[base])
            if sel.instrument is None:
                self.skip(signal_symbol, f"{sel.reason}; " + "; ".join(sel.audit[:3]))
                return False
            inst = sel.instrument
            say("STATUS", f"Instrument selected: {inst.symbol} ({sel.reason})")
            self.by_pid.setdefault(inst.product_id, inst)
            q = self.market.quote(inst.symbol)
            self._feed_paper(inst, q)
            if inst.is_option:
                bad = option_quote_ok(q.bid, q.ask, q.bid_size, q.ask_size, self.selector.option_max_spread_pct)
                if bad:
                    self.skip(inst.symbol, f"{inst.symbol}: {bad}")
                    return False
            elif q.spread_pct > cfg.max_spread_pct:
                self.skip(inst.symbol, f"{inst.symbol}: spread {q.spread_pct:.3f}% exceeds {cfg.max_spread_pct}%")
                return False
            slip = cfg.slippage_bps / 10_000
            long_like = sig.direction == "LONG" or inst.is_option
            entry = q.ask * (1 + slip) if long_like else q.bid * (1 - slip)
            stop_dist = entry * cfg.option_stop_pct if inst.is_option else sig.stop_distance
            fees = FeeSchedule.resolve(cfg, inst)
            if not fees.exact:
                say("STATUS", "Fee schedule is ESTIMATED (not read from the exchange/config)")
            margin = self.available_margin_usd()
            if margin is None:
                self.skip(inst.symbol, "available balance could not be determined")
                return False
            plan = size_position(cfg, inst, sig.direction, entry, stop_dist, fees, margin, q.funding_pct,
                                 underlying_price=spot_q.mark if inst.is_option else None)
            if not plan.ok:
                self.skip(inst.symbol, plan.reason)
                return False
            d = self.risk.can_open(0, plan.econ.net_loss)
            if not d.allowed:
                self.skip("risk", d.reason)
                return False
            e = plan.econ
            say("STATUS", f"Plan {plan.side} {inst.symbol} x{plan.qty} entry<={plan.entry} SL={plan.stop} "
                          f"TP={plan.take_profit} notional=${plan.notional:.2f} margin=${plan.margin:.2f} "
                          f"netRisk=${e.net_loss:.4f} netReward=${e.net_reward:.4f} netRR={e.net_rr:.2f} "
                          f"fees={'EXACT' if fees.exact else 'ESTIMATED'}[{fees.source}]")
            self.orders.open_position(inst, plan, sig.reason, q, fees.source, e.entry_fee + e.exit_fee_tp)
            self.health.api_ok()
            return True
        except EntryAborted as e:
            say("SKIP", f"Reason: {e}")
        except (MarketDataError,) as e:
            self.skip(signal_symbol, f"market data: {e}")
        except AuthError as e:
            say("ERROR", f"authentication: {e}")
            self.risk.halt(f"authentication failure: {e}")
            say("SAFETY", "New entries disabled")
        except ExchangeError as e:
            self.health.error(str(e))
            say("ERROR", f"{type(e).__name__}: {e}")
        return False

    # ---------------------------------------------------------------- shutdown paths
    def emergency_shutdown(self) -> None:
        say("SAFETY", "EMERGENCY STOP requested: new entries disabled, flattening")
        self.risk.halt("emergency stop file present")
        for t in self.db.active_trades(self.cfg.environment):
            inst = self.by_pid.get(t["product_id"])
            if inst is None:
                continue
            try:
                self.orders.close_position(t["trade_id"], inst, "EMERGENCY_STOP")
                q = self.market.quote(inst.symbol)
                self._feed_paper(inst, q)
                self.positions.tick(self.db.get_trade(t["trade_id"]), inst, FeeSchedule.resolve(self.cfg, inst), q.mark)
            except Exception as e:  # noqa: BLE001
                say("ERROR", f"emergency close failed for {inst.symbol}: {e}")
                self.db.log_incident("CRITICAL", f"emergency close failed: {e}", t["trade_id"])
        say("SAFETY", "Emergency shutdown complete")

    def run_forever(self):
        def _sig(signum, _frm):
            self.stop_requested = True
            say("SAFETY", f"signal {signum} received: shutting down (open positions keep their exchange-side stops)")
        signal.signal(signal.SIGINT, _sig)
        signal.signal(signal.SIGTERM, _sig)
        rep = self.startup()
        self.health.print_status("NONE", self.daily_pnl_inr(), self.risk.halt_reason() or "")
        backoff = 1.0
        while not self.stop_requested:
            try:
                if self.tick() == "stop":
                    break
                backoff = 1.0
            except AuthError as e:
                say("ERROR", f"authentication: {e}")
                self.risk.halt(f"authentication failure: {e}")
            except Exception as e:  # noqa: BLE001 - keep the daemon alive, classify and log
                self.health.error(str(e))
                log.exception("tick failed")
                say("ERROR", f"{type(e).__name__}: {e}")
                backoff = min(backoff * 2, 60)
            if self.health.too_many_errors():
                self.risk.halt("too many consecutive errors")
                say("SAFETY", "New entries disabled")
                self.health.consecutive_errors = 0
            self._sleep(max(self.cfg.loop_interval, backoff if backoff > 1 else 0))
        say("STATUS", "Bot stopped")


# ====================================================================== CLI
def _prepare(cfg: Config):
    setup_logging(cfg.log_dir, cfg.log_level)
    os.makedirs(cfg.data_dir, exist_ok=True)
    db = Database(cfg.db_path)
    trading, public = build_clients(cfg)
    if cfg.trading_mode == "PAPER":
        market = MarketData(public, cfg)
        fees = FeeSchedule.resolve(cfg)
        client = PaperExchange(public, fees, balance_usd=float(os.environ.get("PAPER_BALANCE_USD", "1000")))
        db_bal = db.kv_get("paper_state")
        bot = Bot(cfg, client, db, market=market)
    else:
        bot = Bot(cfg, trading, db)
    return bot, db


def cmd_run(cfg):
    bot, db = _prepare(cfg)
    if cfg.trading_mode == "PAPER":
        say("STATUS", "PAPER mode: simulated fills; paper positions are NOT persisted across restarts "
                      "(use DEMO mode for restart-safe exchange-side testing)")
        for t in db.active_trades(cfg.environment):
            db.update_trade(t["trade_id"], status="ABORTED", error="paper session ended")
    say("STATUS", f"Environment: {cfg.environment}  mode={cfg.trading_mode}  orders="
                  f"{'ENABLED' if cfg.orders_enabled else 'DISABLED'}")
    bot.run_forever()


def cmd_check(cfg):
    bot, db = _prepare(cfg)
    say("STATUS", f"Config valid. REST={cfg.rest_url} mode={cfg.trading_mode}")
    try:
        bot.load_instruments()
        for base in cfg.watchlist:
            q = bot.market.quote(f"{base}USD")
            say("STATUS", f"{base}USD bid={q.bid} ask={q.ask} spread={q.spread_pct:.4f}%")
            sel = bot.selector.select(bot.instruments, cfg.preferred_direction, {base: q.mark})
            inst = sel.instrument
            if inst:
                fees = FeeSchedule.resolve(cfg, inst)
                one = inst.contract_value * q.mark
                say("STATUS", f"{inst.symbol}: id={inst.product_id} contract_value={inst.contract_value} "
                              f"tick={inst.tick_size} max_lev={inst.max_leverage:.1f} fees={fees.source}"
                              f"(maker {fees.maker}, taker {fees.taker})")
                say("STATUS", f"  1 contract ≈ ${one:,.2f} (₹{one * cfg.usd_inr_rate:,.0f}); limit "
                              f"₹{cfg.max_position_notional_inr:g} -> "
                              f"{'OK' if one <= cfg.max_position_notional_usd else 'EXCEEDS LIMIT: bot will skip'}")
            else:
                say("SKIP", f"Reason: {sel.reason}")
        if cfg.trading_mode != "PAPER":
            m = bot.available_margin_usd()
            say("STATUS", f"Authenticated OK. Available balance (USD-equivalent): {m}")
    except AuthError as e:
        say("ERROR", f"Authentication failed: {e}")
        return 2
    except (ExchangeError, MarketDataError) as e:
        say("ERROR", f"{type(e).__name__}: {e}")
        return 2
    return 0


def cmd_discover(cfg):
    setup_logging(cfg.log_dir, cfg.log_level)
    client = DeltaClient(cfg.rest_url)
    insts = discover(client.get_products())
    for i in insts:
        if i.kind in ("PERP", "CALL", "PUT") and (i.underlying in cfg.watchlist):
            print(f"{i.symbol:28s} {i.kind:5s} id={i.product_id:<8d} cv={i.contract_value:<10g} tick={i.tick_size:<8g} "
                  f"maxlev={i.max_leverage:<6.1f} state={i.state} strike={i.strike} exp={i.expiry}")


def cmd_status(cfg):
    db = Database(cfg.db_path)
    risk = RiskManager(cfg, db)
    print(f"environment={cfg.environment} halt={risk.halt_reason()} emergency_file={risk.emergency_stop_requested()}")
    print(f"daily net P&L: {risk.daily_net_pnl():.4f} USD ({risk.daily_net_pnl() * cfg.usd_inr_rate:.2f} INR); "
          f"consecutive losses today: {risk.consecutive_losses()}")
    for t in db.active_trades(cfg.environment):
        print("ACTIVE", t["trade_id"], t["symbol"], t["side"], t["status"], t["quantity"], t["entry_price"])
    for i in db.incidents(5):
        print("INCIDENT", dt.datetime.fromtimestamp(i["ts"]).isoformat(), i["severity"], i["message"])


def cmd_trades(cfg):
    db = Database(cfg.db_path)
    rows = db.all_trades(50)
    print("trade_id             symbol   side  status  qty entry     exit      gross     fees     funding  net       reason  fees_src")
    tot = 0.0
    for t in rows:
        f = lambda v: f"{v:.4f}" if v is not None else "-"
        print(f"{t['trade_id']} {t['symbol']:8s} {t['side']:5s} {t['status']:7s} {t['quantity'] or 0:<3d} "
              f"{f(t['entry_price']):9s} {f(t['exit_price']):9s} {f(t['gross_pnl']):9s} {f(t['fees']):8s} "
              f"{f(t['funding']):8s} {f(t['net_pnl']):9s} {t['exit_reason'] or '-'} {t['fee_source'] or '-'}")
        tot += t["net_pnl"] or 0.0
    print(f"TOTAL net P&L (shown trades): {tot:.4f} USD = {tot * cfg.usd_inr_rate:.2f} INR")


def cmd_report(cfg):
    """Redacted diagnostics to paste back for review: no keys, no secrets."""
    import json
    from logger import RedactingFilter
    print("=== CONFIG (secrets omitted) ===")
    print(json.dumps(cfg.safe_summary(), indent=1, default=str))
    print("=== CHECK ===")
    rc = cmd_check(cfg)
    print(f"check exit code: {rc}")
    print("=== STATUS ===")
    cmd_status(cfg)
    print("=== TRADES ===")
    cmd_trades(cfg)
    print("=== LAST LOG LINES ===")
    path = os.path.join(cfg.log_dir, "bot.log")
    if os.path.exists(path):
        import logging
        flt = RedactingFilter()
        for line in open(path, errors="replace").read().splitlines()[-40:]:
            rec = logging.LogRecord("r", logging.INFO, "", 0, line, (), None)
            flt.filter(rec)
            print(rec.msg)


def cmd_emergency(cfg):
    os.makedirs(cfg.data_dir, exist_ok=True)
    with open(cfg.emergency_file, "w") as f:
        f.write(f"emergency stop requested {dt.datetime.now().isoformat()}\n")
    print(f"Emergency stop file created: {cfg.emergency_file}. A running bot will flatten and stop within one loop.")


def cmd_clear_halt(cfg):
    db = Database(cfg.db_path)
    RiskManager(cfg, db).clear_halt()
    if os.path.exists(cfg.emergency_file):
        os.remove(cfg.emergency_file)
    print("Halt flag and emergency file cleared. Verify exchange state first (`check`, `status`).")


def cmd_backtest(cfg, args):
    from backtest import load_csv, run_backtest
    from strategy import Candle
    setup_logging(cfg.log_dir, cfg.log_level)
    if args.notional_inr:
        cfg.max_position_notional_inr = args.notional_inr
    if args.risk_inr:
        cfg.max_risk_per_trade_inr = args.risk_inr
        if not args.max_daily_loss_inr:
            cfg.max_daily_loss_inr = args.risk_inr * 5
    sym = args.symbol or f"{cfg.watchlist[0]}USD"
    client = DeltaClient(cfg.rest_url)
    from instrument_selector import parse_product
    try:
        inst = parse_product(client.get_product(sym))
    except ExchangeError as e:
        if not args.csv:
            raise
        print(f"[WARN] product spec unavailable ({e}); using ASSUMED spec (contract_value/tick via --contract-value/--tick-size) for offline CSV backtest")
        inst = parse_product({"id": 0, "symbol": sym, "contract_type": "perpetual_futures",
                              "contract_value": args.contract_value or "1",
                              "tick_size": args.tick_size or "0.0001", "state": "live",
                              "initial_margin": "1", "underlying_asset": {"symbol": sym[:-3]}})
    if args.csv:
        candles = load_csv(args.csv)
    else:
        tf = timeframe_seconds(cfg.timeframe)
        end = int(time.time()) // tf * tf
        start = end - args.days * 86400
        candles, cur = [], start
        while cur < end:
            nxt = min(end, cur + tf * 2000)
            for r in client.get_candles(sym, cfg.timeframe, cur, nxt):
                candles.append(Candle(int(r["time"]), float(r["open"]), float(r["high"]), float(r["low"]),
                                      float(r["close"]), float(r.get("volume") or 0)))
            cur = nxt
        candles = sorted({c.time: c for c in candles}.values(), key=lambda c: c.time)
    fees = FeeSchedule.resolve(cfg, inst)
    res = run_backtest(cfg, build_strategy("ema_cross", cfg), inst, candles, fees)
    s = res.stats()
    print(f"Backtest {sym} {cfg.timeframe}, {len(candles)} candles, fees={fees.source}")
    for k, v in s.items():
        print(f"  {k}: {v:.4f}" if isinstance(v, float) else f"  {k}: {v}")
    print("  (a profitable backtest is NOT evidence of future profit; confirm with forward testing)")


def cmd_demo_smoke(cfg, args):
    """Opt-in: places ONE far-from-market resting limit order on the DEMO account, verifies it by
    client_order_id, then cancels it. Refuses to run outside DEMO."""
    if cfg.trading_mode != "DEMO":
        print("demo-smoke requires TRADING_MODE=DEMO"); return 2
    if not args.i_understand_demo:
        print("Re-run with --i-understand-demo to place a test order on the DEMO account."); return 2
    setup_logging(cfg.log_dir, cfg.log_level)
    c = DeltaClient(cfg.rest_url, cfg.api_key, cfg.api_secret)
    sym = f"{cfg.watchlist[0]}USD"
    inst = discover([c.get_product(sym)])[0]
    q = MarketData(c, cfg).quote(sym)
    px = round(q.bid * 0.5 / inst.tick_size) * inst.tick_size
    cid = f"smoke{int(time.time())}"
    from order_manager import fmt
    o = c.place_order({"product_id": inst.product_id, "size": 1, "side": "buy", "order_type": "limit_order",
                       "limit_price": fmt(px, inst.tick_size), "time_in_force": "gtc", "client_order_id": cid})
    print("placed", o.get("id"), o.get("state"))
    got = c.get_order_by_client_id(cid)
    print("lookup by client id:", bool(got))
    c.cancel_order(o["id"], inst.product_id)
    print("cancelled")
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(description="Delta Exchange autonomous trading bot (demo-first)")
    p.add_argument("command", nargs="?", default="run",
                   choices=["run", "check", "discover", "status", "trades", "emergency-stop", "clear-halt",
                            "backtest", "demo-smoke", "report"])
    p.add_argument("--env-file")
    p.add_argument("--csv"); p.add_argument("--symbol"); p.add_argument("--days", type=int, default=30)
    p.add_argument("--notional-inr", type=float); p.add_argument("--risk-inr", type=float)
    p.add_argument("--max-daily-loss-inr", type=float)
    p.add_argument("--contract-value"); p.add_argument("--tick-size")
    p.add_argument("--i-understand-demo", action="store_true")
    args = p.parse_args(argv)
    try:
        cfg = load_config(dotenv_path=args.env_file)
        cfg.validate(need_credentials=args.command in ("run", "check", "demo-smoke", "report")
                     and cfg.trading_mode != "PAPER")
    except ConfigError as e:
        print(f"[ERROR] Configuration: {e}")
        return 1
    if args.command == "run":
        cmd_run(cfg)
    elif args.command == "check":
        return cmd_check(cfg)
    elif args.command == "discover":
        cmd_discover(cfg)
    elif args.command == "status":
        cmd_status(cfg)
    elif args.command == "trades":
        cmd_trades(cfg)
    elif args.command == "emergency-stop":
        cmd_emergency(cfg)
    elif args.command == "clear-halt":
        cmd_clear_halt(cfg)
    elif args.command == "backtest":
        cmd_backtest(cfg, args)
    elif args.command == "demo-smoke":
        return cmd_demo_smoke(cfg, args)
    elif args.command == "report":
        cmd_report(cfg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
