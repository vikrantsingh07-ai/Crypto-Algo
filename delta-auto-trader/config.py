"""Configuration loading, validation and environment isolation.

Environment isolation rules (enforced here, not only by convention):
  * PAPER/DEMO may only ever use the demo (testnet) REST/WS URLs and the DEMO_* credentials.
  * LIVE needs ENABLE_LIVE_TRADING=true AND LIVE_CONFIRMATION=<exact phrase> AND LIVE_* credentials.
  * The URL used is derived from TRADING_MODE; it cannot be set independently.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import List, Optional

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover
    load_dotenv = None

DEMO_REST = "https://cdn-ind.testnet.deltaex.org"
DEMO_WS_PRIVATE = "wss://socket-ind.testnet.deltaex.org"
DEMO_WS_PUBLIC = "wss://socket-ind-pub.testnet.deltaex.org"
LIVE_REST = "https://api.india.delta.exchange"
LIVE_WS_PRIVATE = "wss://socket.india.delta.exchange"
LIVE_WS_PUBLIC = "wss://public-socket.india.delta.exchange"
LIVE_PHRASE = "I ACCEPT REAL MONEY RISK"

MODES = ("PAPER", "DEMO", "LIVE")


class ConfigError(Exception):
    pass


def _b(v: Optional[str], default: bool) -> bool:
    if v is None or v.strip() == "":
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def _f(env, key, default):
    v = env.get(key)
    if v is None or v.strip() == "":
        return default
    try:
        return float(v.split("#")[0].strip())
    except ValueError:
        raise ConfigError(f"{key} must be a number, got {v!r}")


def _i(env, key, default):
    return int(_f(env, key, default))


def _s(env, key, default=""):
    v = env.get(key)
    return default if v is None else v.split("#")[0].strip()


def timeframe_seconds(tf: str) -> int:
    units = {"m": 60, "h": 3600, "d": 86400}
    if len(tf) < 2 or tf[-1] not in units or not tf[:-1].isdigit():
        raise ConfigError(f"Invalid timeframe {tf!r}")
    return int(tf[:-1]) * units[tf[-1]]


@dataclass
class Config:
    trading_mode: str = "DEMO"
    enable_live_trading: bool = False
    live_confirmation: str = ""
    allow_order_placement: bool = True
    api_key: str = field(default="", repr=False)
    api_secret: str = field(default="", repr=False)

    preferred_direction: str = "LONG"
    watchlist: List[str] = field(default_factory=lambda: ["XRP", "DOGE"])
    market_type: str = "PERPETUAL"
    explicit_symbols: List[str] = field(default_factory=list)
    allow_other_contracts: bool = False

    usd_inr_rate: float = 88.0
    max_position_notional_inr: float = 10.0
    max_risk_per_trade_inr: float = 2.0
    risk_reward_ratio: float = 2.0
    rr_mode: str = "GROSS_RR"
    max_daily_loss_inr: float = 10.0
    max_open_positions: int = 1
    max_leverage: float = 3.0
    max_trades_per_day: int = 6
    max_consecutive_losses: int = 3
    cooldown_minutes: float = 30.0
    max_hold_minutes: float = 480.0
    daily_reset_tz: str = "Asia/Kolkata"

    timeframe: str = "15m"
    trend_timeframe: str = "1h"
    ema_fast: int = 9
    ema_slow: int = 21
    ema_trend: int = 200
    rsi_period: int = 14
    rsi_long_min: float = 50.0
    rsi_long_max: float = 70.0
    rsi_short_min: float = 30.0
    rsi_short_max: float = 50.0
    atr_period: int = 14
    atr_stop_mult: float = 1.5
    allow_short: bool = False
    max_spread_pct: float = 0.1
    min_volume: float = 0.0

    maker_fee_rate: Optional[float] = None
    taker_fee_rate: Optional[float] = None
    gst_rate: float = 0.18
    slippage_bps: float = 5.0
    max_tp_r_multiple: float = 4.0
    option_stop_pct: float = 0.30

    trading_hours: str = "24/7"
    log_level: str = "INFO"
    loop_interval: float = 15.0
    stale_data_seconds: float = 90.0
    data_dir: str = "./data"
    log_dir: str = "./logs"

    # ---- derived ----
    @property
    def environment(self) -> str:
        return {"PAPER": "DEMO", "DEMO": "DEMO", "LIVE": "LIVE"}[self.trading_mode]

    @property
    def rest_url(self) -> str:
        return LIVE_REST if self.trading_mode == "LIVE" else DEMO_REST

    @property
    def ws_public_url(self) -> str:
        return LIVE_WS_PUBLIC if self.trading_mode == "LIVE" else DEMO_WS_PUBLIC

    @property
    def ws_private_url(self) -> str:
        return LIVE_WS_PRIVATE if self.trading_mode == "LIVE" else DEMO_WS_PRIVATE

    @property
    def db_path(self) -> str:
        # separate DB per environment so demo and live records can never mix
        return os.path.join(self.data_dir, f"trades_{self.trading_mode.lower()}.db")

    @property
    def emergency_file(self) -> str:
        return os.path.join(self.data_dir, "EMERGENCY_STOP")

    @property
    def max_position_notional_usd(self) -> float:
        return self.max_position_notional_inr / self.usd_inr_rate

    @property
    def max_risk_usd(self) -> float:
        return self.max_risk_per_trade_inr / self.usd_inr_rate

    @property
    def max_daily_loss_usd(self) -> float:
        return self.max_daily_loss_inr / self.usd_inr_rate

    @property
    def orders_enabled(self) -> bool:
        return self.allow_order_placement and self.trading_mode in ("PAPER", "DEMO", "LIVE")

    def validate(self, need_credentials: bool = True) -> None:
        if self.trading_mode not in MODES:
            raise ConfigError(f"TRADING_MODE must be one of {MODES}, got {self.trading_mode!r}")
        if self.trading_mode == "LIVE":
            if not self.enable_live_trading:
                raise ConfigError("TRADING_MODE=LIVE refused: ENABLE_LIVE_TRADING is not true.")
            if self.live_confirmation != LIVE_PHRASE:
                raise ConfigError(f"TRADING_MODE=LIVE refused: LIVE_CONFIRMATION must equal {LIVE_PHRASE!r}.")
        elif self.enable_live_trading:
            raise ConfigError("ENABLE_LIVE_TRADING=true is only valid with TRADING_MODE=LIVE (isolation guard).")
        if self.trading_mode in ("DEMO", "LIVE") and need_credentials and (not self.api_key or not self.api_secret):
            kind = "DELTA_LIVE_API_KEY/SECRET" if self.trading_mode == "LIVE" else "DELTA_DEMO_API_KEY/SECRET"
            raise ConfigError(f"Missing credentials: set {kind} for TRADING_MODE={self.trading_mode}.")
        if self.rr_mode not in ("GROSS_RR", "NET_RR"):
            raise ConfigError("RR_MODE must be GROSS_RR or NET_RR")
        if self.market_type not in ("PERPETUAL", "OPTIONS", "CONFIGURABLE"):
            raise ConfigError("MARKET_TYPE must be PERPETUAL, OPTIONS or CONFIGURABLE")
        if self.market_type == "CONFIGURABLE" and not self.explicit_symbols:
            raise ConfigError("MARKET_TYPE=CONFIGURABLE requires EXPLICIT_SYMBOLS")
        if self.preferred_direction not in ("LONG", "SHORT"):
            raise ConfigError("INITIAL_PREFERRED_DIRECTION must be LONG or SHORT")
        if self.preferred_direction == "SHORT" and not self.allow_short:
            raise ConfigError("INITIAL_PREFERRED_DIRECTION=SHORT requires ALLOW_SHORT=true")
        for name in ("usd_inr_rate", "max_position_notional_inr", "max_risk_per_trade_inr",
                     "risk_reward_ratio", "max_daily_loss_inr", "max_leverage", "atr_stop_mult"):
            if getattr(self, name) <= 0:
                raise ConfigError(f"{name.upper()} must be > 0")
        if self.max_open_positions < 1 or self.max_trades_per_day < 1:
            raise ConfigError("MAX_OPEN_POSITIONS and MAX_TRADES_PER_DAY must be >= 1")
        if self.ema_fast >= self.ema_slow:
            raise ConfigError("EMA_FAST must be < EMA_SLOW")
        timeframe_seconds(self.timeframe)
        timeframe_seconds(self.trend_timeframe)
        if not self.watchlist and not self.explicit_symbols:
            raise ConfigError("WATCHLIST is empty")
        if self.trading_hours != "24/7":
            raise ConfigError("Only TRADING_HOURS=24/7 is implemented")

    def safe_summary(self) -> dict:
        d = {k: v for k, v in self.__dict__.items() if k not in ("api_key", "api_secret")}
        d["rest_url"] = self.rest_url
        d["credentials_present"] = bool(self.api_key and self.api_secret)
        return d


def load_config(env: Optional[dict] = None, dotenv_path: Optional[str] = None) -> Config:
    if env is None:
        if load_dotenv:
            load_dotenv(dotenv_path)
        env = os.environ
    mode = _s(env, "TRADING_MODE", "DEMO").upper()
    # credentials are selected by mode so a live key can never be sent to the demo host
    prefix = "DELTA_LIVE_" if mode == "LIVE" else "DELTA_DEMO_"
    maker = _s(env, "MAKER_FEE_RATE")
    taker = _s(env, "TAKER_FEE_RATE")
    cfg = Config(
        trading_mode=mode,
        enable_live_trading=_b(env.get("ENABLE_LIVE_TRADING"), False),
        live_confirmation=_s(env, "LIVE_CONFIRMATION"),
        allow_order_placement=_b(env.get("ALLOW_ORDER_PLACEMENT"), True),
        api_key=_s(env, prefix + "API_KEY"),
        api_secret=_s(env, prefix + "API_SECRET"),
        preferred_direction=_s(env, "INITIAL_PREFERRED_DIRECTION", "LONG").upper(),
        watchlist=[x.strip().upper() for x in _s(env, "WATCHLIST", "XRP,DOGE").split(",") if x.strip()],
        market_type=_s(env, "MARKET_TYPE", "PERPETUAL").upper(),
        explicit_symbols=[x.strip().upper() for x in _s(env, "EXPLICIT_SYMBOLS").split(",") if x.strip()],
        allow_other_contracts=_b(env.get("ALLOW_OTHER_CONTRACTS"), False),
        usd_inr_rate=_f(env, "USD_INR_RATE", 88.0),
        max_position_notional_inr=_f(env, "MAX_POSITION_NOTIONAL_INR", 10),
        max_risk_per_trade_inr=_f(env, "MAX_RISK_PER_TRADE_INR", 2),
        risk_reward_ratio=_f(env, "RISK_REWARD_RATIO", 2),
        rr_mode=_s(env, "RR_MODE", "GROSS_RR").upper(),
        max_daily_loss_inr=_f(env, "MAX_DAILY_LOSS_INR", 10),
        max_open_positions=_i(env, "MAX_OPEN_POSITIONS", 1),
        max_leverage=_f(env, "MAX_LEVERAGE", 3),
        max_trades_per_day=_i(env, "MAX_TRADES_PER_DAY", 6),
        max_consecutive_losses=_i(env, "MAX_CONSECUTIVE_LOSSES", 3),
        cooldown_minutes=_f(env, "COOLDOWN_MINUTES", 30),
        max_hold_minutes=_f(env, "MAX_HOLD_MINUTES", 480),
        daily_reset_tz=_s(env, "DAILY_RESET_TZ", "Asia/Kolkata"),
        timeframe=_s(env, "TIMEFRAME", "15m"),
        trend_timeframe=_s(env, "TREND_TIMEFRAME", "1h"),
        ema_fast=_i(env, "EMA_FAST", 9), ema_slow=_i(env, "EMA_SLOW", 21), ema_trend=_i(env, "EMA_TREND", 200),
        rsi_period=_i(env, "RSI_PERIOD", 14),
        rsi_long_min=_f(env, "RSI_LONG_MIN", 50), rsi_long_max=_f(env, "RSI_LONG_MAX", 70),
        rsi_short_min=_f(env, "RSI_SHORT_MIN", 30), rsi_short_max=_f(env, "RSI_SHORT_MAX", 50),
        atr_period=_i(env, "ATR_PERIOD", 14), atr_stop_mult=_f(env, "ATR_STOP_MULT", 1.5),
        allow_short=_b(env.get("ALLOW_SHORT"), False),
        max_spread_pct=_f(env, "MAX_SPREAD_PCT", 0.1), min_volume=_f(env, "MIN_VOLUME", 0),
        maker_fee_rate=float(maker) if maker else None,
        taker_fee_rate=float(taker) if taker else None,
        gst_rate=_f(env, "GST_RATE", 0.18), slippage_bps=_f(env, "SLIPPAGE_BPS", 5),
        max_tp_r_multiple=_f(env, "MAX_TP_R_MULTIPLE", 4.0), option_stop_pct=_f(env, "OPTION_STOP_PCT", 0.30),
        trading_hours=_s(env, "TRADING_HOURS", "24/7"),
        log_level=_s(env, "LOG_LEVEL", "INFO").upper(),
        loop_interval=_f(env, "LOOP_INTERVAL_SECONDS", 15),
        stale_data_seconds=_f(env, "STALE_DATA_SECONDS", 90),
        data_dir=_s(env, "DATA_DIR", "./data"), log_dir=_s(env, "LOG_DIR", "./logs"),
    )
    return cfg
