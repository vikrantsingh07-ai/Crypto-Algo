import type { MarketCandle } from './types';

/** Pure geometry helpers for PriceChart (kept out of the component so they can be unit tested). */

/** 1, 2, 2.5, 5 x 10^n step at or above `raw` */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  const m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return m * pow;
}

export interface Domain {
  min: number;
  max: number;
}

/**
 * Y range for the visible candles plus any extra prices that must stay visible (entry/stop/target, last price).
 * The range is snapped to a grid so it only changes when price actually breaks out, which keeps the memoised
 * candle paths from being rebuilt on every tick.
 */
export function computeDomain(candles: readonly MarketCandle[], extras: readonly (number | null | undefined)[] = []): Domain | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of candles) {
    if (c.l < lo) lo = c.l;
    if (c.h > hi) hi = c.h;
  }
  for (const e of extras) {
    if (e === null || e === undefined || !Number.isFinite(e)) continue;
    if (e < lo) lo = e;
    if (e > hi) hi = e;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  const mid = (lo + hi) / 2;
  const range = Math.max(hi - lo, mid * 0.0005, 0.5);
  const pad = range * 0.1;
  const grid = niceStep((range + 2 * pad) / 24);
  return { min: Math.floor((lo - pad) / grid) * grid, max: Math.ceil((hi + pad) / grid) * grid };
}

/** about `target` round tick values inside the domain */
export function yTicks(d: Domain, target = 5): number[] {
  const step = niceStep((d.max - d.min) / target);
  const out: number[] = [];
  for (let v = Math.ceil(d.min / step) * step; v <= d.max + 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

/** minutes between x-axis labels so labels are at least `minPx` apart */
export function timeStepMinutes(pxPerCandle: number, minPx = 64): number {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 240];
  for (const s of steps) if (s * pxPerCandle >= minPx) return s;
  return 360;
}

/** push labels apart so they never overlap (input sorted top to bottom by y); keeps them inside [min, max] */
export function spreadLabels(ys: number[], gap: number, min: number, max: number): number[] {
  const out = ys.slice();
  for (let i = 1; i < out.length; i++) if (out[i] - out[i - 1] < gap) out[i] = out[i - 1] + gap;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] > max) out[i] = max;
    if (i < out.length - 1 && out[i + 1] - out[i] < gap) out[i] = out[i + 1] - gap;
  }
  for (let i = 0; i < out.length; i++) if (out[i] < min) out[i] = min;
  return out;
}
