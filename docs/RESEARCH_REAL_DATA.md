# Real-data research: can these rules reach 70-80 % wins / INR 500 a day?

**Short answer: not on the evidence we could obtain.** On 4.8 years of real ETH 1-minute candles, the default rules (fixed $10 target, $5-$8 stop, no time limit, brokerage on both legs) **lost money in every one of 49 out-of-sample months**, with a win rate of about 41 %, not 70-80 %. This is a simulation on a different venue with modelled costs, so it is evidence about the *rules*, not a forecast for your Delta account; but it points clearly in one direction. Nothing here is a promise or a prediction of profit.

## What data was used (and what it is not)

* **ETHUSDT 1-minute candles on Binance SPOT**, 2022-01-01 to 2026-10-17, 2,521,360 candles (ETH range about $880 to $4,960). **This is not Delta Exchange data** and not a perpetual contract: the Delta hosts (and Binance, Bybit, Coinbase, Kraken, OKX and others) are blocked from the sandbox this was built in, so only third-party copies on GitHub were reachable. No Delta price, fee or funding history could be obtained.
* Source: a GitHub re-publication of Binance public klines (`parshant231234-eng/ETHUSDT-Historical-Data`, monthly CSVs). Checks done: 1 gap of 80 minutes (2023-03-24), 0 duplicates, 0 OHLC violations, 72 zero-volume bars; a second independent copy (`Speirsy11/crypto-dataset`) is bit-identical for 2022-01-01 to 2026-05-18 apart from 7 bars; against Bybit's ETHUSDT perpetual (15-minute bars, `mestoness/btc-eth-candles-history`, to 2025-12) the return correlation is 0.997 and the mean basis about 3 bp. **The last five months (2026-05-19 onward) exist in one copy only** and could not be cross-checked; they are reported separately.

## Method

* The repository's own, unmodified backtester (`packages/core` `runBacktest` / `walkForward`) with the v2 defaults: 0.20 ETH, 50x, fixed +$10 target as a resting maker limit, stop as a taker with $0.25 slippage, entry at the next candle open + $0.10 spread + $0.10 slippage, stop-first when both are inside one candle, funding a constant 0.01 % per 8 h (longs pay), **no time limit**, all risk gates on. Fees are the repository's documented fallback rates (maker 0.02 %, taker 0.05 %, 18 % GST), **not verified against a Delta account**.
* **Strict walk-forward**: for each calendar test month the configuration was picked from 21 pre-declared candidates (stop widths $5, $6, $7, $8 fixed and three ATR-based bands, crossed with base / tight / loose breakout entries) using only trades that had already *closed* in the previous 3 months, then evaluated unchanged on that month. The design was written down before any result was seen. Only out-of-sample trades are reported.
* Checks: a random-direction, random-time **no-skill control** with identical exits and costs (6 seeds); a zero-cost scenario; harsher-cost scenarios; an independent from-scratch recomputation of 400 random trades (entry, exit, fees, funding and net all matched); and the repository's own `walkForward(DEFAULT_GRID)`.

## Results (out-of-sample)

| Run | Trades | Win rate (95 % interval) | Avg net per trade | Note |
|---|---|---|---|---|
| Headline: walk-forward, shipped risk gates, 2022-04 to 2026-04 (49 months) | 1,055 | 40.9 % (38.0-43.9) | -$0.565 (CI -0.73 to -0.44) | 0 of 49 months positive; net -$596; about 0.71 trades/day; about -INR 35/day |
| Same, tail 2026-05 to 2026-10 (single-source data) | 171 | 45.6 % (38.3-53.1) | -$0.421 | 0 of 6 months positive |
| Same walk-forward without the 15 % drawdown halt (larger sample, not a recommended configuration) | 5,749 | 42.0 % (40.7-43.3) | -$0.64 | 0 of 49 months positive |
| The repository's own `walkForward(DEFAULT_GRID)`, 2024-11 to 2026-05 | 262 | 35.5 % (29.9-41.5) | -$0.83 | 15 folds |
| No-skill control: random direction and time, same exits and costs | 49,259 | 38.3 % overall | -$0.69 | win rate rises with stop width, expectancy does not |

* **Every one of 42 fixed configuration / profile combinations had negative expectancy**, and the strategy's results sit within about $0.03-$0.08 per trade of the random control before fees, against about $0.45 of fees per trade. The average gross P&L before fees was already about -$0.11 per trade.
* **High accuracy can be bought with wide stops, not profit.** A 70-80 % win rate only appeared with a stop of about $23-$40 (the strategy: 73.8 % at a $30 stop; random entries: 72-75 % at $30-$40), but then the average loss is about $7 against a $1.4-$1.6 win, the break-even win rate rises to 80-86 % and expectancy stays near -$0.6. The shipped per-trade risk gate ($2.50) would reject those stops anyway. **Do not widen the stop to chase a win rate.**
* Win rate by stop width is what chance predicts: for a price with no drift, the probability of reaching +$10 before a stop of $5 / $6 / $8 is 33 % / 38 % / 44 %; the observed win rates were about 32 % / 39 % / 44 % for fixed stops.
* **INR 500 a day** needs about $5.68 net per day. At the realised sizes (win $1.64, loss $2.09) break-even is a 56 % win rate and INR 500 over 10 trades needs about 71 %; at ETH $3,390 with a maker take-profit the requirement is about 74-78 % for $5-$8 stops (81 % at a $6 stop if the take-profit fills as a taker). The rules produced about 0.7 trades a day with the shipped gates, so even a 100 % win rate would not reach INR 500 at that frequency; only 0.2 % of simulated days netted INR 500 or more. Applying the observed 40.9 % win rate to 10 trades a day gives roughly -INR 500 a day.
* With the 15 % drawdown halt on a $100 demo account, the halt was reached in 29 of 49 simulated months (fresh account each month); in practice the bot would sit halted until it is reset.

## Limitations (all of them favour the strategy or are unknown)

* **Different venue:** Binance spot, not Delta's ETHUSD perpetual. Delta's spread, wicks, slippage, fee schedule, funding and any offers are unknown here.
* **Optimistic simulator:** the resting take-profit is assumed to fill whenever price trades one tick through (no queue position, no partial fills); entry has no latency; no rejections or outages; stop slippage is a fixed $0.25. Real results would be equal or worse.
* **Constant funding and modelled costs.** Scenario runs (zero costs, 2x costs) did not change the sign.
* **Third-party copies** of Binance data, not downloaded from Binance; the last five months are single-source.
* Trades cluster in time, so the Wilson intervals are optimistic; month-block bootstrap intervals for the expectancy are given in the table. The sample cannot rule out a tiny pre-fee edge of a few cents per trade, but that would be an order of magnitude too small to pay about $0.45 of fees per trade.
* Not tested on purpose (to avoid data-dredging): other strategies, filters beyond the 21-candidate grid, other symbols or timeframes, a time-based exit, maker entries.

## What this means for you

* Keep the bot in **Demo**. Treat INR 500 a day as a goal the rules have not shown they can reach.
* Suggested gate before any Live use: **at least 300 forward Demo trades with a positive average net per trade whose 95 % interval excludes zero**, and a fee statement from your own Delta account confirming both legs are charged as modelled.
* Changing the *strategy* (not just the stop and target) is the only lever with a chance of changing this result, and it needs its own out-of-sample evidence, with the same walk-forward discipline, before it is trusted.
