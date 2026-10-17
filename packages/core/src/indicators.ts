import type { Candle } from './types';

/** Exponential moving average seeded with the first value (NaN-free for any length >= 1). */
export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length === 0) return out;
  const k = 2 / (period + 1);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  // Values before `period` bars are not yet stable; mark them NaN so strategies never trade on warm-up noise.
  for (let i = 0; i < Math.min(period - 1, values.length); i++) out[i] = NaN;
  return out;
}

export function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < values.length; i++) {
    s += values[i];
    if (i >= period) s -= values[i - period];
    if (i >= period - 1) out[i] = s / period;
  }
  return out;
}

/** Wilder's ATR in price units (USD for ETHUSD). */
export function atr(candles: Candle[], period: number): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  if (candles.length < period + 1) return out;
  const tr: number[] = new Array(candles.length).fill(0);
  tr[0] = candles[0].h - candles[0].l;
  for (let i = 1; i < candles.length; i++) {
    const pc = candles[i - 1].c;
    tr[i] = Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - pc), Math.abs(candles[i].l - pc));
  }
  let a = 0;
  for (let i = 1; i <= period; i++) a += tr[i];
  a /= period;
  out[period] = a;
  for (let i = period + 1; i < candles.length; i++) {
    a = (a * (period - 1) + tr[i]) / period;
    out[i] = a;
  }
  return out;
}

const DAY_MS = 86_400_000;

/** VWAP anchored to the UTC day, using typical price. Falls back to close when a day has no volume yet. */
export function vwapUtcDay(candles: Candle[]): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  let day = -1;
  let pv = 0;
  let vv = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const d = Math.floor(c.t / DAY_MS);
    if (d !== day) {
      day = d;
      pv = 0;
      vv = 0;
    }
    const tp = (c.h + c.l + c.c) / 3;
    pv += tp * c.v;
    vv += c.v;
    out[i] = vv > 0 ? pv / vv : c.c;
  }
  return out;
}

/** Kaufman efficiency ratio: |net move| / sum(|bar moves|) over `period` bars, in [0, 1]. */
export function efficiencyRatio(closes: number[], period: number): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  for (let i = period; i < closes.length; i++) {
    let path = 0;
    for (let j = i - period + 1; j <= i; j++) path += Math.abs(closes[j] - closes[j - 1]);
    out[i] = path === 0 ? 0 : Math.abs(closes[i] - closes[i - period]) / path;
  }
  return out;
}

/** Highest high / lowest low of the `lookback` bars strictly BEFORE index i. */
export function priorHigh(candles: Candle[], i: number, lookback: number): number {
  let m = -Infinity;
  for (let j = Math.max(0, i - lookback); j < i; j++) if (candles[j].h > m) m = candles[j].h;
  return m;
}

export function priorLow(candles: Candle[], i: number, lookback: number): number {
  let m = Infinity;
  for (let j = Math.max(0, i - lookback); j < i; j++) if (candles[j].l < m) m = candles[j].l;
  return m;
}

/** Mean volume of the `lookback` bars strictly BEFORE index i. */
export function priorMeanVolume(candles: Candle[], i: number, lookback: number): number {
  let s = 0;
  let n = 0;
  for (let j = Math.max(0, i - lookback); j < i; j++) {
    s += candles[j].v;
    n++;
  }
  return n === 0 ? 0 : s / n;
}
