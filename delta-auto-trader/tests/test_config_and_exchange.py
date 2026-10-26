import hashlib
import hmac
import json

import pytest
import requests

from config import (DEMO_REST, LIVE_PHRASE, LIVE_REST, ConfigError, load_config)
from exchange_client import (AmbiguousOrderError, AuthError, DeltaClient, ExchangeReject, RateLimitError,
                             TransientError, sign)


class Resp:
    def __init__(self, status=200, body=None, headers=None):
        self.status_code, self._body, self.headers = status, body, headers or {}

    def json(self):
        if self._body is None:
            raise ValueError
        return self._body


class FakeSession:
    def __init__(self, script):
        self.script, self.calls = list(script), []

    def request(self, method, url, data=None, headers=None, timeout=None):
        self.calls.append((method, url, data, headers))
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def mk(script, **kw):
    return DeltaClient(DEMO_REST, "key123", "secret456", session=FakeSession(script), sleep=lambda s: None,
                       clock=lambda: 1_700_000_000.0, **kw)


# ---- signature
def test_signature_matches_documented_scheme():
    expected = hmac.new(b"secret", b"GET1700000000/v2/orders?product_id=1&state=open", hashlib.sha256).hexdigest()
    assert sign("secret", "GET", "1700000000", "/v2/orders", "?product_id=1&state=open", "") == expected


def test_headers_and_signature_on_request():
    c = mk([Resp(200, {"success": True, "result": []})])
    c.get_open_orders(5)
    method, url, data, h = c.session.calls[0]
    assert h["api-key"] == "key123" and h["timestamp"] == "1700000000" and h["User-Agent"]
    q = "?states=open%2Cpending&product_ids=5"
    assert url.endswith("/v2/orders" + q)
    assert h["signature"] == sign("secret456", "GET", "1700000000", "/v2/orders", q, "")


def test_post_body_is_signed_exactly_as_sent():
    c = mk([Resp(200, {"success": True, "result": {"id": 1}})])
    c.place_order({"product_id": 1, "size": 2})
    _, _, data, h = c.session.calls[0]
    assert h["signature"] == sign("secret456", "POST", h["timestamp"], "/v2/orders", "", data)
    assert json.loads(data) == {"product_id": 1, "size": 2}


def test_public_requests_carry_no_credentials():
    c = DeltaClient(DEMO_REST, session=FakeSession([Resp(200, {"result": []})]))
    c.get_candles("BTCUSD", "5m", 1, 2)
    assert "api-key" not in c.session.calls[0][3]


# ---- errors
def test_invalid_credentials_raise_auth_error_and_are_not_retried():
    c = mk([Resp(401, {"success": False, "error": {"code": "invalid_api_key"}})])
    with pytest.raises(AuthError):
        c.get_balances()
    assert len(c.session.calls) == 1


def test_missing_credentials_fail_before_network():
    c = DeltaClient(DEMO_REST, session=FakeSession([]))
    with pytest.raises(AuthError):
        c.get_balances()


def test_exchange_rejection_is_not_retried():
    c = mk([Resp(400, {"success": False, "error": {"code": "insufficient_margin"}})])
    with pytest.raises(ExchangeReject) as e:
        c.place_order({"x": 1})
    assert e.value.code == "insufficient_margin" and len(c.session.calls) == 1


def test_read_retries_on_timeout_then_succeeds():
    c = mk([requests.Timeout(), requests.ConnectionError(), Resp(200, {"result": [{"id": 1}]})])
    assert c.get_balances() == [{"id": 1}]
    assert len(c.session.calls) == 3


def test_read_gives_up_after_retries():
    c = mk([requests.Timeout()] * 4)
    with pytest.raises(TransientError):
        c.get_balances()


def test_order_timeout_is_ambiguous_and_never_retried():
    c = mk([requests.Timeout(), Resp(200, {"result": {"id": 9}})])
    with pytest.raises(AmbiguousOrderError):
        c.place_order({"x": 1})
    assert len(c.session.calls) == 1


def test_order_5xx_is_ambiguous():
    c = mk([Resp(502, None)])
    with pytest.raises(AmbiguousOrderError):
        c.place_order({"x": 1})


def test_rate_limit_on_read_waits_and_retries():
    waits = []
    c = mk([Resp(429, {}, {"X-RATE-LIMIT-RESET": "2000"}), Resp(200, {"result": []})])
    c._sleep = waits.append
    assert c.get_balances() == []
    assert waits and waits[0] == 2.0


def test_signature_expired_retries_with_fresh_signature():
    c = mk([Resp(401, {"error": "SignatureExpired"}), Resp(200, {"result": []})])
    assert c.get_balances() == []
    assert len(c.session.calls) == 2


# ---- config / isolation
def test_default_is_demo_and_live_disabled():
    cfg = load_config(env={})
    assert cfg.trading_mode == "DEMO" and not cfg.enable_live_trading
    assert cfg.rest_url == DEMO_REST and cfg.environment == "DEMO"


def test_live_requires_flag_phrase_and_live_keys():
    with pytest.raises(ConfigError):
        load_config(env={"TRADING_MODE": "LIVE"}).validate()
    with pytest.raises(ConfigError):
        load_config(env={"TRADING_MODE": "LIVE", "ENABLE_LIVE_TRADING": "true"}).validate()
    env = {"TRADING_MODE": "LIVE", "ENABLE_LIVE_TRADING": "true", "LIVE_CONFIRMATION": LIVE_PHRASE}
    with pytest.raises(ConfigError):
        load_config(env=env).validate()          # no live keys
    cfg = load_config(env={**env, "DELTA_LIVE_API_KEY": "k", "DELTA_LIVE_API_SECRET": "s"})
    cfg.validate()
    assert cfg.rest_url == LIVE_REST


def test_demo_never_uses_live_credentials():
    env = {"TRADING_MODE": "DEMO", "DELTA_LIVE_API_KEY": "LIVEKEY", "DELTA_LIVE_API_SECRET": "LIVESECRET"}
    cfg = load_config(env=env)
    assert cfg.api_key == "" and cfg.rest_url == DEMO_REST
    with pytest.raises(ConfigError):
        cfg.validate()


def test_live_never_uses_demo_credentials():
    env = {"TRADING_MODE": "LIVE", "DELTA_DEMO_API_KEY": "D", "DELTA_DEMO_API_SECRET": "D"}
    assert load_config(env=env).api_key == ""


def test_live_flag_with_demo_mode_is_rejected():
    with pytest.raises(ConfigError):
        load_config(env={"TRADING_MODE": "DEMO", "ENABLE_LIVE_TRADING": "true",
                         "DELTA_DEMO_API_KEY": "a", "DELTA_DEMO_API_SECRET": "b"}).validate()


def test_separate_databases_per_mode():
    assert load_config(env={"TRADING_MODE": "DEMO"}).db_path != load_config(env={"TRADING_MODE": "PAPER"}).db_path


def test_invalid_values_rejected():
    with pytest.raises(ConfigError):
        load_config(env={"TRADING_MODE": "PAPER", "RR_MODE": "X"}).validate(False)
    with pytest.raises(ConfigError):
        load_config(env={"TRADING_MODE": "PAPER", "MAX_RISK_PER_TRADE_INR": "abc"})
    with pytest.raises(ConfigError):
        load_config(env={"TRADING_MODE": "PAPER", "INITIAL_PREFERRED_DIRECTION": "SHORT"}).validate(False)


def test_secrets_not_in_summary_or_repr():
    cfg = load_config(env={"DELTA_DEMO_API_KEY": "SUPERSECRETKEY", "DELTA_DEMO_API_SECRET": "SUPERSECRETVAL"})
    assert "SUPERSECRET" not in repr(cfg) and "SUPERSECRET" not in str(cfg.safe_summary())
