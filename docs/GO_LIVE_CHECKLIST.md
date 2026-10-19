# Demo → Live checklist

Do not skip items. Tick each one. Nothing in this project has been run against the real Delta Exchange (its hosts were unreachable from the build sandbox), and no result on real market data exists in this repository. The operator will add an exchange API later and ask for the Live part then; until that point the system stays in Demo and none of sections B to D applies.

## A. Before touching any exchange account
- [ ] Demo has run for ≥ 1–2 weeks across different market conditions. Check trades/24 h, the stop/target mix, drawdown, and **how long trades stay open**: there is no time limit, so look at trades that ran for hours, the funding they paid or received, and how often a long trade blocked the single position slot.
- [ ] A walk-forward backtest on **real** Delta candles (`npm run backtest -- --days 45 --kind walkforward`, or Developer view → Analytics → Backtests) was run on the VM and its out-of-sample section reviewed: trades ≥ 100? win rate against the **required** win rate ([`STRATEGY_AND_FEES.md`](STRATEGY_AND_FEES.md): about 61-67 % to break even and about 79-83 % for INR 500/day at ETH $3,390 with a $5-$8 stop)? how many trades were still open at the end of the data (`endOfDataPct`)? A backtest on synthetic data proves nothing about the market.
- [ ] You understand the economics: a $10 target on 0.20 ETH is $2.00 gross, brokerage on **both** legs is about USD 0.80 at ETH ~$3,390 (it grows with the price), so a win nets about USD 1.20 and a loss costs USD 1.85 to 2.45. The INR 500/day figure on the dashboard is a goal, not a promise, and 10 trades a day is a ceiling, not a quota.
- [ ] `ADMIN_PASSWORD_HASH` (or a 12+ character `ADMIN_PASSWORD`), `SESSION_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, `PROXY_SHARED_SECRET` set; HTTPS on the backend; backend has a **static outbound IP**. (Phone-only setup: `docs/SUBAH_DEPLOY_HINGLISH.md` or `docs/ORACLE_CLOUD_HINGLISH.md`.)
- [ ] The dashboard's price pill reads **Live** in a real browser (not stuck on *Delayed*); the order-flow card shows buyers on the left and sellers on the right.

## B. Testnet rehearsal (`DELTA_ENV=testnet`, Delta demo account)
- [ ] Testnet API key created with **Trading** permission, backend IP whitelisted; **Test connection** passes.
- [ ] Activation wizard (Developer view → Live Trading → Enable Live Trading…) passes all checks; phrase `ENABLE TESTNET TRADING`. The review states the holding rule in plain words ("no time limit … through funding payments"); read it and tick the fifth acknowledgement only if you accept it.
- [ ] Confirm on the exchange UI: contract `ETHUSD` value/tick/leverage/fees match the dashboard's "Contract" row.
- [ ] Observe a full trade: IOC entry fill, **stop and target both resting** (reduce-only), exit by target or stop; compare fees and P&L with the exchange statement. Both legs should show a commission (this also settles whether the reported commission already includes GST).
- [ ] Hold a testnet trade across a funding time if you can and check the funding line on the statement against the bot's funding figure.
- [ ] Restart the backend mid-position: it adopts the position and keeps both orders; no duplicate entry.
- [ ] Press the **kill switch** with a position open: it flattens; entries stay blocked; release does not re-arm.
- [ ] Switch Live → Demo with a position open and confirm your chosen policy behaves as documented.
- [ ] Unplug the network / block Delta from the backend: the dashboard shows data as stale, no entries are attempted.

## C. Production
- [ ] New production key (Trading only, IP whitelisted). `DELTA_ENV=production`. Test connection.
- [ ] Fund only what you can afford to lose. Set `perTradeRiskUsd`, `dailyLossLimitUsd`, `maxDrawdownPct` conservatively (defaults: $2.50 / $6 / 15 %). Remember that a $8 stop passes the $2.50 per-trade cap only below roughly ETH $3,520.
- [ ] Settings validate with **no warnings you do not understand** (the "no time limit" funding warning is expected; liquidation buffer at 50x is tight: ≈ 1.5 % of price).
- [ ] Decide the holding rule on purpose: no time limit (default), or a time limit / break-even policy in Developer view → Strategy & Risk. With no limit you are accepting overnight trades; keep the kill switch reachable on your phone.
- [ ] Live Trading → Enable Live Trading → read every check → tick the five acknowledgements → password + phrase. Changing settings afterwards invalidates the reviewed token.
- [ ] Watch the first trades manually.

## D. First live trades: compare the bot with Delta
- [ ] For the first live trades, compare the dashboard with Delta's own trade history and fee statement: entry fee and exit fee are both charged (about USD 0.40 each at ETH $3,390 for a taker fill, less for a maker take-profit), and the bot's net P&L matches.
- [ ] Check that a take-profit rests as a limit order and a stop rests as a stop-market order on the exchange for every trade.
- [ ] Review the audit log (`GET /api/audit`, admin) and the actual-versus-simulated fee and slippage difference weekly; stop if it exceeds your assumptions.
- [ ] Only if you have deliberately switched the optional closing-fee waiver on: it is an unverified assumption until live closes confirm it. Follow [`OPERATIONS.md`](OPERATIONS.md#if-you-switched-the-exit-fee-waiver-on-and-it-says-not-applied) if the Scalper Offer card turns *NOT APPLIED*. By default it is off and nothing in the dashboard mentions it.
