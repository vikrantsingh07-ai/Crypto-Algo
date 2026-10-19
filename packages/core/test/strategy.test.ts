import { describe, expect, it } from 'vitest';
import { computeIndicators, evaluate, evaluateLatest, generateSyntheticCandles, runBacktest, walkForward, type Candle } from '../src';
import { PERMISSIVE, T0, legacySettings, settings, spec, trendThenBreakout } from './helpers';

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

  it('clamps target and stop to the configured dollar bands: a fixed USD 10 target and a USD 5-8 stop by default, long and short', () => {
    const s = settings(PERMISSIVE);
    for (const dir of [1, -1] as const) {
      const ev = evaluateLatest(trendThenBreakout(dir), s)!;
      expect(ev.signal!.side).toBe(dir === 1 ? 'long' : 'short');
      expect(ev.signal!.targetMoveUsd).toBe(10);
      expect(ev.signal!.stopMoveUsd).toBeGreaterThanOrEqual(5);
      expect(ev.signal!.stopMoveUsd).toBeLessThanOrEqual(8);
    }
  });

  it('the bands stay configurable (the pre-v2 USD 4-6 target / USD 3-6 stop still clamp correctly)', () => {
    const ev = evaluateLatest(trendThenBreakout(1), legacySettings(PERMISSIVE))!;
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

  it('has no time exit by default: trades end at the target or the stop (or are flagged end_of_data), and may run past 30 minutes', () => {
    const r = runBacktest(candles, { settings: s, spec: spec() });
    expect(r.trades.length).toBeGreaterThan(0);
    for (const tr of r.trades) expect(['take_profit', 'stop_loss', 'liquidation', 'end_of_data']).toContain(tr.exitReason);
    expect(r.metrics.exitReasons.time_exit ?? 0).toBe(0);
    expect(Math.max(...r.trades.map((t) => t.holdMs))).toBeGreaterThan(30 * 60_000);
    // every trade carried the fixed USD 10 target
    for (const tr of r.trades) expect(Math.abs(tr.targetPrice - tr.entryPrice)).toBeCloseTo(10, 6);
  });

  it('with a configured limit (policy close_at_market) it never holds beyond the maximum holding time (+ one bar)', () => {
    const limited = settings({ ...s, exits: { timeExitPolicy: 'close_at_market', maxHoldMinutes: 30 } });
    const r = runBacktest(candles, { settings: limited, spec: spec() });
    expect(r.trades.length).toBeGreaterThan(0);
    for (const tr of r.trades) expect(tr.holdMs).toBeLessThanOrEqual(30 * 60_000 + 60_000);
    expect(r.metrics.exitReasons.time_exit ?? 0).toBeGreaterThan(0);
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

  /** The trend-then-breakout series (a long signal on its last candle) followed by `tail` extra candles. */
  const withTail = (tail: (lastClose: number, t0: number) => Candle[]): Candle[] => {
    const base = trendThenBreakout(1);
    const last = base[base.length - 1];
    return [...base, ...tail(last.c, last.t + 60_000)];
  };
  const flat = (n: number) => (p: number, t0: number): Candle[] =>
    Array.from({ length: n }, (_, i) => ({ t: t0 + i * 60_000, o: p, h: p + 0.05, l: p - 0.05, c: p, v: 100 }));
  const PERM = settings(PERMISSIVE);

  it('a position still open when the data ends is closed at the last price, flagged end_of_data, and never dropped', () => {
    const r = runBacktest(withTail(flat(6)), { settings: PERM, spec: spec() });
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.side).toBe('long');
    expect(t.exitReason).toBe('end_of_data');
    expect(r.endOfDataTrades).toBe(1);
    expect(r.metrics.totalTrades).toBe(1);
    expect(r.metrics.exitReasons.end_of_data).toBe(1);
    expect(r.metrics.endOfDataPct).toBe(100);
    // closed at the last candle's close on the executable side (half the 0.10 spread below it for a long)
    const lastClose = trendThenBreakout(1)[200].c;
    expect(t.exitPrice).toBeCloseTo(lastClose - 0.05, 6);
    expect(t.holdMs).toBeGreaterThan(0);
    expect(t.holdMs).toBeLessThanOrEqual(6 * 60_000);
    expect(t.netPnl).toBeCloseTo(t.grossPnl - t.fees + t.funding, 6);
  });

  it('a trade that ends at its target before the data runs out is not flagged', () => {
    const r = runBacktest(withTail((p, t0) => [...flat(3)(p, t0), { t: t0 + 3 * 60_000, o: p, h: p + 15, l: p - 0.05, c: p + 12, v: 100 }]), { settings: PERM, spec: spec() });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].exitReason).toBe('take_profit');
    expect(r.endOfDataTrades).toBe(0);
  });

  it('a 3-hour trade is simply held: flat for 3 hours, then the USD 10 target (no time exit, net = 2.00 - fees)', () => {
    const r = runBacktest(withTail((p, t0) => [...flat(180)(p, t0), { t: t0 + 180 * 60_000, o: p, h: p + 15, l: p - 0.05, c: p + 12, v: 100 }]), { settings: PERM, spec: spec() });
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.exitReason).toBe('take_profit');
    expect(t.holdMs).toBeGreaterThanOrEqual(180 * 60_000);
    expect(t.grossPnl).toBeCloseTo(2.0, 6);
    expect(t.netPnl).toBeCloseTo(2.0 - t.fees, 6);
    expect(t.netPnl).toBeGreaterThan(1.3);
  });

  it('a 3-hour trade that finally hits the stop is a plain stop loss with both fees paid', () => {
    const r = runBacktest(withTail((p, t0) => [...flat(180)(p, t0), { t: t0 + 180 * 60_000, o: p, h: p + 0.05, l: p - 12, c: p - 10, v: 100 }]), { settings: PERM, spec: spec() });
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.exitReason).toBe('stop_loss');
    expect(t.holdMs).toBeGreaterThanOrEqual(180 * 60_000);
    expect(t.exitFee).toBeGreaterThan(0);
    expect(t.netPnl).toBeLessThan(-1.5);
    expect(t.netPnl).toBeCloseTo(t.grossPnl - t.fees, 6);
  });

  it('funding is charged across a multi-hour backtest hold', () => {
    // the series starts at 01:00 UTC; ~200 warm-up bars later the entry is after ~04:20; 5 hours flat crosses 08:00
    const r = runBacktest(withTail((p, t0) => [...flat(300)(p, t0), { t: t0 + 300 * 60_000, o: p, h: p + 15, l: p - 0.05, c: p + 12, v: 100 }]), { settings: PERM, spec: spec(), fundingRate: 0.0001 });
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.funding).toBeLessThan(0); // a long pays positive funding
    expect(t.funding).toBeCloseTo(-0.0001 * trendThenBreakout(1)[200].c * 0.2, 6); // one 08:00 settlement on 0.20 ETH
    expect(t.netPnl).toBeCloseTo(t.grossPnl - t.fees + t.funding, 6);
  });

  it('never trades just to use up the daily limit: a market with no setup produces no signals and no trades', () => {
    const quiet: Candle[] = Array.from({ length: 1500 }, (_, i) => ({ t: T0 + i * 60_000, o: 3000, h: 3000.2, l: 2999.8, c: 3000, v: 100 }));
    const r = runBacktest(quiet, { settings: PERM, spec: spec() });
    expect(settings().limits.maxTradesPer24h).toBe(10);
    expect(r.signals).toBe(0);
    expect(r.trades).toHaveLength(0);
    expect(r.endOfDataTrades).toBe(0);
  });

  it('walk-forward aggregates only out-of-sample trades', () => {
    const wf = walkForward(candles, { settings: s, spec: spec(), trainBars: 2000, testBars: 1000 });
    expect(wf.folds.length).toBeGreaterThanOrEqual(2);
    expect(wf.outOfSample.totalTrades).toBe(wf.outOfSampleTrades.length);
    for (const f of wf.folds) expect(f.testFrom).toBeGreaterThan(f.trainTo);
  });
});
