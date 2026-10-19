import { z } from 'zod';
import type { ContractSpec } from './types';
import { feeConfigFrom, roundTripFee } from './fees';

/**
 * Persistent bot configuration. Defaults reproduce the requested setup:
 * ETH perpetual, 0.20 ETH, 50x, a fixed $10 target move, a $5-$8 protective stop, NO time limit on a position,
 * at most 10 new trades per rolling 24h (a ceiling, never a quota).
 *
 * Stored documents carry a `version`. Anything stored before version 2 must go through `migrateSettings` before it
 * is parsed (the schema deliberately does not migrate by itself: a partial document must never be rewritten).
 */

/** Bump when a default changes in a way that existing stored settings must be upgraded. */
export const SETTINGS_VERSION = 2;

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
  /** Schema version of the stored document (see `migrateSettings`). A missing version means a pre-v2 document. */
  version: z.number().int().min(1).default(SETTINGS_VERSION),

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
      /** Min = max = 10 means a fixed $10 move per ETH on every trade, long or short. */
      targetMoveMinUsd: num(10, 0.1, 500),
      targetMoveMaxUsd: num(10, 0.1, 500),
      /** Target move = clamp(ATR * mult, min, max). */
      targetAtrMultiple: num(3, 0.1, 50),
      stopLossMinUsd: num(5, 0.1, 500),
      stopLossMaxUsd: num(8, 0.1, 500),
      stopLossAtrMultiple: num(2.5, 0.1, 50),
    })
    .prefault({}),

  exits: z
    .object({
      /**
       * Longest a position may stay open, in minutes. null (default) = NO time limit: the position stays open until
       * its target or its protective stop is hit (or the operator / kill switch closes it).
       */
      maxHoldMinutes: z.number().min(1).max(1440).nullable().default(null),
      /**
       * What to do with a trade that has not reached its target:
       * - none (default): no time exit and no break-even tightening; the target or the stop ends the trade. A set
       *   `maxHoldMinutes` is ignored under this policy.
       * - close_at_market: market-close at `maxHoldMinutes` (needs a time limit to do anything)
       * - breakeven_then_close: after `breakevenAfterMinutes`, tighten the stop to break-even (net of fees) if the
       *   trade is in profit; also hard-close at `maxHoldMinutes` when one is set.
       */
      timeExitPolicy: z.enum(['none', 'close_at_market', 'breakeven_then_close']).default('none'),
      breakevenAfterMinutes: z.number().min(1).max(1440).default(15),
      takeProfitOrderType: z.enum(['limit', 'market']).default('limit'),
    })
    .prefault({}),

  /** Display only: shown to the user as a goal. Nothing in the bot reads it to size, force or relax a trade. */
  goals: z
    .object({
      dailyProfitInr: num(500, 0, 1_000_000),
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
       * DORMANT. Delta's "Scalper Offer" (no closing fee when a position is closed within 30 minutes) is NOT assumed:
       * by default brokerage is paid on both legs. The block stays in the schema so the feature can be switched back on
       * for an account that has joined the offer. When `enabled`:
       *  - Demo / backtests / pre-trade estimates treat an exit inside the window as fee-free, but only when the time
       *    exit guarantees it (a set `maxHoldMinutes` with a policy other than "none"); with no time limit the estimates
       *    keep full fees, because a position may outlive the window;
       *  - Live P&L always uses the fees the exchange actually charged.
       */
      exitFeeWaiver: z
        .object({
          enabled: z.boolean().default(false),
          /** Close-within window of the offer. */
          withinMinutes: z.number().min(1).max(1440).default(30),
          /**
           * Safety margin: time exits fire this many seconds BEFORE the window ends so latency or a slow fill can
           * not push the closing fill past the cut-off (an exit at 30:01 would pay the full closing fee).
           */
          safetyMarginSeconds: z.number().int().min(0).max(600).default(90),
          /** When true the hard time-exit is clamped to (window - safety margin) while the waiver is assumed. */
          clampTimeExit: z.boolean().default(true),
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

/**
 * The longest a position may be held before the bot market-closes it, in ms. `Infinity` means NO time limit, which is
 * the default: `exits.maxHoldMinutes` is null, or the policy is "none" (no time exit at all).
 * Only an existing limit is ever shortened: while the dormant Scalper Offer waiver is assumed it is clamped to
 * (window - safety margin) so that even the time exit is a free exit. The clamp never invents a limit by itself.
 * JSON snapshots must send `effectiveMaxHoldMinutes` (null) instead of Infinity.
 */
export function effectiveMaxHoldMs(settings: Settings, waiverOn: boolean = settings.execution.exitFeeWaiver.enabled): number {
  const minutes = settings.exits.maxHoldMinutes;
  if (minutes === null || settings.exits.timeExitPolicy === 'none') return Infinity;
  const hold = minutes * 60_000;
  const w = settings.execution.exitFeeWaiver;
  if (!waiverOn || !w.clampTimeExit) return hold;
  const limit = w.withinMinutes * 60_000 - w.safetyMarginSeconds * 1000;
  return Math.max(60_000, Math.min(hold, limit));
}

/** `effectiveMaxHoldMs` in minutes, or null when there is no time limit (JSON-safe). */
export function effectiveMaxHoldMinutes(settings: Settings, waiverOn?: boolean): number | null {
  const ms = effectiveMaxHoldMs(settings, waiverOn);
  return Number.isFinite(ms) ? ms / 60_000 : null;
}

/**
 * True when every exit of a position is guaranteed to land inside the Scalper Offer window, i.e. the waiver may be
 * assumed in pre-trade estimates. With no time limit a position can outlive the window, so this is false.
 */
export function waiverGuaranteed(settings: Settings, waiverOn: boolean = settings.execution.exitFeeWaiver.enabled): boolean {
  if (!waiverOn) return false;
  return effectiveMaxHoldMs(settings, true) <= settings.execution.exitFeeWaiver.withinMinutes * 60_000;
}

/**
 * Upgrade a stored settings document to the current version. Pure and idempotent: a document that already carries
 * `version >= SETTINGS_VERSION` is returned unchanged, anything else (a missing version counts as 1) gets the v2
 * changes and every other stored value is kept. Run it on stored documents BEFORE `SettingsSchema.parse`.
 *
 * v2: no time limit (maxHoldMinutes null, policy "none"), the dormant exit-fee waiver switched off, a fixed $10
 * target with a $5-$8 stop band, and the display-only daily goal.
 */
export function migrateSettings(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const stored = (raw as Record<string, unknown>).version;
  const version = typeof stored === 'number' && Number.isFinite(stored) ? stored : 1;
  if (version >= SETTINGS_VERSION) return raw;
  return deepMerge(raw, {
    version: SETTINGS_VERSION,
    exits: { maxHoldMinutes: null, timeExitPolicy: 'none' },
    execution: { exitFeeWaiver: { enabled: false } },
    targets: { targetMoveMinUsd: 10, targetMoveMaxUsd: 10, stopLossMinUsd: 5, stopLossMaxUsd: 8 },
    goals: { dailyProfitInr: 500 },
  });
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

  const ex = settings.exits;
  const limited = Number.isFinite(effectiveMaxHoldMs(settings, false));
  if (!limited) {
    warn(
      'exits.maxHoldMinutes',
      'No time limit: a position stays open until its target or its stop is hit, so it may be held through funding payments (every 8 hours). Funding can add to or reduce the result.',
    );
    if (ex.maxHoldMinutes !== null && ex.timeExitPolicy === 'none') {
      warn('exits.timeExitPolicy', `A maximum holding time of ${ex.maxHoldMinutes} min is set but the time-exit policy is "none", so it is ignored.`);
    }
  }
  if (ex.timeExitPolicy === 'close_at_market' && ex.maxHoldMinutes === null) {
    warn('exits.timeExitPolicy', 'The policy "close_at_market" needs a maximum holding time; without one nothing is closed by time.');
  }
  // Only compare the two times when both apply.
  if (ex.timeExitPolicy === 'breakeven_then_close' && ex.maxHoldMinutes !== null && ex.breakevenAfterMinutes >= ex.maxHoldMinutes) {
    err('exits.breakevenAfterMinutes', 'Break-even time must be earlier than the maximum holding time.');
  }

  const w = settings.execution.exitFeeWaiver;
  if (w.enabled) {
    if (w.safetyMarginSeconds >= w.withinMinutes * 60) {
      err('execution.exitFeeWaiver.safetyMarginSeconds', 'The safety margin must be shorter than the waiver window.');
    }
    if (!limited) {
      warn(
        'execution.exitFeeWaiver.enabled',
        `The closing-fee waiver only covers exits within ${w.withinMinutes} min, but there is no time limit: a position that runs longer pays the full closing fee, so fee estimates keep full fees.`,
      );
    } else {
      const effMin = effectiveMaxHoldMs(settings, true) / 60_000;
      if (ex.maxHoldMinutes !== null && effMin < ex.maxHoldMinutes) {
        warn(
          'exits.maxHoldMinutes',
          `Scalper Offer waiver is assumed, so the time exit is clamped to ${effMin.toFixed(1)} min (window ${w.withinMinutes} min minus ${w.safetyMarginSeconds}s safety margin) to keep every exit fee-free.`,
        );
      }
      if (!w.clampTimeExit && ex.maxHoldMinutes !== null && ex.maxHoldMinutes >= w.withinMinutes) {
        warn('execution.exitFeeWaiver.clampTimeExit', 'A time exit at or after the waiver window pays the full closing fee, but the estimates still assume it is free.');
      }
      if (ex.timeExitPolicy === 'breakeven_then_close' && ex.breakevenAfterMinutes * 60_000 >= effectiveMaxHoldMs(settings, true)) {
        err('exits.breakevenAfterMinutes', 'Break-even time must be earlier than the (clamped) time exit.');
      }
    }
    if (w.withinMinutes > 30) {
      warn('execution.exitFeeWaiver.withinMinutes', 'Delta publishes a 30-minute window for BTCUSD and ETHUSD (15 minutes for other futures). A longer window makes the fee estimates too optimistic.');
    }
    if (w.safetyMarginSeconds < 20) {
      warn('execution.exitFeeWaiver.safetyMarginSeconds', 'A very small safety margin risks the exit fill landing after the 30-minute cut-off and paying the closing fee.');
    }
  }

  if (spec.tradingStatus !== 'operational' && spec.verified) {
    warn('instrument.symbol', `Exchange reports trading status "${spec.tradingStatus}" for ${spec.symbol}.`);
  }

  if (contracts !== null) {
    const qtyEth = contracts * spec.contractValue;
    // Worst case at the widest stop, as the risk manager sees it: stop distance plus the simulated entry and stop
    // slippage on the quantity, plus (when a price is known) full taker/taker brokerage with no waiver.
    const px = ctx.referencePrice;
    const slip = settings.execution.simSlippageUsd + settings.execution.simStopSlippageUsd;
    const worstGross = (t.stopLossMaxUsd + slip) * qtyEth;
    const worstFees =
      px && px > 0 ? roundTripFee({ price: px, contracts, contractValue: spec.contractValue, cfg: feeConfigFrom(settings, spec, { waiverOverride: false }) }).total : 0;
    const worstStopLoss = worstGross + worstFees;
    if (worstStopLoss > settings.limits.perTradeRiskUsd) {
      warn(
        'limits.perTradeRiskUsd',
        `A max-width stop ($${t.stopLossMaxUsd}) can lose about $${worstStopLoss.toFixed(2)} on a trade (${worstFees > 0 ? 'including slippage and brokerage on both legs' : 'including slippage, before brokerage'}), above the per-trade limit ($${settings.limits.perTradeRiskUsd}). Wide-stop signals will be rejected.`,
      );
    }
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
