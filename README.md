# CryptoAlgo — Demo-first ETH scalping bot for Delta Exchange

An automated **ETH perpetual futures bot** for Delta Exchange (India) with a Vercel dashboard and an always-on trading worker.

> **Starts in `DEMO MODE — LIVE TRADING DISABLED`.** On a fresh install the bot trades only a *virtual* account against live prices with simulated fills and fees. **No real order can be sent** until an administrator completes a multi-step activation workflow (safety checks → review → password + typed phrase). Selecting "Live" in the dashboard never places an order by itself.

**Deploy from a phone (no terminal):** [`docs/SUBAH_DEPLOY_HINGLISH.md`](docs/SUBAH_DEPLOY_HINGLISH.md) is a step-by-step Hinglish guide (Neon Postgres + Render backend + Vercel dashboard) that also lists what was *not* verified. With an Oracle Cloud VM use [`docs/ORACLE_CLOUD_HINGLISH.md`](docs/ORACLE_CLOUD_HINGLISH.md) instead of the Neon/Render steps (`deploy/oracle/`: Postgres + server + Caddy HTTPS on one VM, a first-boot script to paste, and `update.sh` for later updates). The English reference is [Deployment](#deployment) below.

**Read this first — honest expectations**

* Nothing here is investment advice and **no profitability is claimed**. The default plan is a fixed **$10 move per ETH** target (long or short) on **0.20 ETH**, which is **$2.00 gross**, with a protective stop of $5-$8 and **no time limit** on a position. Brokerage is paid on **both** legs: about **USD 0.80** for the round trip at ETH ~$3,390 (taker/taker, 18 % GST included), so a winner nets roughly USD 1.20 and a loser costs USD 1.85 to 2.45.
* **The INR 500 a day shown on the dashboard is a goal, not a promise.** With those numbers roughly **80 % of trades would have to win** to average INR 500/day over 10 trades (79 % at a $5 stop, 81 % at $6, 83 % at $8; [`docs/STRATEGY_AND_FEES.md`](docs/STRATEGY_AND_FEES.md)), while a price with no drift reaches +$10 before −$5 only about a third of the time. Wide stops buy a higher win rate with bigger losing trades. Up to 10 new trades per rolling 24 hours is a **ceiling, never a quota**: the bot does not trade to fill it, and no win rate is claimed by the code, the dashboard or these docs.
* **No time limit means a trade can run for hours**, including overnight and across funding payments. The stop-loss is always active; only the time exit was removed.
* **Real-data research says these rules lost money.** On 4.8 years of real ETH 1-minute candles (Binance *spot*, as a stand-in: Delta's hosts were not reachable from the sandbox this was built in), a strict walk-forward of the default rules (fixed $10 target, $5-$8 stop, no time limit, brokerage on both legs) won about **41 %** of its trades (95 % interval 38-44 %), averaged **-$0.57 per trade** and was **negative in all 49 out-of-sample months**; a random-entry control with the same exits and costs did about as badly. A 70-80 % win rate only appeared with $23-$40 stops, where the average loss is several times the win and the expectancy is still negative. So **70-80 % accuracy and INR 500/day are not supported by the evidence**; keep the bot in Demo. Details, method and limits: [`docs/RESEARCH_REAL_DATA.md`](docs/RESEARCH_REAL_DATA.md). The exchange adapter and the browser price feed are verified against Delta's *official documentation source*, the *official Python client*, a faithful local mock and a fake WebSocket server — **not against the live exchange** (see [What was and was not verified](#what-was-and-was-not-verified)). Run the Demo-to-Live checklist, starting on the Delta **testnet**, before using real money.

---

## Contents

1. [Architecture](#architecture) · 2. [Safety model](#safety-model) · 3. [Quick start](#quick-start-local) · 4. [Using the dashboard](#using-the-dashboard) · 5. [Strategy, fees and what to expect](#strategy-fees-and-what-to-expect) · 6. [Optional exit-fee waiver (off)](#optional-exit-fee-waiver-off-by-default) · 7. [Backtesting](#backtesting) · 8. [Deployment and updates](#deployment) · 9. [Delta API configuration](#delta-api-configuration) · 10. [Demo → Live checklist](#demo--live-checklist) · 11. [Testing](#testing) · 12. [Project layout](#project-layout) · 13. [Configuration reference](#configuration-reference) · 14. [What was and was not verified](#what-was-and-was-not-verified) · 15. [Known limitations](#known-limitations) · 16. [What you still need to do](#what-you-still-need-to-do)

More detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/DELTA_API.md`](docs/DELTA_API.md) · [`docs/STRATEGY_AND_FEES.md`](docs/STRATEGY_AND_FEES.md) · [`docs/GO_LIVE_CHECKLIST.md`](docs/GO_LIVE_CHECKLIST.md) · [`docs/OPERATIONS.md`](docs/OPERATIONS.md) · [`docs/SUBAH_DEPLOY_HINGLISH.md`](docs/SUBAH_DEPLOY_HINGLISH.md) · [`docs/ORACLE_CLOUD_HINGLISH.md`](docs/ORACLE_CLOUD_HINGLISH.md) · [`apps/web/lib/market/PROTOCOL.md`](apps/web/lib/market/PROTOCOL.md)

---

## Architecture

Vercel cannot run a 24/7 process, so the system is split:

```
 Browser ──HTTPS──▶ Vercel: Next.js dashboard (apps/web)
    │                  │  httpOnly session cookie; server-side proxy adds the bearer token
    │                  │  (backend URL + secrets never reach the browser)
    │                  ▼
    │      Always-on backend (apps/server) — Oracle VM / Render / Railway / Fly.io / VPS (Docker)
    │        ├─ REST API  (auth, roles, rate limits, audit log)
    │        ├─ Trading worker  (market data → strategy → risk manager → Demo engine | Live executor)
    │        │     one active worker at a time (database lease)
    │        └─ Delta adapter (packages/delta): signed REST, WebSocket, reconnects, rate limiter
    │                  │                              │
    │                  ▼                              ▼
    │         PostgreSQL                 Delta Exchange (public WS + REST, private REST/WS)
    │
    └──wss, PUBLIC market data only, no key──▶ Delta Exchange public WebSocket
         (live price, chart, order book; the backend quote is the fallback)
```

* `packages/core` — pure trading logic (no I/O): settings (versioned), fee/P&L engine, indicators, strategy, risk manager, paper-execution simulator, backtester, walk-forward. The **same code** runs in backtests, Demo and Live.
* `packages/delta` — the exchange adapter. Strategy code never touches exchange details, so API changes stay local to this package.
* `apps/server` — API + worker + persistence. `apps/web` — dashboard (a simple default view, a Developer view, and a browser-side market feed in `lib/market`).

Closing the browser never stops the bot. The worker is independent of any dashboard session. The browser feed carries no secrets and places no orders; it only draws the price, chart and order book.

## Safety model

| Layer | What it does |
|---|---|
| **Default state** | Fresh DB ⇒ `mode=demo`, `liveArmed=false`. Demo engine never imports the exchange client. |
| **One choke point** | Every order goes through `LiveExecutor.submit()`. A request that can open exposure (not reduce-only) is refused unless a *fresh database read* says `mode=live ∧ liveArmed ∧ running ∧ ¬killSwitch`. Tests assert zero orders reach the exchange otherwise. |
| **Activation workflow** | Preflight (credentials, contract, permissions, leverage, quantity, margin, balance, position/order sync, data freshness, clock, plus a plain-language holding-rule line) → review + 5 risk acknowledgements (one states that a position has no time limit and can run for hours through funding payments) → password re-entry + exact phrase (`ENABLE LIVE TRADING`) → audit record. Review token expires in 5 min and is bound to the reviewed parameters. Admin only. |
| **Kill switch** | Separate admin button: blocks **all** entries (demo + live), disarms live, cancels resting entry orders, and (default) flattens with a **reduce-only** market order. Releasing it does **not** re-arm live. |
| **Mode switch Live → Demo** | New live entries stop immediately. An open real position is **never silently abandoned**: policy `keep_managing` (default), `close_at_market`, or `manual_review`, and it is flagged on the dashboard. |
| **Fail closed** | Stale data, unhealthy API, unreconciled exchange state, unverified contract spec, missing credentials, unknown order outcome ⇒ no new entries. |
| **Duplicate-order protection** | Deterministic `client_order_id` per signal candle, write-ahead order records, unique constraint, in-flight lock, exchange-side uniqueness. Ambiguous network failures are resolved by *looking the order up*, never by re-sending. |
| **Stop-loss always on** | Stop-loss (reduce-only stop-market) is placed right after the fill; if that fails the position is flattened immediately. A software backstop also closes at market if price runs 50¢ beyond the exchange-side stop. The v2 change removed the *time exit*, never a stop: a position ends at its take-profit, its stop, a manual close or the kill switch. Break-even tightening exists only if you choose that policy (off by default) and places the new stop *before* cancelling the old one. |
| **Risk manager** | ≤10 trades/rolling 24 h (hard ceiling, never a quota), one position, per-trade risk (full brokerage on both legs), daily loss, max drawdown, loss-streak breaker + cooldown, free margin, liquidation-distance buffer, max spread/slippage, min **net** reward:risk after fees, stale data, API health, reconciliation. 50x never overrides any of them. No martingale, no size increase after losses. |
| **Secrets** | API keys live only on the backend: env vars or AES-256-GCM encrypted in the DB. Never returned by any API, never logged, never in the browser/Vercel. Delta keys have no withdrawal permission; you grant *Trading* only and whitelist the server IP. The browser's direct connection to Delta's public WebSocket needs no key and sends none. |
| **Auth** | bcrypt passwords, signed short-lived sessions in an `httpOnly; SameSite=Strict` cookie, `admin`/`viewer` roles, login lockout, per-route rate limits (reads are limited per signed-in user, login and every write route keep strict limits), CSRF checks, strict CSP, audit log (append-only at the DB level). Optional proxy shared secret. |
| **Deployment lock** | `LIVE_HARD_DISABLE=true` makes activation impossible regardless of the dashboard, refuses new entries even if the database says Live is armed, and disarms an armed Live at startup (an open real position keeps being managed). |

## Quick start (local)

Requirements: Node ≥ 22 (root `package.json` `engines`), npm. No database or Docker needed locally (an embedded Postgres is used).

```bash
git clone https://github.com/vikrantsingh07-ai/Crypto-Algo && cd Crypto-Algo
git checkout main
npm install
npm test                                 # unit + integration tests
```

**Option A — try everything safely with the local mock exchange** (random-walk prices, full REST/WS/order/Live flow, nothing leaves your machine). The mock charges closing fees like the bot assumes by default; `MOCK_SCALPER_OFFER=true` makes it model the optional waiver for rehearsing that setting:

```bash
npm run dev:mock                         # backend on :8080 (prints a dev admin password), mock exchange on :9911
# second terminal
echo "BACKEND_URL=http://127.0.0.1:8080" > apps/web/.env.local
npm run dev:web                          # dashboard on http://localhost:3000
```

**Option B — real Delta market data in Demo** (needs internet access to `api.india.delta.exchange`; no API key required for market data):

```bash
cp .env.example .env                     # then edit: SESSION_SECRET, ADMIN_PASSWORD_HASH (or ADMIN_PASSWORD), DELTA_ENV=production|testnet
NODE_ENV=development npm run dev:server  # dev mode accepts any ADMIN_PASSWORD; production needs a 12+ character ADMIN_PASSWORD or an ADMIN_PASSWORD_HASH
npm run dev:web
```

**Option C — accelerated synthetic data** (UI/engine mechanics only; clearly labelled, refused in production): `MARKET_DATA_SOURCE=synthetic SYNTHETIC_SPEED=120 npm run dev:server`. The dashboard turns the browser price feed off in this mode so test prices never mix with real Delta prices.

Generate an admin password hash: `npm run hash-password -- "a long passphrase"`.

## Using the dashboard

The dashboard opens in a **simple view** meant for someone who just wants to see what the algo is doing. A **Developer view** switch keeps everything technical.

### Simple view (default)

* **Header** — app name, a chip that says **DEMO - simulated, no real money** (it says LIVE only when the backend reports live armed; "LIVE selected - not active, no orders" otherwise), the algo's status in plain words ("Algo is watching the market", "Algo is in a trade", paused, offline, emergency stop on), an **Overview | History** switch, and a **Menu** (Developer view, light/dark, Emergency stop for admins with a confirmation, Sign out).
* **Price and live chart** (top left) — the ETH price in big type with the change and bid/ask/spread, a status pill (**Live**, **Connecting**, **Delayed**, **Reconnecting**) and a live candlestick chart. While a trade is open, its entry, stop and target are drawn as dashed lines.
* **Order flow** (next to it) — like an exchange order book: **buyers on the left in green, sellers on the right in red**, 10 levels each side as horizontal bars that change live, the ETH price in the middle, and a thin thread from every bar to the price. Colour is never the only signal: sizes, prices and labels are written out.
* **My simulated account** (below) — balance, equity, today's result after brokerage in USD and INR, wins/losses, the daily goal bar (**"A goal, not a promise. The algo never trades just to reach it."**), trades today as "n of 10", brokerage paid today, and the line "Brokerage about USD 0.80 per trade (entry + exit)" (the number follows the live price and the exchange's fee rates).
* **What the algo is doing** (beside the account) — a running trade with side, entry, take-profit, stop-loss, live profit/loss in USD and INR (price move only; brokerage is taken when the trade closes), how long it has been open (no countdown, there is no time limit) and its waiting orders; when flat, "Waiting for a good setup" with one plain sentence on why; and the last closed trades with their result.
* **History** — totals and a paged list of closed trades, with a note that small samples say nothing about the future.
* **On a phone** the cards stack as: price and chart, order flow, algo activity, account.
* **Where the price comes from.** The browser reads **Delta's public market-data WebSocket directly** (`wss://public-socket.india.delta.exchange`, public data only, no key or secret involved), so the price moves as fast as Delta's own site would show it. If the browser feed is stale for about 10 seconds, refused or disconnected, the page shows the **backend's quote** instead with the pill "Delayed", reconnects with back-off, and returns to Live by itself. The account and algo cards come from the backend, polled every 2 s (10 s while the tab is hidden); the first request and one every 30 s are full snapshots, the polls in between use `GET /api/state?slim=1`, which leaves out the chart series (an older backend that ignores it simply sends everything). Protocol notes and what is documented versus inferred: [`apps/web/lib/market/PROTOCOL.md`](apps/web/lib/market/PROTOCOL.md).
* **Hidden from this view on purpose:** settings, risk-check codes, fee tables, API and connection internals, and the activation wizard. Nothing is removed; it is all in the Developer view.

### Developer view

Menu → **Developer view** shows the original technical tabs (a "Simple view" button goes back; the choice is remembered in the browser):

* **Demo Trading** — virtual equity (USD + INR), realised/unrealised P&L, simulated fees, drawdown, win rate, trades/24 h, the current simulated position with entry/stop/target and time open (no countdown), signal diagnostics (which of the 10 conditions pass for Long/Short), risk status, trade history, and the fee reality check. Everything is labelled *Simulated*.
* **Live Trading** — disabled banner until activation; connection/API health, **real** balance and available margin, exchange positions, open orders, actual fees, risk status, real trade history, and the **Enable Live Trading…** activation wizard. Unavailable or stale data is labelled as such; demo data is never shown here.
* **Strategy & Risk** — every setting (instrument, quantity, leverage, target and stop, holding rule with a "No time limit" switch, the daily goal, risk limits, filters, strategy parameters, fee assumptions), validated server-side against the exchange contract; exchange connection (add/test/replace the API key); the fee reality check.
* **Analytics** — paper results, live results and backtests, kept visibly separate: cumulative P&L, drawdown, daily P&L, trade distribution, exit reasons, holding time, long vs short, regimes, target-hit rate, with a *View as table* toggle on each chart.

Roles: `admin` can change settings, start/stop, activate Live, use the kill switch and run backtests; `viewer` is read-only.

## Strategy, fees and what to expect

**Strategy** (1-minute candles, closed bars only): trend alignment (EMA 9 > 21 > 55, rising), price on the right side of the UTC-day VWAP, N-bar breakout, momentum ≥ k·ATR, strong candle body/close, volume confirmation, "don't chase" (distance from EMA), Kaufman efficiency ratio (chop filter), ATR band, spread filter. **Target = a fixed $10 move per ETH**, **stop = clamp(2.5·ATR, $5, $8)**. A position ends at its take-profit (a resting limit order), its stop-loss, a manual close or the kill switch; there is **no time exit and no break-even tightening by default**. At most 10 new trades per rolling 24 h, a ceiling; it never trades to fill a daily quota.

**Fee reality** (0.20 ETH = 20 contracts × 0.01 ETH; taker 0.05 %, maker 0.02 %, +18 % GST; computed by the fee engine in `packages/core`; the dashboard recomputes it from the live price). Brokerage is paid on both legs:

| ETH price | Round trip taker/taker | Net of a $10 win (taker exit) | Net of a loss at a $6 stop | Win rate to break even | Win rate needed for INR 500/day over 10 trades |
|---|---|---|---|---|---|
| $2,000 | $0.47 | +$1.53 | −$1.72 | 53.0 % | 70.5 % |
| $3,000 | $0.71 | +$1.29 | −$1.96 | 60.2 % | 77.7 % |
| **$3,390** | **$0.80** | **+$1.20** | **−$2.05** | **63.1 %** | **80.6 %** |
| $4,000 | $0.94 | +$1.06 | −$2.19 | 67.5 % | 85.0 % |

A loss includes $0.25 of simulated stop slippage. A winner that exits through the resting take-profit is a maker fill and pays less (about $0.56 round trip at ETH $3,390). At ETH $3,390 the required win rate for INR 500/day is 79.3 % with a $5 stop, 80.6 % with $6 and 82.7 % with $8 (73.5 % / 75.0 % / 77.6 % with a maker take-profit); a price with no drift reaches +$10 before the stop 33.3 % / 37.5 % / 44.4 % of the time. The entry gate rejects a trade whose net loss at the stop exceeds the $2.50 per-trade cap with full fees, which for a $8 stop means ETH above roughly $3,520. Full tables, the funding and overnight implications of having no time limit, the scenario table and the limits of the evidence: [`docs/STRATEGY_AND_FEES.md`](docs/STRATEGY_AND_FEES.md). **Do not assume profit; measure it.**

## Optional exit-fee waiver (off by default)

Delta advertises a "Scalper Offer" (terms supplied by the operator, **not verified against Delta**): a closing fee that is waived when a position is closed within 30 minutes by an account that joined the offer. **The bot does not assume it.** `execution.exitFeeWaiver.enabled` defaults to `false`, and while it is off nothing user-facing mentions the offer and every estimate counts the full fee on both legs. The settings block is kept only so it can be switched on for an account that has joined (it then needs a time limit to apply, and live closes are checked against it). Details: [`docs/STRATEGY_AND_FEES.md`](docs/STRATEGY_AND_FEES.md#the-dormant-optional-exit-fee-waiver-off-by-default). The separate **Diwali Scalper Offer** is BTCUSD only, does not apply to this ETHUSD bot and is not modelled.

## Backtesting

* Dashboard: Developer view → **Analytics → Backtests** (admin) runs a single backtest (70 % in-sample / 30 % out-of-sample) or a **walk-forward** evaluation (parameters chosen on a training window, results reported only on the following untouched window).
* CLI: `npm run backtest -- --days 30 --kind walkforward --out result.json` downloads public 1-minute candles from Delta (no key) and prints the summary. `--settings file.json` overrides settings (for example `{"targets":{"stopLossMinUsd":6,"stopLossMaxUsd":6}}`).
* Assumptions are printed with every result: entries at the next bar open + spread + slippage, stop-first when stop and target share a candle, maker/taker fees + GST on both legs, funding for every funding time crossed (positions can run for hours), all risk limits enforced. A position still open when the data ends is closed at the last price, flagged `end_of_data` and counted separately. Results with < 100 trades are flagged statistically weak; the win-rate 95 % interval is shown.
* **No backtest on Delta's own data was run during development** (hosts unreachable). The research in [`docs/RESEARCH_REAL_DATA.md`](docs/RESEARCH_REAL_DATA.md) used Binance spot candles as a stand-in and found the default rules negative out-of-sample. The tests use clearly-labelled synthetic data for mechanics only. Run the backtests yourself on Delta's data before drawing conclusions, ideally on the VM, where the candle history is reachable.

## Deployment

Phone-only walkthroughs with troubleshooting: [`docs/SUBAH_DEPLOY_HINGLISH.md`](docs/SUBAH_DEPLOY_HINGLISH.md) (Neon + Render + Vercel) and [`docs/ORACLE_CLOUD_HINGLISH.md`](docs/ORACLE_CLOUD_HINGLISH.md) (one Oracle VM). Nothing below was deployed to a real host by the author.

### 1. Database (managed PostgreSQL)
Create a Postgres instance (Neon, Supabase, Render, Railway, RDS…). Set `DATABASE_URL` to the plain `postgresql://…` string (no quotes, no `psql` prefix; `DATABASE_SSL=require|no-verify` only if the provider needs it, a Neon string ending in `?sslmode=require` does not). Migrations in `apps/server/migrations/*.sql` run automatically at start; to run them by hand: `DATABASE_URL=… npm run db:migrate`. The worker touches the database every few seconds, so the database never idles: check your provider's free-tier compute limits and budget for a paid plan.

### 2. Backend worker (always-on) — pick one
Delta whitelists API keys by IP, so for Live you need a **static outbound IP**, and the exchange runs in AWS Tokyo, so choose Tokyo/Singapore.

* **Oracle Cloud VM** (`deploy/oracle/`): Postgres + server + Caddy (automatic HTTPS) in one `docker compose`, installed by pasting `user-data.sh` as the cloud-init script; guide: [`docs/ORACLE_CLOUD_HINGLISH.md`](docs/ORACLE_CLOUD_HINGLISH.md).
* **Render** (`render.yaml` Blueprint: Starter plan, Singapore, Docker, health check `/api/health`, one instance). Generates `SESSION_SECRET`, `CREDENTIAL_ENCRYPTION_KEY` and `PROXY_SHARED_SECRET`; asks for `DATABASE_URL` and `ADMIN_PASSWORD` (12+ characters). It does not create a database. Never use a free plan: a sleeping service is a stopped bot. Render's outbound IPs are shared per region; check them in the dashboard before whitelisting.
* **Railway** (`railway.json`: Dockerfile build, health check `/api/health`, one replica). Set the same variables by hand.
* **Fly.io** (`fly.toml`, region `nrt`): `fly launch --no-deploy --copy-config` → `fly secrets set SESSION_SECRET=… CREDENTIAL_ENCRYPTION_KEY=… ADMIN_PASSWORD_HASH='…' PROXY_SHARED_SECRET=… DATABASE_URL=…` (single-quote the bcrypt hash, it contains `$`) → `fly ips allocate-egress --region nrt` (whitelist that IP on Delta) → `fly deploy`.
* **VPS + Docker Compose** (`docker-compose.yml`): `cp .env.example .env && docker compose up -d --build`, put Caddy/nginx with TLS in front.
* Keep **exactly one instance**. A second instance becomes a read-only API replica automatically (database lease).

Generate secrets: `openssl rand -hex 32` for `SESSION_SECRET` and `PROXY_SHARED_SECRET`; `CREDENTIAL_ENCRYPTION_KEY` is either `openssl rand -base64 32` or any random secret of 32+ characters (e.g. `openssl rand -hex 32`, stretched with HKDF-SHA256); the admin login is either `ADMIN_PASSWORD` (12+ characters, hashed at startup, with a warning) or `npm run hash-password -- "…"` → `ADMIN_PASSWORD_HASH` (preferred; wins if both are set).

### 3. Dashboard on Vercel
1. Import the repo in Vercel. **Root Directory:** `apps/web` (leave "Include source files outside of the Root Directory" enabled). Framework preset: Next.js (`apps/web/vercel.json` sets the install command `cd ../.. && npm ci --include=dev` and the build command). Do not set `NODE_ENV` in Vercel.
2. Environment variables (Production *and* Preview, server-side only): `BACKEND_URL` = your backend's `https://…` (no trailing slash, no `/api`), `PROXY_SHARED_SECRET` = same value as on the backend.
3. Deploy. Open the site, sign in as `admin`. You should see the simple dashboard with the chip `DEMO - simulated, no real money` (Developer view shows `DEMO MODE — LIVE TRADING DISABLED`).

Never add exchange keys or any `NEXT_PUBLIC_*` secret to Vercel. The dashboard's Content-Security-Policy (`apps/web/next.config.ts`) allows the page to connect to `'self'` plus Delta's public hosts `wss://public-socket.india.delta.exchange` (the browser price feed; this is the only one the feed needs), `wss://socket.india.delta.exchange` and `https://api.india.delta.exchange` (listed so a documented fallback never needs a redeploy; they can be removed for a tighter policy). Pointing the feed at the testnet needs `wss://socket-ind-pub.testnet.deltaex.org` added.

### 4. Updating (what to do after new code reaches `main`)

* **Web part: nothing to do.** Vercel rebuilds `apps/web` from `main` by itself.
* **Backend on the Oracle VM: one SSH command**, no secrets to type (it reuses the `.env` that `setup.sh` created):

  ```bash
  ssh -i <key-file> ubuntu@<VM-IP> "sudo bash /opt/cryptoalgo/deploy/oracle/update.sh"
  ```

  It does `git pull --ff-only`, `docker compose up -d --build` in `deploy/oracle`, then waits (up to 300 s) for the server's health check and prints `OK: the backend runs <commit> and is healthy`, or the last 40 log lines with secrets hidden if it is not healthy. It refuses to run if tracked files were changed by hand on the VM, and `DRY_RUN=1` only checks. Step by step in Hinglish: [`docs/ORACLE_CLOUD_HINGLISH.md`](docs/ORACLE_CLOUD_HINGLISH.md#naya-version-lagana--band-karna). Render/Railway/Fly: redeploy as usual.
* **Settings upgrade (version 2).** The first start of the new backend upgrades the stored settings once (`migrateSettings`, `SETTINGS_VERSION = 2`): no time limit (`exits.maxHoldMinutes = null`, `exits.timeExitPolicy = "none"`), the exit-fee waiver off, target $10 / $10, stop $5-$8, and a display-only `goals.dailyProfitInr = 500`; **every other stored value is kept** (quantity, leverage, risk limits, filters, strategy, INR rate…). It writes the new document back once and adds a `settings_migrated` row to the audit log (`GET /api/audit`); a second start changes nothing, and a fresh database simply gets the v2 defaults. If an old document cannot be read the stored copy is left untouched, the defaults are used and a `settings_migration_failed` row is audited. If you had changed the target or stop yourself, set them again in Developer view → Strategy & Risk.
* Update when no trade is open if you can. Do not run an old and a new backend against the same database at the same time (the old code cannot read `maxHoldMinutes: null`); the single-container Oracle setup replaces the old container, so this only matters if you also run another backend elsewhere.

## Delta API configuration

1. Create a Delta account for the environment you want (**testnet/demo first**: `demo.delta.exchange`, API host `cdn-ind.testnet.deltaex.org`; production: `api.india.delta.exchange`). Environments are independent: keys, product IDs and balances differ.
2. *API management* → create a key with **Trading** permission (no other permission is needed; Delta keys cannot withdraw) and whitelist your backend's static IP.
3. Provide it either as `DELTA_API_KEY`/`DELTA_API_SECRET` on the backend, or in the dashboard (Developer view → Strategy & Risk → Exchange connection; stored AES-256-GCM encrypted, shown only as a fingerprint). Use **Test connection**.
4. Set `DELTA_ENV=testnet` while rehearsing; the dashboard then labels the environment *sandbox* and the activation phrase becomes `ENABLE TESTNET TRADING`. Details and doc references: [`docs/DELTA_API.md`](docs/DELTA_API.md).
5. The operator will add the exchange API later and ask for the Live part then; until then the system stays in Demo.

## Demo → Live checklist

The full version is in [`docs/GO_LIVE_CHECKLIST.md`](docs/GO_LIVE_CHECKLIST.md). In short: run Demo for days across regimes and **include trades that stay open for hours**; run a walk-forward backtest on real data (on the VM); **rehearse the entire Live flow on testnet** (entry, stop, target, kill switch, restart mid-position, a trade held through a funding time); verify the fee statement matches the bot's numbers (both legs charged); start with a small balance; keep `perTradeRisk`/`dailyLossLimit` tight; then Developer view → Strategy & Risk → exchange key (production) → **Live Trading → Enable Live Trading…**; then watch the first live trades by hand.

## Testing

```bash
npm run typecheck     # all workspaces
npm test              # vitest run: 545 tests in 26 files (core 124, delta 65, server 201, web 155)
npm run build         # server bundle + Next.js production build
```

CI (`.github/workflows/ci.yml`) runs typecheck, the tests, both builds and a production-boot smoke test (health, proxy-secret rule, admin login), plus a separate job that builds and runs the Docker image; that job had not run when this was written.

Coverage highlights (all run against the real code paths; exchange responses come from the local mock that validates HMAC signatures):

* fees/GST/P&L on both legs (a $10 win on 0.20 ETH is $2.00 gross; the taker/taker round trip is about $0.80 at ETH 3,390), `roundTripFee`, `requiredWinRate` and `dailyOutlook` as plain arithmetic, the dormant waiver (off by default, covered when switched on), contract-size mapping, settings validation
* settings v2: new-install defaults, `migrateSettings` (a stored 30-minute / waiver-on / $4-$6 document is upgraded, other values kept, idempotent), the server writing the upgrade back once with an audit row
* Long and Short signals, cooldowns, warm-up, determinism; backtester invariants (a trade open at the end of the data is flagged `end_of_data`); walk-forward isolation
* risk limits (10/24 h rolling, daily loss, drawdown, streak breaker, cooldown, spread, stale data, duplicate, kill switch, fail-closed live); the per-trade loss cap with full fees; no default risk message mentioning the old offer or 30 minutes
* paper fills: slippage, maker/taker, stop-first, through-vs-touch TP, multi-hour holds that finally hit the target or the stop (long and short), no time exit without a limit, break-even only when chosen, funding across many hours
* request signing vs the official client vectors; rate limiter; 429/5xx/timeouts; ambiguous failures; clock skew resync
* order placement/cancel, partial fills, duplicate `client_order_id`, reduce-only, stop/target fills, protective-stop failure ⇒ flatten; a live position is never closed for time when no limit is set
* default-disarmed live; every guard of the order choke point; zero orders when disarmed
* activation: every refusal path (viewer, wrong phrase, no ack, wrong password, forged/expired/stale token, failed checks, hard lock, synthetic data), success path, audit, the settings-dependent acknowledgements
* auth: lockout, roles, secrets never in responses/logs, shared-secret proxy; per-user read rate limits
* persistence: settings, demo account + open position across restart, live orders, worker lease/takeover, restart with live armed (adopt position, re-create missing stop, finalise exchange-side closes, orphan position ⇒ blocked)
* the snapshot: `state.market`, `state.demo.today`, `state.economics.roundTrip`, `?slim=1`, no `Infinity`/`NaN` anywhere, build cost
* `deploy/oracle/update.sh` run for real against a local bare git origin with a fake `docker` (pull, rebuild, health wait, refusal on local changes, dry run, secrets hidden in the log tail)
* the browser market layer: message parser incl. hostile input, the order-book reducer against the two checksum examples printed in Delta's docs, candle merging, the status model, the socket lifecycle with a fake WebSocket (single socket under StrictMode, back-off, 10 s silence, resync, throttle), server-side rendering of the price, chart and order-flow components; the simple-view helpers
* WebSocket reconnect/replay (server side), heartbeat watchdog, private `key-auth`, REST fallback, candle-close confirmation
* kill switch (flatten / keep protective), Live→Demo policies, demo/live data isolation
* production config: secret handling, `.env.example` matching what `apps/server/src/config.ts` reads, `render.yaml` shape, the Oracle `setup.sh` dry run

## Project layout

```
apps/server     backend: api.ts, auth.ts, runtime.ts, repos.ts (settings migration), services/{bot,demoEngine,liveExecutor,activation,today,holdLimit,...}, migrations/
apps/web        Next.js dashboard (app/api = server-side proxy; components/simple = default view, DeveloperView + Demo/Live/Settings/Analytics/wizard = Developer view, components/market = price, chart, order flow; lib/market = the browser feed)
packages/core   pure trading logic (settings + migration, fees, strategy, risk, paper, backtest)
packages/delta  Delta adapter (signing, http, rate limit, ws, market feed, order builders) + mock exchange (src/mock)
deploy/oracle   Oracle VM: user-data.sh (first boot), setup.sh (install), update.sh (update), docker-compose.yml, Caddyfile
docs/           architecture, Delta API notes, strategy & fees, go-live checklist, operations, Hinglish deploy guides
Dockerfile · docker-compose.yml · render.yaml · railway.json · fly.toml · .github/workflows/ci.yml · .env.example
```

## Configuration reference

Backend environment: see [`.env.example`](.env.example) (every variable documented, including the dev-only `MOCK_PORT` and `MOCK_SCALPER_OFFER`). Dashboard environment: [`apps/web/.env.example`](apps/web/.env.example). Trading settings (all editable in Developer view → Strategy & Risk and persisted in the database) are defined and validated by `packages/core/src/settings.ts`. The v2 defaults:

| Setting | Default |
|---|---|
| `version` | `2` (`SETTINGS_VERSION`) |
| `position.quantityEth` / `leverage` | 0.2 ETH / 50x |
| `targets.targetMoveMinUsd` / `targetMoveMaxUsd` | 10 / 10 (a fixed $10 move per ETH) |
| `targets.stopLossMinUsd` / `stopLossMaxUsd` | 5 / 8 |
| `exits.maxHoldMinutes` | `null` (no time limit) |
| `exits.timeExitPolicy` | `none` (also `close_at_market`, `breakeven_then_close`) |
| `limits.maxTradesPer24h` | 10 (hard ceiling 10; a ceiling, not a quota) |
| `limits.perTradeRiskUsd` / `dailyLossLimitUsd` / `maxDrawdownPct` | 2.5 / 6 / 15 |
| `goals.dailyProfitInr` | 500 (display only; nothing reads it to size or force a trade) |
| `execution.exitFeeWaiver.enabled` | `false` (dormant; `withinMinutes` 30, `safetyMarginSeconds` 90, `clampTimeExit` true) |
| `execution.usdInrRate` | 88 |

## What was and was not verified

**Done and verified here**
* Full test suite (545 tests in 26 files, all passing, `npx vitest run`, run once after all v2 work) and typechecking of the workspaces; the dashboard's production build and the server bundle built during the v2 work.
* The dashboard exercised in a real headless browser against **mocked backend responses and a fake Delta WebSocket**: simple view and Developer view at desktop and phone widths in light and dark, view switching and persistence, price and profit/loss following the socket, history paging, the emergency-stop dialog, drop/reconnect, silence, sequence gaps, hidden tabs, reduced motion, the Content-Security-Policy enforced. The browser price feed was also run against a local fake exchange that speaks Delta's documented protocol, including the two order-book checksum examples printed in Delta's docs.
* Request signing byte-compatible with Delta's official Python client; endpoints, parameters, WebSocket URLs/channels/auth, rate-limit weights and error codes taken from Delta's official documentation source (github.com/delta-exchange/slate).
* The settings migration, the multi-hour hold mechanics and the server snapshot against the local mock, fake feeds and unit tests; `update.sh` against a local git repository and a fake `docker`.

**Not verified (could not be, from the build environment)**
* Any call to the real Delta API or WebSocket (hosts blocked by the sandbox's network policy). Consequently: the real `ETHUSD` `contract_value`/max leverage/fee rates are *read at runtime* (fallback values `0.01 ETH`, `0.05 %/0.02 %` are used only for display until then and block Live); whether Delta lets a reduce-only stop and a reduce-only target coexist at full size; whether fill `commission` already includes GST; the unit of the WebSocket funding rate (assumed percent; used only by Demo); how INR-denominated settlement is presented; whether `GET /wallet/balances` works with a Read-only key.
* **The browser price feed against the real public WebSocket.** It is unconfirmed whether Delta's public endpoint accepts a browser Origin from a non-Delta site, what the candlestick `ts` field means exactly (publish time or candle start), the exact ticker layout, and real message rates. If the endpoint refuses the page, the dashboard falls back to the backend quote and shows "Delayed". Only opening the live dashboard in a real browser settles it.
* **Whether the strategy can reach its goal.** The only real-data evidence (Binance spot candles, not Delta; see [`docs/RESEARCH_REAL_DATA.md`](docs/RESEARCH_REAL_DATA.md)) is negative: about 41 % wins and a loss on average in every out-of-sample month. No test on Delta's own data was possible. The INR 500/day figure is a goal, not an expectation.
* `update.sh` on a real Oracle VM with real Docker, the Docker image on ARM or a real host, and any deployment to Vercel/Render/Railway/Fly/Neon/Oracle.

## Known limitations

* One active worker per database (lease). No horizontal scaling; API-only replicas are read-only.
* Order-book depth beyond the best bid/ask is not used by the strategy (the browser order-flow card shows depth, display only); Demo fills are modelled from top-of-book (adverse-by-design) and will differ from real execution (queue position, partial fills).
* ETH perpetuals only, linear (vanilla) contracts, isolated margin, one position at a time by default; cross/portfolio margin, options, and inverse contracts are not supported (inverse is rejected).
* Funding in Demo uses the feed's rate or a configured fallback; INR figures use a configured rate (no live FX feed).
* **No time limit.** A trade can stay open for hours: it pays or receives funding at every funding time it spans, it is not protected by a break-even stop unless you choose that policy, it blocks the single position slot (so 10 trades a day is rarely reached), and a fast move can fill a stop beyond its price. In Demo a trade moves only while the backend runs.
* A software backstop exists behind the exchange-side stop, but if the exchange, your host and your network all fail simultaneously, only the exchange-side stop protects you. Delta's "dead man's switch" is deliberately not used because it cancels *all* orders, including protective stops.
* The History page in the simple view shows raw pages of 20 trades (open or failed rows are skipped on the client, so a page can show 19); the account's "today" counts trades closed on the current Indian (IST) calendar day in the current demo epoch.
* The Docker image installs its production dependencies from `package.json` ranges rather than the lockfile (CI builds it, but it resolves versions at build time); pin it before relying on it for real money.
* Extra transaction taxes (e.g. TDS) are configurable (`otherTaxRate`, default 0) but not assumed; income-tax treatment of profits is out of scope.
* The optional exit-fee waiver is an unverified assumption when switched on: enrolment cannot be read through the API, the offer can change or end without notice, and it only takes effect with a time limit configured.

## What you still need to do

1. Deploy the backend (Oracle VM guide, or Render/Railway/Fly/VPS with a managed Postgres) and note its **static outbound IP**.
2. Deploy the dashboard on Vercel with `BACKEND_URL` and `PROXY_SHARED_SECRET`; open it in a real browser and check that the price pill reads **Live** (if it stays **Delayed**, the browser feed was refused and the backend quote is being used).
3. Run a walk-forward backtest on Delta's own candles on the VM and let Demo run for weeks, including trades that run for hours; read the win rate against the required win rate, with the small-sample caveats. The suggested bar before any Live use is at least 300 forward Demo trades with a positive average net per trade whose 95 % interval excludes zero.
4. When you are ready for Live: create a Delta **testnet** key (Trading permission, IP whitelisted), add it, run **Test connection**, rehearse Live on testnet, and only then a production key and the activation workflow; watch the first live trades by hand.

---

*Trading leveraged derivatives is risky; you can lose more than expected, including your entire deposit. This software is provided as-is, without warranty.*
