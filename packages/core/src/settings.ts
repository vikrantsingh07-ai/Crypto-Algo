import { z } from 'zod';
import type { ContractSpec } from './types';

/**
 * Persistent bot configuration. Defaults reproduce the requested initial setup:
 * ETH perpetual, 0.20 ETH, 50x, $4-$6 target, 30 minute max hold, max 10 trades / 24h.
 */

const num = (def: number, min: number, max: number) => z.number().min(min).max(max).default(def);

export const StrategyParamsSchema = z.object({
  emaFast: z.number().int().min(2).max(100).default(9),
  emaSlow: z.number().int().min(3).max(200).default(21),
  emaTrend: z.number().int().min(5).max(400).default(55),
  atrPeriod: z.number().int().min(2).max(100).default(14),
  breakoutLookback: z.number().int().min(3).max(100).default(10),
  momentumLookback: z.number().int().min(1).max(30).default(3),
  momentumAtrMult: num(0.8, 0, 10),
  minBodyAtrRatio: num(0.5, 0, 5),
  /** Close must sit in the favourable X fraction of the candle range (0.65 => top/bottom 35%). */
  closeStrength: num(0.65, 0.5, 1),
  volumeLookback: z.number().int().min(2).max(200).default(20),
  minVolumeRatio: num(0.8, 0, 10),
  /** Do not chase: |close - emaFast| must be <= this many ATRs. */
  maxExtensionAtr: num(2, 0.1, 10),
  efficiencyLookback: z.number().int().min(5).max(100).default(20),
  minEfficiencyRatio: num(0.25, 0, 1),
  /** Candles to wait after a signal before another is allowed (per direction). */
  signalCooldownCandles: z.number().int().min(0).max(100).default(3),
  allowLong: z.boolean().default(true),
  allowShort: z.boolean().default(true),
});

export const SettingsSchema = z.object({
  instrument: z
    .object({
      symbol: z
        .string()
        .regex(/^ETH[A-Z]{3,4}$/, 'Only ETH contracts are supported (e.g. ETHUSD)')
        .default('ETHUSD'),
    })
    .prefault({}),

  position: z
    .object({
      quantityEth: z.number().positive().max(100).default(0.2),
      leverage: z.number().int().min(1).max(200).default(50),
      maxOpenPositions: z.number().int().min(1).max(3).default(1),
    })
    .prefault({}),

  targets: z
    .object({
      targetMoveMinUsd: num(4, 0.1, 500),
      targetMoveMaxUsd: num(6, 0.1, 500),
      /** Target move = clamp(ATR * mult, min, max). */
      targetAtrMultiple: num(3, 0.1, 50),
      stopLossMinUsd: num(3, 0.1, 500),
      stopLossMaxUsd: num(6, 0.1, 500),
      stopLossAtrMultiple: num(2.5, 0.1, 50),
    })
    .prefault({}),

  exits: z
    .object({
      maxHoldMinutes: z.number().min(1).max(240).default(30),
      /**
       * What to do with a trade that has not reached its target before maxHoldMinutes:
       * - close_at_market: close at the time limit (default, always applies as the hard backstop)
       * - breakeven_then_close: after `breakevenAfterMinutes`, tighten the stop to break-even
       *   (net of fees) if the trade is in profit; still hard-close at the time limit.
       */
      timeExitPolicy: z.enum(['close_at_market', 'breakeven_then_close']).default('breakeven_then_close'),
      breakevenAfterMinutes: z.number().min(1).max(240).default(15),
      takeProfitOrderType: z.enum(['limit', 'market']).default('limit'),
    })
    .prefault({}),

  limits: z
    .object({
      /** Hard ceiling is 10 per rolling 24h (mandatory safety control). */
      maxTradesPer24h: z.number().int().min(1).max(10).default(10),
      perTradeRiskUsd: num(2.5, 0.01, 100000),
      dailyLossLimitUsd: num(6, 0.01, 100000),
      maxDrawdownPct: num(15, 0.1, 100),
      maxConsecutiveLosses: z.number().int().min(1).max(50).default(3),
      /** After the breaker trips, new entries are paused for this long, then the loss streak resets. */
      consecutiveLossPauseMinutes: num(120, 1, 10080),
      cooldownMinutesAfterLoss: num(5, 0, 1440),
      /** Free margin left after opening must be >= this % of equity. */
      minFreeMarginPct: num(30, 0, 100),
      /** Estimated liquidation distance must be >= this multiple of the stop distance. */
      minLiquidationBufferMultiple: num(3, 1, 50),
      /** (expected net reward) / (net loss at stop incl. fees), must be >= this. */
      minNetRewardRisk: num(0.25, 0, 10),
      minExpectedNetRewardUsd: num(0.1, 0, 100000),
    })
    .prefault({}),

  filters: z
    .object({
      maxSpreadUsd: num(0.5, 0.01, 100),
      /** Max adverse slippage tolerated on entry; used as the IOC limit buffer. */
      maxSlippageUsd: num(0.6, 0.01, 100),
      staleDataSeconds: z.number().min(1).max(600).default(10),
      minAtrUsd: num(1, 0, 1000),
      maxAtrUsd: num(15, 0.1, 1000),
    })
    .prefault({}),

  strategy: StrategyParamsSchema.prefault({}),

  execution: z
    .object({
      /** null => use the rate published on the exchange product. */
      makerFeeRate: z.number().min(0).max(0.01).nullable().default(null),
      takerFeeRate: z.number().min(0).max(0.01).nullable().default(null),
      /** GST on trading fees for Indian platforms. Verify against your account's fee statement. */
      gstRate: num(0.18, 0, 1),
      /**
       * Any additional transaction tax charged on each leg's notional (e.g. a TDS-style levy), as a fraction.
       * 0 by default: Delta's published fee schedule does not state one for perpetuals; enter your own figure if your
       * statements show it.
       */
      otherTaxRate: z.number().min(0).max(0.05).default(0),
      /**
       * Optional exit-fee waiver. DISABLED by default: no official source verified that exiting
       * inside 30 minutes is free, so it is never assumed. Enable only if your fee statement shows it.
       */
      exitFeeWaiver: z
        .object({
          enabled: z.boolean().default(false),
          withinMinutes: z.number().min(1).max(1440).default(30),
        })
        .prefault({}),
      /** Adverse slippage applied to simulated market fills (USD per ETH). */
      simSlippageUsd: num(0.1, 0, 50),
      /** Extra adverse slippage applied to simulated stop-market fills. */
      simStopSlippageUsd: num(0.25, 0, 50),
      /** 'through': a resting TP fills only once the market trades through it. 'touch': fills on touch. */
      tpFillModel: z.enum(['through', 'touch']).default('through'),
      usdInrRate: num(88, 1, 1000),
      /** Funding rate per 8h interval (fraction) assumed in Demo when the live funding feed is unavailable. */
      fundingRateFallback: z.number().min(-0.01).max(0.01).default(0.0001),
    })
    .prefault({}),

  demo: z
    .object({
      startingBalanceUsd: num(100, 1, 10_000_000),
    })
    .prefault({}),

  live: z
    .object({
      /**
       * What happens to an OPEN real position when the operator switches Live -> Demo:
       * - keep_managing: new entries stop; stops/targets/time-exit keep managing the position (default)
       * - close_at_market: close the position immediately with a reduce-only market order
       * - manual_review: stop managing entries, keep protective stop on the exchange, alert operator
       * The position is never silently abandoned.
       */
      modeSwitchPolicy: z.enum(['keep_managing', 'close_at_market', 'manual_review']).default('keep_managing'),
      /**
       * What the emergency kill switch does to an open REAL position:
       * - flatten_positions: reduce-only market close (default; safest in an emergency)
       * - keep_protective: leave the exchange-side stop/target in place, only block new entries
       */
      killSwitchAction: z.enum(['flatten_positions', 'keep_protective']).default('flatten_positions'),
      reconcileIntervalSeconds: z.number().int().min(3).max(300).default(10),
      minAvailableBalanceUsd: num(0, 0, 100_000_000),
    })
    .prefault({}),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type StrategyParams = z.infer<typeof StrategyParamsSchema>;

export function defaultSettings(): Settings {
  return SettingsSchema.parse({});
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return (patch as T) ?? base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const cur = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      out[k] = deepMerge(cur, v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

/** Documented fallback used ONLY when the exchange spec cannot be fetched. Never counts as verified. */
export function fallbackContractSpec(symbol = 'ETHUSD'): ContractSpec {
  return {
    symbol,
    productId: null,
    contractValue: 0.01,
    tickSize: 0.05,
    makerFeeRate: 0.0002,
    takerFeeRate: 0.0005,
    maxLeverage: 100,
    initialMarginPct: 1,
    maintenanceMarginPct: 0.5,
    positionSizeLimit: null,
    settlingAsset: 'USD',
    quotingAsset: 'USD',
    underlyingAsset: 'ETH',
    notionalType: 'vanilla',
    contractType: 'perpetual_futures',
    tradingStatus: 'unknown',
    fundingIntervalSec: 28800,
    verified: false,
    fetchedAt: null,
  };
}

/** Convert an ETH quantity to an integer number of contracts. Returns null if it is not a whole number. */
export function quantityToContracts(quantityEth: number, contractValue: number): number | null {
  if (!(contractValue > 0)) return null;
  const raw = quantityEth / contractValue;
  const n = Math.round(raw);
  if (n < 1) return null;
  return Math.abs(raw - n) < 1e-6 ? n : null;
}

export interface SettingsIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ValidationContext {
  /** Reference price used for margin/liquidation estimates (last known ETH price). */
  referencePrice?: number | null;
}

/**
 * Validate settings against the exchange contract specification and cross-field safety rules.
 * Errors block saving; warnings are surfaced in the UI.
 */
export function validateSettings(settings: Settings, spec: ContractSpec, ctx: ValidationContext = {}): SettingsIssue[] {
  const issues: SettingsIssue[] = [];
  const err = (path: string, message: string) => issues.push({ path, message, severity: 'error' });
  const warn = (path: string, message: string) => issues.push({ path, message, severity: 'warning' });

  const contracts = quantityToContracts(settings.position.quantityEth, spec.contractValue);
  if (contracts === null) {
    err(
      'position.quantityEth',
      `Quantity must be a whole multiple of the contract value (${spec.contractValue} ${spec.underlyingAsset} per contract). ` +
        `${settings.position.quantityEth} ${spec.underlyingAsset} is not valid.`,
    );
  } else if (spec.positionSizeLimit !== null && contracts > spec.positionSizeLimit) {
    err('position.quantityEth', `Quantity of ${contracts} contracts exceeds the exchange position size limit (${spec.positionSizeLimit}).`);
  }

  if (settings.position.leverage > spec.maxLeverage) {
    err('position.leverage', `Leverage ${settings.position.leverage}x exceeds the maximum ${spec.maxLeverage}x allowed for ${spec.symbol}.`);
  }
  if (settings.position.leverage > 50) {
    warn('position.leverage', 'Leverage above 50x leaves very little room between your stop and liquidation.');
  }

  const t = settings.targets;
  if (t.targetMoveMinUsd > t.targetMoveMaxUsd) err('targets.targetMoveMinUsd', 'Minimum target must not exceed the maximum target.');
  if (t.stopLossMinUsd > t.stopLossMaxUsd) err('targets.stopLossMinUsd', 'Minimum stop must not exceed the maximum stop.');

  if (settings.exits.breakevenAfterMinutes >= settings.exits.maxHoldMinutes && settings.exits.timeExitPolicy === 'breakeven_then_close') {
    err('exits.breakevenAfterMinutes', 'Break-even time must be earlier than the maximum holding time.');
  }
  if (settings.exits.maxHoldMinutes > 30) warn('exits.maxHoldMinutes', 'Holding longer than 30 minutes is outside the intended scalping profile.');

  if (spec.tradingStatus !== 'operational' && spec.verified) {
    warn('instrument.symbol', `Exchange reports trading status "${spec.tradingStatus}" for ${spec.symbol}.`);
  }

  if (contracts !== null) {
    const qtyEth = contracts * spec.contractValue;
    const worstStopLoss = t.stopLossMaxUsd * qtyEth;
    if (worstStopLoss > settings.limits.perTradeRiskUsd) {
      warn(
        'limits.perTradeRiskUsd',
        `A max-width stop ($${t.stopLossMaxUsd}) risks $${worstStopLoss.toFixed(2)} before fees, above the per-trade limit ($${settings.limits.perTradeRiskUsd}). Wide-stop signals will be rejected.`,
      );
    }
    const px = ctx.referencePrice;
    if (px && px > 0) {
      const notional = qtyEth * px;
      const margin = notional / settings.position.leverage;
      if (margin > settings.demo.startingBalanceUsd) {
        warn('position.leverage', `Estimated margin $${margin.toFixed(2)} exceeds the demo starting balance ($${settings.demo.startingBalanceUsd}).`);
      }
      const liqDistance = px * Math.max(0, 1 / settings.position.leverage - spec.maintenanceMarginPct / 100);
      if (liqDistance < t.stopLossMaxUsd * settings.limits.minLiquidationBufferMultiple) {
        warn(
          'limits.minLiquidationBufferMultiple',
          `At ${settings.position.leverage}x the estimated liquidation distance is ~$${liqDistance.toFixed(2)}; a $${t.stopLossMaxUsd} stop with a ${settings.limits.minLiquidationBufferMultiple}x buffer needs $${(t.stopLossMaxUsd * settings.limits.minLiquidationBufferMultiple).toFixed(2)}. Entries will be rejected by the risk manager.`,
        );
      }
    }
  }

  if (settings.strategy.emaFast >= settings.strategy.emaSlow) err('strategy.emaFast', 'Fast EMA must be shorter than slow EMA.');
  if (settings.strategy.emaSlow >= settings.strategy.emaTrend) err('strategy.emaSlow', 'Slow EMA must be shorter than trend EMA.');
  if (settings.filters.minAtrUsd >= settings.filters.maxAtrUsd) err('filters.minAtrUsd', 'Minimum ATR must be below maximum ATR.');
  if (!settings.strategy.allowLong && !settings.strategy.allowShort) err('strategy.allowLong', 'At least one trading direction must be enabled.');

  return issues;
}

export function hasErrors(issues: SettingsIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
