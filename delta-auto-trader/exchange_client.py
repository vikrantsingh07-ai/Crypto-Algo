"""Signed REST client for Delta Exchange (India).

Auth (docs.delta.exchange, "Authentication"): headers api-key, timestamp (epoch seconds), signature,
User-Agent. signature = hex(HMAC_SHA256(secret, METHOD + timestamp + path + query_string + body)),
where query_string includes the leading "?" when present. A signature is valid for 5 seconds.

Error classes:
  AuthError            invalid key / signature / permissions / IP whitelist   -> never retried
  RateLimitError       HTTP 429                                               -> read: wait + retry
  ExchangeReject       business rejection (4xx with error body)               -> never retried
  TransientError       network/5xx on a READ                                  -> retried with backoff
  AmbiguousOrderError  timeout / 5xx / connection loss on an order WRITE      -> NEVER retried here;
                       the caller must query the exchange by client_order_id.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any, Dict, List, Optional
from urllib.parse import urlencode

import requests

from logger import get_logger

log = get_logger("exchange")

USER_AGENT = "delta-auto-trader/1.0 (python-requests)"


class ExchangeError(Exception):
    pass


class AuthError(ExchangeError):
    pass


class RateLimitError(ExchangeError):
    def __init__(self, msg, reset_ms: int = 0):
        super().__init__(msg)
        self.reset_ms = reset_ms


class ExchangeReject(ExchangeError):
    def __init__(self, msg, code: str = "", body: Any = None):
        super().__init__(msg)
        self.code, self.body = code, body


class TransientError(ExchangeError):
    pass


class AmbiguousOrderError(ExchangeError):
    pass


def sign(secret: str, method: str, timestamp: str, path: str, query_string: str, body: str) -> str:
    msg = method + timestamp + path + query_string + body
    return hmac.new(secret.encode(), msg.encode(), hashlib.sha256).hexdigest()


AUTH_CODES = {"invalid_api_key", "signature mismatch", "ip_not_whitelisted_for_api_key",
              "signatureexpired", "unauthorizedapiaccess", "forbidden"}


class DeltaClient:
    def __init__(self, base_url: str, api_key: str = "", api_secret: str = "", timeout: float = 10.0,
                 session: Optional[requests.Session] = None, max_read_retries: int = 3,
                 sleep=time.sleep, clock=time.time):
        self.base_url = base_url.rstrip("/")
        self.api_key, self.api_secret = api_key, api_secret
        self.timeout = timeout
        self.session = session or requests.Session()
        self.max_read_retries = max_read_retries
        self._sleep, self._clock = sleep, clock
        self.clock_offset = 0.0  # server - local, learned from Date header
        self.last_ok: float = 0.0

    # ------------------------------------------------------------------ core
    def _headers(self, method: str, path: str, query: str, body: str, auth: bool) -> Dict[str, str]:
        h = {"User-Agent": USER_AGENT, "Content-Type": "application/json", "Accept": "application/json"}
        if auth:
            if not self.api_key or not self.api_secret:
                raise AuthError("API credentials missing")
            ts = str(int(self._clock() + self.clock_offset))
            h.update({"api-key": self.api_key, "timestamp": ts,
                      "signature": sign(self.api_secret, method, ts, path, query, body)})
        return h

    def _classify(self, resp) -> Any:
        status = resp.status_code
        try:
            data = resp.json()
        except ValueError:
            data = None
        if status == 429:
            reset = 0
            try:
                reset = int(resp.headers.get("X-RATE-LIMIT-RESET", 0))
            except (TypeError, ValueError):
                pass
            raise RateLimitError("rate limited", reset)
        err = data.get("error") if isinstance(data, dict) else None
        code = ""
        if isinstance(err, dict):
            code = str(err.get("code", ""))
        elif isinstance(err, str):
            code = err
        if status in (401, 403) or code.lower() in AUTH_CODES:
            raise AuthError(f"auth failure: {code or status}")
        if status >= 500:
            raise TransientError(f"server error {status}")
        if status >= 400 or (isinstance(data, dict) and data.get("success") is False):
            raise ExchangeReject(f"rejected ({status}): {code}", code, data)
        if data is None:
            raise TransientError("non-JSON response")
        return data

    def _request(self, method: str, path: str, params: Optional[dict] = None, body: Optional[dict] = None,
                 auth: bool = False, is_order_write: bool = False) -> Any:
        query = ("?" + urlencode(params)) if params else ""
        payload = json.dumps(body, separators=(",", ":")) if body is not None else ""
        attempts = 1 if (is_order_write or method != "GET") else self.max_read_retries + 1
        last: Exception = TransientError("no attempt")
        for i in range(attempts):
            headers = self._headers(method, path, query, payload, auth)  # fresh timestamp each try
            try:
                resp = self.session.request(method, self.base_url + path + query, data=payload or None,
                                            headers=headers, timeout=self.timeout)
            except (requests.Timeout, requests.ConnectionError) as e:
                if is_order_write:
                    raise AmbiguousOrderError(f"{method} {path}: {type(e).__name__}") from e
                last = TransientError(f"{method} {path}: {type(e).__name__}")
            else:
                self._learn_clock(resp)
                try:
                    data = self._classify(resp)
                    self.last_ok = self._clock()
                    return data
                except RateLimitError as e:
                    last = e
                    if method == "GET":
                        self._sleep(min(max(e.reset_ms / 1000.0, 0.5), 30))
                    else:
                        raise
                except TransientError as e:
                    if is_order_write:
                        raise AmbiguousOrderError(f"{method} {path}: {e}") from e
                    last = e
                except AuthError as e:
                    if "signatureexpired" in str(e).lower() and i + 1 < attempts:
                        last = e
                        continue
                    raise
            if i + 1 < attempts:
                self._sleep(min(2 ** i * 0.5, 8))
        raise last

    def _learn_clock(self, resp) -> None:
        d = resp.headers.get("Date") if getattr(resp, "headers", None) else None
        if d:
            try:
                from email.utils import parsedate_to_datetime
                self.clock_offset = parsedate_to_datetime(d).timestamp() - self._clock()
            except Exception:  # pragma: no cover
                pass

    # -------------------------------------------------------------- public data
    def get_products(self) -> List[dict]:
        out: List[dict] = []
        params: Dict[str, Any] = {"page_size": 500}
        while True:
            r = self._request("GET", "/v2/products", params)
            out.extend(r.get("result", []))
            after = (r.get("meta") or {}).get("after")
            if not after or len(r.get("result", [])) == 0:
                break
            params["after"] = after
        return out

    def get_product(self, symbol: str) -> dict:
        return self._request("GET", f"/v2/products/{symbol}")["result"]

    def get_ticker(self, symbol: str) -> dict:
        return self._request("GET", f"/v2/tickers/{symbol}")["result"]

    def get_orderbook(self, symbol: str, depth: int = 10) -> dict:
        return self._request("GET", f"/v2/l2orderbook/{symbol}", {"depth": depth})["result"]

    def get_candles(self, symbol: str, resolution: str, start: int, end: int) -> List[dict]:
        r = self._request("GET", "/v2/history/candles",
                          {"symbol": symbol, "resolution": resolution, "start": int(start), "end": int(end)})
        return r.get("result", [])

    # ------------------------------------------------------------ private data
    def get_balances(self) -> List[dict]:
        return self._request("GET", "/v2/wallet/balances", auth=True)["result"]

    def get_position(self, product_id: int) -> dict:
        r = self._request("GET", "/v2/positions", {"product_id": product_id}, auth=True)["result"]
        if isinstance(r, list):
            r = r[0] if r else {}
        return r or {}

    def get_open_orders(self, product_id: Optional[int] = None) -> List[dict]:
        params: Dict[str, Any] = {"states": "open,pending"}
        if product_id is not None:
            params["product_ids"] = product_id
        return self._request("GET", "/v2/orders", params, auth=True)["result"]

    def get_order(self, order_id) -> dict:
        return self._request("GET", f"/v2/orders/{order_id}", auth=True)["result"]

    def get_order_by_client_id(self, client_order_id: str) -> Optional[dict]:
        try:
            return self._request("GET", f"/v2/orders/client_order_id/{client_order_id}", auth=True)["result"]
        except ExchangeReject as e:
            if "not_found" in e.code.lower() or "not found" in str(e).lower():
                return None
            raise

    def get_fills(self, product_id: Optional[int] = None, start_time_us: Optional[int] = None) -> List[dict]:
        params: Dict[str, Any] = {"page_size": 100}
        if product_id is not None:
            params["product_ids"] = product_id
        if start_time_us:
            params["start_time"] = int(start_time_us)
        return self._request("GET", "/v2/fills", params, auth=True)["result"]

    # ------------------------------------------------------------------ writes
    def place_order(self, payload: dict) -> dict:
        """Never retried. Timeouts surface as AmbiguousOrderError."""
        return self._request("POST", "/v2/orders", body=payload, auth=True, is_order_write=True)["result"]

    def cancel_order(self, order_id: int, product_id: int) -> dict:
        return self._request("DELETE", "/v2/orders", body={"id": order_id, "product_id": product_id},
                             auth=True, is_order_write=True)["result"]

    def set_leverage(self, product_id: int, leverage: float) -> dict:
        return self._request("POST", f"/v2/products/{product_id}/orders/leverage",
                             body={"product_id": product_id, "leverage": str(leverage)}, auth=True)["result"]
