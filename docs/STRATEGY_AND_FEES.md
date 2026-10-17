# Strategy and fees

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

Then: target = clamp(3·ATR, $4, $6), stop = clamp(2.5·ATR, $3, $6). Entry is an IOC taker order capped at +$0.60 slippage; take-profit is a resting reduce-only limit (maker); stop is an exchange-side reduce-only stop-market. After 15 min in profit (net of fees) the stop moves to break-even; at 30 min the position is closed at market. Regimes (trend up/down, range, high/low volatility) are recorded per trade.

The risk manager then must approve (see README). Notably **expected net reward:risk ≥ 0.25 and expected net reward ≥ $0.10 after fees**; with the default $4.5 stop this is what rejects most signals when the target is small.

## Why fees dominate

Commission = rate × notional, per leg, plus 18 % GST. At ETH ≈ $3,000 and 0.20 ETH (notional ≈ $600): taker leg ≈ $0.354, maker leg ≈ $0.142. A taker-in/taker-out round trip ≈ $0.71 — almost the whole $0.80 gross of a $4 move. With a maker take-profit the round trip is ≈ $0.50, so a $4/$5/$6 winner nets ≈ $0.30/$0.50/$0.70, while a stopped trade loses ≈ $1.66 (stop $4.5 + stop slippage + two taker legs). Break-even therefore requires a win rate of ≈ 84 % / 77 % / 70 %. Fees scale with price while the target is fixed in dollars: the problem worsens as ETH rises (see the README table).

Levers you control: wider/more selective entries (higher win rate), larger targets, maker entries (not implemented: IOC taker entries are used for fill certainty), lower trade frequency. The fee reality check on **Strategy & Risk** recomputes these numbers from the live price and the exchange's rates.

## Demo fill model (deliberately conservative)

* Entry at ask/bid ± `simSlippageUsd` ($0.10), taker fee. Stop fills at min(stop, bid) − `simStopSlippageUsd` (extra $0.25), taker fee.
* Take-profit fills only after the market trades **through** the target (one tick beyond), at the target price, maker fee (`touch` model optional).
* If stop and target are both inside one bar/tick, the **stop is assumed to hit first**.
* Funding is charged when a funding timestamp is crossed (rate from the feed, else `fundingRateFallback`).
* Real execution will differ (queue position, partial fills, latency); Demo labels say so.

## Backtest and out-of-sample

`runBacktest` replays closed candles with the same strategy/risk/paper code; the signal on bar *i* fills at the open of bar *i+1*. `walkForward` rolls (train → test) windows, chooses the best of a **small** parameter grid in-sample, and reports only out-of-sample trades. Metrics: trades, win rate (+95 % Wilson interval), gross, costs, net, profit factor, max drawdown, average hold, % reaching the target, TP/stop/time-exit mix, performance per regime and per side. Fewer than 100 trades ⇒ flagged statistically weak. **A profitable backtest is not evidence of future profit**; confirm with weeks of Demo.
