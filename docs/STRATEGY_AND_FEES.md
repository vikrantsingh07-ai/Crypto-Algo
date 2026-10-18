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

Then: target = clamp(3·ATR, $4, $6), stop = clamp(2.5·ATR, $3, $6). Entry is an IOC taker order capped at +$0.60 slippage; take-profit is a resting reduce-only limit (maker); stop is an exchange-side reduce-only stop-market. After 15 min in profit (net of fees) the stop moves to break-even. The position is closed at market by the **time exit**: at **28.5 min** while the Scalper Offer waiver is assumed (the 30-minute window minus a 90 s safety margin), at `exits.maxHoldMinutes` (30) otherwise. Regimes (trend up/down, range, high/low volatility) are recorded per trade.

The risk manager then must approve (see README). Notably **expected net reward:risk ≥ 0.25 and expected net reward ≥ $0.10 after fees**. This is what rejects signals when the target is small; with the Scalper Offer assumed it rejects fewer of them (table in [Risk gates](#risk-gates-with-and-without-the-offer)).

## Delta Scalper Offer (exit-fee waiver)

### Terms (supplied by the operator; not verified against Delta)

* Close a position within **30 minutes** (BTCUSD and ETHUSD; 15 minutes for other futures) and **no closing fee** is charged on eligible trades. The **opening fee is still paid**. Delta's example: opening maker fee 0.02 % ($12 on $60,000) is paid, the closing taker fee 0.05 % ($30.05) is waived.
* The account must have **joined** the offer. Trades taken before joining are not eligible; it cannot be deactivated once activated.
* Liquidations are not eligible. Partially closed positions are eligible. Not available to internal, corporate, RMM/MM/KOL or other fixed-fee users.
* Delta may modify or discontinue the offer without notice.
* The separate **Diwali Scalper Offer** (opening fee returned as a Fee Voucher; **BTCUSD only**; effective 25 Sep 2026 per the operator; capped at $100 per user per month) does **not** apply to this ETHUSD bot and is **not modelled**. Nothing in the bot credits an opening-fee voucher.

### What a web search added (unverified)

Delta's pages could not be opened from the build sandbox. A web search (search-result summaries only) was consistent with the terms above and added the following. Treat all of it as unverified and re-check on Delta before going Live.

* Eligibility is described as KYC-verified users who click **Join Now** on a Scalper Offer pop-up on the Futures page. KYC was not in the operator's terms.
* **ETHUSD window is not settled.** One source (the Diwali offer table) and two third-party pages say 30 minutes for ETHUSD. Another summary of the help article lists 30 minutes for BTC futures only and 15 minutes for "other futures", and the December 2024 launch reportedly had 15 minutes for both. If ETHUSD is really 15 minutes, set `execution.exitFeeWaiver.withinMinutes` to 15: the time exit clamps to 13.5 min and settings refuse to save until `exits.breakevenAfterMinutes` is below 13.5 (checked with `validateSettings`). Left at 30 while the real window is 15, every trade held between 15 and 28.5 min would pay the full closing fee and the estimates would be wrong; the live check below would catch it on the first such close.
* **Not found anywhere:** whether the 30 minutes run from the first or the latest entry fill, whether adding to a position restarts the clock, whether each partial close is judged from the original open, whether stop-loss / take-profit / API-placed orders count like manual closes, and how a waived closing fee appears in the API (commission `0`, or a charge plus a credit). A maker closing fill is presumably waived like a taker one (the wording is "the closing leg") but this is not stated.

### How the bot models it

The offer cannot be read through the Delta API. So it is an **assumption**, controlled by `settings.execution.exitFeeWaiver` (Strategy & Risk → *Delta Scalper Offer (closing-fee waiver)* → *Assume the Scalper Offer*), default **ON**:

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | assume the offer. **Turn it OFF if your Delta account has not joined.** OFF counts the full closing fee everywhere. |
| `withinMinutes` | `30` | close-within window |
| `safetyMarginSeconds` | `90` | time exit fires this long before the window ends, so latency or a slow fill cannot land the closing fill after the cut-off |
| `clampTimeExit` | `true` | while the waiver is assumed, the hard time exit is `min(exits.maxHoldMinutes, window − margin)` = 28.5 min |

| Where | What it does |
|---|---|
| **Demo** | Simulated. An exit whose hold time (exit fill time − entry fill time) is ≤ 30 min pays no closing fee, for any exit reason (take-profit, stop, break-even stop, time exit). The entry fee is always charged. Each trade records `exitFeeSaved`, shown on the dashboard ("exit FREE (saved $x)") and summed as `feesSavedUsd`. |
| **Backtest / walk-forward** | Same code as Demo. The waiver assumption is printed with every result (`assumptions`, and `summary.scalperOffer`). |
| **Pre-trade gates** (Demo and Live) | Net reward and net reward:risk are computed with an entry fee only. In Live this holds only while the status is not `not_applied` (below). The per-trade **loss cap** (`PER_TRADE_RISK`) is always evaluated on full fees: an assumed waiver never makes a risk limit looser. |
| **Live P&L** | **Always the commission the exchange reports on the fills** (authoritative). The estimate is used only when the closing fills could not be fetched, and the trade is then marked `commissionSource: estimate_full_fee` and uses the full closing fee (no waiver, no saving claimed). A fill whose payload has no usable commission number is treated as unknown, never as 0. |
| **Live time exit** | 28.5 min, measured from the bot's own entry timestamp (taken when the entry order is sent, i.e. slightly *before* the fill). A failed close is retried on every monitor tick, and the 5-second housekeeping pass also enforces it when the quote feed is down. |
| **Live fallback** | If the exchange charges a closing fee on an eligible close, or the setting is OFF: entry gates use full-fee economics and the time exit goes back to 30 min. |

Not eligible, in Demo/backtests and in the Live estimates: **liquidations** (the closing fee is always charged) and any **extra transaction tax** you configured (`otherTaxRate`, a separate levy). 

Hold time everywhere is measured **entry fill → exit fill** (exchange timestamps in Live; falls back to the bot's own timestamp when entry fills are unknown). The bot opens one position per signal and never adds to it, so only the first-fill case occurs. A hold of exactly 30:00.000 counts as inside; one millisecond later is not (core `calcFee`, and the mock exchange).

**What the waiver does not change.** Every safety gate (kill switch, 10 trades/24 h, daily loss, drawdown, loss streak, cooldown, free margin, liquidation buffer, spread, stale data, reconciliation, activation) is untouched. The offer only changes the *cost inputs* of the three economics gates. If the assumption is wrong, trades that pass only on waiver economics can be entered until the first eligible close exposes it; one position at a time, so normally that is a single trade, costing one closing fee (about $0.14 for a maker take-profit, $0.35 for a taker exit at ETH $3,000).

### Live verification

State is stored in the `live_waiver` document (`app_state` table) and shown in `GET /api/state` → `live.scalper`:

```
 unverified ── eligible close, closing commission ≤ $0.001 ─────────▶ confirmed (confirmedCount + 1, each time)
     │                                                                   │
     │ eligible close, commission > $0.001                               │ eligible close, commission > $0.001
     ▼                                                                   ▼
 not_applied  (sticky: a later free close is recorded in lastCheck but does not re-enable the waiver)
     │
     └── reset: POST /api/live/waiver/reset (admin) or any change to execution.exitFeeWaiver.*  ──▶ unverified
```

* An **eligible close** is one where all hold: the setting is ON, it was not a liquidation, the exchange's closing fills are known, and hold ≤ window − 5 s. A close within 5 s of the cut-off is ambiguous (clock skew, latency, how Delta measures the cut-off), so it is recorded in `lastCheck` with `expectedWaived: false` and counts neither way. A close after the window is recorded the same way and the dashboard shows an attention item ("closed after the Scalper window - closing fee will apply").
* `lastCheck` is `{ tradeId, at, holdMs, expectedWaived, exitFeeUsd }` for the most recent close with known exit fills, eligible or not.
* `not_applied` writes an audit row `scalper_offer_not_applied` and an attention item once, on the transition. `confirmed` writes `scalper_offer_confirmed` on the first confirmation. A reset writes `scalper_offer_status_reset`.
* While `not_applied` the bot trades **less, never more**: entry gates use full-fee economics and the time exit is no longer clamped. Reported P&L was never based on the assumption.
* The runbook is in [`OPERATIONS.md`](OPERATIONS.md#scalper-offer-not-applied); the step before going Live is in [`GO_LIVE_CHECKLIST.md`](GO_LIVE_CHECKLIST.md).

Limits of the check: it reads the commission as `meta_data.total_commission_in_settling_asset` when the fill has it, otherwise `commission`. If Delta handles a waived fee as "charged, then credited back" (not documented either way), the check reads it as charged and flips to `not_applied`; the Delta trade history would then show the credit. On the testnet the offer may not exist at all (not found in any Delta text), so a `not_applied` there is not evidence about production.

## Why fees dominate

Commission = rate × notional, per charged leg, plus 18 % GST. All figures below are computed by the real fee engine (`packages/core/src/fees.ts`) at ETH $3,000, 0.20 ETH (20 contracts × 0.01 ETH, notional $600), taker 0.05 %, maker 0.02 %:

* taker leg = $0.30 + $0.054 GST = **$0.354**; maker leg = **$0.1416**
* **without** the offer: taker in / taker out = **$0.708**; taker in / maker out (the default take-profit) = **$0.4956**
* **with** the offer: only the entry leg, **$0.354**, whatever the exit role. The break-even move is $0.354 / 0.20 ETH = **$1.77** (it was $2.48 with a maker exit, $3.54 with a taker exit)

| Take-profit move | Gross | Entry fee | Closing fee with offer | Net with offer | Net without offer, maker TP | Net without offer, taker / market TP |
|---|---|---|---|---|---|---|
| $4 | +$0.80 | $0.354 | $0 | **+$0.446** | +$0.304 | +$0.092 |
| $5 | +$1.00 | $0.354 | $0 | **+$0.646** | +$0.504 | +$0.291 |
| $6 | +$1.20 | $0.354 | $0 | **+$0.846** | +$0.704 | +$0.491 |

A stopped trade (stop $4.5 + $0.25 stop slippage on 0.20 ETH = $0.95 gross) loses **$1.30** with the offer (entry fee only) and **$1.66** without (the entry gate further down also counts $0.10 entry slippage: $1.32 / $1.68). So a winner nets a few tenths of a dollar while a loser costs about $1.30: the required win rate stays high even with the offer.

Fee-reality check (the same table the dashboard recomputes from the live price; stop = $4.5 + $0.25 slippage, taker entry, maker take-profit):

| ETH price | Move needed just to cover fees: with offer / without (taker exit) | Net at $4 / $5 / $6 target, with offer | Net at $4 / $5 / $6, without offer | Win rate needed, with offer | Win rate needed, without offer |
|---|---|---|---|---|---|
| $2,000 | $1.18 / $1.65 ($2.36) | +$0.56 / +$0.76 / +$0.96 | +$0.47 / +$0.67 / +$0.87 | 68 % / 61 % / 55 % | 75 % / 68 % / 62 % |
| $3,000 | $1.77 / $2.48 ($3.54) | +$0.45 / +$0.65 / +$0.85 | +$0.30 / +$0.50 / +$0.70 | 75 % / 67 % / 61 % | 84 % / 77 % / 70 % |
| $4,000 | $2.36 / $3.30 ($4.72) | +$0.33 / +$0.53 / +$0.73 | +$0.14 / +$0.34 / +$0.54 | 81 % / 73 % / 66 % | 93 % / 85 % / 78 % |

Fees scale with price while the target is fixed in dollars, so the problem worsens as ETH rises. The offer lowers the required win rate by roughly 7 to 12 points; it does not make a 55–81 % win rate easy. **No profitability is claimed**: the win rate has to be measured in Demo and on real-data backtests, and a small sample proves nothing.

### Risk gates with and without the offer

Exactly what the entry gate computes at ETH $3,000 (it also adds the $0.10 simulated entry slippage; limits: net reward:risk ≥ 0.25, net reward ≥ $0.10, net loss at stop ≤ $2.50). Cells are net reward:risk; **REJECT** = the entry is refused.

| Stop width | Loss at stop, with / without offer | Target $4: with / without | Target $5: with / without | Target $6: with / without |
|---|---|---|---|---|
| $3 | $1.02 / $1.38 | 0.416 / 0.206 **REJECT** | 0.611 / 0.351 | 0.807 / 0.497 |
| $4.5 | $1.32 / $1.68 | 0.322 / 0.169 **REJECT** | 0.473 / 0.289 | 0.624 / 0.408 |
| $6 | $1.62 / $1.98 | 0.262 / 0.144 **REJECT** | 0.385 / 0.245 **REJECT** | 0.509 / 0.346 |

With the offer assumed, every default target/stop combination passes the economics gates. Without it, $4 targets are always refused and a $6 stop needs at least a $6 target. That is why a wrong assumption matters, and why Live switches back to the "without" column as soon as the exchange charges a closing fee on an eligible close.

Levers you control: wider/more selective entries (higher win rate), larger targets, lower trade frequency, and maker entries. Maker entries are not implemented (IOC taker entries are used for fill certainty); for scale, a maker entry with the offer would cut the entry fee from $0.354 to $0.142 (a $4 winner would net +$0.658 instead of +$0.446). The fee reality check on **Strategy & Risk** and **Demo** recomputes the tables from the live price and the exchange's rates, with and without the offer.

## Demo fill model (deliberately conservative)

* Entry at ask/bid ± `simSlippageUsd` ($0.10), taker fee (always charged). Stop fills at min(stop, bid) − `simStopSlippageUsd` (extra $0.25).
* Take-profit fills only after the market trades **through** the target (one tick beyond), at the target price, maker role (`touch` model optional).
* If stop and target are both inside one bar/tick, the **stop is assumed to hit first**.
* Time exit: market close with slippage at 28.5 min (30 min if the waiver is OFF).
* Every exit (take-profit, stop, break-even stop, time exit) pays no closing fee while the hold is ≤ 30 min and the waiver is ON; a later close pays the normal maker/taker fee plus GST. The break-even stop only has to recover the entry fee (about a $1.77 move at $3,000) inside the window.
* Funding is charged when a funding timestamp is crossed (rate from the feed, else `fundingRateFallback`).
* Real execution will differ (queue position, partial fills, latency); Demo labels say so. Demo fees are an assumption of the offer, not evidence of it.

## Backtest and out-of-sample

`runBacktest` replays closed candles with the same strategy/risk/paper code; the signal on bar *i* fills at the open of bar *i+1*. `walkForward` rolls (train → test) windows, chooses the best of a **small** parameter grid in-sample, and reports only out-of-sample trades. Metrics: trades, win rate (+95 % Wilson interval), gross, costs, net, profit factor, max drawdown, average hold, % reaching the target, TP/stop/time-exit mix, performance per regime and per side, and `feesSavedUsd`. Fewer than 100 trades ⇒ flagged statistically weak. Every result states whether the waiver was assumed, the clamped time exit, and that the Diwali offer is not modelled; backtests with the waiver ON are only as good as that assumption. **A profitable backtest is not evidence of future profit**; confirm with weeks of Demo and then the first live closes.
