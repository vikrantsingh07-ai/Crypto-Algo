import type { Candle, ClosedTrade, ContractSpec } from './types';
import { deepMerge, type Settings } from './settings';
import { runBacktest, type BacktestResult } from './backtest';
import { computeMetrics, type PerformanceMetrics } from './metrics';
import { warmupBars } from './strategy';

/**
 * Walk-forward (rolling out-of-sample) evaluation.
 *
 * For each fold the parameter set with the best IN-SAMPLE result (net P&L, with a minimum trade
 * count) is selected and then evaluated, untouched, on the following OUT-OF-SAMPLE window.
 * Only out-of-sample trades are aggregated into the headline number. The grid is deliberately
 * tiny to limit data-snooping, and a "small sample" flag is raised below 100 trades.
 */

export type ParamPatch = Record<string, unknown>;

export const DEFAULT_GRID: { name: string; patch: ParamPatch }[] = [
  { name: 'baseline', patch: {} },
  { name: 'tight-breakout', patch: { strategy: { breakoutLookback: 8, momentumAtrMult: 1.0 } } },
  { name: 'loose-breakout', patch: { strategy: { breakoutLookback: 14, momentumAtrMult: 0.6 } } },
  { name: 'wide-target', patch: { targets: { targetAtrMultiple: 4 } } },
];

export interface FoldResult {
  fold: number;
  trainFrom: number;
  trainTo: number;
  testFrom: number;
  testTo: number;
  chosen: string;
  inSample: PerformanceMetrics;
  outOfSample: PerformanceMetrics;
}

export interface WalkForwardResult {
  folds: FoldResult[];
  outOfSampleTrades: ClosedTrade[];
  outOfSample: PerformanceMetrics;
  inSampleNetPnl: number;
  note: string;
}

export interface WalkForwardOptions {
  settings: Settings;
  spec: ContractSpec;
  trainBars: number;
  testBars: number;
  grid?: { name: string; patch: ParamPatch }[];
  minTrainTrades?: number;
  spreadUsd?: number;
  fundingRate?: number;
}

export function walkForward(candles: Candle[], o: WalkForwardOptions): WalkForwardResult {
  const grid = o.grid ?? DEFAULT_GRID;
  const warm = warmupBars(o.settings.strategy);
  const minTrades = o.minTrainTrades ?? 5;
  const folds: FoldResult[] = [];
  const oosTrades: ClosedTrade[] = [];
  let isNet = 0;

  let testStart = warm + o.trainBars;
  let fold = 0;
  while (testStart + o.testBars <= candles.length) {
    const trainStart = testStart - o.trainBars;
    let best: { name: string; res: BacktestResult; settings: Settings } | null = null;
    for (const g of grid) {
      const settings = deepMerge(o.settings, g.patch);
      const res = runBacktest(candles, {
        settings,
        spec: o.spec,
        spreadUsd: o.spreadUsd,
        fundingRate: o.fundingRate,
        startIndex: trainStart,
        endIndex: testStart - 1,
      });
      if (res.metrics.totalTrades < minTrades) continue;
      if (!best || res.metrics.netPnl > best.res.metrics.netPnl) best = { name: g.name, res, settings };
    }
    const chosen = best ?? {
      name: 'baseline',
      settings: o.settings,
      res: runBacktest(candles, { settings: o.settings, spec: o.spec, spreadUsd: o.spreadUsd, fundingRate: o.fundingRate, startIndex: trainStart, endIndex: testStart - 1 }),
    };
    const oos = runBacktest(candles, {
      settings: chosen.settings,
      spec: o.spec,
      spreadUsd: o.spreadUsd,
      fundingRate: o.fundingRate,
      // Indicators are computed over the full series but the test window starts at testStart;
      // warm-up bars come from history that precedes it (no look-ahead: indicators are causal).
      startIndex: testStart,
      endIndex: testStart + o.testBars - 1,
    });
    isNet += chosen.res.metrics.netPnl;
    oosTrades.push(...oos.trades);
    folds.push({
      fold: ++fold,
      trainFrom: candles[trainStart].t,
      trainTo: candles[testStart - 1].t,
      testFrom: candles[testStart].t,
      testTo: candles[testStart + o.testBars - 1].t,
      chosen: chosen.name,
      inSample: chosen.res.metrics,
      outOfSample: oos.metrics,
    });
    testStart += o.testBars;
  }

  const oosMetrics = computeMetrics(oosTrades, o.settings.demo.startingBalanceUsd, o.settings.execution.usdInrRate);
  return {
    folds,
    outOfSampleTrades: oosTrades,
    outOfSample: oosMetrics,
    inSampleNetPnl: isNet,
    note:
      oosMetrics.totalTrades < 100
        ? 'Fewer than 100 out-of-sample trades: the result is statistically weak and must not be read as evidence of profitability.'
        : 'Out-of-sample result across rolling folds. Past performance does not guarantee future results; forward-test in Demo before any live use.',
  };
}

/** Simple chronological in-sample / out-of-sample split. */
export function splitBars(total: number, inSampleRatio = 0.7, warmup = 0): { inSample: [number, number]; outOfSample: [number, number] } {
  const cut = Math.floor(total * inSampleRatio);
  return { inSample: [warmup, cut - 1], outOfSample: [cut, total - 1] };
}
