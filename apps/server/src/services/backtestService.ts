import {
  breakevenWinRate,
  computeMetrics,
  deepMerge,
  drawdownSeries,
  estimateEconomics,
  feeConfigFrom,
  generateSyntheticCandles,
  runBacktest,
  splitBars,
  walkForward,
  warmupBars,
  type Candle,
  type ClosedTrade,
  type ContractSpec,
  type PerformanceMetrics,
  type Settings,
} from '@cryptoalgo/core';
import type { DeltaClient, Logger } from '@cryptoalgo/delta';
import { randomId } from '../crypto';
import type { Repos } from '../repos';

export type DataSource = 'delta' | 'synthetic';

export interface BacktestParams {
  kind: 'backtest' | 'walkforward';
  days: number;
  spreadUsd?: number;
  /** walk-forward windows, in days */
  trainDays?: number;
  testDays?: number;
  /** Partial settings merged over the current ones for this run only. */
  settingsPatch?: Record<string, unknown>;
}

export async function loadCandles(source: DataSource, days: number, client: DeltaClient | null, symbol: string, onProgress?: (done: number, total: number) => void): Promise<Candle[]> {
  if (source === 'synthetic') return generateSyntheticCandles({ seed: 20260101, count: Math.round(days * 1440), startTime: Date.now() - days * 86_400_000, volatility: 0.0006 });
  if (!client) throw new Error('No exchange client available for fetching history');
  const end = Math.floor(Date.now() / 1000) - 120; // exclude the forming candle
  const start = end - Math.round(days * 86_400);
  return client.getCandlesRange(symbol, '1m', start, end, onProgress);
}

const downsample = <T>(xs: T[], max: number): T[] => {
  if (xs.length <= max) return xs;
  const step = xs.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(xs[Math.floor(i * step)]);
  out.push(xs[xs.length - 1]);
  return out;
};

function trimMetrics(m: PerformanceMetrics) {
  return { ...m, equityCurve: downsample(m.equityCurve, 400), drawdownCurve: drawdownSeries(downsample(m.equityCurve, 400), m.startingBalance) };
}

function tradeRows(trades: ClosedTrade[]) {
  return trades.slice(-300).map((t) => ({ id: t.id, side: t.side, entryTs: t.entryTs, exitTs: t.exitTs, entryPrice: t.entryPrice, exitPrice: t.exitPrice, exitReason: t.exitReason, netPnl: t.netPnl, fees: t.fees, holdMs: t.holdMs, regime: t.regime }));
}

/** Pure job: run a backtest or walk-forward evaluation on candles and return a serialisable report. */
export function runBacktestJob(candles: Candle[], settingsIn: Settings, spec: ContractSpec, params: BacktestParams, dataSource: DataSource) {
  const settings = params.settingsPatch ? deepMerge(settingsIn, params.settingsPatch) : settingsIn;
  const spread = params.spreadUsd ?? 0.1;
  const warm = warmupBars(settings.strategy);
  if (candles.length < warm + 500) throw new Error(`Not enough candles (${candles.length}); need at least ${warm + 500}`);

  const refPrice = candles[candles.length - 1].c;
  const contracts = Math.round(settings.position.quantityEth / spec.contractValue);
  const economics = estimateEconomics(
    { side: 'long', entryPrice: refPrice, targetPrice: refPrice + settings.targets.targetMoveMinUsd, stopPrice: refPrice - settings.targets.stopLossMinUsd, contracts, contractValue: spec.contractValue, targetRole: settings.exits.takeProfitOrderType === 'limit' ? 'maker' : 'taker' },
    feeConfigFrom(settings, spec),
  );
  const costNote = {
    referencePrice: refPrice,
    breakevenMoveUsd: economics.breakevenMoveUsd,
    roundTripFeeIfTargetUsd: economics.feeIfTarget,
    roundTripFeeIfStopUsd: economics.feeIfStop,
    netRewardAtMinTargetUsd: economics.rewardNet,
    requiredWinRateAtMinTarget: breakevenWinRate(economics.rewardNet, economics.riskNet),
  };

  const common = {
    dataSource,
    synthetic: dataSource === 'synthetic',
    candles: candles.length,
    from: candles[0].t,
    to: candles[candles.length - 1].t,
    spreadUsd: spread,
    assumptions: [
      'Signals use closed 1-minute candles only; entries fill at the next candle open plus spread and slippage.',
      `Entry/stop are taker orders; take-profit is a resting limit (maker) filled only when price trades through it (${settings.execution.tpFillModel}).`,
      'If stop and target fall inside one candle the stop is assumed to fill first.',
      `Fees: maker ${(feeConfigFrom(settings, spec).makerRate * 100).toFixed(3)}% / taker ${(feeConfigFrom(settings, spec).takerRate * 100).toFixed(3)}% + ${(settings.execution.gstRate * 100).toFixed(0)}% GST. No exit-fee waiver is assumed unless enabled.`,
      'All risk limits (max 10 trades/24h, one position, daily loss, drawdown, consecutive losses, net reward:risk) are enforced as in live trading.',
      'Historical results do not predict future results; a small sample is not evidence of profitability.',
    ],
    costNote,
  };

  if (params.kind === 'walkforward') {
    const train = Math.round((params.trainDays ?? 10) * 1440);
    const test = Math.round((params.testDays ?? 5) * 1440);
    if (candles.length < warm + train + test) throw new Error('Not enough data for the requested walk-forward windows');
    const wf = walkForward(candles, { settings, spec, trainBars: train, testBars: test, spreadUsd: spread });
    const summary = {
      ...common,
      kind: 'walkforward',
      folds: wf.folds.length,
      outOfSample: pickSummary(wf.outOfSample),
      inSampleNetPnl: wf.inSampleNetPnl,
      note: wf.note,
    };
    const result = {
      ...summary,
      outOfSampleMetrics: trimMetrics(wf.outOfSample),
      folds: wf.folds.map((f) => ({ fold: f.fold, chosen: f.chosen, trainFrom: f.trainFrom, trainTo: f.trainTo, testFrom: f.testFrom, testTo: f.testTo, inSample: pickSummary(f.inSample), outOfSample: pickSummary(f.outOfSample) })),
      trades: tradeRows(wf.outOfSampleTrades),
    };
    return { summary, result };
  }

  const split = splitBars(candles.length, 0.7, warm);
  const full = runBacktest(candles, { settings, spec, spreadUsd: spread });
  const ins = runBacktest(candles, { settings, spec, spreadUsd: spread, startIndex: split.inSample[0], endIndex: split.inSample[1] });
  const oos = runBacktest(candles, { settings, spec, spreadUsd: spread, startIndex: split.outOfSample[0], endIndex: split.outOfSample[1] });
  const summary = {
    ...common,
    kind: 'backtest',
    fullSample: pickSummary(full.metrics),
    inSample: pickSummary(ins.metrics),
    outOfSample: pickSummary(oos.metrics),
    signals: full.signals,
    rejected: full.rejected,
    note:
      oos.metrics.totalTrades < 100
        ? 'Fewer than 100 out-of-sample trades: statistically weak. Do not treat this as evidence of profitability.'
        : 'Out-of-sample section was not used to choose any parameter. Forward-test in Demo before any live use.',
  };
  const result = { ...summary, fullMetrics: trimMetrics(full.metrics), inSampleMetrics: trimMetrics(ins.metrics), outOfSampleMetrics: trimMetrics(oos.metrics), trades: tradeRows(full.trades) };
  return { summary, result };
}

function pickSummary(m: PerformanceMetrics) {
  return {
    trades: m.totalTrades,
    winRate: m.winRate,
    winRateCI95: m.winRateCI95,
    grossPnl: m.grossPnl,
    fees: m.fees,
    netPnl: m.netPnl,
    profitFactor: m.profitFactor,
    maxDrawdownPct: m.maxDrawdownPct,
    avgHoldMinutes: m.avgHoldMinutes,
    targetReachedPct: m.targetReachedPct,
    takeProfitPct: m.takeProfitPct,
    stopLossPct: m.stopLossPct,
    timeExitPct: m.timeExitPct,
    breakevenWinRate: m.breakevenWinRate,
    smallSample: m.smallSample,
  };
}

export interface BacktestDeps {
  repos: Repos;
  client: DeltaClient | null;
  source: DataSource;
  symbol: string;
  getSettings: () => Settings;
  getSpec: () => ContractSpec;
  logger: Logger;
}

/** Background backtest runner. Stores progress/results in the database for the Analytics panel. */
export class BacktestService {
  private running = new Set<string>();
  constructor(private readonly d: BacktestDeps) {}

  async start(params: BacktestParams): Promise<string> {
    if (this.running.size >= 1) throw new Error('A backtest is already running');
    const days = Math.min(Math.max(params.days, 2), 60);
    const p = { ...params, days };
    const id = randomId('bt_', 6);
    await this.d.repos.createBacktest(id, p.kind, this.d.source, p);
    this.running.add(id);
    void this.execute(id, p).finally(() => this.running.delete(id));
    return id;
  }

  private async execute(id: string, params: BacktestParams) {
    try {
      const candles = await loadCandles(this.d.source, params.days, this.d.client, this.d.getSpec().symbol || this.d.symbol);
      // yield to the event loop so live handling is not starved
      await new Promise((r) => setImmediate(r));
      const { summary, result } = runBacktestJob(candles, this.d.getSettings(), this.d.getSpec(), params, this.d.source);
      await this.d.repos.finishBacktest(id, 'done', summary, result);
      this.d.logger.info('backtest finished', { id });
    } catch (e) {
      await this.d.repos.finishBacktest(id, 'failed', null, null, (e as Error).message);
      this.d.logger.error('backtest failed', { id, error: (e as Error).message });
    }
  }
}

export { computeMetrics };
