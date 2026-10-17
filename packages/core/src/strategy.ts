import type { Candle, MarketRegime, Side, Signal } from './types';
import type { Settings, StrategyParams } from './settings';
import { clamp } from './math';
import { atr, efficiencyRatio, ema, priorHigh, priorLow, priorMeanVolume, sma, vwapUtcDay } from './indicators';

/**
 * EMA / VWAP momentum-breakout scalper on 1-minute candles.
 *
 * A LONG signal needs ALL of:
 *   trend      emaFast > emaSlow > emaTrend and emaTrend rising
 *   vwap       close above the UTC-day VWAP and above emaFast
 *   breakout   close above the highest high of the previous N bars
 *   momentum   close - close[m bars ago] >= k * ATR
 *   body       candle body >= b * ATR and close in the top (1 - closeStrength) of its range
 *   volume     volume >= r * mean volume of previous bars
 *   extension  close within X ATR of emaFast (do not chase)
 *   efficiency Kaufman efficiency ratio >= threshold (filters chop)
 *   atr band   minAtr <= ATR <= maxAtr (enough range for a $4-6 move, but not chaos)
 * SHORT is the mirror image. Targets/stops are ATR-scaled and clamped to the configured $ bands.
 *
 * Signals are generated on CLOSED candles only; execution happens on the next tick / next bar open.
 */

export interface IndicatorSet {
  emaFast: number[];
  emaSlow: number[];
  emaTrend: number[];
  atr: number[];
  atrAvg: number[];
  vwap: number[];
  er: number[];
}

export function computeIndicators(candles: Candle[], p: StrategyParams, atrPeriod = p.atrPeriod): IndicatorSet {
  const closes = candles.map((c) => c.c);
  const a = atr(candles, atrPeriod);
  return {
    emaFast: ema(closes, p.emaFast),
    emaSlow: ema(closes, p.emaSlow),
    emaTrend: ema(closes, p.emaTrend),
    atr: a,
    atrAvg: sma(a.map((x) => (Number.isFinite(x) ? x : 0)), 100),
    vwap: vwapUtcDay(candles),
    er: efficiencyRatio(closes, p.efficiencyLookback),
  };
}

export function warmupBars(p: StrategyParams): number {
  return Math.max(p.emaTrend, p.atrPeriod, p.breakoutLookback, p.volumeLookback, p.efficiencyLookback, 100) + 10;
}

export function classifyRegime(ind: IndicatorSet, i: number): MarketRegime {
  const a = ind.atr[i];
  const avg = ind.atrAvg[i];
  if (Number.isFinite(a) && Number.isFinite(avg) && avg > 0) {
    if (a / avg >= 1.6) return 'high_volatility';
    if (a / avg <= 0.6) return 'low_volatility';
  }
  const er = ind.er[i];
  if (Number.isFinite(er) && er >= 0.35) {
    return ind.emaFast[i] >= ind.emaSlow[i] ? 'trend_up' : 'trend_down';
  }
  return 'range';
}

export interface ConditionResult {
  name: string;
  pass: boolean;
  detail: string;
}

export interface SideEvaluation {
  side: Side;
  pass: boolean;
  conditions: ConditionResult[];
}

export interface Evaluation {
  index: number;
  candleTime: number;
  ready: boolean;
  long: SideEvaluation;
  short: SideEvaluation;
  atr: number;
  regime: MarketRegime;
  signal: Signal | null;
}

const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : 'n/a');

function evalSide(side: Side, candles: Candle[], ind: IndicatorSet, i: number, s: Settings): SideEvaluation {
  const p = s.strategy;
  const f = s.filters;
  const c = candles[i];
  const a = ind.atr[i];
  const long = side === 'long';
  const sgn = long ? 1 : -1;
  const range = c.h - c.l;
  const conds: ConditionResult[] = [];
  const add = (name: string, pass: boolean, detail: string) => conds.push({ name, pass, detail });

  const trendOk =
    long
      ? ind.emaFast[i] > ind.emaSlow[i] && ind.emaSlow[i] > ind.emaTrend[i] && ind.emaTrend[i] > ind.emaTrend[Math.max(0, i - 5)]
      : ind.emaFast[i] < ind.emaSlow[i] && ind.emaSlow[i] < ind.emaTrend[i] && ind.emaTrend[i] < ind.emaTrend[Math.max(0, i - 5)];
  add('trend', trendOk, `EMA${p.emaFast} ${f2(ind.emaFast[i])} / EMA${p.emaSlow} ${f2(ind.emaSlow[i])} / EMA${p.emaTrend} ${f2(ind.emaTrend[i])}`);

  const vwapOk = long ? c.c > ind.vwap[i] && c.c > ind.emaFast[i] : c.c < ind.vwap[i] && c.c < ind.emaFast[i];
  add('vwap', vwapOk, `close ${f2(c.c)} vs VWAP ${f2(ind.vwap[i])}`);

  const lvl = long ? priorHigh(candles, i, p.breakoutLookback) : priorLow(candles, i, p.breakoutLookback);
  add('breakout', long ? c.c > lvl : c.c < lvl, `close ${f2(c.c)} vs prior ${p.breakoutLookback}-bar ${long ? 'high' : 'low'} ${f2(lvl)}`);

  const mom = sgn * (c.c - candles[Math.max(0, i - p.momentumLookback)].c);
  add('momentum', mom >= p.momentumAtrMult * a, `${f2(mom)} vs ${f2(p.momentumAtrMult * a)} (${p.momentumAtrMult}xATR)`);

  const body = sgn * (c.c - c.o);
  const closePos = range > 0 ? (long ? (c.c - c.l) / range : (c.h - c.c) / range) : 0;
  add('body', body >= p.minBodyAtrRatio * a && closePos >= p.closeStrength, `body ${f2(body)} (min ${f2(p.minBodyAtrRatio * a)}), close position ${closePos.toFixed(2)}`);

  const mv = priorMeanVolume(candles, i, p.volumeLookback);
  add('volume', mv > 0 ? c.v >= p.minVolumeRatio * mv : true, `vol ${f2(c.v)} vs mean ${f2(mv)}`);

  const ext = sgn * (c.c - ind.emaFast[i]);
  add('extension', ext <= p.maxExtensionAtr * a, `${f2(ext)} vs max ${f2(p.maxExtensionAtr * a)}`);

  add('efficiency', ind.er[i] >= p.minEfficiencyRatio, `ER ${Number.isFinite(ind.er[i]) ? ind.er[i].toFixed(2) : 'n/a'} vs min ${p.minEfficiencyRatio}`);

  add('atr_band', a >= f.minAtrUsd && a <= f.maxAtrUsd, `ATR ${f2(a)} within [${f.minAtrUsd}, ${f.maxAtrUsd}]`);

  const allowed = long ? p.allowLong : p.allowShort;
  add('direction_enabled', allowed, allowed ? 'enabled' : 'disabled in settings');

  return { side, pass: conds.every((x) => x.pass), conditions: conds };
}

export interface EvaluateOptions {
  /** Index of the most recent signal per side, for the cooldown. */
  lastSignalIndex?: { long: number; short: number };
}

/** Evaluate the strategy on closed candle `i`. Pure and deterministic. */
export function evaluate(candles: Candle[], ind: IndicatorSet, i: number, s: Settings, opts: EvaluateOptions = {}): Evaluation {
  const ready = i >= warmupBars(s.strategy) && Number.isFinite(ind.atr[i]) && Number.isFinite(ind.emaTrend[i]);
  const empty = (side: Side): SideEvaluation => ({ side, pass: false, conditions: [{ name: 'warmup', pass: false, detail: 'not enough candles yet' }] });
  const base = {
    index: i,
    candleTime: candles[i]?.t ?? 0,
    atr: ind.atr[i],
    regime: ready ? classifyRegime(ind, i) : ('range' as MarketRegime),
  };
  if (!ready) return { ...base, ready, long: empty('long'), short: empty('short'), signal: null };

  const long = evalSide('long', candles, ind, i, s);
  const short = evalSide('short', candles, ind, i, s);

  const cd = s.strategy.signalCooldownCandles;
  const last = opts.lastSignalIndex ?? { long: -Infinity, short: -Infinity };
  const longReady = long.pass && i - last.long > cd;
  const shortReady = short.pass && i - last.short > cd;

  let side: Side | null = null;
  if (longReady && !shortReady) side = 'long';
  else if (shortReady && !longReady) side = 'short';
  // Both can never be true simultaneously (trend conditions are mutually exclusive).

  if (!side) return { ...base, ready, long, short, signal: null };

  const a = ind.atr[i];
  const t = s.targets;
  const signal: Signal = {
    side,
    candleTime: candles[i].t,
    refPrice: candles[i].c,
    atr: a,
    targetMoveUsd: clamp(a * t.targetAtrMultiple, t.targetMoveMinUsd, t.targetMoveMaxUsd),
    stopMoveUsd: clamp(a * t.stopLossAtrMultiple, t.stopLossMinUsd, t.stopLossMaxUsd),
    regime: base.regime,
    reasons: (side === 'long' ? long : short).conditions.map((c) => `${c.name}: ${c.detail}`),
    features: {
      atr: a,
      emaFast: ind.emaFast[i],
      emaSlow: ind.emaSlow[i],
      emaTrend: ind.emaTrend[i],
      vwap: ind.vwap[i],
      efficiencyRatio: ind.er[i],
    },
  };
  return { ...base, ready, long, short, signal };
}

/** Convenience for live use: compute indicators on a rolling window and evaluate the last closed candle. */
export function evaluateLatest(candles: Candle[], s: Settings, opts: EvaluateOptions = {}): Evaluation | null {
  if (candles.length === 0) return null;
  const ind = computeIndicators(candles, s.strategy);
  return evaluate(candles, ind, candles.length - 1, s, opts);
}
