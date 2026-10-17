# Architecture

## Processes

* **Dashboard** (`apps/web`, Vercel): server components + a proxy under `/api/*`. Holds only an `httpOnly` session cookie. Allow-listed backend paths, CSRF check (same-origin + `x-requested-with`), optional `PROXY_SHARED_SECRET`.
* **Backend** (`apps/server`): one Node process = Fastify API + trading worker. The worker acquires a database lease (`worker_lease`, TTL 30 s, renewed every 5 s). A second instance stays a read-only API replica and takes over if the lease expires.

## Data flow

```
Delta public WS / REST ─▶ DeltaMarketFeed ─ quote ─▶ Bot ─▶ DemoEngine.onQuote  (manages simulated exits)
                                         └ closed 1m candle ─▶ strategy (core) ─▶ signal
                                                                   │
                                          mode = demo ─▶ risk manager ─▶ DemoEngine.tryEnter  (paper fills)
                                          mode = live ─▶ risk manager ─▶ LiveExecutor.tryEnter ─▶ Delta REST
Delta private WS (orders/positions/fills) ─▶ PrivateStream ─▶ debounce ─▶ LiveExecutor.reconcile (REST = truth)
```

Candles: seeded from REST; the WebSocket `candlestick_1m` updates the forming bar; each closed minute is **confirmed against REST** (authoritative) and a flat carry-forward candle is used for minutes without trades so indicators stay continuous. If the WebSocket stalls the feed falls back to REST ticker polling.

## Persistence (PostgreSQL; embedded PGlite for local/tests)

`app_state` (settings, bot state, demo account), `trades` (`mode` = `demo`|`live`, with open positions), `live_orders` (every real order reference, unique `client_order_id`), `live_fills`, `audit_log` (append-only via trigger), `equity_snapshots`, `backtest_runs`, `credentials` (AES-256-GCM), `worker_lease`, `schema_migrations`. Demo and live rows never share a table row; every query takes the mode.

## Live executor lifecycle

1. fresh `reconcile()` (balances, position, open orders vs. database) → `reconciled` flag
2. risk manager (account + signal checks) — all fail closed
3. ensure leverage; **write-ahead** trade + order rows; submit IOC entry (deterministic `client_order_id`)
4. confirm fill from the exchange position; fee from fills; place stop (fail ⇒ flatten) and target
5. monitor: software target (if market TP), 30-min time exit, break-even tightening (new stop first), 50¢ software stop backstop
6. close: cancel target → reduce-only market close (retry, free the stop if needed) → verify flat → finalise from real fills
7. restart: adopt the position, re-create missing protection, finalise trades that closed while down; an **untracked** exchange position blocks entries until an operator closes it

## Audit

Logins, forbidden attempts, settings changes (changed paths), credential changes (fingerprint only), preflight, activation (success/failure with check results), mode switches, kill switch, manual closes, demo resets, backtests. Visible to admins at `GET /api/audit`.
