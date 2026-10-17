# CryptoAlgo — Demo-first ETH scalping bot for Delta Exchange

An automated **ETH perpetual futures scalper** for Delta Exchange (India) with a Vercel dashboard and an always-on trading worker.

> **Starts in `DEMO MODE — LIVE TRADING DISABLED`.** On a fresh install the bot trades only a *virtual* account against live prices with simulated fills and fees. **No real order can be sent** until an administrator completes a multi-step activation workflow (safety checks → review → password + typed phrase). Selecting "Live" in the dashboard never places an order by itself.

**Read this first — honest expectations**

* Nothing here is investment advice and **no profitability is claimed**. The strategy is objective and backtestable, but on the requested setup (0.20 ETH, **$4–$6 target**) *fees consume most of the gross move* (table below). Use Demo and the backtester to decide for yourself, and treat small samples as noise.
* Delta's API hosts were **not reachable from the sandbox this was built in**, so the exchange adapter is verified against Delta's *official documentation source*, the *official Python client* and a faithful local mock — **not against the live exchange**. See [What was and was not verified](#what-was-and-was-not-verified). Run the Demo-to-Live checklist, starting on the Delta **testnet**, before using real money.

---

## Contents

1. [Architecture](#architecture) · 2. [Safety model](#safety-model) · 3. [Quick start](#quick-start-local) · 4. [Using the dashboard](#using-the-dashboard) · 5. [Strategy, fees and what to expect](#strategy-fees-and-what-to-expect) · 6. [Backtesting](#backtesting) · 7. [Deployment](#deployment) · 8. [Delta API configuration](#delta-api-configuration) · 9. [Demo → Live checklist](#demo--live-checklist) · 10. [Testing](#testing) · 11. [Project layout](#project-layout) · 12. [Configuration reference](#configuration-reference) · 13. [What was and was not verified](#what-was-and-was-not-verified) · 14. [Known limitations](#known-limitations) · 15. [What you still need to do](#what-you-still-need-to-do)

More detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/DELTA_API.md`](docs/DELTA_API.md) · [`docs/STRATEGY_AND_FEES.md`](docs/STRATEGY_AND_FEES.md) · [`docs/GO_LIVE_CHECKLIST.md`](docs/GO_LIVE_CHECKLIST.md) · [`docs/OPERATIONS.md`](docs/OPERATIONS.md)

---

## Architecture

Vercel cannot run a 24/7 process, so the system is split:

```
 Browser ──HTTPS──▶ Vercel: Next.js dashboard (apps/web)
                       │  httpOnly session cookie; server-side proxy adds the bearer token
                       │  (backend URL + secrets never reach the browser)
                       ▼
        Always-on backend (apps/server) — Fly.io / Render / VPS (Docker)
          ├─ REST API  (auth, roles, rate limits, audit log)
          ├─ Trading worker  (market data → strategy → risk manager → Demo engine | Live executor)
          │     one active worker at a time (database lease)
          └─ Delta adapter (packages/delta): signed REST, WebSocket, reconnects, rate limiter
                       │                              │
                       ▼                              ▼
              Managed PostgreSQL            Delta Exchange (public WS + REST, private REST/WS)
```

* `packages/core` — pure trading logic (no I/O): settings, fee/P&L engine, indicators, strategy, risk manager, paper-execution simulator, backtester, walk-forward. The **same code** runs in backtests, Demo and Live.
* `packages/delta` — the exchange adapter. Strategy code never touches exchange details, so API changes stay local to this package.
* `apps/server` — API + worker + persistence. `apps/web` — dashboard.

Closing the browser never stops the bot. The worker is independent of any dashboard session.

## Safety model

| Layer | What it does |
|---|---|
| **Default state** | Fresh DB ⇒ `mode=demo`, `liveArmed=false`. Demo engine never imports the exchange client. |
| **One choke point** | Every order goes through `LiveExecutor.submit()`. A request that can open exposure (not reduce-only) is refused unless a *fresh database read* says `mode=live ∧ liveArmed ∧ running ∧ ¬killSwitch`. Tests assert zero orders reach the exchange otherwise. |
| **Activation workflow** | Preflight (credentials, contract, permissions, leverage, quantity, margin, balance, position/order sync, data freshness, clock) → review + 4 risk acknowledgements → password re-entry + exact phrase (`ENABLE LIVE TRADING`) → audit record. Review token expires in 5 min and is bound to the reviewed parameters. Admin only. |
| **Kill switch** | Separate admin button: blocks **all** entries (demo + live), disarms live, cancels resting entry orders, and (default) flattens with a **reduce-only** market order. Releasing it does **not** re-arm live. |
| **Mode switch Live → Demo** | New live entries stop immediately. An open real position is **never silently abandoned**: policy `keep_managing` (default), `close_at_market`, or `manual_review`, and it is flagged on the dashboard. |
| **Fail closed** | Stale data, unhealthy API, unreconciled exchange state, unverified contract spec, missing credentials, unknown order outcome ⇒ no new entries. |
| **Duplicate-order protection** | Deterministic `client_order_id` per signal candle, write-ahead order records, unique constraint, in-flight lock, exchange-side uniqueness. Ambiguous network failures are resolved by *looking the order up*, never by re-sending. |
| **Exchange-side protection** | Stop-loss (reduce-only stop-market) is placed right after the fill; if that fails the position is flattened immediately. Break-even tightening places the new stop *before* cancelling the old one. |
| **Risk manager** | ≤10 trades/rolling 24 h (hard ceiling), one position, per-trade risk, daily loss, max drawdown, loss-streak breaker + cooldown, free margin, liquidation-distance buffer, max spread/slippage, min **net** reward:risk after fees, stale data, API health, reconciliation. 50x never overrides any of them. No martingale, no size increase after losses. |
| **Secrets** | API keys live only on the backend: env vars or AES-256-GCM encrypted in the DB. Never returned by any API, never logged, never in the browser/Vercel. Delta keys have no withdrawal permission; you grant *Trading* only and whitelist the server IP. |
| **Auth** | bcrypt passwords, signed short-lived sessions in an `httpOnly; SameSite=Strict` cookie, `admin`/`viewer` roles, login lockout, per-route rate limits, CSRF checks, strict CSP, audit log (append-only at the DB level). Optional proxy shared secret. |
| **Deployment lock** | `LIVE_HARD_DISABLE=true` makes activation impossible regardless of the dashboard. |

## Quick start (local)

Requirements: Node ≥ 20.11 (22 recommended), npm. No database or Docker needed locally (an embedded Postgres is used).

```bash
git clone https://github.com/vikrantsingh07-ai/Crypto-Algo && cd Crypto-Algo
git checkout ccr-12ad71d8-4mu4gv        # the branch this was built on
npm install
npm test                                 # unit + integration tests
```

**Option A — try everything safely with the local mock exchange** (random-walk prices, full REST/WS/order/Live flow, nothing leaves your machine):

```bash
npm run dev:mock                         # backend on :8080 (prints a dev admin password), mock exchange on :9911
# second terminal
echo "BACKEND_URL=http://127.0.0.1:8080" > apps/web/.env.local
npm run dev:web                          # dashboard on http://localhost:3000
```

**Option B — real Delta market data in Demo** (needs internet access to `api.india.delta.exchange`; no API key required for market data):

```bash
cp .env.example .env                     # then edit: SESSION_SECRET, ADMIN_PASSWORD_HASH, DELTA_ENV=production|testnet
NODE_ENV=development npm run dev:server  # dev mode allows ADMIN_PASSWORD=...; production requires ADMIN_PASSWORD_HASH
npm run dev:web
```

**Option C — accelerated synthetic data** (UI/engine mechanics only; clearly labelled, refused in production): `MARKET_DATA_SOURCE=synthetic SYNTHETIC_SPEED=120 npm run dev:server`.

Generate an admin password hash: `npm run hash-password -- "a long passphrase"`.

## Using the dashboard

* **Header** — big **DEMO TRADING / LIVE TRADING** selector, an always-visible status label (`DEMO MODE — LIVE TRADING DISABLED`, `LIVE MODE — REAL ORDERS ENABLED`, `KILL SWITCH ENGAGED …`), connection indicators (market data, exchange account API, reconciliation), kill switch.
* **Demo Trading** — virtual equity (USD + INR), realised/unrealised P&L, simulated fees, drawdown, win rate, trades/24 h, current simulated position with entry/stop/target/holding time, signal diagnostics (which of the 10 conditions pass for Long/Short), risk status, trade history. Everything is labelled *Simulated*.
* **Live Trading** — disabled banner until activation; connection/API health, **real** balance and available margin, exchange positions, open orders, actual fees, risk status, real trade history. Unavailable or stale data is labelled as such; demo data is never shown here.
* **Strategy & Risk** — every setting (instrument, quantity, leverage, target band, stop, time-exit policy, risk limits, filters, strategy parameters, fee assumptions), validated server-side against the exchange contract; exchange connection (add/test/replace the API key); a live **fee reality check**.
* **Analytics** — paper results, live results and backtests, kept visibly separate: cumulative P&L, drawdown, daily P&L, trade distribution, exit reasons, holding time, long vs short, regimes, target-hit rate, with a *View as table* toggle on each chart.

Roles: `admin` can change settings, start/stop, activate Live, use the kill switch, run backtests; `viewer` is read-only.

## Strategy, fees and what to expect

**Strategy** (1-minute candles, closed bars only): trend alignment (EMA 9 > 21 > 55, rising), price on the right side of the UTC-day VWAP, N-bar breakout, momentum ≥ k·ATR, strong candle body/close, volume confirmation, "don't chase" (distance from EMA), Kaufman efficiency ratio (chop filter), ATR band (enough range for a $4–$6 move, not chaos), spread filter. Target = clamp(3·ATR, $4, $6); stop = clamp(2.5·ATR, $3, $6). Exits: take-profit (resting limit), stop, break-even tightening after 15 min when in profit, hard market close at 30 min. It never trades to fill a daily quota.

**Fee reality** (0.20 ETH = 20 contracts × 0.01 ETH; taker 0.05 %, maker 0.02 %, +18 % GST; computed by the fee engine and recomputed live in the dashboard):

| ETH price | Price move needed just to cover fees (maker TP / taker exit) | Net at $4 / $5 / $6 target (maker TP) | Win rate needed to break even (stop ≈ $4.5 + slippage) |
|---|---|---|---|
| $2,000 | $1.65 / $2.36 | +$0.47 / +$0.67 / +$0.87 | 75 % / 68 % / 62 % |
| $3,000 | $2.48 / $3.54 | +$0.30 / +$0.50 / +$0.70 | 84 % / 77 % / 70 % |
| $4,000 | $3.30 / $4.72 | +$0.14 / +$0.34 / +$0.54 | 93 % / 85 % / 78 % |

A $4 move on 0.20 ETH is $0.80 gross; a taker-in/taker-out round trip costs ≈ $0.71 at $3,000. The bot therefore uses a maker take-profit and **refuses trades whose expected net reward:risk is below your threshold** — but a strategy must still win roughly 70–85 % of the time to break even, which is a high bar. In simulation on random-walk data fees exceeded gross P&L. **Do not assume profit; measure it.** (No exit-fee waiver is assumed; see `docs/STRATEGY_AND_FEES.md`.)

## Backtesting

* Dashboard: **Analytics → Backtests** (admin) runs a single backtest (70 % in-sample / 30 % out-of-sample) or a **walk-forward** evaluation (parameters chosen on a training window, results reported only on the following untouched window).
* CLI: `npm run backtest -- --days 30 --kind walkforward --out result.json` downloads public 1-minute candles from Delta (no key) and prints the summary.
* Assumptions are printed with every result: entries at the next bar open + spread + slippage, stop-first when stop and target share a candle, maker/taker fees + GST, funding, all risk limits enforced. Results with < 100 trades are flagged statistically weak; the win-rate 95 % interval is shown.
* **No backtest on real Delta data was run during development** (hosts unreachable); the mechanics were exercised on clearly-labelled synthetic data only. Run it yourself before drawing conclusions.

## Deployment

### 1. Database (managed PostgreSQL)
Create a Postgres instance (Supabase, Neon, Render, Railway, RDS…). Set `DATABASE_URL` (+ `DATABASE_SSL=require` where the provider needs TLS). Migrations in `apps/server/migrations/*.sql` run automatically at start; to run them by hand: `DATABASE_URL=… npm run db:migrate`.

### 2. Backend worker (always-on) — pick one
Delta whitelists API keys by IP, so you need a **static outbound IP**, and the exchange runs in AWS Tokyo, so choose Tokyo/Singapore.

* **Fly.io** (`fly.toml`, region `nrt`): `fly launch --no-deploy --copy-config` → `fly secrets set SESSION_SECRET=… CREDENTIAL_ENCRYPTION_KEY=… ADMIN_PASSWORD_HASH=… PROXY_SHARED_SECRET=… DATABASE_URL=…` → `fly ips allocate-egress --region nrt` (whitelist that IP on Delta) → `fly deploy`.
* **Render** (`render.yaml` Blueprint, region Singapore, paid always-on plan; whitelist the service's outbound IPs shown in the dashboard).
* **VPS + Docker Compose** (`docker-compose.yml`): `cp .env.example .env && docker compose up -d --build`, put Caddy/nginx with TLS in front.
* Keep **exactly one instance**. A second instance becomes a read-only API replica automatically (database lease).

Generate secrets: `openssl rand -hex 32` (SESSION_SECRET, PROXY_SHARED_SECRET), `openssl rand -base64 32` (CREDENTIAL_ENCRYPTION_KEY), `npm run hash-password -- "…"` (ADMIN_PASSWORD_HASH).

### 3. Dashboard on Vercel
1. Import the repo in Vercel. **Root Directory:** `apps/web` (leave "Include source files outside of the Root Directory" enabled). Framework preset: Next.js (`apps/web/vercel.json` sets the install/build commands).
2. Environment variables (Production *and* Preview, server-side only): `BACKEND_URL` = your backend's `https://…`, `PROXY_SHARED_SECRET` = same value as on the backend.
3. Deploy. Open the site, sign in as `admin`. You should see `DEMO MODE — LIVE TRADING DISABLED`.

Never add exchange keys or any `NEXT_PUBLIC_*` secret to Vercel.

## Delta API configuration

1. Create a Delta account for the environment you want (**testnet/demo first**: `demo.delta.exchange`, API host `cdn-ind.testnet.deltaex.org`; production: `api.india.delta.exchange`). Environments are independent: keys, product IDs and balances differ.
2. *API management* → create a key with **Trading** permission (no other permission is needed; Delta keys cannot withdraw) and whitelist your backend's static IP.
3. Provide it either as `DELTA_API_KEY`/`DELTA_API_SECRET` on the backend, or in the dashboard (Strategy & Risk → Exchange connection; stored AES-256-GCM encrypted, shown only as a fingerprint). Use **Test connection**.
4. Set `DELTA_ENV=testnet` while rehearsing; the dashboard then labels the environment *sandbox* and the activation phrase becomes `ENABLE TESTNET TRADING`. Details and doc references: [`docs/DELTA_API.md`](docs/DELTA_API.md).

## Demo → Live checklist

The full version is in [`docs/GO_LIVE_CHECKLIST.md`](docs/GO_LIVE_CHECKLIST.md). In short: run Demo for days across regimes; run a walk-forward backtest on real data; **rehearse the entire Live flow on testnet** (entry, stop, target, kill switch, restart mid-position); verify the fee statement matches the bot's numbers; start with a small balance; keep `perTradeRisk`/`dailyLossLimit` tight; then Strategy & Risk → exchange key (production) → **Live Trading → Enable Live Trading…**.

## Testing

```bash
npm run typecheck     # all workspaces
npm test              # vitest: core + delta + server
```

Coverage highlights (all run against the real code paths; exchange responses come from the local mock that validates HMAC signatures):

* fees/GST/waiver/P&L (0.20 ETH = $0.80/$1.00/$1.20 at $4/$5/$6), contract-size mapping, settings validation
* Long and Short signals, cooldowns, warm-up, determinism; backtester invariants; walk-forward isolation
* risk limits (10/24 h rolling, daily loss, drawdown, streak breaker, cooldown, spread, stale data, duplicate, kill switch, fail-closed live)
* paper fills: slippage, maker/taker, stop-first, through-vs-touch TP, time exit, break-even, funding
* request signing vs the official client vectors; rate limiter; 429/5xx/timeouts; ambiguous failures; clock skew resync
* order placement/cancel, partial fills, duplicate `client_order_id`, reduce-only, stop/target fills, protective-stop failure ⇒ flatten
* default-disarmed live; every guard of the order choke point; zero orders when disarmed
* activation: every refusal path (viewer, wrong phrase, no ack, wrong password, forged/expired/stale token, failed checks, hard lock, synthetic data), success path, audit
* auth: lockout, roles, secrets never in responses/logs, shared-secret proxy
* persistence: settings, demo account + open position across restart, live orders, worker lease/takeover, restart with live armed (adopt position, re-create missing stop, finalise exchange-side closes, orphan position ⇒ blocked)
* WebSocket reconnect/replay, heartbeat watchdog, private `key-auth`, REST fallback, candle-close confirmation
* kill switch (flatten / keep protective), Live→Demo policies, demo/live data isolation

## Project layout

```
apps/server     backend: api.ts, auth.ts, runtime.ts, services/{bot,demoEngine,liveExecutor,activation,privateStream,...}, migrations/
apps/web        Next.js dashboard (app/api = server-side proxy; components/ = Demo, Live, Settings, Analytics, wizard)
packages/core   pure trading logic (settings, fees, strategy, risk, paper, backtest)
packages/delta  Delta adapter (signing, http, rate limit, ws, market feed, order builders) + mock exchange (src/mock)
docs/           architecture, Delta API notes, strategy & fees, go-live checklist, operations
Dockerfile · docker-compose.yml · render.yaml · fly.toml · .github/workflows/ci.yml · .env.example
```

## Configuration reference

Backend environment: see [`.env.example`](.env.example) (every variable documented). Dashboard environment: [`apps/web/.env.example`](apps/web/.env.example). Trading settings (all editable in the dashboard and persisted in the database) are defined and validated by `packages/core/src/settings.ts`.

## What was and was not verified

**Done and verified here**
* Full test suite green (see the final report for counts) and typechecking of all workspaces; production builds of the server bundle and the Next.js app; boot of the production bundle (refuses to start without secrets; behaves correctly when Delta is unreachable).
* The dashboard exercised in a real browser (login via the proxy, Demo/Live/Settings/Analytics, the whole activation wizard against the mock, kill switch, mobile/dark layout).
* Request signing byte-compatible with Delta's official Python client; endpoints, parameters, WebSocket URLs/channels/auth, rate-limit weights and error codes taken from Delta's official documentation source (github.com/delta-exchange/slate).

**Not verified (could not be, from the build environment)**
* Any call to the real Delta API (hosts blocked by the sandbox's network policy). Consequently: the real `ETHUSD` `contract_value`/max leverage/fee rates are *read at runtime* (fallback values `0.01 ETH`, `0.05 %/0.02 %` are used only for display until then and block Live); whether Delta lets a reduce-only stop and a reduce-only target coexist at full size; whether fill `commission` already includes GST (Live uses the exchange-reported amount; estimates add GST); the unit of the WebSocket funding rate (assumed percent; used only by Demo); how INR-denominated settlement is presented (`settling_asset`); whether `GET /wallet/balances` works with a Read-only key.
* No backtest on real market data; no Docker image build (no Docker daemon in the sandbox — the image layout was validated by hand); no deployment to Vercel/Fly/Render.
* No claim of an exit-fee waiver: nothing in the official API docs states one, so it is **off** (a setting exists if your fee statement shows it).

## Known limitations

* One active worker per database (lease). No horizontal scaling; API-only replicas are read-only.
* Order-book depth beyond the best bid/ask is not used by the strategy; Demo fills are modelled from top-of-book (adverse-by-design) and will differ from real execution (queue position, partial fills).
* ETH perpetuals only, linear (vanilla) contracts, isolated margin, one position at a time by default; cross/portfolio margin, options, and inverse contracts are not supported (inverse is rejected).
* Funding in Demo uses the feed's rate or a configured fallback; INR figures use a configured rate (no live FX feed).
* A software backstop exists behind the exchange-side stop, but if the exchange, your host and your network all fail simultaneously, only the exchange-side stop protects you. Delta's "dead man's switch" is deliberately not used because it cancels *all* orders, including protective stops.
* Extra transaction taxes (e.g. TDS) are configurable (`otherTaxRate`, default 0) but not assumed; income-tax treatment of profits is out of scope.

## What you still need to do

1. Create the managed Postgres database and set `DATABASE_URL`.
2. Deploy the backend (Fly/Render/VPS) with the secrets above; note its **static outbound IP**.
3. Deploy the dashboard on Vercel with `BACKEND_URL` and `PROXY_SHARED_SECRET`.
4. Create a Delta **testnet** key (Trading permission, IP whitelisted), add it, run **Test connection**, then rehearse Live on testnet.
5. Run a real-data walk-forward backtest and several days of Demo; review the fee reality check.
6. Only then create a production key, repeat the checks, and use the activation workflow.

---

*Trading leveraged derivatives is risky; you can lose more than expected, including your entire deposit. This software is provided as-is, without warranty.*
