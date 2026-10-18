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

`app_state` (key/value documents: `settings`, `bot_state`, demo account, `live_waiver`), `trades` (`mode` = `demo`|`live`, with open positions; `exit_fee_saved` since migration `apps/server/migrations/002_exit_fee_saved.sql`, `NULL` on older rows), `live_orders` (every real order reference, unique `client_order_id`), `live_fills`, `audit_log` (append-only via trigger), `equity_snapshots`, `backtest_runs`, `credentials` (AES-256-GCM), `worker_lease`, `schema_migrations`. Demo and live rows never share a table row; every query takes the mode. Migrations in `apps/server/migrations/` run at start.

## Live executor lifecycle

1. fresh `reconcile()` (balances, position, open orders vs. database) → `reconciled` flag
2. risk manager (account + signal checks) — all fail closed; economics gates use the live fee view (see Scalper Offer below)
3. ensure leverage; **write-ahead** trade + order rows; submit IOC entry (deterministic `client_order_id`)
4. confirm fill from the exchange position; fee from fills; place stop (fail ⇒ flatten) and target
5. monitor: software target (if market TP), time exit (28.5 min while the Scalper Offer waiver is effective, `exits.maxHoldMinutes` otherwise; a failed close is retried every tick), break-even tightening (new stop first), 50¢ software stop backstop
6. close: cancel target → reduce-only market close (retry, free the stop if needed) → verify flat → finalise from real fills (commission = what the exchange reported; hold = opening fill → closing fill) → check the Scalper Offer assumption against the closing commission
7. restart: adopt the position, re-create missing protection, finalise trades that closed while down (these are verified against the offer too); an **untracked** exchange position blocks entries until an operator closes it

## Scalper Offer (closing-fee waiver)

Delta charges no closing fee when a position is closed within 30 minutes (terms supplied by the operator; see [`STRATEGY_AND_FEES.md`](STRATEGY_AND_FEES.md)). The offer is not visible through the API, so the code **assumes** it for estimates and **checks** it on real closes. The Diwali Scalper Offer (BTCUSD only) is not modelled anywhere.

| Layer | Where | What |
|---|---|---|
| Settings | `packages/core/src/settings.ts` | `execution.exitFeeWaiver` `{ enabled: true, withinMinutes: 30, safetyMarginSeconds: 90, clampTimeExit: true }`; `effectiveMaxHoldMs()` = `min(exits.maxHoldMinutes, window − margin)` = 28.5 min while the waiver is on; `validateSettings` warns about the clamp and refuses a break-even time at or after it |
| Fees | `packages/core/src/fees.ts` | `calcFee` waives an exit leg when `enabled ∧ holdMs ≤ window` (the entry leg never); `FeeBreakdown { waived, saved }`; `estimateEconomics` returns `entryFee`, `exitFeeWaived`, `exitFeeSaved`; `feeConfigFrom(settings, spec, { waiverOverride })` lets Live override the setting |
| Simulator | `packages/core/src/{paper,backtest,metrics}.ts` | Demo and backtests share the code: waived exits, `timeExitMs`, `breakevenStopPrice(…, heldMs)`, `ClosedTrade.exitFeeSaved`, `metrics.feesSavedUsd` |
| Risk gates | `packages/core/src/risk.ts` | `evaluateEntryRisk({ …, feeOptions })`; the gates themselves are unchanged, only their fee inputs differ |
| Live state | `apps/server/src/services/liveExecutor.ts` | `waiver` = `{ status, confirmedCount, lastCheck, since }` persisted as the `live_waiver` document; `waiverEffective()` = setting ON ∧ status ≠ `not_applied`; every Live fee computation, the entry gates and the time exit go through it; `verifyWaiver()` runs once per finalised trade whose closing fills are known |
| Snapshot | `apps/server/src/services/bot.ts` | `economics.scalper` (assumed / effective / liveEffective / window / margin / effective max hold), `*NoWaiver` tables and break-evens for the with-vs-without comparison |
| Activation | `apps/server/src/services/activation.ts` | non-blocking check `scalper_offer`; `summary.scalperOffer`; a fifth risk acknowledgement; the review token's hash includes the waiver settings, so changing them invalidates a reviewed token |
| API | `apps/server/src/api.ts` | `POST /api/live/waiver/reset` (admin, audited, needs the active worker); status in `GET /api/state` → `live.scalper` and in the `POST /api/live/reconcile` response; `GET /api/trades` rows carry `exitFee` and `exitFeeSaved`; `GET /api/analytics` → `metrics.feesSavedUsd` |
| Backtests | `apps/server/src/services/backtestService.ts` | an assumption sentence in `assumptions`, structured form in `summary.scalperOffer`, `costNote` with `entryFeeUsd` / `exitFeeWaived` |
| Mock exchange | `packages/delta/src/mock/mockExchange.ts` | `scalperOffer: { enabled, windowMs }`, default **off**: a fill that closes (part of) a position opened at most `windowMs` earlier on the mock clock reports commission 0, the closing part of a flip is waived, the new side is charged. `npm run dev:mock` turns it on (`MOCK_SCALPER_OFFER=false` turns it off). This is a stand-in written from the operator's terms, not a recording of Delta |
| Dashboard | `apps/web/components/` | status chip "Scalper Offer: …" in the top bar; Demo: exit-fee clock on the open position, per-trade "exit FREE (saved $x)", with/without fee card; Live: *Scalper Offer — closing-fee waiver* card with *Reset & re-check…* (admin); Strategy & Risk: the four settings with a readout of the clamped time exit; Analytics: *Closing fees saved*; activation wizard: waiver row and an information-only check |

### Live status

`unverified` (initial, after a reset, after any change to `execution.exitFeeWaiver.*`) → `confirmed` when an eligible close paid a closing commission ≤ $0.001 → `not_applied` when an eligible close paid more. `not_applied` is sticky until a reset. An eligible close needs the setting ON, a non-liquidation, known exit fills and hold ≤ window − 5 s. Full rules, field shapes and audit actions: [`STRATEGY_AND_FEES.md`](STRATEGY_AND_FEES.md#live-verification); operator steps: [`OPERATIONS.md`](OPERATIONS.md#scalper-offer-not-applied).

### Safety properties kept

* The waiver changes cost estimates only. It adds no path that opens exposure, does not touch the choke point (`LiveExecutor.submit()`), the kill switch, reconciliation or any fail-closed rule.
* Live P&L is always the exchange-reported commission; the assumption never replaces a real number. The estimate is used only when closing fills could not be fetched (`commissionSource` in the trade meta).
* A contradiction from the exchange moves Live to full-fee economics (fewer trades). Nothing but an admin reset or a settings change moves it back.
* Verification is bookkeeping: if it throws, the error is logged and the closed position is still finalised.
* The status document is read once at start on standby instances and is not refreshed there; the reset endpoint refuses (`409 worker_not_active_here`) on a non-worker instance.
* The `live_waiver` document is one document per database. It is not keyed by Delta environment or API key.

## Audit

Logins, forbidden attempts, settings changes (changed paths), credential changes (fingerprint only), preflight, activation (success/failure with check results), mode switches, kill switch, manual closes, demo resets, backtests, and the Scalper Offer events `scalper_offer_confirmed`, `scalper_offer_not_applied` and `scalper_offer_status_reset`. Visible to admins at `GET /api/audit`.
