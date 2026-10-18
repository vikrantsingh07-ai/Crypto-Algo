# Delta Exchange API notes

Sources used (all read during development): Delta's official API documentation source
(`github.com/delta-exchange/slate`, `source/includes/_*.md`, changelog up to 16 Oct 2026), the official
`delta-rest-client` (PyPI 1.0.14) and CCXT's Delta implementation for cross-checks. The docs web host and the API hosts were
**not reachable from the build sandbox**, so nothing below was exercised against the real exchange.

## Environments (each fully independent: keys, product ids, balances)

| `DELTA_ENV` | REST | Public WS | Private WS |
|---|---|---|---|
| `production` (Delta India, **real funds**) | `https://api.india.delta.exchange` | `wss://public-socket.india.delta.exchange` | `wss://socket.india.delta.exchange` |
| `testnet` (India demo account) | `https://cdn-ind.testnet.deltaex.org` | `wss://socket-ind-pub.testnet.deltaex.org` | `wss://socket-ind.testnet.deltaex.org` |
| `global` / `global-testnet` | `https://api.delta.exchange` / `https://testnet-api.delta.exchange` | per Global docs (currently `*.faida.trade` hosts) — **re-check** | idem |
| `custom` | `DELTA_REST_URL` | `DELTA_WS_PUBLIC_URL` | `DELTA_WS_PRIVATE_URL` |

A key created for one environment returns `invalid_api_key` on another. ETHUSD's product id on India production is listed as `3136` in the docs; the bot reads the id from `GET /v2/products/ETHUSD` and never hard-codes it.

## Authentication (documented)

`signature = hex(HMAC_SHA256(api_secret, METHOD + timestamp + path + "?query" + body))`; headers `api-key`, `timestamp` (epoch **seconds**), `signature`, and a mandatory `User-Agent` (requests without one get 403 from the CDN). A signature is valid for **5 seconds** (`SignatureExpired` otherwise) ⇒ the client learns the server clock offset from `Date` headers and resyncs/retries once. Query values are encoded like Python's `quote_plus`, byte-for-byte as in the official client (verified with vectors in `packages/delta/test/signing.test.ts`).

Key permissions: *Read Data* and *Trading*. **There is no withdrawal permission**, so a key can never withdraw. Trading keys require IP whitelisting. The docs say orders/positions/wallet need *Trading*.

Private WebSocket: `{"type":"key-auth","payload":{"api-key","signature","timestamp"}}`, signature = HMAC of `"GET" + timestamp + "/live"`.

## Endpoints used

| Purpose | Endpoint | Weight* |
|---|---|---|
| Contract spec (contract value, tick, fees, margin, status) | `GET /v2/products/{symbol}` | 3 |
| Ticker / quote fallback | `GET /v2/tickers/{symbol}` | 3 |
| Order book | `GET /v2/l2orderbook/{symbol}` | 3 |
| OHLCV (≤ 2000 candles per call; paged) | `GET /v2/history/candles` | 3 |
| Balances | `GET /v2/wallet/balances` | 3 |
| Position (real-time) | `GET /v2/positions?product_id=` | 3 |
| Open orders | `GET /v2/orders?product_ids=&states=open,pending` | 3 |
| Place / cancel | `POST /v2/orders`, `DELETE /v2/orders` | 5 |
| Order status | `GET /v2/orders/{id}`, `GET /v2/orders/client_order_id/{id}` | 1 |
| Fills (authoritative commission) | `GET /v2/fills` | 10 |
| Leverage | `GET/POST /v2/products/{id}/orders/leverage` | 1 |

\* Per the docs: default quota 20,000 weight per 5-minute window; HTTP 429 with `X-RATE-LIMIT-RESET` (ms). The client limiter budgets 70 % of the quota, honours 429 back-offs, and lets reduce-only exits wait through a back-off rather than fail. Product-level matching-engine limit: 500 ops/s (irrelevant at this order rate).

WebSocket channels (public endpoint, current docs; the legacy `l1_orderbook`, `l2_orderbook`, `v2/ticker`, `all_trades` channels are deprecated on 31 Oct 2026 and are **not** used): `ob_l1`, `trades`, `candlestick_1m`, `mark_price` (`MARK:ETHUSD`), `funding_rate`. Private: `orders`, `positions`, `margins`, `v2/user_trades`. Heartbeat: `enable_heartbeat` ⇒ message every ~30 s; the client reconnects after 35 s of silence, with exponential back-off + jitter (HTTP 429 on connect ⇒ wait 5–10 min), then replays subscriptions.

Orders sent: **entry** = `limit_order` + `time_in_force: ioc` priced at ask/bid ± `maxSlippageUsd` (a slippage-capped taker entry), `reduce_only:false`; **stop** = `market_order` + `stop_order_type: stop_loss_order` + `stop_price` + `stop_trigger_method: mark_price`, `reduce_only:true`; **target** = resting `limit_order`, `reduce_only:true`; **exits** = `market_order`, `reduce_only:true`. `size` is an integer number of contracts (`quantityEth / contract_value`); `client_order_id` ≤ 32 chars.

Deliberately **not** used: `POST /v2/orders/bracket` (TP is trigger-based, not a maker order), `DELETE /v2/orders/all` (its flags are ambiguous and could cancel protective stops), and the Deadman Switch (`cancel_orders` would cancel the protective stop too).

## Contract multiplier and quantity unit

Linear `vanilla` perpetual: P&L = (exit − entry) × `contract_value` × contracts. At 0.01 ETH/contract, **0.20 ETH = 20 contracts**; $4 / $5 / $6 ⇒ $0.80 / $1.00 / $1.20 gross. The bot reads `contract_value`; if 0.20 ETH is not a whole number of contracts it refuses to save/activate. Max leverage is derived as `100 / initial_margin%` from the product. `inverse` contracts are rejected.

## Fees

Product fields `maker_commission_rate` / `taker_commission_rate` (docs sample: 0.02 % / 0.05 %). Commission = rate × notional; GST (18 %) is added in estimates. In Live the **fill's reported commission is authoritative**: the adapter reads `meta_data.total_commission_in_settling_asset` when a fill has it, otherwise `commission` (`mapFill` in `packages/delta/src/mappers.ts`). Only `commission`, `role`, `size`, `price` and the timestamp of each fill are stored (`live_fills`); the raw `meta_data` is not.

### Scalper Offer (closing-fee waiver): what the API does and does not tell us

* **Terms are operator-supplied.** Close within 30 minutes (BTCUSD and ETHUSD; 15 for other futures) and the closing fee is waived on eligible trades; the opening fee is still paid; the account must have joined; liquidations are not eligible; Delta may change or end it. Nothing in the API documentation used for this project mentions the offer. A web search (result summaries only; Delta's pages could not be opened from the build sandbox) found no enrolment endpoint or flag either, so **enrolment cannot be read or verified through the API**.
* **How a waived fee appears in a fill is unknown.** Most plausibly `commission` is `0`, but a charge with an offsetting credit is not excluded. The v2 docs list, on a fill, `commission`, `role` and a `meta_data` object (`commission_deto`, `effective_commission_rate`, `total_commission_in_settling_asset`, `tfc_used_for_commission`, `trading_fee_credits_used`), and on orders `paid_commission`; what these hold for a waived close is not documented. The bot's check treats a closing commission ≤ $0.001 as waived and anything higher as charged (see [`STRATEGY_AND_FEES.md`](STRATEGY_AND_FEES.md#live-verification)). If Delta reports a charge and credits it later, the check will read "charged".
* **Which orders count is unknown**: whether the clock starts at the first or the latest entry fill, and whether reduce-only stop-market, resting take-profit and API-placed market closes are treated like manual closes. The bot assumes all of them are (and that a maker closing fill is waived like a taker one); the first live closes of each kind (take-profit, stop, time exit) are the test.
* **Testnet**: no text found says whether the offer exists on the India testnet / demo environment. Do not expect waived closing fees there and do not read a testnet result as evidence about production.
* The Diwali Scalper Offer (opening fee returned as a Fee Voucher, BTCUSD only) does not apply to this ETHUSD bot and is not modelled.
* **What the bot does about it**: Demo, backtests and the pre-trade gates assume the waiver while `execution.exitFeeWaiver.enabled`; Live P&L uses the reported commission; the first eligible live closes confirm or refute the assumption (`live.scalper.status`). No request in this project reads the offer.

## Open items to confirm on testnet before real money

1. `ETHUSD`: actual `contract_value`, tick size, max leverage, fee rates (the dashboard shows what was read; activation blocks until verified).
2. A **reduce-only stop and a reduce-only limit target at full size can coexist** (the executor handles a rejection by flattening only if the *stop* fails; a rejected target falls back to the software target monitor).
3. Whether a reduce-only market close is accepted while the stop is resting (the executor cancels the stop and retries once if rejected).
4. Whether `commission` on fills already includes GST (Live uses the reported amount; estimates add GST, e.g. $0.30 + 18 % = $0.354 for a taker leg on $600 notional; compare with the statement); whether INR is the settling currency and how `GET /wallet/balances` reports it (`settling_asset.symbol` is used; INR balances are converted with `usdInrRate`).
5. `GET /v2/wallet/balances` and `/positions` with your key's permissions.
6. Funding-rate unit on the WebSocket (`fr: 0.01` is read as 0.01 %); only Demo's funding simulation uses it.
7. Behaviour of `stop_trigger_method: mark_price` in fast markets (a software backstop engages if price runs 50¢ beyond the stop with the position still open).
8. **Scalper Offer** (the bot's assumptions, none verified): that a closing fill inside the window reports a commission of 0 for take-profit (maker), stop and time-exit (taker) closes alike; which fill starts the 30 minutes; whether ETHUSD's window is 30 or 15 minutes today (some Delta-sourced text says 15 for futures other than BTC); and whether the testnet has the offer. On the first eligible close compare the dashboard's *Scalper Offer* card (`lastCheck`) with the fill on Delta's trade history.
