# Architecture

## Processes

* **Dashboard** (`apps/web`, Vercel): server components + a proxy under `/api/*`. Holds only an `httpOnly` session cookie. Allow-listed backend paths, CSRF check (same-origin + `x-requested-with`), optional `PROXY_SHARED_SECRET`. The query string is forwarded, so `GET /api/state?slim=1` reaches the backend.
* **Backend** (`apps/server`): one Node process = Fastify API + trading worker. The worker acquires a database lease (`worker_lease`, TTL 30 s, renewed every 5 s). A second instance stays a read-only API replica and takes over if the lease expires.
* **Browser market feed** (`apps/web/lib/market`): the page itself opens a WebSocket to Delta's PUBLIC market-data endpoint (no key, no secret, no orders). It draws the price, the chart and the order flow. It is independent of the backend worker.

## Data flow

```
Delta public WS / REST ─▶ DeltaMarketFeed ─ quote ─▶ Bot ─▶ DemoEngine.onQuote  (manages simulated exits)
                                         └ closed 1m candle ─▶ strategy (core) ─▶ signal
                                                                   │
                                          mode = demo ─▶ risk manager ─▶ DemoEngine.tryEnter  (paper fills)
                                          mode = live ─▶ risk manager ─▶ LiveExecutor.tryEnter ─▶ Delta REST
Delta private WS (orders/positions/fills) ─▶ PrivateStream ─▶ debounce ─▶ LiveExecutor.reconcile (REST = truth)

Browser ─ GET /api/state (every 2 s) ─▶ Vercel proxy ─▶ backend snapshot (account, algo, trades, 180 closed 1m candles)
        └ wss public-socket.india.delta.exchange ─▶ useDeltaMarket ─▶ price, chart, order flow (backend quote = fallback)
```

Candles: seeded from REST; the WebSocket `candlestick_1m` updates the forming bar; each closed minute is **confirmed against REST** (authoritative) and a flat carry-forward candle is used for minutes without trades so indicators stay continuous. If the WebSocket stalls the feed falls back to REST ticker polling.

## Persistence (PostgreSQL; embedded PGlite for local/tests)

`app_state` (key/value documents: `settings` (versioned, see below), `bot_state`, demo account, `live_waiver`), `trades` (`mode` = `demo`|`live`, with open positions; `exit_fee_saved` since migration `apps/server/migrations/002_exit_fee_saved.sql`, `NULL` on older rows), `live_orders` (every real order reference, unique `client_order_id`), `live_fills`, `audit_log` (append-only via trigger), `equity_snapshots`, `backtest_runs`, `credentials` (AES-256-GCM), `worker_lease`, `schema_migrations`. Demo and live rows never share a table row; every query takes the mode. SQL migrations in `apps/server/migrations/` run at start.

## Settings versioning (version 2)

The `settings` document carries a numeric `version` (`SETTINGS_VERSION = 2` in `packages/core/src/settings.ts`). v2 is the "no time limit, fees on both legs, fixed $10 target" change. The schema itself never migrates (a partial document must keep what it states); the upgrade is an explicit step:

* `migrateSettings(raw)` (core, pure, idempotent) upgrades a document with `version < 2` (a missing version counts as 1): `exits.maxHoldMinutes = null`, `exits.timeExitPolicy = "none"`, `execution.exitFeeWaiver.enabled = false`, `targets.targetMoveMinUsd = targetMoveMaxUsd = 10`, `targets.stopLossMinUsd = 5`, `stopLossMaxUsd = 8`, `goals.dailyProfitInr = 500`, `version = 2`. Every other stored value is kept.
* `Repos.loadSettingsMigrating()` (`apps/server/src/repos.ts`, called by `runtime.ts` at start) runs it before `SettingsSchema.parse` and writes the upgraded document back **once** (compare-and-set on the stored version, so two instances starting together cannot both do it) together with one `settings_migrated` audit row (`details: { from, to, changed: [dotted paths] }`) in the same transaction. A second start changes nothing. A fresh database gets the schema defaults. A legacy document that cannot be parsed is left untouched, the defaults are used and a `settings_migration_failed` audit row is written.
* `PUT /api/settings` ignores a `version` sent by the client, so a stale browser tab cannot downgrade it. `null` clears the time limit.
* `exits.maxHoldMinutes` is `number | null`. `effectiveMaxHoldMs(settings)` returns `Infinity` for "no limit"; JSON snapshots send `effectiveMaxHoldMinutes` (null) instead, and no snapshot ever contains `Infinity` or `NaN` (tested by walking every number).

## Live executor lifecycle

1. fresh `reconcile()` (balances, position, open orders vs. database) → `reconciled` flag
2. risk manager (account + signal checks) — all fail closed; the per-trade loss cap always uses full brokerage on both legs
3. ensure leverage; **write-ahead** trade + order rows; submit IOC entry (deterministic `client_order_id`)
4. confirm fill from the exchange position; fee from fills; place stop (fail ⇒ flatten) and target
5. monitor: software target (if market TP), software stop backstop 50¢ beyond the exchange-side stop, and, **only if a time limit or the break-even policy is configured**, the time exit (a failed close is retried every tick) and break-even tightening (new stop first). With the defaults (`maxHoldMinutes = null`, policy `none`) nothing closes a position for time; the stop-loss and the target are the exits. `timeBackstop()` is a no-op without a limit.
6. close: cancel target → reduce-only market close (retry, free the stop if needed) → verify flat → finalise from real fills (commission = what the exchange reported, both legs; hold = opening fill → closing fill)
7. restart: adopt the position, re-create missing protection, finalise trades that closed while down; an **untracked** exchange position blocks entries until an operator closes it

## Snapshot (`GET /api/state`)

`Bot.snapshot()` plus `serverTime`; every older key is kept. The v2 additions (`apps/server/src/services/bot.ts`, `today.ts`, `holdLimit.ts`):

| Key | Content |
|---|---|
| `market` | `{ quote, candles, forming? }`: the last up to 180 **closed** 1-minute candles oldest first (`{ t, o, h, l, c, v }`, `t` = open time ms) and the forming candle moved to the newest quote. The candle array is rebuilt only when the closed set changes. Seeds the browser chart; the quote is the browser's fallback price |
| `demo.today` | `{ day, trades, wins, losses, netPnlUsd, netPnlInr, feesUsd, goalInr, tradesLimit }` for the current **IST** calendar day (UTC+5:30), counting trades **closed** that day in the current demo epoch |
| `economics.roundTrip` | `{ priceUsd, qtyEth, notionalUsd, entryFeeUsd, exitFeeUsd, totalFeeUsd }`: taker/taker brokerage at the current price via core `roundTripFee`, waiver never applied (about USD 0.80 for 0.20 ETH at ETH 3,390; follows the rates). `state.economics` is `null` while there is no quote |
| `settings.exits.maxHoldMinutes`, `…effectiveMaxHoldMinutes` | number or `null` (`null` = no time limit) |
| activation summary | `maxHoldMinutes` (null), `holdNote` (the holding rule in plain words), a non-blocking `holding_rule` check, and settings-dependent acknowledgements (5 by default; a 6th only if the waiver is on) |

`GET /api/state?slim=1` returns the same body with `market.candles = []`, `spark = []` and `slim: true`; the two chart series are about two thirds of the 27 KiB full body. An older backend ignores the parameter and sends the full state, which the dashboard handles.

**Read limits.** The dashboard polls several read endpoints every 1-2 s per open tab, so GET reads (`state`, `settings`, `trades`, `analytics`, `backtests`, `credentials`, `auth/me`) are limited per signed-in user (3000/min) and anonymous or invalid-token callers per IP (120/min). `POST /api/auth/login` stays at 10/min per IP, `PUT /api/settings` at 30/min, other write routes keep their strict limits, and the global default is 600/min per IP. `GET /api/trades` and `GET /api/analytics` answers are shared for 1 s between pollers and dropped at once when this process writes a trade.

## The dashboard (`apps/web`)

* **Two views over one polled state.** `components/Dashboard.tsx` owns what both share: the polled snapshot (2 s visible, 10 s hidden, immediate refresh when the tab returns, overlapping responses cannot overwrite newer ones; a full snapshot first and every 30 s, `?slim=1` in between, with the chart series merged back from the last full one), who is signed in, the toast, and the modals (activation wizard, switch to demo, kill switch). It then renders either `components/simple/SimpleView.tsx` (default) or `components/DeveloperView.tsx` (the original tabs Demo / Live / Strategy & Risk / Analytics). The choice is stored in the browser (`localStorage` key `ca_view`, wrapped in try/catch so blocked storage still renders).
* **Simple view** layout on a wide screen: `[price + live chart] [order flow]` over `[my simulated account] [what the algo is doing]`; on a phone: price + chart, order flow, algo activity, account. It shows no raw risk codes, settings, fee tables or connection internals, and never says anything about a time limit countdown or an exit-fee offer. Account and algo cards read the backend snapshot; if the backend lacks `demo.today` the same numbers are worked out from the trade list.
* **Market components** (`components/market`: `PriceHero`, `PriceChart`, `OrderFlow`, plus the `StatusPill`) are display-only and take a `MarketState` from `useDeltaMarket` (`lib/market/useDeltaMarket.ts`). A page calls the hook **once** and passes the result down (each call opens its own socket; Delta allows 150 connections per 5 minutes per IP). Order flow: buyers on the left in green, sellers on the right in red, 10 levels each side, bars anchored at the outer edge and growing toward the price, a thin thread from every bar to the price plate in the middle.
* **Browser feed internals** (`lib/market`, pure modules so each can be tested without a browser): `protocol.ts` (messages), `book.ts` (the incremental order book with sequence and CRC32 checks, reproducing the two checksum examples in Delta's docs), `candles.ts`, `model.ts` (the status model `connecting → live → fallback → down`), `feed.ts` (socket lifecycle: back-off with jitter, 10 s silence rule, resync on gaps, StrictMode-safe single socket), `store.ts` (React updates batched to at most about 20 per second; a hidden tab does no React work). Subscribed channels: `ob_l1`, `ob_l2` (a second depth source while the incremental book resyncs), `ob_updates`, `trades`, `candlestick_1m`, `mark_price` (`MARK:ETHUSD`), `ticker` (24 h change). Documented versus inferred behaviour: [`apps/web/lib/market/PROTOCOL.md`](../apps/web/lib/market/PROTOCOL.md).
* **Fallback rules.** `live` = the browser feed is fresh; `connecting` = the first connection (about 8 s); `fallback` = the feed is not live and the backend quote changed within 2 minutes (the pill reads "Delayed", the order flow shows skeleton bars); `down` = neither. When the backend reports synthetic development data the browser feed is switched off so test prices never mix with real Delta prices.
* **Content-Security-Policy** (`apps/web/next.config.ts`): `connect-src 'self' wss://public-socket.india.delta.exchange wss://socket.india.delta.exchange https://api.india.delta.exchange`. The browser feed needs only the first Delta host; the other two are allowed so a documented fallback needs no redeploy and can be removed for a tighter policy. A feed pointed at testnet also needs `wss://socket-ind-pub.testnet.deltaex.org`. No `unsafe-eval` in production.

## The dormant exit-fee waiver

Delta's "Scalper Offer" (operator-supplied terms, unverified) is **not assumed**: `execution.exitFeeWaiver.enabled` defaults to `false`, brokerage is charged on both legs everywhere, and nothing user-facing mentions the offer while it is off. The code path is kept for an account that has joined: it lives in `packages/core/src/{settings,fees,paper,risk}.ts` (`calcFee`, `waiverGuaranteed`, `effectiveMaxHoldMs`), in the live executor's `waiver` state (the `live_waiver` document, `POST /api/live/waiver/reset`) and in the mock exchange's `scalperOffer` option (off unless `MOCK_SCALPER_OFFER=true`). `roundTripFee` and the per-trade loss cap never apply it. Live P&L is always the exchange-reported commission, and the waiver adds no path that opens exposure and does not touch the choke point (`LiveExecutor.submit()`), the kill switch, reconciliation or any fail-closed rule. Behaviour and state machine: [`STRATEGY_AND_FEES.md`](STRATEGY_AND_FEES.md#the-dormant-optional-exit-fee-waiver-off-by-default); operator steps: [`OPERATIONS.md`](OPERATIONS.md#if-you-switched-the-exit-fee-waiver-on-and-it-says-not-applied).

## Deployment on one Oracle VM

`deploy/oracle/docker-compose.yml` runs three containers on one VM: `db` (Postgres 16), `server` (this repo's `Dockerfile`, health check on `/api/health`) and `caddy` (automatic HTTPS). `user-data.sh` (cloud-init) clones `main` to `/opt/cryptoalgo` and runs `setup.sh`, which installs Docker, creates `deploy/oracle/.env` once (mode 600, secrets generated once and kept) and starts the stack. `update.sh` is the update path: root only, one run at a time (`flock`), refuses to run when tracked files have local changes, `git pull --ff-only --quiet`, `docker compose up -d --build`, then polls the server's own health check (`HEALTH_TIMEOUT` 300 s, `HEALTH_INTERVAL` 5 s) and prints `OK: …` or `NOT healthy …` with the last 40 server log lines, every secret value from `.env` replaced by `***`. `DRY_RUN=1` makes read-only checks only. The web part updates itself: Vercel rebuilds `apps/web` from `main`.

## Audit

Logins, forbidden attempts, settings changes (changed paths), `settings_migrated` / `settings_migration_failed`, credential changes (fingerprint only), preflight, activation (success/failure with check results), mode switches, kill switch, manual closes, demo resets, backtests, and, only if the waiver is used, `scalper_offer_confirmed`, `scalper_offer_not_applied` and `scalper_offer_status_reset`. Visible to admins at `GET /api/audit`.
