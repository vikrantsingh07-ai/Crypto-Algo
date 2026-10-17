import type { ClosedTrade, ExitReason, MarketRegime, Side } from './types';
import { mean, round, sum, wilsonInterval } from './math';

export interface GroupStats {
  trades: number;
  wins: number;
  winRate: number;
  netPnl: number;
  grossPnl: number;
  fees: number;
  avgNetPnl: number;
}

export interface PerformanceMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  winRateCI95: { low: number; high: number };
  grossPnl: number;
  fees: number;
  slippageCost: number;
  funding: number;
  totalCosts: number;
  netPnl: number;
  netPnlInr: number;
  profitFactor: number | null;
  avgNetPnl: number;
  avgWin: number;
  avgLoss: number;
  expectancyPerTrade: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  startingBalance: number;
  endingBalance: number;
  avgHoldMinutes: number;
  /** Share of trades whose price excursion reached the favourable target distance while open. */
  targetReachedPct: number;
  /** Share of trades that closed via the take-profit order. */
  takeProfitPct: number;
  stopLossPct: number;
  timeExitPct: number;
  breakevenStopPct: number;
  exitReasons: Record<string, number>;
  /** Win rate needed to break even given the realised average win / loss sizes. */
  breakevenWinRate: number | null;
  /** Closing fees the Scalper Offer waived across these trades (USD). */
  feesSavedUsd: number;
  byRegime: Record<string, GroupStats>;
  bySide: Record<Side, GroupStats>;
  /** True when fewer than 100 trades: results are not statistically meaningful. */
  smallSample: boolean;
  equityCurve: { ts: number; equity: number }[];
  dailyPnl: { day: string; netPnl: number; fees: number; trades: number }[];
  holdingBuckets: { label: string; count: number }[];
}

function group(trades: ClosedTrade[]): GroupStats {
  const wins = trades.filter((t) => t.netPnl > 0).length;
  const net = sum(trades.map((t) => t.netPnl));
  return {
    trades: trades.length,
    wins,
    winRate: trades.length ? wins / trades.length : 0,
    netPnl: round(net, 6),
    grossPnl: round(sum(trades.map((t) => t.grossPnl)), 6),
    fees: round(sum(trades.map((t) => t.fees)), 6),
    avgNetPnl: trades.length ? round(net / trades.length, 6) : 0,
  };
}

export function computeMetrics(trades: ClosedTrade[], startingBalance: number, usdInrRate = 88): PerformanceMetrics {
  const sorted = [...trades].sort((a, b) => a.exitTs - b.exitTs);
  const n = sorted.length;
  const wins = sorted.filter((t) => t.netPnl > 0);
  const losses = sorted.filter((t) => t.netPnl <= 0);
  const grossWin = sum(wins.map((t) => t.netPnl));
  const grossLoss = Math.abs(sum(losses.map((t) => t.netPnl)));

  let equity = startingBalance;
  let peak = startingBalance;
  let maxDdUsd = 0;
  let maxDdPct = 0;
  const curve: { ts: number; equity: number }[] = [];
  for (const t of sorted) {
    equity += t.netPnl;
    peak = Math.max(peak, equity);
    const dd = peak - equity;
    maxDdUsd = Math.max(maxDdUsd, dd);
    if (peak > 0) maxDdPct = Math.max(maxDdPct, (dd / peak) * 100);
    curve.push({ ts: t.exitTs, equity: round(equity, 6) });
  }

  const exitReasons: Record<string, number> = {};
  for (const t of sorted) exitReasons[t.exitReason] = (exitReasons[t.exitReason] ?? 0) + 1;
  const pct = (r: ExitReason) => (n ? ((exitReasons[r] ?? 0) / n) * 100 : 0);

  const byRegime: Record<string, GroupStats> = {};
  for (const r of ['trend_up', 'trend_down', 'range', 'high_volatility', 'low_volatility'] as MarketRegime[]) {
    byRegime[r] = group(sorted.filter((t) => t.regime === r));
  }

  const days = new Map<string, { netPnl: number; fees: number; trades: number }>();
  for (const t of sorted) {
    const day = new Date(t.exitTs).toISOString().slice(0, 10);
    const d = days.get(day) ?? { netPnl: 0, fees: 0, trades: 0 };
    d.netPnl += t.netPnl;
    d.fees += t.fees;
    d.trades += 1;
    days.set(day, d);
  }

  const bucketsDef: [string, number][] = [['<5m', 5], ['5-10m', 10], ['10-20m', 20], ['20-30m', 30], ['>30m', Infinity]];
  const holdingBuckets = bucketsDef.map(([label]) => ({ label, count: 0 }));
  for (const t of sorted) {
    const m = t.holdMs / 60_000;
    const idx = bucketsDef.findIndex(([, hi]) => m < hi || hi === Infinity);
    holdingBuckets[idx === -1 ? holdingBuckets.length - 1 : idx].count++;
  }

  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const net = sum(sorted.map((t) => t.netPnl));

  return {
    totalTrades: n,
    wins: wins.length,
    losses: losses.length,
    winRate: n ? wins.length / n : 0,
    winRateCI95: wilsonInterval(wins.length, n),
    grossPnl: round(sum(sorted.map((t) => t.grossPnl)), 6),
    fees: round(sum(sorted.map((t) => t.fees)), 6),
    feesSavedUsd: round(sum(sorted.map((t) => t.exitFeeSaved ?? 0)), 6),
    slippageCost: round(sum(sorted.map((t) => t.slippageCost)), 6),
    funding: round(sum(sorted.map((t) => t.funding)), 6),
    totalCosts: round(sum(sorted.map((t) => t.fees)) - sum(sorted.map((t) => t.funding)) + sum(sorted.map((t) => t.slippageCost)), 6),
    netPnl: round(net, 6),
    netPnlInr: round(net * usdInrRate, 2),
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 4) : grossWin > 0 ? null : 0,
    avgNetPnl: n ? round(net / n, 6) : 0,
    avgWin: round(avgWin, 6),
    avgLoss: round(avgLoss, 6),
    expectancyPerTrade: n ? round(net / n, 6) : 0,
    maxDrawdownUsd: round(maxDdUsd, 6),
    maxDrawdownPct: round(maxDdPct, 4),
    startingBalance,
    endingBalance: round(equity, 6),
    avgHoldMinutes: n ? round(mean(sorted.map((t) => t.holdMs / 60_000)), 3) : 0,
    targetReachedPct: n ? round((sorted.filter((t) => t.reachedTarget).length / n) * 100, 3) : 0,
    takeProfitPct: round(pct('take_profit'), 3),
    stopLossPct: round(pct('stop_loss') + pct('liquidation'), 3),
    timeExitPct: round(pct('time_exit'), 3),
    breakevenStopPct: round(pct('breakeven_stop'), 3),
    exitReasons,
    breakevenWinRate: avgWin + avgLoss > 0 ? round(avgLoss / (avgWin + avgLoss), 4) : null,
    byRegime,
    bySide: { long: group(sorted.filter((t) => t.side === 'long')), short: group(sorted.filter((t) => t.side === 'short')) },
    smallSample: n < 100,
    equityCurve: curve,
    dailyPnl: [...days.entries()].map(([day, d]) => ({ day, netPnl: round(d.netPnl, 6), fees: round(d.fees, 6), trades: d.trades })),
    holdingBuckets,
  };
}

/** Drawdown series (percent below running peak) from an equity curve. */
export function drawdownSeries(curve: { ts: number; equity: number }[], start: number): { ts: number; dd: number }[] {
  let peak = start;
  return curve.map((p) => {
    peak = Math.max(peak, p.equity);
    return { ts: p.ts, dd: peak > 0 ? round(((peak - p.equity) / peak) * 100, 4) : 0 };
  });
}
