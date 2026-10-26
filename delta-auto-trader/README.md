# delta-auto-trader

Terminal-only, safety-first autonomous trading bot for **Delta Exchange India**. Python 3.10+. No UI.
It starts in **DEMO** (virtual funds on the Delta demo/testnet) and cannot trade live money unless several
separate gates are opened. **No profitability is claimed or implied.**

> Independent of the TypeScript project in the repository root.

## Status — read this first

| Item | State |
|---|---|
| Unit/integration tests (mocked exchange + in-memory simulated exchange) | **119 pass** (`pytest`) |
| Delta demo API connectivity | **NOT verified** — the build sandbox blocks Delta hosts (proxy 403). |
| Demo order placement / exchange-native stop & take-profit | **NOT tested against the real demo.** Verified only against the in-repo simulated exchange. |
| Request signing | Matches the documented scheme (`METHOD+timestamp+path+query+body`, HMAC-SHA256); unit-tested against the doc formula, never against a live server. |
| Payload/response field names | From the official docs source and the existing repo notes (`../docs/DELTA_API.md`). First thing to confirm on your demo account: run `python main.py check`, then the opt-in `demo-smoke`, then a full DEMO run with raised limits. |

**Your default limits cannot trade BTC/ETH.** ₹10 notional ≈ $0.11, while one BTCUSD contract
(0.001 BTC) is ≈ $100 (₹8,800+). With `MAX_POSITION_NOTIONAL_INR=10` / `MAX_RISK_PER_TRADE_INR=2` the bot will
detect signals and print `[SKIP] Reason: Minimum order size exceeds configured limit…` — by design: it never
raises size or risk to meet exchange minimums. To exercise the order path on the *demo* account, raise the
limits in `.env` (e.g. `MAX_POSITION_NOTIONAL_INR=5000`, `MAX_RISK_PER_TRADE_INR=100`); demo funds are virtual.
`python main.py check` prints the exact INR cost of one contract against your limit.

## Install

```bash
cd delta-auto-trader
python3 -m venv .venv && source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                                       # Windows: copy .env.example .env
```

## Demo API keys

1. Open the **demo** site (`https://demo.delta.exchange`), create a demo account.
2. *API Management → Create key*. Enable **Read Data** and **Trading** only (there is no withdrawal permission — never ask for one).
   Trading keys need an **IP whitelist**: add the public IP of the machine running the bot (cloud/VPS with a static IPv4 recommended).
3. Put them in `.env`: `DELTA_DEMO_API_KEY=` / `DELTA_DEMO_API_SECRET=`. Demo keys only work on the demo host and vice-versa
   (`invalid_api_key` otherwise). Live keys use *different* variables (`DELTA_LIVE_*`) and are never read in DEMO/PAPER mode.

## Modes (`TRADING_MODE`)

| Mode | Orders | Data | Credentials |
|---|---|---|---|
| `PAPER` | simulated locally (fees, stops, TP, partial fills) | demo public REST | none |
| `DEMO` (default) | real orders on the demo account | demo REST | `DELTA_DEMO_*` |
| `LIVE` | **refused** unless `ENABLE_LIVE_TRADING=true` **and** `LIVE_CONFIRMATION="I ACCEPT REAL MONEY RISK"` **and** `DELTA_LIVE_*` are set | production | `DELTA_LIVE_*` |

The REST/WS URLs are derived from the mode (demo `cdn-ind.testnet.deltaex.org`, live `api.india.delta.exchange`) and cannot be set independently.
Each mode has its own SQLite file. Live is not recommended until DEMO/PAPER forward-testing shows a net-positive result *after* fees over a meaningful sample; it never switches itself on.

## Commands

```bash
python main.py check             # validate config, fetch instruments/quotes, show contract cost vs. your limits, test auth
python main.py run               # start the 24/7 loop (default command)
python main.py status            # halt flag, daily P&L, active trade, recent incidents
python main.py trades            # last 50 trades with gross / fees / funding / net P&L (USD and INR total)
python main.py emergency-stop    # create data/EMERGENCY_STOP: running bot flattens, disables entries, exits
python main.py clear-halt        # clear the halt flag + emergency file (verify exchange state first!)
python main.py discover          # list BTC/ETH perps and options with spec fields (public data)
python main.py backtest --days 30 [--symbol BTCUSD] [--csv file.csv] [--notional-inr N --risk-inr N]
python main.py demo-smoke --i-understand-demo   # DEMO only: place one far-from-market limit order, look it up by client id, cancel
python -m pytest                 # tests (never touch the network or real credentials)
```

Stop with Ctrl-C / SIGTERM (graceful). Open positions keep their exchange-side stop-loss/take-profit; the bot reconciles on next start.

## What the bot does

* **Strategy** (`strategy.py`, pluggable): completed candles only. LONG when EMA9 crosses above EMA21, higher-timeframe close > EMA200, RSI14 in `[RSI_LONG_MIN, RSI_LONG_MAX]`, spread/volume filters pass. Stop distance = `ATR14 × ATR_STOP_MULT`. SHORT only with `ALLOW_SHORT=true`. One evaluation per completed candle; cooldown after each trade; no martingale/averaging/grid.
* **Sizing** (`position_sizer.py`): integer contracts; `qty = min(⌊notional limit / contract cost⌋, ⌊risk budget / (stop loss + fees + slippage)⌋)`. Tick-rounded levels (stop rounded away from entry). Rejects if 1 contract exceeds the notional or risk limit, if margin > available balance, or if expected net reward ≤ 0. Leverage = `min(MAX_LEVERAGE, product max)`; leverage is never treated as capital.
* **RR modes**: `GROSS_RR` — TP at `RISK_REWARD_RATIO × stop distance`, net outcome reported; `NET_RR` — TP placed so *net* reward ÷ *net* loss ≥ ratio after fees/funding, else skip (also skips if TP > `MAX_TP_R_MULTIPLE` R away).
* **Fees** (`fee_calculator.py`): maker/taker rates from `MAKER_FEE_RATE/TAKER_FEE_RATE` (label `CONFIG`), else the product's `*_commission_rate` (label `EXCHANGE`), else documented sample rates labelled **ESTIMATED**. GST (default 18%) added. Closed trades use the exchange's actual fill commissions (`fee_source=ACTUAL`). Funding is estimated (rate × notional × 8-hour boundaries crossed, costs only) and always labelled an estimate. Any Delta fee promotions (e.g. scalper offers) are **not** assumed.
* **Protection**: entry = IOC limit capped at `ask + SLIPPAGE_BPS`; then a reduce-only **stop-market** (`stop_loss_order`, mark-price trigger) and a reduce-only **limit take-profit**. Both are verified in the open-orders list. Stop can't be confirmed → retries, then **flatten + halt entries + CRITICAL incident**. If only the TP order fails, the stop stays and a software TP monitor backs it up. A stop is *not* a guaranteed price: gaps/slippage can exceed the planned loss (see test `test_gap_slippage_can_exceed_planned_loss`).
* **Ambiguous responses**: order writes are never auto-retried. On timeout/5xx the bot looks the order up by `client_order_id`; if it can't be determined, the trade is marked `NEEDS_RECONCILIATION` and entries are disabled.
* **Risk** (`risk_manager.py`, persisted in SQLite, not reset by restarts): max open positions (default 1 across the watchlist), max position notional, max risk/trade, daily loss limit (realized net incl. fees; a new trade is also refused if its worst case would breach the limit), daily trade cap, consecutive-loss pause (lifts at the daily reset), cooldown, stale/invalid data rejection, emergency stop file. Day boundary: `DAILY_RESET_TZ` (IST).
* **Restart recovery** (`recovery.py`): resolves `PENDING_ENTRY` trades by client id, installs missing protection on filled entries, and disables entries if the exchange shows any position/orders the DB doesn't explain.
* **Instruments** (`instrument_selector.py`): perps `BTCUSD/ETHUSD` by default; options only with `MARKET_TYPE=OPTIONS` (deterministic rule: matching call/put, nearest expiry ≥ 24h, strike nearest spot, symbol as tie-break; spread + liquidity checks; long-premium only) or explicit `EXPLICIT_SYMBOLS` (if unavailable → skip, never substitute). Option trading is **experimental and untested against the exchange** (premium stop = `OPTION_STOP_PCT`; the option fee cap of 10% of premium is an assumption to verify). Other contract types are not implemented.

## Logs, trades, P&L

* Terminal: concise `[STATUS] / [SIGNAL] / [ORDER] / [PROTECTION] / [SKIP] / [ERROR] / [RECOVERY] / [SAFETY]` lines.
* `logs/bot.log` (rotating 5 × 5 MB, secrets redacted): `tail -f logs/bot.log`.
* `data/trades_demo.db` (SQLite; `trades_paper.db`, `trades_live.db` separate):
  `sqlite3 data/trades_demo.db "select symbol,side,quantity,entry_price,exit_price,gross_pnl,fees,funding,net_pnl,exit_reason,fee_source from trades order by created_at desc limit 20;"`
  Tables: `trades`, `orders` (every client/exchange order id), `kv` (risk state), `incidents`.

## Keep it running 24/7

A terminal window is not required, but **the machine must stay on and online** — if it sleeps, loses power or loses network the bot stops evaluating (exchange-side stops stay active, but nothing manages the trade). Consider an always-on VPS with a static IPv4 (whitelist it on the API key) **only after** testing is done.

**Linux (systemd):**
```bash
sudo useradd -r -m trader; sudo cp -r delta-auto-trader /opt/ && sudo chown -R trader /opt/delta-auto-trader
cd /opt/delta-auto-trader && sudo -u trader bash -c 'python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && cp .env.example .env'
sudo chmod 600 .env     # edit it with your demo keys
sudo cp deploy/delta-auto-trader.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now delta-auto-trader
journalctl -u delta-auto-trader -f        # live output;   sudo systemctl stop delta-auto-trader
```
**Windows:** install Python, create the venv as above, then either (a) Task Scheduler: *Create Task → Run whether user is logged on or not → Trigger: At startup → Action:* `C:\path\delta-auto-trader\.venv\Scripts\python.exe` with arguments `main.py run`, *Start in* the project folder, *Restart every 1 minute, up to 999 times* on failure; or (b) [NSSM](https://nssm.cc): `nssm install DeltaAutoTrader "C:\path\.venv\Scripts\python.exe" "main.py run"` and set the startup directory. Disable sleep in Power Options. Emergency stop: `python main.py emergency-stop`.

## Common errors

| Message | Meaning / fix |
|---|---|
| `invalid_api_key` | Wrong environment (demo key on live host or vice-versa), deleted/regenerated key, typo. |
| `ip_not_whitelisted_for_api_key` | Whitelist the IP shown in the error response on the key. |
| `SignatureExpired` | Clock off by >5 s; sync NTP. The client also learns the server clock offset and retries once. |
| `Forbidden` / 403 from CDN | Missing User-Agent (the client sends one) or blocked network/IP. |
| `UnauthorizedApiAccess` | Key lacks *Trading* permission. |
| HTTP 429 | Rate limit; reads wait for `X-RATE-LIMIT-RESET` and retry; writes are not retried. |
| `[SKIP] Minimum order size exceeds…` | Limits too small for the contract; see Status section. |
| `[SAFETY] New entries disabled` | A halt is set (see `python main.py status`). Investigate the exchange, then `clear-halt`. |
| `market data unusable` / stale | Gap/stale candles or quote; the bot skips until data is healthy. |

## Layout

`main.py` (CLI + loop) · `config.py` · `exchange_client.py` · `instrument_selector.py` · `market_data.py` · `strategy.py` ·
`risk_manager.py` · `position_sizer.py` · `fee_calculator.py` · `order_manager.py` · `position_manager.py` · `pnl_tracker.py` ·
`database.py` · `recovery.py` · `logger.py` · `health_monitor.py` · `backtest.py` · `paper_exchange.py` · `deploy/` · `tests/`

## Known limitations

* Not exercised against the real demo exchange (see Status); response field names and order-parameter acceptance (reduce-only stop + reduce-only limit at full size coexisting, `stop_trigger_method`, `GET /v2/positions` shape) must be confirmed on first demo run.
* Funding and option fees are estimates. Backtests use candle data only (intra-candle order unknown → stop assumed first), so they are optimistic/approximate.
* The WebSocket feed (`WsFeed`) is implemented and tested for reconnect/backoff but the loop currently uses REST polling for decisions; a stale WS never blocks trading because REST is authoritative.
* Paper-mode state is not persisted across restarts.

## Running from a phone (Android / Termux) and sharing a report

iPhone cannot run this directly; use a small cloud server instead. On Android: install **Termux from F-Droid** (not the Play Store build), then
`pkg install git && git clone <repo> && cd Crypto-Algo/delta-auto-trader && bash deploy/termux_setup.sh`, edit `.env` (`nano .env`), run `python main.py check`.
Keep it alive with `termux-wake-lock`, disable battery optimisation for Termux, and run in `tmux`. Caveats: Delta trading keys require a **whitelisted IP** and mobile data/Wi-Fi IPs change, so a phone is fine for testing but poor for 24/7 — use a VPS with a static IPv4 for real running.
To have someone review a run: `python main.py report` prints config (no secrets), connectivity check, status, trades and the last log lines, with keys redacted. Never paste your `.env`.
