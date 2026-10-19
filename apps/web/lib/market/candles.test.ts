import { describe, expect, it } from 'vitest';
import { CandleSeries, MAX_CANDLES, minuteStart, sanitizeCandle } from './candles';
import type { MarketCandle } from './types';

const M = 60_000;
const T0 = Math.floor(1_775_800_000_000 / M) * M; // a minute boundary
const c = (i: number, o = 100, h = 101, l = 99, cl = 100.5, v = 10): MarketCandle => ({ t: T0 + i * M, o, h, l, c: cl, v });

describe('sanitizeCandle', () => {
  it('accepts ms and seconds, repairs inconsistent highs/lows, rejects junk', () => {
    expect(sanitizeCandle({ t: T0 / 1000, o: 1, h: 2, l: 1, c: 1.5, v: 3 })).toEqual({ t: T0, o: 1, h: 2, l: 1, c: 1.5, v: 3 });
    expect(sanitizeCandle({ t: T0 + 12_345, o: 5, h: 4, l: 6, c: 5 })).toMatchObject({ t: T0, h: 6, l: 4 });
    for (const bad of [null, 'x', {}, { t: T0, o: 0, h: 1, l: 1, c: 1 }, { t: NaN, o: 1, h: 1, l: 1, c: 1 }, { t: T0, o: 1, h: 1, l: 1, c: -1 }]) expect(sanitizeCandle(bad)).toBeNull();
  });
});

describe('CandleSeries: seed + live', () => {
  it('merges seeds sorted and de-duplicated', () => {
    const s = new CandleSeries();
    expect(s.mergeSeed([c(2), c(0), c(1), c(1, 1, 2, 1, 1.5)], false)).toBe(true);
    expect(s.toArray().map((x) => x.t)).toEqual([T0, T0 + M, T0 + 2 * M]);
    expect(s.toArray()[1].o).toBe(1);
  });

  it('a live candle replaces the seed candle of the same minute and is protected from later seeds while the feed is healthy', () => {
    const s = new CandleSeries();
    s.mergeSeed([c(0), c(1)], false);
    s.applyLive(c(1, 100, 105, 99, 104, 50), (T0 + M) + 5_000);
    expect(s.toArray()[1]).toMatchObject({ h: 105, c: 104, v: 50 });
    expect(s.mergeSeed([c(1, 100, 101, 99, 100, 1)], false)).toBe(false);
    expect(s.toArray()[1].c).toBe(104);
    // when the feed is down the backend is authoritative again
    expect(s.mergeSeed([c(1, 100, 101, 99, 100, 1)], true)).toBe(true);
    expect(s.toArray()[1].c).toBe(100);
  });

  it('seed fills history older than the live candles', () => {
    const s = new CandleSeries();
    s.applyLive(c(5), T0 + 5 * M + 1000);
    s.mergeSeed([c(0), c(1), c(2)], false);
    expect(s.toArray().map((x) => (x.t - T0) / M)).toEqual([0, 1, 2, 5]);
  });

  it('ignores an out-of-order (older timestamp) message for a candle it already updated', () => {
    const s = new CandleSeries();
    s.applyLive(c(0, 100, 110, 99, 109), T0 + 30_000);
    expect(s.applyLive(c(0, 100, 103, 99, 101), T0 + 10_000)).toBe(false);
    expect(s.toArray()[0].c).toBe(109);
  });

  it('caps the series length', () => {
    const s = new CandleSeries();
    for (let i = 0; i < MAX_CANDLES + 50; i++) s.applyLive(c(i, 100 + i, 102 + i, 99 + i, 101 + i), T0 + i * M + 1000);
    expect(s.length).toBe(MAX_CANDLES);
    expect(s.toArray()[0].t).toBe(T0 + 50 * M);
  });
});

describe('CandleSeries: ticks move the forming candle', () => {
  it('first tick of a new minute opens a candle at the trade price, later ticks update close/high/low only', () => {
    const s = new CandleSeries();
    s.mergeSeed([c(0, 100, 101, 99, 100.5)], false);
    expect(s.applyTick(100.7, T0 + M + 1_000)).toBe(true);
    expect(s.last()).toEqual({ t: T0 + M, o: 100.7, h: 100.7, l: 100.7, c: 100.7, v: 0 });
    s.applyTick(101.2, T0 + M + 2_000);
    s.applyTick(100.1, T0 + M + 3_000);
    expect(s.last()).toEqual({ t: T0 + M, o: 100.7, h: 101.2, l: 100.1, c: 100.1, v: 0 });
    expect(s.length).toBe(2);
  });

  it('never mutates a candle object that was already handed out', () => {
    const s = new CandleSeries();
    s.applyTick(100, T0 + 1000);
    const handedOut = s.toArray();
    const before = { ...handedOut[0] };
    s.applyTick(105, T0 + 2000);
    expect(handedOut[0]).toEqual(before);
    expect(s.last()?.c).toBe(105);
  });

  it('ignores a tick for an older minute and a repeated identical tick', () => {
    const s = new CandleSeries();
    s.applyTick(100, T0 + M + 1000);
    expect(s.applyTick(99, T0 + 1000)).toBe(false);
    expect(s.applyTick(100, T0 + M + 2000)).toBe(false);
    expect(s.length).toBe(1);
  });

  it('the authoritative candle message then replaces the tick-built candle (and carries the volume)', () => {
    const s = new CandleSeries();
    s.applyTick(100.7, T0 + 1000);
    s.applyLive(c(0, 100.6, 101, 100.5, 100.8, 321), T0 + 2000);
    expect(s.last()).toEqual({ t: T0, o: 100.6, h: 101, l: 100.5, c: 100.8, v: 321 });
  });
});

describe('CandleSeries: closing update stamped just after the rollover', () => {
  it('folds a late update of minute N (same open, wider range, stamped within 1.5 s of N+1) back into N', () => {
    const s = new CandleSeries();
    s.applyLive(c(0, 100, 101, 99.5, 100.4, 40), T0 + 50_000);
    // the exchange publishes the final state of minute 0 with a timestamp that already falls into minute 1
    const late = s.applyLive({ t: T0 + M, o: 100, h: 101.2, l: 99.5, c: 100.9, v: 55 }, T0 + M + 300);
    expect(late).toBe(true);
    expect(s.length).toBe(1);
    expect(s.last()).toMatchObject({ t: T0, h: 101.2, c: 100.9, v: 55 });
  });

  it('does not swallow a genuinely new candle (different open)', () => {
    const s = new CandleSeries();
    s.applyLive(c(0, 100, 101, 99.5, 100.4), T0 + 50_000);
    s.applyLive({ t: T0 + M, o: 100.4, h: 100.6, l: 100.3, c: 100.5, v: 1 }, T0 + M + 300);
    expect(s.length).toBe(2);
    expect(s.last()?.o).toBe(100.4);
  });

  it('does not apply the heuristic later than 1.5 s into the minute', () => {
    const s = new CandleSeries();
    s.applyLive(c(0, 100, 101, 99.5, 100.4), T0 + 50_000);
    s.applyLive({ t: T0 + M, o: 100, h: 101.2, l: 99.5, c: 100.9, v: 55 }, T0 + M + 5_000);
    expect(s.length).toBe(2);
  });
});

describe('CandleSeries: window change', () => {
  it('reports % from the oldest open and a readable window label', () => {
    const s = new CandleSeries();
    s.mergeSeed(Array.from({ length: 180 }, (_, i) => c(i, 100, 101, 99, 100)), false);
    const w = s.windowChange(101);
    expect(w?.pct).toBeCloseTo(1, 6);
    expect(w?.label).toBe('3h');
    const small = new CandleSeries();
    small.mergeSeed([c(0), c(1), c(2)], false);
    expect(small.windowChange(101)).toBeNull();
    expect(minuteStart(T0 + 59_999)).toBe(T0);
  });
});
