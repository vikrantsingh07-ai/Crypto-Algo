import type { Candle } from './types';
import { gaussian, mulberry32 } from './math';

/**
 * Deterministic SYNTHETIC candle generator.
 *
 * ⚠ NOT MARKET DATA. This exists ONLY for unit tests, deterministic engine checks and an explicit
 * offline-development switch (MARKET_DATA_SOURCE=synthetic). It must never be used to evaluate
 * profitability. The server labels any run on this feed as "SYNTHETIC" in the UI.
 *
 * The process is a regime-switching random walk (trend up / trend down / range) with
 * volatility clustering and volume that scales with volatility.
 */

export interface SyntheticOptions {
  seed?: number;
  startPrice?: number;
  startTime?: number;
  count: number;
  periodMs?: number;
  /** Per-bar return volatility (fraction). 0.0004 ~= 0.04% per minute ~= $1.2 on a $3,000 asset. */
  volatility?: number;
}

type Regime = 'up' | 'down' | 'range';

export function generateSyntheticCandles(o: SyntheticOptions): Candle[] {
  const rand = mulberry32(o.seed ?? 42);
  const period = o.periodMs ?? 60_000;
  const baseVol = o.volatility ?? 0.0004;
  let price = o.startPrice ?? 3000;
  let t = o.startTime ?? Date.UTC(2026, 0, 1);
  let regime: Regime = 'range';
  let regimeLeft = 0;
  let volMult = 1;
  const out: Candle[] = [];

  for (let i = 0; i < o.count; i++) {
    if (regimeLeft <= 0) {
      const r = rand();
      regime = r < 0.3 ? 'up' : r < 0.6 ? 'down' : 'range';
      regimeLeft = 40 + Math.floor(rand() * 160);
    }
    regimeLeft--;
    // Volatility clustering (mean-reverting log-multiplier).
    volMult = Math.max(0.4, Math.min(3, volMult * 0.97 + 0.03 + gaussian(rand) * 0.06));
    const vol = baseVol * volMult;
    const drift = regime === 'up' ? vol * 0.35 : regime === 'down' ? -vol * 0.35 : 0;

    const open = price;
    // Build the candle from 4 intra-bar steps so highs/lows exceed open/close naturally.
    let p = open;
    let hi = open;
    let lo = open;
    for (let k = 0; k < 4; k++) {
      p = p * (1 + drift / 4 + (vol / 2) * gaussian(rand));
      hi = Math.max(hi, p);
      lo = Math.min(lo, p);
    }
    const close = p;
    const v = Math.max(1, 300 * volMult * (0.6 + rand() * 0.8));
    out.push({ t, o: round2(open), h: round2(hi), l: round2(lo), c: round2(close), v: Math.round(v) });
    price = close;
    t += period;
  }
  return out;
}

const round2 = (x: number) => Math.round(x * 20) / 20; // 0.05 tick
