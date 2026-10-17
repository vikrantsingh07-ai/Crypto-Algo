# Demo → Live checklist

Do not skip items. Tick each one.

## A. Before touching any exchange account
- [ ] Demo has run for ≥ 1–2 weeks across different market conditions; trades/24 h, stop/target/time-exit mix and drawdown look as expected.
- [ ] A walk-forward backtest on **real** Delta candles (`npm run backtest -- --days 45 --kind walkforward`) was run and its out-of-sample section reviewed (trades ≥ 100? win rate vs the *required* win rate on the fee reality check?).
- [ ] You understand that fees consume most of a $4–$6 move (README table) and accept the break-even win rate.
- [ ] `ADMIN_PASSWORD_HASH`, `SESSION_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, `PROXY_SHARED_SECRET` set; HTTPS on the backend; backend has a **static outbound IP**.

## B. Testnet rehearsal (`DELTA_ENV=testnet`, Delta demo account)
- [ ] Testnet API key created with **Trading** permission, backend IP whitelisted; **Test connection** passes.
- [ ] Activation wizard passes all checks; phrase `ENABLE TESTNET TRADING`.
- [ ] Confirm on the exchange UI: contract `ETHUSD` value/tick/leverage/fees match the dashboard's "Contract" row.
- [ ] Observe a full trade: IOC entry fill, **stop and target both resting** (reduce-only), exit by target / stop / time exit; compare fees and P&L with the exchange statement (this settles the GST / commission question).
- [ ] Restart the backend mid-position: it adopts the position and keeps both orders; no duplicate entry.
- [ ] Press the **kill switch** with a position open: it flattens; entries stay blocked; release does not re-arm.
- [ ] Switch Live → Demo with a position open and confirm your chosen policy behaves as documented.
- [ ] Unplug the network / block Delta from the backend: the dashboard shows data as stale, no entries are attempted.

## C. Production
- [ ] New production key (Trading only, IP whitelisted). `DELTA_ENV=production`. Test connection.
- [ ] Fund only what you can afford to lose. Set `perTradeRiskUsd`, `dailyLossLimitUsd`, `maxDrawdownPct` conservatively (defaults: $2.50 / $6 / 15 %).
- [ ] Settings validate with **no warnings you do not understand** (liquidation buffer at 50x is tight: ≈ 1.5 % of price).
- [ ] Live Trading → Enable Live Trading → read every check → tick acknowledgements → password + phrase.
- [ ] Watch the first trades manually. Keep the kill switch reachable on your phone.
- [ ] Review the audit log and the actual-vs-simulated fee/slippage difference weekly; stop if it exceeds your assumptions.
