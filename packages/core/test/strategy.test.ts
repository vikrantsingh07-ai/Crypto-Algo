import { describe, expect, it } from 'vitest';
import { computeIndicators, evaluate, evaluateLatest, generateSyntheticCandles, runBacktest, walkForward, type Candle } from '../src';
import { PERMISSIVE, settings, spec, trendThenBreakout } from './helpers';

describe('strategy signals', () => {
  it('emits a LONG signal on an up-trend breakout', () => {
    const s = settings(PERMISSIVE);
    const candles = trendThenBreakout(1);
    const ev = evaluateLatest(candles, s)!;
    expect(ev.ready).toBe(true);
    expect(ev.signal, JSON.stringify(ev.long.conditions.filter((c) => !c.pass))).not.toBeNull();
    expect(ev.signal!.side).toBe('long');
    expect(ev.short.pass).toBe(false);
  });

  it('emits a SHORT signal on a down-trend breakdown', () => {
    const s = settings(PERMISSIVE);
    const candles = trendThenBreakout(-1);
    const ev = evaluateLatest(candles, s)!;
    expect(ev.signal, JSON.stringify(ev.short.conditions.filter((c) => !c.pass))).not.toBeNull();
    expect(ev.signal!.side).toBe('short');
    expect(ev.long.pass).toBe(false);
  });

  it('clamps target and stop to the configured dollar bands', () => {
    const s = settings(PERMISSIVE);
    const ev = evaluateLatest(trendThenBreakout(1), s)!;
    expect(ev.signal!.targetMoveUsd).toBeGreaterThanOrEqual(4);
    expect(ev.signal!.targetMoveUsd).toBeLessThanOrEqual(6);
    expect(ev.signal!.stopMoveUsd).toBeGreaterThanOrEqual(3);
    expect(ev.signal!.stopMoveUsd).toBeLessThanOrEqual(6);
  });

  it('does not trade without breakout confirmation (quiet candle after the trend)', () => {
    const s = settings(PERMISSIVE);
    const candles = trendThenBreakout(1, 200, 0.25, 0.05);
    const ev = evaluateLatest(candles, s)!;
    expect(ev.signal).toBeNull();
    expect(ev.long.conditions.find((c) => c.name === 'breakout')!.pass || ev.long.conditions.find((c) => c.name === 'momentum')!.pass).toBe(false);
  });

  it('respects direction switches', () => {
    const s = settings({ ...PERMISSIVE, strategy: { ...PERMISSIVE.strategy, allowLong: false } });
    expect(evaluateLatest(trendThenBreakout(1), s)!.signal).toBeNull();
  });

  it('blocks low-volatility conditions via the ATR band', () => {
    const s = settings({ ...PERMISSIVE, filters: { minAtrUsd: 5, maxAtrUsd: 15 } });
    expect(evaluateLatest(trendThenBreakout(1), s)!.signal).toBeNull();
  });

  it('respects the per-direction signal cooldown', () => {
    const s = settings(PERMISSIVE);
    const candles = trendThenBreakout(1);
    const ind = computeIndicators(candles, s.strategy);
    const i = candles.length - 1;
    const blocked = evaluate(candles, ind, i, s, { lastSignalIndex: { long: i - 1, short: -Infinity } });
    expect(blocked.signal).toBeNull();
  });

  it('reports not-ready during warm-up instead of trading on noise', () => {
    const s = settings(PERMISSIVE);
    const ev = evaluateLatest(trendThenBreakout(1, 20), s)!;
    expect(ev.ready).toBe(false);
    expect(ev.signal).toBeNull();
  });

  it('is deterministic (same candles => same evaluation)', () => {
    const s = settings(PERMISSIVE);
    const c = trendThenBreakout(1);
    expect(JSON.stringify(evaluateLatest(c, s))).toBe(JSON.stringify(evaluateLatest(c, s)));
  });
});

describe('backtester (synthetic data — mechanics only, NOT evidence of profit)', () => {
  const candles: Candle[] = generateSyntheticCandles({ seed: 7, count: 6000, volatility: 0.0006 });
  const s = settings({
    limits: { minNetRewardRisk: 0, minExpectedNetRewardUsd: 0, perTradeRiskUsd: 100, maxConsecutiveLosses: 50, dailyLossLimitUsd: 1000, maxDrawdownPct: 100, cooldownMinutesAfterLoss: 0 },
    strategy: { maxExtensionAtr: 6, minVolumeRatio: 0 },
  });

  it('produces trades, honours one-position and 10-trades/24h limits', () => {
    const r = runBacktest(candles, { settings: s, spec: spec() });
    expect(r.metrics.totalTrades).toBeGreaterThan(0);
    // verify no overlapping trades and <=10 entries in any rolling 24h
    const t = [...r.trades].sort((a, b) => a.entryTs - b.entryTs);
    for (let i = 1; i < t.length; i++) expect(t[i].entryTs).toBeGreaterThanOrEqual(t[i - 1].exitTs);
    for (let i = 0; i < t.length; i++) {
      const inWindow = t.filter((x) => x.entryTs > t[i].entryTs - 86_400_000 && x.entryTs <= t[i].entryTs).length;
      expect(inWindow).toBeLessThanOrEqual(10);
    }
  });

  it('never holds beyond the maximum holding time (+ one bar)', () => {
    const r = runBacktest(candles, { settings: s, spec: spec() });
    for (const tr of r.trades) expect(tr.holdMs).toBeLessThanOrEqual(30 * 60_000 + 60_000);
  });

  it('is deterministic and net = gross - fees + funding for every trade', () => {
    const a = runBacktest(candles, { settings: s, spec: spec() });
    const b = runBacktest(candles, { settings: s, spec: spec() });
    expect(a.metrics.netPnl).toBe(b.metrics.netPnl);
    for (const tr of a.trades) expect(tr.netPnl).toBeCloseTo(tr.grossPnl - tr.fees + tr.funding, 6);
  });

  it('flags small samples and reports exit-reason mix', () => {
    const r = runBacktest(candles.slice(0, 1500), { settings: s, spec: spec() });
    expect(r.metrics.smallSample).toBe(r.metrics.totalTrades < 100);
    const sum = Object.values(r.metrics.exitReasons).reduce((x, y) => x + y, 0);
    expect(sum).toBe(r.metrics.totalTrades);
  });

  it('walk-forward aggregates only out-of-sample trades', () => {
    const wf = walkForward(candles, { settings: s, spec: spec(), trainBars: 2000, testBars: 1000 });
    expect(wf.folds.length).toBeGreaterThanOrEqual(2);
    expect(wf.outOfSample.totalTrades).toBe(wf.outOfSampleTrades.length);
    for (const f of wf.folds) expect(f.testFrom).toBeGreaterThan(f.trainTo);
  });
});
