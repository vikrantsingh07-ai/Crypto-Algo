import { defaultSettings, deepMerge, fallbackContractSpec, type Candle, type ContractSpec, type Settings } from '../src';

export const T0 = Date.UTC(2026, 0, 5, 1, 0, 0); // mid-day-anchored far from funding times

export function spec(over: Partial<ContractSpec> = {}): ContractSpec {
  return { ...fallbackContractSpec('ETHUSD'), verified: true, tradingStatus: 'operational', ...over };
}

export function settings(patch: Record<string, unknown> = {}): Settings {
  return deepMerge(defaultSettings(), patch);
}

/**
 * Deterministic staircase: `n` candles drifting by `step` per bar with a tiny alternating wiggle,
 * followed by one strong breakout candle in the same direction.
 */
export function trendThenBreakout(dir: 1 | -1, n = 200, step = 0.25, breakout = 2.6, startPrice = 3000): Candle[] {
  const out: Candle[] = [];
  let price = startPrice;
  for (let i = 0; i < n; i++) {
    const wiggle = i % 2 === 0 ? 0.1 : -0.1;
    const o = price;
    const c = o + dir * step + wiggle * 0.2;
    out.push({ t: T0 + i * 60_000, o, h: Math.max(o, c) + 0.35, l: Math.min(o, c) - 0.35, c, v: 100 });
    price = c;
  }
  const o = price;
  const c = o + dir * breakout;
  out.push({
    t: T0 + n * 60_000,
    o,
    h: dir === 1 ? c + 0.1 : o + 0.1,
    l: dir === 1 ? o - 0.1 : c - 0.1,
    c,
    v: 220,
  });
  return out;
}

/** Wide-open settings used where a test needs a signal to survive the risk manager. */
export const PERMISSIVE = {
  strategy: { maxExtensionAtr: 6 },
  limits: { minNetRewardRisk: 0, minExpectedNetRewardUsd: 0, perTradeRiskUsd: 100, minFreeMarginPct: 0 },
};
