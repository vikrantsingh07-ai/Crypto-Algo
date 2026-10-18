# Operations runbook

| Situation | What to do |
|---|---|
| Dashboard says *not in sync* / *untracked exchange position* | The exchange holds something the bot did not open (manual trade, crash mid-entry). Entries are blocked on purpose. Inspect Live → Exchange positions/orders, then either close it on the exchange or use **Close real position** (reduce-only). **Re-check exchange state**. |
| Need to stop everything now | **KILL SWITCH** (header). Default: flattens with a reduce-only market order and blocks all entries. Release afterwards; go Live again through the activation workflow. |
| Stop only new entries, keep managing exits | Demo tab → **Stop bot**, or switch to Demo (policy applies to an open real position). |
| Backend restarted / redeployed | Nothing to do: it reconciles first, adopts an open position and its protective orders, finalises trades that closed meanwhile (and checks them against the Scalper Offer assumption), and only then allows entries. A restarted worker with live armed but a *different API key* disarms itself. |
| Exchange unreachable | Dashboard shows data as stale, entries blocked (fail closed). An open position keeps its **exchange-side** stop/target. |
| `ip_not_whitelisted_for_api_key` | Whitelist the backend's static IP on the Delta key (the error context shows the IP the exchange saw). |
| `SignatureExpired` | Server clock drifting: enable NTP. The client also learns the offset from response headers. |
| 429 / rate limited | Automatic back-off; the limiter budgets 70 % of Delta's 20,000/5-min quota. |
| Rotate API key | Strategy & Risk → Exchange connection → Replace key (password re-entry). Live is disarmed; re-run activation. The Scalper Offer check result is bound to environment + key, so a different Delta account or environment starts again as *unverified* automatically. |
| Reset demo | Demo tab → *Reset account* (history is kept, the epoch restarts). |
| Drawdown limit hit | Entries stay blocked until you reset the baseline (Live: *reset* next to the drawdown baseline; Demo: reset account) — an intentional manual decision. |
| Attention item "Live trade … closed after the Scalper window - closing fee will apply" | A live position was held longer than the 30-minute window (the 28.5-min time exit kept failing, or the exchange was slow or down), so Delta charges the closing fee. Nothing is wrong with the offer: this close is recorded in *Last check* with "a closing fee expected" and is not counted for or against the offer. Find out why the exit was delayed (reduce-only close rejected, rate limit, outage; see the logs) and **Acknowledge**. P&L already uses the real fee. |
| Scalper Offer card shows a stale status, or `POST /api/live/waiver/reset` returns `409 worker_not_active_here` | The status lives in the worker. A standby instance loads it once at start and does not refresh it. Use the instance that reports `workerActive`. |
| Scalper Offer status says *NOT APPLIED* | See below. |
| Backups | Back up the PostgreSQL database (trades, orders, audit log, encrypted credentials, the `live_waiver` status). The `CREDENTIAL_ENCRYPTION_KEY` is needed to read stored keys. |
| Logs | JSON lines on stdout with secrets redacted; `GET /api/health` for uptime monitors (DB + worker). A status change logs `scalper offer status changed`; a failed check logs `scalper offer verification failed` (the trade is still finalised). |
| Updating | Deploy the new image; migrations apply at boot (`apps/server/migrations/002_exit_fee_saved.sql` adds the nullable `trades.exit_fee_saved`; old rows read as unknown). Keep a single instance (the lease prevents double trading during rolling deploys, but the new instance waits up to 30 s to take over). |

## Scalper Offer: NOT APPLIED

**What it means.** On a live close that should have been fee-free (waiver setting ON, not a liquidation, held at most 29 min 55 s, closing fills known) the exchange reported a closing commission above $0.001. Delta's Scalper Offer does not appear to apply to this account, this order type or this window. The offer cannot be read through the API, so this observation is the only evidence.

**What you see.** A red banner at the top of the Live tab, the pill *NOT APPLIED — closing fees are being charged, using full-fee economics*, the top-bar chip *Scalper Offer: NOT APPLIED · full fees*, an item under *Needs your attention*, and an audit row `scalper_offer_not_applied` (`GET /api/audit`, admin). *Last check* on the *Scalper Offer — closing-fee waiver* card shows the trade, the hold time and the fee charged.

**What the bot does by itself.** It trades **less, never more**: entry gates use full-fee economics (at ETH $3,000 a $4 target is then always refused, see `STRATEGY_AND_FEES.md`), and the time exit goes back to the configured 30 min. An open position keeps being managed, nothing is closed or disarmed, and reported P&L is unchanged (it was always the real fee). The state is sticky: later free closes are recorded but do not bring the waiver back.

**What you do** (no need to hurry; the bot is already on the cautious side):
1. Open the closing fill of that trade in Delta's trade history / fee statement. Was a fee really charged, and was anything credited back? The bot cannot see credits: if Delta charges and later refunds, the offer works but the bot reads "charged". In that case leave the bot on full-fee economics (or turn the assumption OFF), because it cannot tell the cases apart.
2. Find the cause:
   * **Account has not joined, or joined after that trade.** Join (see `GO_LIVE_CHECKLIST.md`, section C). Earlier trades stay charged. Then step 3a.
   * **Window shorter than assumed** (ETHUSD at 15 minutes instead of 30, and the trade was held between 15 and 28.5 min). Set *Close-within window* to 15 and lower *Break-even stop after* below 13.5 min; saving the settings resets the status.
   * **That kind of close is not covered** (for example stop-market or API-placed closes), or **Delta changed or ended the offer.** Step 3b.
3. Decide:
   * a. **The offer should apply:** Live tab → *Scalper Offer* card → **Reset & re-check…** (admin; `POST /api/live/waiver/reset`). The status returns to *Assumed — unverified* and the next eligible close decides again. Each reset is audited (`scalper_offer_status_reset`). Do not use it to get back the cheaper economics without a reason: if the next eligible close is charged, the bot flips again.
   * b. **It does not apply, or you are unsure:** Strategy & Risk → *Delta Scalper Offer* → switch **Assume the Scalper Offer** OFF and save. Demo, backtests and Live then count the full closing fee everywhere, which is the "without offer" column of the README table. Re-run a backtest and ask whether the strategy still makes sense at full fees.
4. Acknowledge the attention item.

Changing any `execution.exitFeeWaiver.*` setting also resets the status to *unverified* and writes the same audit row.

## Rehearsing the offer locally

`npm run dev:mock` starts a fake exchange that models the offer (closing fills within 30 minutes on the mock clock report commission 0); `MOCK_SCALPER_OFFER=false npm run dev:mock` starts it without the offer, which is how to see the *NOT APPLIED* path in the dashboard. The mock is a stand-in written from the operator's terms, not a recording of Delta; the behaviour is covered by `packages/delta/test/mock-scalper.test.ts` and `apps/server/test/scalper.test.ts`. The `dev:mock` command itself was type-checked but not started while this documentation was written.
