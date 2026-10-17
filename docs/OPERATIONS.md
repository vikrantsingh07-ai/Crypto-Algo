# Operations runbook

| Situation | What to do |
|---|---|
| Dashboard says *not in sync* / *untracked exchange position* | The exchange holds something the bot did not open (manual trade, crash mid-entry). Entries are blocked on purpose. Inspect Live → Exchange positions/orders, then either close it on the exchange or use **Close real position** (reduce-only). **Re-check exchange state**. |
| Need to stop everything now | **KILL SWITCH** (header). Default: flattens with a reduce-only market order and blocks all entries. Release afterwards; go Live again through the activation workflow. |
| Stop only new entries, keep managing exits | Demo tab → **Stop bot**, or switch to Demo (policy applies to an open real position). |
| Backend restarted / redeployed | Nothing to do: it reconciles first, adopts an open position and its protective orders, finalises trades that closed meanwhile, and only then allows entries. A restarted worker with live armed but a *different API key* disarms itself. |
| Exchange unreachable | Dashboard shows data as stale, entries blocked (fail closed). An open position keeps its **exchange-side** stop/target. |
| `ip_not_whitelisted_for_api_key` | Whitelist the backend's static IP on the Delta key (the error context shows the IP the exchange saw). |
| `SignatureExpired` | Server clock drifting: enable NTP. The client also learns the offset from response headers. |
| 429 / rate limited | Automatic back-off; the limiter budgets 70 % of Delta's 20,000/5-min quota. |
| Rotate API key | Strategy & Risk → Exchange connection → Replace key (password re-entry). Live is disarmed; re-run activation. |
| Reset demo | Demo tab → *Reset account* (history is kept, the epoch restarts). |
| Drawdown limit hit | Entries stay blocked until you reset the baseline (Live: *reset* next to the drawdown baseline; Demo: reset account) — an intentional manual decision. |
| Backups | Back up the PostgreSQL database (trades, orders, audit log, encrypted credentials). The `CREDENTIAL_ENCRYPTION_KEY` is needed to read stored keys. |
| Logs | JSON lines on stdout with secrets redacted; `GET /api/health` for uptime monitors (DB + worker). |
| Updating | Deploy the new image; migrations apply at boot. Keep a single instance (the lease prevents double trading during rolling deploys, but the new instance waits up to 30 s to take over). |
