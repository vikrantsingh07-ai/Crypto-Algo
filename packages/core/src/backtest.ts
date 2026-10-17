import type { Candle, ClosedTrade, ContractSpec, OpenPosition } from './types';
import type { Settings } from './settings';
import { quantityToContracts } from './settings';
import { computeIndicators, type IndicatorSet } from './strategy';
import { evaluate, warmupBars } from './strategy';
import {
  applyClose,
  applyOpen,
  closePosition,
  markEquity,
  newDemoAccount,
  openPaperPosition,
  paperContext,
  stepPosition,
  tickFromCandle,
  accountEquity,
  type PaperContext,
} from './paper';
import { effectiveConsecutiveLosses, evaluateEntryRisk, type RealisedPnlEntry, type RiskState, type TradeEntry } from './risk';
import { computeMetrics, type PerformanceMetrics } from './metrics';

/**
 * Candle-based backtester. It re-uses the SAME strategy, risk manager and paper-execution code
 * as the live demo engine, so results are directly comparable.
 *
 * Realism rules:
 *  - Signals use only CLOSED candles; entry executes at the NEXT candle's open (+ spread/slippage).
 *  - A configurable synthetic spread is applied around candle prices (historical OHLCV has no book).
 *  - Within a candle, if stop and target are both inside the range the stop is assumed to hit first.
 *  - Fees, GST, slippage and funding come from the shared fee engine.
 *  - The same risk limits (max 10 trades/24h, daily loss, drawdown, consecutive loss, cooldown,
 *    net reward:risk, liquidation buffer...) are enforced.
 */

export interface BacktestOptions {
  settings: Settings;
  spec: ContractSpec;
  /** Assumed bid/ask spread in USD around candle prices. */
  spreadUsd?: number;
  /** Funding rate per interval as a fraction (default 0). */
  fundingRate?: number;
  /** Candle period in ms (default 60_000). */
  periodMs?: number;
  /** Skip signals before this index (for walk-forward: use earlier bars only as warm-up). */
  startIndex?: number;
  endIndex?: number;
}

export interface RejectionCounts {
  [code: string]: number;
}

export interface BacktestResult {
  trades: ClosedTrade[];
  metrics: PerformanceMetrics;
  signals: number;
  rejected: RejectionCounts;
  candles: number;
  from: number;
  to: number;
}

export function runBacktest(candles: Candle[], opts: BacktestOptions): BacktestResult {
  const { settings, spec } = opts;
  const period = opts.periodMs ?? 60_000;
  const spread = opts.spreadUsd ?? 0.1;
  const ctx: PaperContext = paperContext(settings, spec, opts.fundingRate ?? 0);
  const contracts = quantityToContracts(settings.position.quantityEth, spec.contractValue);
  if (contracts === null) throw new Error('Configured quantity is not a whole number of contracts for this spec');

  const ind: IndicatorSet = computeIndicators(candles, settings.strategy);
  const start = Math.max(opts.startIndex ?? 0, warmupBars(settings.strategy));
  const end = Math.min(opts.endIndex ?? candles.length - 1, candles.length - 1);

  let account = newDemoAccount(settings.demo.startingBalanceUsd, candles[start]?.t ?? 0);
  const trades: ClosedTrade[] = [];
  const entries: TradeEntry[] = [];
  const realised: RealisedPnlEntry[] = [];
  const rejected: RejectionCounts = {};
  let signals = 0;
  let consecutiveLosses = 0;
  let lastLossTs: number | null = null;
  let lastEntrySignalCandle: number | null = null;
  const lastSignalIndex = { long: -Infinity, short: -Infinity };
  let seq = 0;

  // A signal generated on candle i executes at open of candle i+1.
  for (let i = start; i <= end; i++) {
    const candle = candles[i];
    const closeTs = candle.t + period;

    // 1) Manage open position using this candle's range.
    if (account.openPosition) {
      const tick = tickFromCandle(candle, closeTs, spread);
      const res = stepPosition(account.openPosition, tick, ctx);
      account = { ...account, openPosition: res.position };
      if (res.exit) {
        const trade = closePosition(res.position, res.exit, closeTs, ctx);
        account = applyClose(account, trade, closeTs);
        trades.push(trade);
        realised.push({ ts: trade.exitTs, netPnl: trade.netPnl });
        if (trade.netPnl < 0) {
          consecutiveLosses++;
          lastLossTs = trade.exitTs;
        } else consecutiveLosses = 0;
      } else {
        account = markEquity(account, accountEquity(account, tick), closeTs);
      }
    }

    // 2) Look for a new signal on this closed candle; execute at next candle open.
    if (i + 1 > end || account.openPosition) continue;
    const ev = evaluate(candles, ind, i, settings, { lastSignalIndex });
    if (!ev.signal) continue;
    signals++;
    lastSignalIndex[ev.signal.side] = i;

    const next = candles[i + 1];
    const half = spread / 2;
    const quote = { ts: next.t, bid: next.o - half, ask: next.o + half, last: next.o };
    const equity = accountEquity(account, null);
    const state: RiskState = {
      now: next.t,
      mode: 'demo',
      killSwitch: false,
      equityUsd: equity,
      startingEquityUsd: account.startingBalanceUsd,
      peakEquityUsd: account.peakEquityUsd,
      availableMarginUsd: equity,
      openPositions: 0,
      entries,
      realised,
      consecutiveLosses: (consecutiveLosses = effectiveConsecutiveLosses(consecutiveLosses, lastLossTs, next.t, settings)),
      lastLossTs,
      lastTickTs: next.t,
      apiHealthy: true,
      lastEntrySignalCandle,
      pendingOrder: false,
    };
    const decision = evaluateEntryRisk({ settings, spec, state, signal: ev.signal, quote });
    if (!decision.allowed) {
      for (const c of decision.checks) if (!c.ok) rejected[c.code] = (rejected[c.code] ?? 0) + 1;
      continue;
    }

    const tick = tickFromCandle(next, next.t, spread);
    // Entry happens at the open: bid/ask around the open price.
    const entryTick = { ...tick, ts: next.t, bid: next.o - half, ask: next.o + half, last: next.o, high: next.o, low: next.o };
    const pos: OpenPosition = openPaperPosition({ id: `bt-${++seq}`, signal: ev.signal, tick: entryTick, contracts }, ctx);
    account = applyOpen(account, pos, next.t);
    entries.push({ ts: next.t });
    lastEntrySignalCandle = ev.signal.candleTime;
  }

  // Close any position still open at the end of data (mark as time exit at last close).
  if (account.openPosition) {
    const last = candles[end];
    const closeTs = last.t + period;
    const tick = tickFromCandle(last, closeTs, spread);
    const pos = account.openPosition;
    const dir = pos.side === 'long' ? 1 : -1;
    const price = dir === 1 ? tick.bid : tick.ask;
    const trade = closePosition(pos, { reason: 'time_exit', price, role: 'taker' }, closeTs, ctx);
    account = applyClose(account, trade, closeTs);
    trades.push(trade);
  }

  const metrics = computeMetrics(trades, settings.demo.startingBalanceUsd, settings.execution.usdInrRate);
  return { trades, metrics, signals, rejected, candles: end - start + 1, from: candles[start]?.t ?? 0, to: candles[end]?.t ?? 0 };
}
