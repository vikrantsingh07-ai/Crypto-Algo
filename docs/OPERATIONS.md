# Operations runbook

Most of the technical controls below are in the dashboard's **Developer view** (Menu → Developer view). The simple view shows the same facts in plain words and keeps the **Emergency stop** in its menu.

| Situation | What to do |
|---|---|
| Dashboard says *not in sync* / *untracked exchange position* | The exchange holds something the bot did not open (manual trade, crash mid-entry). Entries are blocked on purpose. Inspect Live → Exchange positions/orders, then either close it on the exchange or use **Close real position** (reduce-only). **Re-check exchange state**. |
| Need to stop everything now | **Emergency stop / KILL SWITCH** (simple view: Menu → Emergency stop; Developer view: header). Default: flattens with a reduce-only market order and blocks all entries. Release afterwards; go Live again through the activation workflow. |
| Stop only new entries, keep managing exits | Developer view → Demo tab → **Stop bot**, or switch to Demo (policy applies to an open real position). |
| A trade has been open for hours | Normal: there is **no time limit** by default. It ends at its take-profit or its stop-loss. To end it yourself: Developer view → Demo → **Close simulated position** (admin), or Live → **Close real position**. It may have paid or received funding while open (see the trade's fees in History). |
| The price pill says *Delayed* | The browser could not use Delta's public WebSocket (blocked network, an extension, Delta refusing the page's Origin, or a pause on Delta's side) and is showing the backend's quote, which is a little slower. It reconnects by itself with back-off; reload the page to try at once. The bot is not affected: it uses the backend's own feed. If it never turns *Live*, tell the developer (it is unconfirmed against the real exchange, see README). |
| The price pill says *Reconnecting* | Neither the browser feed nor a recent backend quote is available. Check the backend (`/api/health`) and market-data status in Developer view. Entries are blocked while data is stale (fail closed). |
| Dashboard shows *Reconnecting...* with a *Try now* button | The dashboard cannot reach the backend (backend restarting or down, wrong `BACKEND_URL`, `PROXY_SHARED_SECRET` mismatch). It keeps retrying every few seconds. |
| Backend restarted / redeployed | Nothing to do: it reconciles first, adopts an open position and its protective orders, finalises trades that closed meanwhile, and only then allows entries. A restarted worker with live armed but a *different API key* disarms itself. |
| Exchange unreachable | Dashboard shows data as stale, entries blocked (fail closed). An open position keeps its **exchange-side** stop/target. |
| `ip_not_whitelisted_for_api_key` | Whitelist the backend's static IP on the Delta key (the error context shows the IP the exchange saw). |
| `SignatureExpired` | Server clock drifting: enable NTP. The client also learns the offset from response headers. |
| 429 / rate limited | Automatic back-off; the limiter budgets 70 % of Delta's 20,000/5-min quota. Dashboard reads are limited per signed-in user (3000/min) so several open tabs are fine. |
| Rotate API key | Developer view → Strategy & Risk → Exchange connection → Replace key (password re-entry). Live is disarmed; re-run activation. |
| Reset demo | Developer view → Demo tab → *Reset account* (history is kept, the epoch restarts; "today" in the simple view starts again). |
| Drawdown limit hit | Entries stay blocked until you reset the baseline (Live: *reset* next to the drawdown baseline; Demo: reset account) — an intentional manual decision. |
| Backups | Back up the PostgreSQL database (trades, orders, audit log, encrypted credentials). The `CREDENTIAL_ENCRYPTION_KEY` is needed to read stored keys. On the Oracle VM: `sudo docker compose -f /opt/cryptoalgo/deploy/oracle/docker-compose.yml exec db pg_dump -U cryptoalgo cryptoalgo > backup.sql`. |
| Logs | JSON lines on stdout with secrets redacted; `GET /api/health` for uptime monitors (DB + worker). |
| Updating | See the next section. |

## Applying an update

Merged code reaches two places:

* **Dashboard (Vercel): automatic.** Vercel rebuilds `apps/web` from `main`. Nothing to do. The new dashboard also works against a backend that has not been updated yet (it works out what it can itself, for example today's totals from the trade list, seeds the chart from the older price series and hides the daily-goal setting), so the order does not matter for safety. The trading rules, though, live in the backend: nothing about holding time, targets or stops changes until the backend is updated, so do it soon after.
* **Backend on the Oracle VM: one SSH command**, run from anywhere with your key (a laptop, or Oracle Cloud Shell on a phone):

  ```bash
  ssh -i <key-file> ubuntu@<VM-IP> "sudo bash /opt/cryptoalgo/deploy/oracle/update.sh"
  ```

  No password or secret is typed: it reuses `deploy/oracle/.env` created by `setup.sh`. Steps and output:

  1. refuses to start if another update is running, or if tracked files in `/opt/cryptoalgo` were edited by hand (it lists the file names and changes nothing);
  2. `git pull --ff-only --quiet` (a failed pull stops here, the old version keeps running);
  3. `docker compose up -d --build` in `deploy/oracle` (a build with new code takes a few minutes; on a 1 GB VM longer);
  4. waits up to `HEALTH_TIMEOUT` seconds (default 300, checked every `HEALTH_INTERVAL`, default 5) for the server's health check, then prints `OK: the backend runs <commit> and is healthy` and exits 0. If it never gets healthy it prints `NOT healthy`, the last 40 server log lines (every secret value from `.env` replaced by `***`) and the exact command to go back to the previous commit, and exits 1.
  
  `sudo DRY_RUN=1 bash /opt/cryptoalgo/deploy/oracle/update.sh` only checks that the tree is clean and says what it would do. Other hosts (Render, Railway, Fly, VPS) redeploy the usual way for that host. Keep a single backend per database: do not run an old and a new backend against the same database at the same time (the old code cannot read the upgraded settings).

What happens on the first start of the new backend (settings **version 2**): the stored settings are upgraded once, with one audit row. Look for it as admin: `GET /api/audit`, action `settings_migrated` (`details` lists `from`, `to` and the changed keys). It sets no time limit (`exits.maxHoldMinutes = null`, policy `none`), switches the exit-fee waiver off, sets the target to a fixed $10 and the stop band to $5-$8, and adds the display-only daily goal (INR 500); every other value you set is kept. If you had customised the target or stop, set them again in Developer view → Strategy & Risk. A second start changes nothing. A `settings_migration_failed` row means the old document could not be read: it was left untouched and the defaults are in use; tell the developer before changing any setting. Update when no trade is open if you can; a position that is open at the update is picked up again after the restart (Demo account and open position survive a restart; in Live the exchange-side stop keeps protecting it).

## If you switched the exit-fee waiver on and it says NOT APPLIED

This section matters only if someone enabled `execution.exitFeeWaiver` (Developer view → Strategy & Risk → *Closing-fee waiver (optional, off by default)*). By default it is off and none of this appears.

**What it means.** With the waiver on, a live close that should have been fee-free (not a liquidation, held at most 29 min 55 s, closing fills known) was charged a closing commission above $0.001. The offer cannot be read through the API, so this observation is the only evidence, and it covers this account, this order type and this window only.

**What the bot does by itself.** It trades **less, never more**: estimates use full fees, an open position keeps being managed, nothing is closed or disarmed, and reported P&L is unchanged (it was always the real fee). The state is sticky until an admin resets it.

**What you do.** Check the closing fill in Delta's trade history (was a fee charged, was something credited back?). If the offer should apply, Live tab → *Scalper Offer — closing-fee waiver* card → **Reset & re-check…** (`POST /api/live/waiver/reset`, admin, audited as `scalper_offer_status_reset`); otherwise switch the waiver **off** and save, which makes Demo, backtests and Live count the full closing fee everywhere (the default). Changing any `execution.exitFeeWaiver.*` setting also resets the status. Acknowledge the attention item. A live trade closed after the 30-minute window while the waiver is on raises the attention item "closed after the Scalper window - closing fee will apply"; that is not evidence against the offer.

`npm run dev:mock` starts a fake exchange whose waiver model is OFF by default (like the bot); `MOCK_SCALPER_OFFER=true npm run dev:mock` turns it on to rehearse the waiver. The mock is a stand-in written from the operator's terms, not a recording of Delta; it is covered by `packages/delta/test/mock-scalper.test.ts` and `apps/server/test/scalper.test.ts`.
