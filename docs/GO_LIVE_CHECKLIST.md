# Demo → Live checklist

Do not skip items. Tick each one. Nothing in this project has been run against the real Delta Exchange (its hosts were unreachable from the build sandbox); the Scalper Offer in particular is an **assumption until your first live closes confirm it** (section D).

## A. Before touching any exchange account
- [ ] Demo has run for ≥ 1–2 weeks across different market conditions; trades/24 h, stop/target/time-exit mix and drawdown look as expected.
- [ ] A walk-forward backtest on **real** Delta candles (`npm run backtest -- --days 45 --kind walkforward`) was run and its out-of-sample section reviewed (trades ≥ 100? win rate vs the *required* win rate on the fee reality check?).
- [ ] You understand that fees consume most of a $4–$6 move (README table, both columns) and accept the break-even win rate. **Demo and backtest results assume the Scalper Offer** (no closing fee within 30 minutes); if your account has not joined it, they overstate your results (README "without offer" columns are the realistic ones).
- [ ] `ADMIN_PASSWORD_HASH` (or a 12+ character `ADMIN_PASSWORD`), `SESSION_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, `PROXY_SHARED_SECRET` set; HTTPS on the backend; backend has a **static outbound IP**. (Phone-only setup: `docs/SUBAH_DEPLOY_HINGLISH.md`.)

## B. Testnet rehearsal (`DELTA_ENV=testnet`, Delta demo account)
- [ ] Testnet API key created with **Trading** permission, backend IP whitelisted; **Test connection** passes.
- [ ] Activation wizard passes all checks; phrase `ENABLE TESTNET TRADING`. The *Scalper Offer* row is information only, never a tick.
- [ ] Confirm on the exchange UI: contract `ETHUSD` value/tick/leverage/fees match the dashboard's "Contract" row.
- [ ] Observe a full trade: IOC entry fill, **stop and target both resting** (reduce-only), exit by target / stop / time exit; compare fees and P&L with the exchange statement (this settles the GST / commission question).
- [ ] Note what the testnet charged on a close inside 28.5 min. The offer may not exist on the testnet; if the dashboard turns *NOT APPLIED* there, that says nothing about production. **The verdict is bound to environment + API key, so switching to the production key starts it again as *unverified*; confirm that in step C.**
- [ ] Restart the backend mid-position: it adopts the position and keeps both orders; no duplicate entry.
- [ ] Press the **kill switch** with a position open: it flattens; entries stay blocked; release does not re-arm.
- [ ] Switch Live → Demo with a position open and confirm your chosen policy behaves as documented.
- [ ] Unplug the network / block Delta from the backend: the dashboard shows data as stale, no entries are attempted.

## C. Production
- [ ] **Join the Scalper Offer in your production Delta account, before the first live trade.** Per the operator's terms, trades taken before joining are not eligible, and it cannot be deactivated afterwards. A web-search summary of Delta's help article says: KYC-verified account, click *Join Now* on the Scalper Offer pop-up on the Futures page. Treat that as unverified and follow what Delta's site shows (or ask Delta support). Accounts with internal, corporate, RMM/MM/KOL fixed-fee terms are not eligible.
- [ ] Check Delta's current text for the offer: is **ETHUSD 30 minutes** today? (Some Delta-sourced text lists 30 minutes for BTC only and 15 for other futures.) If it is 15, set Strategy & Risk → *Close-within window* to 15 and lower *Break-even stop after* below 13.5 min, otherwise the settings will not save.
- [ ] **If you cannot or did not join:** switch *Assume the Scalper Offer* OFF (Strategy & Risk) **before** activation. All estimates then include the closing fee and the time exit stays at the configured 30 min.
- [ ] The Diwali Scalper Offer (opening-fee voucher) is BTCUSD only. It does not apply to this ETHUSD bot, is not modelled, and must not be counted in your expectations.
- [ ] New production key (Trading only, IP whitelisted). `DELTA_ENV=production`. Test connection.
- [ ] Live → Scalper Offer card: confirm the status reads *Assumed — unverified* for the production account (it resets automatically when the environment or key changes; if it still shows an old verdict, press **Reset & re-check…**).
- [ ] Fund only what you can afford to lose. Set `perTradeRiskUsd`, `dailyLossLimitUsd`, `maxDrawdownPct` conservatively (defaults: $2.50 / $6 / 15 %).
- [ ] Settings validate with **no warnings you do not understand** (liquidation buffer at 50x is tight: ≈ 1.5 % of price; the time-exit clamp to 28.5 min is expected while the offer is assumed).
- [ ] Live Trading → Enable Live Trading → read every check (the *Scalper Offer (zero closing fee)* line says whether it is assumed, confirmed or not applied, and the max holding time shows 28.5 min) → tick the five acknowledgements → password + phrase. Changing any waiver setting afterwards invalidates the reviewed token.
- [ ] Watch the first trades manually. Keep the kill switch reachable on your phone.

## D. First live closes: check the closing fee
The bot assumes the closing fee is zero for a position closed within 30 minutes and checks it on every live close it can verify. You must see it confirmed before you trust the economics.
- [ ] Wait for the first live trade that closes inside the window (take-profit, stop or the 28.5-min time exit). In the *Scalper Offer* card on the Live tab the status becomes **Confirmed ×1** and *Last check* reads "expected FREE · exchange charged $0.000 → waived as expected" (the top-bar chip says *confirmed ×1*; `GET /api/audit` as admin lists a `scalper_offer_confirmed` row; the dashboard has no audit page).
- [ ] Cross-check on Delta's own trade history / fee statement: the closing fill shows a fee of 0, and the opening fee matches the dashboard's entry fee (about $0.354 for a taker entry at 0.20 ETH and ETH $3,000).
- [ ] Repeat the check for each exit type you actually get (resting take-profit, stop, time exit). A single confirmation does not prove that every order type is covered; the bot keeps checking every later close and flips to *NOT APPLIED* if one of them is charged.
- [ ] **If the card says NOT APPLIED, or the dashboard and Delta disagree: stop and follow [`OPERATIONS.md`](OPERATIONS.md#scalper-offer-not-applied).** Do not press *Reset & re-check…* just to get back the cheaper economics. Joining the offer later does not cover trades taken before; pressing reset only makes the bot check the next eligible close again.
- [ ] Review the audit log (`GET /api/audit`, admin) and the actual-vs-simulated fee/slippage difference weekly (Analytics → *Closing fees saved* for Demo and for Live); stop if it exceeds your assumptions. Delta can change or end the offer without notice: a *NOT APPLIED* banner later in life means exactly that, and the "without offer" column of the README table is then your reality.
