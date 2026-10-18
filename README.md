# CryptoAlgo — Demo-first ETH scalping bot for Delta Exchange

An automated **ETH perpetual futures scalper** for Delta Exchange (India) with a Vercel dashboard and an always-on trading worker.

> **Starts in `DEMO MODE — LIVE TRADING DISABLED`.** On a fresh install the bot trades only a *virtual* account against live prices with simulated fills and fees. **No real order can be sent** until an administrator completes a multi-step activation workflow (safety checks → review → password + typed phrase). Selecting "Live" in the dashboard never places an order by itself.

**Deploy from a phone (no terminal):** [`docs/SUBAH_DEPLOY_HINGLISH.md`](docs/SUBAH_DEPLOY_HINGLISH.md) is a step-by-step Hinglish guide (Neon Postgres + Render backend + Vercel dashboard) that also lists what was *not* verified. With an Oracle Cloud VM use [`docs/ORACLE_CLOUD_HINGLISH.md`](docs/ORACLE_CLOUD_HINGLISH.md) instead of the Neon/Render steps (`deploy/oracle/`: Postgres + server + Caddy HTTPS on one VM, first-boot script to paste). The English reference is [Deployment](#deployment) below.

**Read this first — honest expectations**

* Nothing here is investment advice and **no profitability is claimed**. The strategy is objective and backtestable, but on the requested setup (0.20 ETH, **$4–$6 target**) *fees consume a large part of the gross move* even with the Scalper Offer (tables below). Use Demo and the backtester to decide for yourself, and treat small samples as noise.
* **The zero closing fee is an assumption, not a fact the bot can read.** Delta's Scalper Offer (no closing fee when a position is closed within 30 minutes; terms as supplied by the operator) cannot be seen through Delta's API. Demo, backtests and the pre-trade gates **assume it by default**. Live P&L always uses the commission the exchange actually reports, and the assumption is checked on live closes. Until your first eligible live close confirms it, treat every Demo and backtest number as optimistic. If your Delta account has not joined the offer, switch the assumption off (Strategy & Risk). See [Delta Scalper Offer](#delta-scalper-offer-closing-fee-waiver).
* Delta's API hosts were **not reachable from the sandbox this was built in**, so the exchange adapter is verified against Delta's *official documentation source*, the *official Python client* and a faithful local mock — **not against the live exchange**. See [What was and was not verified](#what-was-and-was-not-verified). Run the Demo-to-Live checklist, starting on the Delta **testnet**, before using real money.

---

## Contents

1. [Architecture](#architecture) · 2. [Safety model](#safety-model) · 3. [Quick start](#quick-start-local) · 4. [Using the dashboard](#using-the-dashboard) · 5. [Strategy, fees and what to expect](#strategy-fees-and-what-to-expect) · 6. [Delta Scalper Offer](#delta-scalper-offer-closing-fee-waiver) · 7. [Backtesting](#backtesting) · 8. [Deployment](#deployment) · 9. [Delta API configuration](#delta-api-configuration) · 10. [Demo → Live checklist](#demo--live-checklist) · 11. [Testing](#testing) · 12. [Project layout](#project-layout) · 13. [Configuration reference](#configuration-reference) · 14. [What was and was not verified](#what-was-and-was-not-verified) · 15. [Known limitations](#known-limitations) · 16. [What you still need to do](#what-you-still-need-to-do)

More detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/DELTA_API.md`](docs/DELTA_API.md) · [`docs/STRATEGY_AND_FEES.md`](docs/STRATEGY_AND_FEES.md) · [`docs/GO_LIVE_CHECKLIST.md`](docs/GO_LIVE_CHECKLIST.md) · [`docs/OPERATIONS.md`](docs/OPERATIONS.md) · [`docs/SUBAH_DEPLOY_HINGLISH.md`](docs/SUBAH_DEPLOY_HINGLISH.md)

---

## Architecture

Vercel cannot run a 24/7 process, so the system is split:

```
 Browser ──HTTPS──▶ Vercel: Next.js dashboard (apps/web)
                       │  httpOnly session cookie; server-side proxy adds the bearer token
                       │  (backend URL + secrets never reach the browser)
                       ▼
        Always-on backend (apps/server) — Render / Railway / Fly.io / VPS (Docker)
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
| **Activation workflow** | Preflight (credentials, contract, permissions, leverage, quantity, margin, balance, position/order sync, data freshness, clock, plus an information-only Scalper Offer line) → review + 5 risk acknowledgements → password re-entry + exact phrase (`ENABLE LIVE TRADING`) → audit record. Review token expires in 5 min and is bound to the reviewed parameters, including the Scalper Offer settings. Admin only. |
| **Kill switch** | Separate admin button: blocks **all** entries (demo + live), disarms live, cancels resting entry orders, and (default) flattens with a **reduce-only** market order. Releasing it does **not** re-arm live. |
| **Mode switch Live → Demo** | New live entries stop immediately. An open real position is **never silently abandoned**: policy `keep_managing` (default), `close_at_market`, or `manual_review`, and it is flagged on the dashboard. |
| **Fail closed** | Stale data, unhealthy API, unreconciled exchange state, unverified contract spec, missing credentials, unknown order outcome ⇒ no new entries. |
| **Duplicate-order protection** | Deterministic `client_order_id` per signal candle, write-ahead order records, unique constraint, in-flight lock, exchange-side uniqueness. Ambiguous network failures are resolved by *looking the order up*, never by re-sending. |
| **Exchange-side protection** | Stop-loss (reduce-only stop-market) is placed right after the fill; if that fails the position is flattened immediately. Break-even tightening places the new stop *before* cancelling the old one. |
| **Risk manager** | ≤10 trades/rolling 24 h (hard ceiling), one position, per-trade risk, daily loss, max drawdown, loss-streak breaker + cooldown, free margin, liquidation-distance buffer, max spread/slippage, min **net** reward:risk after fees, stale data, API health, reconciliation. 50x never overrides any of them. No martingale, no size increase after losses. |
| **Scalper Offer check** | The offer only changes cost *estimates*; no gate is loosened and no order path is added. Live P&L is always the exchange-reported commission. Every live close is checked against the zero-closing-fee assumption; if the exchange charges a closing fee on an eligible trade, Live switches to full-fee economics (it trades *less*) until an admin resets it. |
| **Secrets** | API keys live only on the backend: env vars or AES-256-GCM encrypted in the DB. Never returned by any API, never logged, never in the browser/Vercel. Delta keys have no withdrawal permission; you grant *Trading* only and whitelist the server IP. |
| **Auth** | bcrypt passwords, signed short-lived sessions in an `httpOnly; SameSite=Strict` cookie, `admin`/`viewer` roles, login lockout, per-route rate limits, CSRF checks, strict CSP, audit log (append-only at the DB level). Optional proxy shared secret. |
| **Deployment lock** | `LIVE_HARD_DISABLE=true` makes activation impossible regardless of the dashboard, refuses new entries even if the database says Live is armed, and disarms an armed Live at startup (an open real position keeps being managed). |

## Quick start (local)

Requirements: Node ≥ 22 (root `package.json` `engines`), npm. No database or Docker needed locally (an embedded Postgres is used).

```bash
git clone https://github.com/vikrantsingh07-ai/Crypto-Algo && cd Crypto-Algo
git checkout main                        # (the work branch is ccr-12ad71d8-4mu4gv; main equals it after the merge)
npm install
npm test                                 # unit + integration tests
```

**Option A — try everything safely with the local mock exchange** (random-walk prices, full REST/WS/order/Live flow, nothing leaves your machine). The mock models the Scalper Offer (closing fills within 30 minutes report commission 0); `MOCK_SCALPER_OFFER=false` starts it without the offer:

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

**Option C — accelerated synthetic data** (UI/engine mechanics only; clearly labelled, refused in production): `MARKET_DATA_SOURCE=synthetic SYNTHETIC_SPEED=120 npm run dev:server`.

Generate an admin password hash: `npm run hash-password -- "a long passphrase"`.

## Using the dashboard

* **Header** — big **DEMO TRADING / LIVE TRADING** selector, an always-visible status label (`DEMO MODE — LIVE TRADING DISABLED`, `LIVE MODE — REAL ORDERS ENABLED`, `KILL SWITCH ENGAGED …`), connection indicators (market data, exchange account API, reconciliation) and a **Scalper Offer** chip (`assumed · no closing fee ≤ 30 min`, `confirmed ×N`, `NOT APPLIED · full fees` or `off · full closing fee`), kill switch.
* **Demo Trading** — virtual equity (USD + INR), realised/unrealised P&L, simulated fees, drawdown, win rate, trades/24 h, current simulated position with entry/stop/target/holding time and an "exit fee free until HH:MM" clock, signal diagnostics (which of the 10 conditions pass for Long/Short), risk status, trade history with each trade's entry fee and "exit FREE (saved $x)" or the charged exit fee, and the **fee reality check** (with vs without the offer). Everything is labelled *Simulated*.
* **Live Trading** — disabled banner until activation; connection/API health, **real** balance and available margin, exchange positions, open orders, actual fees, risk status, real trade history, and the **Scalper Offer — closing-fee waiver** card (status, last check, *Reset & re-check…* for admins). Unavailable or stale data is labelled as such; demo data is never shown here.
* **Strategy & Risk** — every setting (instrument, quantity, leverage, target band, stop, time-exit policy, the Scalper Offer assumption, risk limits, filters, strategy parameters, fee assumptions), validated server-side against the exchange contract; exchange connection (add/test/replace the API key); a live **fee reality check**.
* **Analytics** — paper results, live results and backtests, kept visibly separate: cumulative P&L, drawdown, daily P&L, trade distribution, exit reasons, holding time, long vs short, regimes, target-hit rate, closing fees saved, with a *View as table* toggle on each chart.

Roles: `admin` can change settings, start/stop, activate Live, use the kill switch, run backtests, reset the Scalper Offer check; `viewer` is read-only.

## Strategy, fees and what to expect

**Strategy** (1-minute candles, closed bars only): trend alignment (EMA 9 > 21 > 55, rising), price on the right side of the UTC-day VWAP, N-bar breakout, momentum ≥ k·ATR, strong candle body/close, volume confirmation, "don't chase" (distance from EMA), Kaufman efficiency ratio (chop filter), ATR band (enough range for a $4–$6 move, not chaos), spread filter. Target = clamp(3·ATR, $4, $6); stop = clamp(2.5·ATR, $3, $6). Exits: take-profit (resting limit), stop, break-even tightening after 15 min when in profit, hard market close (time exit) at **28.5 min** while the Scalper Offer is assumed (30 min otherwise). It never trades to fill a daily quota.

**Fee reality** (0.20 ETH = 20 contracts × 0.01 ETH; taker 0.05 %, maker 0.02 %, +18 % GST; every figure below comes from the fee engine in `packages/core`, and the dashboard recomputes it from the live price). Taker entry, resting-limit take-profit, stop ≈ $4.5 + $0.25 slippage:

| ETH price | Price move needed just to cover fees: with offer / without (taker exit) | Net at $4 / $5 / $6 target, **with** offer | Net at $4 / $5 / $6, **without** offer (maker TP) | Win rate needed, with offer | Win rate needed, without offer |
|---|---|---|---|---|---|
| $2,000 | $1.18 / $1.65 ($2.36) | +$0.56 / +$0.76 / +$0.96 | +$0.47 / +$0.67 / +$0.87 | 68 % / 61 % / 55 % | 75 % / 68 % / 62 % |
| $3,000 | $1.77 / $2.48 ($3.54) | +$0.45 / +$0.65 / +$0.85 | +$0.30 / +$0.50 / +$0.70 | 75 % / 67 % / 61 % | 84 % / 77 % / 70 % |
| $4,000 | $2.36 / $3.30 ($4.72) | +$0.33 / +$0.53 / +$0.73 | +$0.14 / +$0.34 / +$0.54 | 81 % / 73 % / 66 % | 93 % / 85 % / 78 % |

At $3,000 a taker leg costs $0.354. A $4 move on 0.20 ETH is $0.80 gross: a taker-in/taker-out round trip without the offer costs $0.708; with the offer only the entry leg is paid ($0.354, a $0.446 net winner at $4) and a stopped trade loses about $1.30 (about $1.66 without the offer). So even with the offer a strategy must win roughly 55–81 % of the time to break even, which is a high bar; without it, 62–93 %. The bot uses a resting take-profit and **refuses trades whose expected net reward:risk is below your threshold**: with the offer assumed, every default target/stop combination passes that gate; without it, $4 targets are always refused. In simulation on random-walk data fees exceeded gross P&L. **Do not assume profit; measure it.** Full tables (stop/target grid, gate results, maker-entry comparison): [`docs/STRATEGY_AND_FEES.md`](docs/STRATEGY_AND_FEES.md).

## Delta Scalper Offer (closing-fee waiver)

**Terms (supplied by the operator; not verified against Delta).** Close a position within **30 minutes** (BTCUSD and ETHUSD; 15 minutes for other futures) and Delta charges **no closing fee** on eligible trades; the **opening fee is still paid**. Delta's example: opening maker fee 0.02 % ($12 on $60,000) is paid, the closing taker fee 0.05 % ($30.05) is waived. Your Delta account must have **joined** the offer (trades taken before joining are not eligible; it cannot be deactivated once activated). Liquidations are not eligible; partially closed positions are. Not for internal, corporate, RMM/MM/KOL fixed-fee users. Delta may change or end the offer without notice.

**Not modelled: the Diwali Scalper Offer** (opening fee returned as a Fee Voucher; **BTCUSD only**; capped at $100 per user per month). It does not apply to this ETHUSD bot.

**What the bot does**

| Where | Behaviour |
|---|---|
| Demo, backtests | Assume the offer while `execution.exitFeeWaiver.enabled` (default **on**): a trade closed within 30 minutes pays only the entry fee. The time exit fires at **28.5 min** (30 min minus a 90 s safety margin) so even the backstop exit is inside the window. |
| Pre-trade gates | Net reward and net reward:risk use the entry fee only, while the assumption stands. The per-trade **loss cap** always uses full fees (no waiver assumed), so an assumption never loosens a risk limit. |
| Live P&L | **Always the commission Delta reports on the fills.** Never the assumption. |
| Live verification | Each live close with known closing fills is compared with the assumption. Status: `unverified` → `confirmed` (closing commission ≤ $0.001 on an eligible close) or `NOT APPLIED` (charged). `NOT APPLIED` switches Live to full-fee economics and the unclamped 30-min time exit, raises an attention item and an audit row, and stays until an admin presses **Reset & re-check…** (`POST /api/live/waiver/reset`) or changes the waiver settings. |
| Switch off | Strategy & Risk → *Assume the Scalper Offer* OFF counts the full closing fee everywhere. Do this if your account has not joined. |

State machine, field shapes and audit actions: [`docs/STRATEGY_AND_FEES.md`](docs/STRATEGY_AND_FEES.md#live-verification). What to do on `NOT APPLIED`: [`docs/OPERATIONS.md`](docs/OPERATIONS.md#scalper-offer-not-applied). Joining the offer and checking the first live closes: [`docs/GO_LIVE_CHECKLIST.md`](docs/GO_LIVE_CHECKLIST.md).

**Not verified, and why it matters:** whether your account has joined (invisible to the API), whether ETHUSD's window is 30 or 15 minutes today (some Delta-sourced text says 15 for futures other than BTC), which fill starts the 30 minutes, whether stop, take-profit and API-placed closes qualify like manual ones, how a waived fee appears in a fill, and whether the testnet has the offer. The first eligible live closes are the test; until then it is an assumption.

## Backtesting

* Dashboard: **Analytics → Backtests** (admin) runs a single backtest (70 % in-sample / 30 % out-of-sample) or a **walk-forward** evaluation (parameters chosen on a training window, results reported only on the following untouched window).
* CLI: `npm run backtest -- --days 30 --kind walkforward --out result.json` downloads public 1-minute candles from Delta (no key) and prints the summary. For the no-offer result add `--settings nowaiver.json` with `{"execution":{"exitFeeWaiver":{"enabled":false}}}`.
* Assumptions are printed with every result: entries at the next bar open + spread + slippage, stop-first when stop and target share a candle, maker/taker fees + GST (the closing fee is waived inside 30 minutes while the Scalper Offer is assumed, and the result says so), funding, all risk limits enforced. Results with < 100 trades are flagged statistically weak; the win-rate 95 % interval is shown.
* **No backtest on real Delta data was run during development** (hosts unreachable); the mechanics were exercised on clearly-labelled synthetic data only. Run it yourself before drawing conclusions.

## Deployment

Phone-only walkthrough with troubleshooting: [`docs/SUBAH_DEPLOY_HINGLISH.md`](docs/SUBAH_DEPLOY_HINGLISH.md). Nothing below was deployed to a real host by the author.

### 1. Database (managed PostgreSQL)
Create a Postgres instance (Neon, Supabase, Render, Railway, RDS…). Set `DATABASE_URL` to the plain `postgresql://…` string (no quotes, no `psql` prefix; `DATABASE_SSL=require|no-verify` only if the provider needs it, a Neon string ending in `?sslmode=require` does not). Migrations in `apps/server/migrations/*.sql` run automatically at start; to run them by hand: `DATABASE_URL=… npm run db:migrate`. The worker touches the database every few seconds, so the database never idles: check your provider's free-tier compute limits and budget for a paid plan.

### 2. Backend worker (always-on) — pick one
Delta whitelists API keys by IP, so for Live you need a **static outbound IP**, and the exchange runs in AWS Tokyo, so choose Tokyo/Singapore.

* **Render** (`render.yaml` Blueprint: Starter plan, Singapore, Docker, health check `/api/health`, one instance). Generates `SESSION_SECRET`, `CREDENTIAL_ENCRYPTION_KEY` and `PROXY_SHARED_SECRET`; asks for `DATABASE_URL` and `ADMIN_PASSWORD` (12+ characters). It does not create a database. Never use a free plan: a sleeping service is a stopped bot. Render's outbound IPs are shared per region; check them in the dashboard before whitelisting.
* **Railway** (`railway.json`: Dockerfile build, health check `/api/health`, one replica). Set the same variables by hand.
* **Fly.io** (`fly.toml`, region `nrt`): `fly launch --no-deploy --copy-config` → `fly secrets set SESSION_SECRET=… CREDENTIAL_ENCRYPTION_KEY=… ADMIN_PASSWORD_HASH='…' PROXY_SHARED_SECRET=… DATABASE_URL=…` (single-quote the bcrypt hash, it contains `$`) → `fly ips allocate-egress --region nrt` (whitelist that IP on Delta) → `fly deploy`.
* **VPS + Docker Compose** (`docker-compose.yml`): `cp .env.example .env && docker compose up -d --build`, put Caddy/nginx with TLS in front.
* Keep **exactly one instance**. A second instance becomes a read-only API replica automatically (database lease).

Generate secrets: `openssl rand -hex 32` for `SESSION_SECRET` and `PROXY_SHARED_SECRET`; `CREDENTIAL_ENCRYPTION_KEY` is either `openssl rand -base64 32` or any random secret of 32+ characters (e.g. `openssl rand -hex 32`, stretched with HKDF-SHA256); the admin login is either `ADMIN_PASSWORD` (12+ characters, hashed at startup, with a warning) or `npm run hash-password -- "…"` → `ADMIN_PASSWORD_HASH` (preferred; wins if both are set).

### 3. Dashboard on Vercel
1. Import the repo in Vercel. **Root Directory:** `apps/web` (leave "Include source files outside of the Root Directory" enabled). Framework preset: Next.js (`apps/web/vercel.json` sets the install command `cd ../.. && npm ci --include=dev` and the build command). Do not set `NODE_ENV` in Vercel.
2. Environment variables (Production *and* Preview, server-side only): `BACKEND_URL` = your backend's `https://…` (no trailing slash, no `/api`), `PROXY_SHARED_SECRET` = same value as on the backend.
3. Deploy. Open the site, sign in as `admin`. You should see `DEMO MODE — LIVE TRADING DISABLED`.

Never add exchange keys or any `NEXT_PUBLIC_*` secret to Vercel.

## Delta API configuration

1. Create a Delta account for the environment you want (**testnet/demo first**: `demo.delta.exchange`, API host `cdn-ind.testnet.deltaex.org`; production: `api.india.delta.exchange`). Environments are independent: keys, product IDs and balances differ.
2. *API management* → create a key with **Trading** permission (no other permission is needed; Delta keys cannot withdraw) and whitelist your backend's static IP.
3. Provide it either as `DELTA_API_KEY`/`DELTA_API_SECRET` on the backend, or in the dashboard (Strategy & Risk → Exchange connection; stored AES-256-GCM encrypted, shown only as a fingerprint). Use **Test connection**.
4. Set `DELTA_ENV=testnet` while rehearsing; the dashboard then labels the environment *sandbox* and the activation phrase becomes `ENABLE TESTNET TRADING`. Details and doc references: [`docs/DELTA_API.md`](docs/DELTA_API.md).
5. For production, **join the Scalper Offer in your Delta account before the first live trade** (or switch the assumption off). See [`docs/GO_LIVE_CHECKLIST.md`](docs/GO_LIVE_CHECKLIST.md).

## Demo → Live checklist

The full version is in [`docs/GO_LIVE_CHECKLIST.md`](docs/GO_LIVE_CHECKLIST.md). In short: run Demo for days across regimes; run a walk-forward backtest on real data; **rehearse the entire Live flow on testnet** (entry, stop, target, kill switch, restart mid-position); verify the fee statement matches the bot's numbers; **join the Scalper Offer on the production account** (or switch the assumption off); start with a small balance; keep `perTradeRisk`/`dailyLossLimit` tight; then Strategy & Risk → exchange key (production) → **Live Trading → Enable Live Trading…**; then check that the first live close inside the window shows a closing fee of 0 on the *Scalper Offer* card and on Delta's own statement.

## Testing

```bash
npm run typecheck     # all workspaces
npm test              # vitest run: core + delta + server (279 tests in 14 files: core 64, delta 65, server 150)
npx vitest run apps/server/test/scalper.test.ts packages/delta/test/mock-scalper.test.ts   # Scalper Offer only
npm run build         # server bundle + Next.js production build
```

CI (`.github/workflows/ci.yml`) runs typecheck, the tests, both builds and a production-boot smoke test (health, proxy-secret rule, admin login), plus a separate job that builds and runs the Docker image; that job had not run when this was written.

Coverage highlights (all run against the real code paths; exchange responses come from the local mock that validates HMAC signatures):

* fees/GST/P&L (0.20 ETH = $0.80/$1.00/$1.20 at $4/$5/$6), the Scalper Offer waiver (entry fee always charged, closing fee free at ≤ 30:00.000 and charged one millisecond later, long and short, switched off), the clamped 28.5-min time exit, contract-size mapping, settings validation
* Long and Short signals, cooldowns, warm-up, determinism; backtester invariants; walk-forward isolation
* risk limits (10/24 h rolling, daily loss, drawdown, streak breaker, cooldown, spread, stale data, duplicate, kill switch, fail-closed live); the same $4 trade scoring a materially better net reward and reward:risk with the offer than without
* paper fills: slippage, maker/taker, stop-first, through-vs-touch TP, time exit, break-even (entry fee only inside the window), funding
* request signing vs the official client vectors; rate limiter; 429/5xx/timeouts; ambiguous failures; clock skew resync
* order placement/cancel, partial fills, duplicate `client_order_id`, reduce-only, stop/target fills, protective-stop failure ⇒ flatten
* default-disarmed live; every guard of the order choke point; zero orders when disarmed
* activation: every refusal path (viewer, wrong phrase, no ack, wrong password, forged/expired/stale token, failed checks, hard lock, synthetic data), success path, audit; the waiver settings invalidating a reviewed token; the fifth acknowledgement
* auth: lockout, roles, secrets never in responses/logs, shared-secret proxy
* persistence: settings, demo account + open position across restart, live orders, worker lease/takeover, restart with live armed (adopt position, re-create missing stop, finalise exchange-side closes, orphan position ⇒ blocked), the Scalper Offer status surviving a restart
* Scalper Offer, live path against the mock exchange: a close inside the window pays only the entry fee and confirms the status; a charged closing fee on an eligible trade ⇒ `not_applied` (audited, flagged, full-fee gates, unclamped time exit); the time exit at 28.5 min and its retry; closes after the window and liquidations never counted; confirmed ⇒ not applied when Delta stops waiving; reset by endpoint (admin only) and by settings change; old trade rows without `exit_fee_saved`
* the mock exchange's own offer model: off by default, boundary inclusive, partial closes, a flip waives only the closing part
* WebSocket reconnect/replay, heartbeat watchdog, private `key-auth`, REST fallback, candle-close confirmation
* kill switch (flatten / keep protective), Live→Demo policies, demo/live data isolation
* production config: secret handling, `.env.example` matching what `apps/server/src/config.ts` reads, `render.yaml` shape

## Project layout

```
apps/server     backend: api.ts, auth.ts, runtime.ts, services/{bot,demoEngine,liveExecutor,activation,privateStream,...}, migrations/
apps/web        Next.js dashboard (app/api = server-side proxy; components/ = Demo, Live, Settings, Analytics, wizard, scalper)
packages/core   pure trading logic (settings, fees, strategy, risk, paper, backtest)
packages/delta  Delta adapter (signing, http, rate limit, ws, market feed, order builders) + mock exchange (src/mock)
docs/           architecture, Delta API notes, strategy & fees, go-live checklist, operations, Hinglish deploy guide
Dockerfile · docker-compose.yml · render.yaml · railway.json · fly.toml · .github/workflows/ci.yml · .env.example
```

## Configuration reference

Backend environment: see [`.env.example`](.env.example) (every variable documented, including the dev-only `MOCK_PORT` and `MOCK_SCALPER_OFFER`). Dashboard environment: [`apps/web/.env.example`](apps/web/.env.example). Trading settings (all editable in the dashboard and persisted in the database) are defined and validated by `packages/core/src/settings.ts`; the Scalper Offer ones are `execution.exitFeeWaiver.{enabled, withinMinutes, safetyMarginSeconds, clampTimeExit}` (defaults `true`, 30, 90, `true`).

## What was and was not verified

**Done and verified here**
* Full test suite green (279 tests in 14 files, `npx vitest run`, run after the Scalper Offer work) and typechecking of all workspaces; production builds of the server bundle and the Next.js app; boot of the production bundle (refuses to start without secrets; behaves correctly when Delta is unreachable; health, proxy-secret and login rules).
* The dashboard exercised in a real browser (login via the proxy, Demo/Live/Settings/Analytics, the whole activation wizard against the mock, kill switch, mobile/dark layout). The Scalper Offer screens were checked at 390 px and 1360 px in light and dark, but against mocked API responses built from the real fee engine, not against the final server.
* Request signing byte-compatible with Delta's official Python client; endpoints, parameters, WebSocket URLs/channels/auth, rate-limit weights and error codes taken from Delta's official documentation source (github.com/delta-exchange/slate).
* The Scalper Offer logic (assumption, 28.5-min time exit, verification, fallback to full fees, reset) against the **local mock exchange** and unit tests only.

**Not verified (could not be, from the build environment)**
* Any call to the real Delta API (hosts blocked by the sandbox's network policy). Consequently: the real `ETHUSD` `contract_value`/max leverage/fee rates are *read at runtime* (fallback values `0.01 ETH`, `0.05 %/0.02 %` are used only for display until then and block Live); whether Delta lets a reduce-only stop and a reduce-only target coexist at full size; whether fill `commission` already includes GST (Live uses the exchange-reported amount; estimates add GST); the unit of the WebSocket funding rate (assumed percent; used only by Demo); how INR-denominated settlement is presented (`settling_asset`); whether `GET /wallet/balances` works with a Read-only key.
* **The Scalper Offer itself.** The terms are operator-supplied. A web search (result summaries only) did not contradict them but could not settle: account enrolment (and that KYC and a *Join Now* step are required), whether ETHUSD's window is 30 or 15 minutes, which fill starts the clock, whether stop/take-profit/API closes and maker closing fills qualify, how a waived fee appears in a fill, and whether the testnet has the offer. None of this was checked against Delta.
* No backtest on real market data; the Docker image could not be built in the author's sandbox (no Docker daemon), but the GitHub CI `docker` job builds it (linux/amd64) and its container passes the health check; it was not run on ARM or on a real host; no deployment to Vercel/Render/Railway/Fly/Neon.

## Known limitations

* One active worker per database (lease). No horizontal scaling; API-only replicas are read-only.
* Order-book depth beyond the best bid/ask is not used by the strategy; Demo fills are modelled from top-of-book (adverse-by-design) and will differ from real execution (queue position, partial fills).
* ETH perpetuals only, linear (vanilla) contracts, isolated margin, one position at a time by default; cross/portfolio margin, options, and inverse contracts are not supported (inverse is rejected).
* Funding in Demo uses the feed's rate or a configured fallback; INR figures use a configured rate (no live FX feed).
* A software backstop exists behind the exchange-side stop, but if the exchange, your host and your network all fail simultaneously, only the exchange-side stop protects you. Delta's "dead man's switch" is deliberately not used because it cancels *all* orders, including protective stops.
* The Docker image installs its production dependencies from `package.json` ranges rather than the lockfile (CI builds it, but it resolves versions at build time); pin it before relying on it for real money.
* Extra transaction taxes (e.g. TDS) are configurable (`otherTaxRate`, default 0) but not assumed; income-tax treatment of profits is out of scope.
* **Scalper Offer:**
  * It is an assumption. Enrolment cannot be read through the API, so the bot cannot know whether your account joined; it learns only from real closes, and the first eligible live close is what exposes a wrong assumption (at the cost of one closing fee).
  * Hold time is measured from the entry fill to the closing fill using exchange timestamps (falling back to the bot's own clock when entry fills are unknown). The 90 s safety margin covers latency; if a close is delayed beyond the window the closing fee is paid. A close within 5 s of the cut-off is treated as inconclusive. How Delta itself measures the window (first or last fill, rounding) is unknown.
  * Verification needs the closing fills with a usable commission figure. If they cannot be fetched, or a fill carries no commission number (a blank is not read as "free"), the trade is finalised from a pessimistic full-fee estimate, no saving is claimed, and it does not count towards the check.
  * A fee that Delta charges and later credits back would be read as "charged" and flip the status to `NOT APPLIED`.
  * The status is bound to the Delta environment and API key it was observed with: switching either returns it to *unverified* automatically (audited). Standby instances do not refresh it.
  * Liquidations and any extra transaction tax you configure (`otherTaxRate`) are never treated as waived.
  * The offer can change or end without notice. If ETHUSD's window is 15 minutes, `withinMinutes` must be changed by hand (and the break-even time lowered).
  * The testnet may not have the offer, so a `NOT APPLIED` there is not evidence about production.
  * The Diwali Scalper Offer (BTCUSD only) is not modelled.

## What you still need to do

1. Create the managed Postgres database and set `DATABASE_URL`.
2. Deploy the backend (Render/Railway/Fly/VPS) with the secrets above; note its **static outbound IP**.
3. Deploy the dashboard on Vercel with `BACKEND_URL` and `PROXY_SHARED_SECRET`.
4. Create a Delta **testnet** key (Trading permission, IP whitelisted), add it, run **Test connection**, then rehearse Live on testnet.
5. Run a real-data walk-forward backtest (with and without the offer) and several days of Demo; review the fee reality check.
6. Join the Scalper Offer on the production Delta account, or switch the assumption off.
7. Only then create a production key, repeat the checks, use the activation workflow, and verify the first live closes show a closing fee of 0.

---

*Trading leveraged derivatives is risky; you can lose more than expected, including your entire deposit. This software is provided as-is, without warranty.*
