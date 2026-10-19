# Strategy and fees

Every number in this file comes from the real fee code in `packages/core/src/fees.ts` (`roundTripFee`, `calcFee`, `estimateEconomics`, `requiredWinRate`, `dailyOutlook`) and the real entry gate in `packages/core/src/risk.ts` (`evaluateEntryRisk`). The key ones are pinned by `packages/core/test/fees.test.ts`. They are arithmetic on stated inputs. **None of this is a forecast, and no win rate or profit is claimed anywhere in this project.**

## Rules (1-minute candles; evaluated once per closed candle)

Long needs **all** of (Short is the mirror):

| Condition | Default |
|---|---|
| trend | EMA9 > EMA21 > EMA55 and EMA55 rising |
| vwap | close > UTC-day VWAP and > EMA9 |
| breakout | close > highest high of the previous 10 bars |
| momentum | close − close[3 bars ago] ≥ 0.8·ATR14 |
| body | body ≥ 0.5·ATR and close in the top 35 % of the candle |
| volume | volume ≥ 0.8 × mean of the previous 20 bars |
| extension | close within 2·ATR of EMA9 (do not chase) |
| efficiency | Kaufman ER(20) ≥ 0.25 (filters chop) |
| ATR band | $1 ≤ ATR14 ≤ $15 |

Then the trade plan:

* **Target: a fixed $10 move per ETH**, long or short (`targets.targetMoveMinUsd = targetMoveMaxUsd = 10`). On 0.20 ETH that is **$2.00 gross**.
* **Stop: clamp(2.5·ATR, $5, $8)** (`targets.stopLossMinUsd = 5`, `stopLossMaxUsd = 8`): calm markets get the $5 floor, busy ones up to the $8 cap.
* Entry is an IOC taker order capped at +$0.60 slippage; the take-profit is a resting reduce-only **limit** order (a maker fill); the stop is an exchange-side reduce-only stop-market.
* **At most 10 new trades in any rolling 24 hours** (`limits.maxTradesPer24h`, hard ceiling 10). This is a **ceiling, never a quota**: the bot trades only when a setup passes every condition above and every risk gate below, and it never opens a trade to fill the number. One position at a time, so a trade that is still running also blocks new entries.

## How a trade ends: there is no time limit

A position stays open until **its take-profit fills or its stop-loss is hit** (or an administrator closes it by hand, or the kill switch fires). The default is `exits.maxHoldMinutes = null` with `exits.timeExitPolicy = "none"`: no time exit and no break-even tightening. A trade may run 2-3 hours or much longer. The stop-loss is always active; only the time exit was removed.

Developer view → Strategy & Risk can still set a limit (a number of minutes with the policy `close_at_market`, or `breakeven_then_close` for a break-even stop after `breakevenAfterMinutes` plus a hard close). Under the policy `none` a stored `maxHoldMinutes` is ignored, and settings validation says so.

What "no time limit" means in practice:

* **Funding.** A position open across a funding time pays or receives funding. At the fallback rate (0.01 % per 8-hour interval, `execution.fundingRateFallback`) one interval on 0.20 ETH at ETH $3,390 is about USD 0.07 (longs pay and shorts receive when the rate is positive). The simulator charges every funding time crossed, however many hours the trade runs, from the feed's rate when it has one. Real rates move, and a long hold crosses several times. Settings validation shows a "no time limit" warning for this reason.
* **Overnight.** A trade can be open while you sleep. In Live the stop and the target rest on the exchange; in Demo they are simulated by the worker, so a Demo trade only moves while the backend is running.
* **A trade that is in profit is not protected.** With no break-even tightening, a trade that reaches +$9 and turns around still ends at the stop for a full loss.
* **Gaps and fast moves.** A stop-market order can fill beyond the stop price. Demo models $0.25 of extra slippage on stops, not larger gaps.
* **The one position slot.** A long trade blocks the slot, so "10 per day" is rarely reachable; fewer trades also means a smaller daily total.

## Fees: brokerage is paid on BOTH legs

Commission = rate × notional per leg, plus 18 % GST. Rates are read from the exchange product at runtime; until then the documented fallback (taker 0.05 %, maker 0.02 %) is used for display and blocks Live activation. 0.20 ETH = 20 contracts × 0.01 ETH.

| ETH price | Taker leg | Maker leg | Round trip taker/taker (the planning figure) | Round trip taker entry / maker exit | Price move needed to cover taker/taker |
|---|---|---|---|---|---|
| $2,000 | $0.236 | $0.094 | **$0.472** | $0.330 | $2.36 |
| $3,000 | $0.354 | $0.142 | **$0.708** | $0.496 | $3.54 |
| **$3,390** | **$0.400** | **$0.160** | **$0.800** | **$0.560** | **$4.00** |
| $4,000 | $0.472 | $0.189 | **$0.944** | $0.661 | $4.72 |

* The standard planning figure is **taker/taker ≈ USD 0.80 at ETH ~3,390** (the dashboard's "Brokerage about USD 0.80 per trade (entry + exit)" is `state.economics.roundTrip`, which follows the live price and the exchange rates; nothing is hard-coded). A stop-out always pays this: entry is a taker order and the stop is a market order.
* A winner exits through the resting take-profit limit order, which is a **maker** fill (0.02 %) when it rests and is hit: that costs about $0.56 at ETH 3,390. The simulator and the entry gate assume this. The conservative taker/taker figure is used below for the required win rates, with the maker-exit variant next to it.
* Fees scale with the ETH price while the target is a fixed dollar move, so the same target is worth less as ETH rises.
* In Live the commission the exchange **reports on each fill is authoritative**; these figures are estimates (including whether Delta's reported commission already contains GST, which is still an open item in `DELTA_API.md`).

## The $10 target on 0.20 ETH, and what it implies

At ETH $3,390, taker/taker fees $0.80, stop slippage $0.25 (`execution.simStopSlippageUsd`), 88 INR per USD (`execution.usdInrRate`):

| Stop | Net of a win ($2.00 − $0.80) | Net of a loss ((stop + $0.25) × 0.20 + $0.80) | Break-even win rate | Win rate needed for INR 500/day over 10 trades | Same, with a maker take-profit | A driftless random walk reaches +$10 before −stop |
|---|---|---|---|---|---|---|
| $5 | +$1.20 | −$1.85 | 60.7 % | **79.3 %** | 73.5 % | 33.3 % |
| $6 | +$1.20 | −$2.05 | 63.1 % | **80.6 %** | 75.0 % | 37.5 % |
| $8 | +$1.20 | −$2.45 | 67.1 % | **82.7 %** | 77.6 % | 44.4 % |

How to read it:

* INR 500 a day is USD 5.68, which is USD 0.57 per trade over 10 trades. A winner nets about USD 1.20 and a loser costs USD 1.85 to 2.45, so roughly **80 % of trades must win** at every stop in the band. Fewer than 10 trades makes the daily total smaller still.
* The last column is the textbook probability for a price with no drift (stop ÷ (target + stop)). It is a reference point, not a measurement of the strategy: the strategy only enters on a trend and momentum signal, so its own rate can be higher or lower, and **only a measurement on real data can say which**. It does show the structure of the problem: a $10 target against a $5 stop is reached first about a third of the time on a plain random walk, and widening the stop raises the hit rate but makes every loss bigger.
* The needed win rate also depends on the price (stop $6): 70.5 % at ETH $2,000, 77.7 % at $3,000, 80.6 % at $3,390, 85.0 % at $4,000.

If the win rate were as in the first column (10 trades, taker/taker, ETH $3,390), these are **scenarios, not predictions**:

| Win rate | Stop $5 | Stop $6 | Stop $8 |
|---|---|---|---|
| 50 % | −$3.25 (INR −286) | −$4.25 (INR −374) | −$6.25 (INR −550) |
| 60 % | −$0.20 (INR −18) | −$1.00 (INR −88) | −$2.60 (INR −229) |
| 70 % | +$2.85 (INR 251) | +$2.25 (INR 198) | +$1.05 (INR 92) |
| 80 % | +$5.90 (INR 519) | +$5.50 (INR 484) | +$4.70 (INR 414) |

### The INR 500 figure is a goal, not a promise

The dashboard shows "Today ₹x of ₹500 goal" with the line "A goal, not a promise. The algo never trades just to reach it." (`goals.dailyProfitInr`, default 500, display only). Nothing in the bot reads the goal to size, force or relax a trade, and reaching it does not stop or start anything. A 70-80 % win rate is the operator's target; it is not something the bot, the backtester or this documentation has demonstrated.

## Risk gates (every one still applies)

The entry gate computes, for the planned trade at the current quote (it adds the $0.10 simulated entry slippage, and prices the take-profit as a maker exit): net loss at the stop must be ≤ `limits.perTradeRiskUsd` ($2.50) **with full brokerage on both legs**, net reward at the target ≥ $0.10, and net reward:risk ≥ 0.25. At ETH $3,390 for a long (`evaluateEntryRisk`):

| Stop | Net loss at stop | Net reward at target | Net reward:risk | Highest ETH price at which the $2.50 per-trade cap still passes |
|---|---|---|---|---|
| $5 | $1.87 | $1.42 | 0.76 | about $6,060 |
| $6 | $2.07 | $1.42 | 0.69 | about $5,200 |
| $8 | $2.47 | $1.42 | 0.57 | **about $3,520** |

So a $8 stop is accepted only while ETH is below roughly $3,520; above that wide-stop signals are rejected by `PER_TRADE_RISK` and no trade is taken (the bot never trades to fill a quota, and raising the cap is a deliberate decision of the operator). Settings validation warns about this when a price is known.

The other gates are unchanged: daily loss limit ($6), max drawdown (15 %), loss-streak breaker (3 losses, then a pause), cooldown after a loss, one open position, free margin ≥ 30 %, liquidation distance ≥ 3× the stop distance (at 50x and the fallback margin values the estimated liquidation distance is about $51 at ETH $3,390, versus a $5-$8 stop), max spread, stale data, API health, reconciliation, the kill switch, and the 10-per-24h ceiling. 50x leverage overrides none of them.

## What the evidence says, and what it does not

* **There are no real-data results in this repository.** The Delta hosts were not reachable from the sandbox this was built in, so no backtest on real Delta candles was run, and no research on how often a $10 move comes before a $5-$8 stop on real ETH data was available when this was written. The mechanics (fees, fills, funding, multi-hour holds, end-of-data handling) are tested on clearly labelled synthetic data and on unit cases only.
* The 70-80 % win rate is therefore an operator goal. The evidence has to come from running the dashboard backtests on the VM, where the real Delta candle history is reachable: Developer view → Analytics → Backtests (an administrator can run a single backtest or a walk-forward evaluation), or `npm run backtest -- --days 45 --kind walkforward`. Read the out-of-sample section, the trade count (fewer than 100 trades is flagged statistically weak), the win-rate interval, and how many trades were still open at the end of the data.
* A small sample proves nothing, in Demo as in a backtest. Days of Demo with a handful of trades say almost nothing about a win rate; the 95 % interval around, say, 7 wins in 10 trades spans roughly 40 % to 89 %.

## Demo fill model (deliberately conservative)

* Entry at ask/bid ± `simSlippageUsd` ($0.10), taker fee. The target and stop are measured from the **filled** entry price, so a winner is exactly $10 × 0.20 = $2.00 gross. Stop fills at min(stop, bid) − `simStopSlippageUsd` (extra $0.25).
* Take-profit fills only after the market trades **through** the target (one tick beyond), at the target price, maker role (`touch` model optional).
* If stop and target are both inside one bar/tick, the **stop is assumed to hit first**.
* No time exit by default; with a limit configured the exit is a market close with slippage at that time.
* Funding is charged for every funding time crossed while the position is open (rate from the feed, else `fundingRateFallback`), however long the trade runs.
* Both legs pay brokerage: a maker or taker fee plus 18 % GST on the exit, never zero.
* Real execution will differ (queue position, partial fills, latency); Demo labels say so.

## Backtest and out-of-sample

`runBacktest` replays closed candles with the same strategy/risk/paper code; the signal on bar *i* fills at the open of bar *i+1*. `walkForward` rolls (train → test) windows, chooses the best of a **small** parameter grid in-sample, and reports only out-of-sample trades. The default grid has a baseline, a `tight-breakout` and a `loose-breakout` candidate, and a `wide-stop` candidate (stop $7-$8; with the fixed $10 target a wide-target candidate would be identical to the baseline).

Metrics: trades, win rate (+95 % Wilson interval), gross, costs, net, profit factor, max drawdown, average hold, % reaching the target, target/stop mix, performance per regime and per side. Holding-time buckets are < 10 min, 10-30 min, 30-60 min, 1-3 h and > 3 h.

A position that is **still open when the data ends** is closed at the last executable price with the reason `end_of_data`. It stays in the trade list and is counted in `endOfDataTrades` and `metrics.endOfDataPct`; treat its P&L as unfinished, not as a real exit. Walk-forward folds cut the data at each window edge, so they can contain such trades too (they are included in the out-of-sample aggregate; filter them by exit reason for a stricter figure). The per-trade loss cap in a backtest always uses full fees.

Every result states its assumptions. **A profitable backtest is not evidence of future profit**; confirm with weeks of Demo and then the first live trades.

## The dormant optional exit-fee waiver (off by default)

Delta has a "Scalper Offer" (terms as supplied by the operator, **not verified against Delta**): close a position within 30 minutes and no closing fee is charged on eligible trades, the opening fee is still paid, the account must have joined the offer, liquidations are not eligible, and Delta may change or end it. **The bot does not assume it.** `execution.exitFeeWaiver.enabled` defaults to `false`, and when it is off nothing in the dashboard, the activation workflow or the estimates mentions it.

The setting block stays in the schema (`enabled`, `withinMinutes` 30, `safetyMarginSeconds` 90, `clampTimeExit`) so it can be switched on for an account that has joined. Switched on, it works in a limited way: the estimates treat an exit as free only when a configured time limit guarantees every exit inside the window (with no time limit the full closing fee is always counted); a set time limit is clamped to window minus margin (28.5 min); Live P&L is always the commission the exchange reports; each live close that should have been free is checked against the assumption (`unverified` → `confirmed`, or `not_applied`, after which Live goes back to full fees until an administrator resets it with `POST /api/live/waiver/reset`). The loss cap always uses full fees. What to do on `not_applied`: [`OPERATIONS.md`](OPERATIONS.md#if-you-switched-the-exit-fee-waiver-on-and-it-says-not-applied).

The separate **Diwali Scalper Offer** (opening fee returned as a Fee Voucher; **BTCUSD only**) does not apply to this ETHUSD bot and is not modelled.
