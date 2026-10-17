import type { ContractSpec, Quote, Side, Signal, TradingMode } from './types';
import type { Settings } from './settings';
import { quantityToContracts } from './settings';
import { estimateEconomics, feeConfigFrom, type TradeEconomics } from './fees';
import { roundToTick } from './math';

/**
 * Mandatory pre-trade risk manager. Shared by the backtester, the demo engine and the live
 * executor. 50x leverage never overrides any of these checks, and every check fails CLOSED:
 * missing/unknown state is treated as "not ok".
 */

export type RiskCode =
  | 'KILL_SWITCH'
  | 'LIVE_NOT_ARMED'
  | 'SPEC_UNVERIFIED'
  | 'TRADING_STATUS'
  | 'STALE_DATA'
  | 'API_UNHEALTHY'
  | 'NOT_RECONCILED'
  | 'MAX_OPEN_POSITIONS'
  | 'MAX_TRADES_24H'
  | 'DAILY_LOSS_LIMIT'
  | 'MAX_DRAWDOWN'
  | 'CONSECUTIVE_LOSSES'
  | 'COOLDOWN'
  | 'SPREAD'
  | 'DUPLICATE_SIGNAL'
  | 'PENDING_ORDER'
  | 'QUANTITY'
  | 'LEVERAGE'
  | 'PER_TRADE_RISK'
  | 'NET_REWARD'
  | 'NET_REWARD_RISK'
  | 'FREE_MARGIN'
  | 'LIQUIDATION_BUFFER'
  | 'MIN_BALANCE';

export interface RiskCheck {
  code: RiskCode;
  ok: boolean;
  message: string;
  value?: number | string | boolean | null;
  limit?: number | string | boolean | null;
}

export interface TradeEntry {
  ts: number;
}

export interface RealisedPnlEntry {
  ts: number;
  netPnl: number;
}

export interface RiskState {
  now: number;
  mode: TradingMode;
  killSwitch: boolean;
  /** Live only: has the operator completed the activation workflow and is execution armed? */
  liveArmed?: boolean;
  equityUsd: number;
  startingEquityUsd: number;
  peakEquityUsd: number;
  /** Margin available for new positions (free margin before this trade). */
  availableMarginUsd: number;
  openPositions: number;
  /** Timestamps of all new entries for this mode (any age; we filter to the rolling 24h). */
  entries: TradeEntry[];
  /** Realised closed-trade P&L for this mode (any age; we filter to the rolling 24h). */
  realised: RealisedPnlEntry[];
  consecutiveLosses: number;
  lastLossTs: number | null;
  /** Timestamp of the last quote/tick received. */
  lastTickTs: number | null;
  /** Connectivity of the market-data / exchange API. */
  apiHealthy: boolean;
  /** Live only: exchange positions/orders reconciled with our records. */
  reconciled?: boolean;
  /** Candle time of the last entry we acted on (duplicate-signal protection). */
  lastEntrySignalCandle: number | null;
  /** An entry/exit order is currently in flight (duplicate-order protection). */
  pendingOrder: boolean;
}

export interface RiskInput {
  settings: Settings;
  spec: ContractSpec;
  state: RiskState;
  signal: Signal;
  quote: Quote;
}

export interface PlannedTrade {
  side: Side;
  contracts: number;
  qtyEth: number;
  /** Expected entry price (ask for long, bid for short) before slippage. */
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  marginUsd: number;
  liquidationPrice: number;
  liquidationDistanceUsd: number;
  economics: TradeEconomics;
}

export interface RiskDecision {
  allowed: boolean;
  checks: RiskCheck[];
  /** Messages of failed checks. */
  reasons: string[];
  plan: PlannedTrade | null;
}

const DAY_MS = 86_400_000;

export function rollingEntries(entries: TradeEntry[], now: number): number {
  return entries.filter((e) => e.ts > now - DAY_MS && e.ts <= now).length;
}

export function rollingPnl(realised: RealisedPnlEntry[], now: number): number {
  return realised.filter((r) => r.ts > now - DAY_MS && r.ts <= now).reduce((s, r) => s + r.netPnl, 0);
}

/**
 * The consecutive-loss circuit breaker pauses entries for `consecutiveLossPauseMinutes` after the
 * last loss and then the streak resets, so the bot recovers on its own without hiding the event.
 */
export function effectiveConsecutiveLosses(count: number, lastLossTs: number | null, now: number, settings: Settings): number {
  if (count < settings.limits.maxConsecutiveLosses) return count;
  if (lastLossTs === null) return count;
  return (now - lastLossTs) / 60_000 >= settings.limits.consecutiveLossPauseMinutes ? 0 : count;
}

/** Estimated isolated-margin liquidation price (exchange-reported value replaces this in LIVE). */
export function estimateLiquidationPrice(side: Side, entryPrice: number, leverage: number, maintenanceMarginPct: number): number {
  const frac = Math.max(0, 1 / leverage - maintenanceMarginPct / 100);
  return side === 'long' ? entryPrice * (1 - frac) : entryPrice * (1 + frac);
}

/** Checks that do not depend on the specific signal. Also used for the dashboard "risk status". */
export function accountChecks(settings: Settings, spec: ContractSpec, st: RiskState): RiskCheck[] {
  const L = settings.limits;
  const f = settings.filters;
  const checks: RiskCheck[] = [];
  const add = (c: RiskCheck) => checks.push(c);

  add({ code: 'KILL_SWITCH', ok: !st.killSwitch, message: st.killSwitch ? 'Emergency kill switch is engaged' : 'Kill switch released' });

  if (st.mode === 'live') {
    add({
      code: 'LIVE_NOT_ARMED',
      ok: st.liveArmed === true,
      message: st.liveArmed ? 'Live execution is armed' : 'Live execution is not armed (activation workflow not completed)',
    });
    add({ code: 'SPEC_UNVERIFIED', ok: spec.verified, message: spec.verified ? 'Contract spec verified with exchange' : 'Contract spec is not verified against the exchange' });
    add({ code: 'NOT_RECONCILED', ok: st.reconciled === true, message: st.reconciled ? 'Exchange state reconciled' : 'Exchange positions/orders are not reconciled' });
    add({
      code: 'MIN_BALANCE',
      ok: st.availableMarginUsd >= settings.live.minAvailableBalanceUsd,
      message: `Available balance ${st.availableMarginUsd.toFixed(2)} vs minimum ${settings.live.minAvailableBalanceUsd}`,
      value: st.availableMarginUsd,
      limit: settings.live.minAvailableBalanceUsd,
    });
  }

  add({
    code: 'TRADING_STATUS',
    ok: !spec.verified || spec.tradingStatus === 'operational',
    message: spec.verified ? `Exchange trading status: ${spec.tradingStatus}` : 'Trading status unverified (fallback spec)',
    value: spec.tradingStatus,
  });

  const tickAgeS = st.lastTickTs === null ? Infinity : (st.now - st.lastTickTs) / 1000;
  add({
    code: 'STALE_DATA',
    ok: tickAgeS <= f.staleDataSeconds,
    message: Number.isFinite(tickAgeS) ? `Market data age ${tickAgeS.toFixed(1)}s (limit ${f.staleDataSeconds}s)` : 'No market data received',
    value: Number.isFinite(tickAgeS) ? Number(tickAgeS.toFixed(2)) : null,
    limit: f.staleDataSeconds,
  });
  add({ code: 'API_UNHEALTHY', ok: st.apiHealthy, message: st.apiHealthy ? 'Exchange connectivity healthy' : 'Exchange connectivity unhealthy' });

  add({
    code: 'MAX_OPEN_POSITIONS',
    ok: st.openPositions < settings.position.maxOpenPositions,
    message: `Open positions ${st.openPositions} / ${settings.position.maxOpenPositions}`,
    value: st.openPositions,
    limit: settings.position.maxOpenPositions,
  });

  const trades24 = rollingEntries(st.entries, st.now);
  add({
    code: 'MAX_TRADES_24H',
    ok: trades24 < L.maxTradesPer24h,
    message: `New trades in rolling 24h: ${trades24} / ${L.maxTradesPer24h}`,
    value: trades24,
    limit: L.maxTradesPer24h,
  });

  const pnl24 = rollingPnl(st.realised, st.now);
  add({
    code: 'DAILY_LOSS_LIMIT',
    ok: pnl24 > -L.dailyLossLimitUsd,
    message: `Rolling 24h realised P&L ${pnl24.toFixed(2)} (loss limit -${L.dailyLossLimitUsd})`,
    value: Number(pnl24.toFixed(4)),
    limit: -L.dailyLossLimitUsd,
  });

  const ddPct = st.peakEquityUsd > 0 ? ((st.peakEquityUsd - st.equityUsd) / st.peakEquityUsd) * 100 : 0;
  add({
    code: 'MAX_DRAWDOWN',
    ok: ddPct < L.maxDrawdownPct,
    message: `Drawdown from peak ${ddPct.toFixed(2)}% (limit ${L.maxDrawdownPct}%)`,
    value: Number(ddPct.toFixed(4)),
    limit: L.maxDrawdownPct,
  });

  const sinceLossMin = st.lastLossTs === null ? Infinity : (st.now - st.lastLossTs) / 60_000;
  const streak = effectiveConsecutiveLosses(st.consecutiveLosses, st.lastLossTs, st.now, settings);
  add({
    code: 'CONSECUTIVE_LOSSES',
    ok: streak < L.maxConsecutiveLosses,
    message:
      streak >= L.maxConsecutiveLosses
        ? `Circuit breaker: ${streak} consecutive losses; paused ${Math.max(0, L.consecutiveLossPauseMinutes - sinceLossMin).toFixed(0)} more min`
        : `Consecutive losses ${streak} / ${L.maxConsecutiveLosses}`,
    value: streak,
    limit: L.maxConsecutiveLosses,
  });

  add({
    code: 'COOLDOWN',
    ok: sinceLossMin >= L.cooldownMinutesAfterLoss,
    message: Number.isFinite(sinceLossMin)
      ? `${sinceLossMin.toFixed(1)} min since last loss (cooldown ${L.cooldownMinutesAfterLoss} min)`
      : 'No recent loss',
    value: Number.isFinite(sinceLossMin) ? Number(sinceLossMin.toFixed(2)) : null,
    limit: L.cooldownMinutesAfterLoss,
  });

  add({ code: 'PENDING_ORDER', ok: !st.pendingOrder, message: st.pendingOrder ? 'An order is already in flight' : 'No order in flight' });

  return checks;
}

/** Full pre-trade evaluation for a candidate signal. */
export function evaluateEntryRisk(input: RiskInput): RiskDecision {
  const { settings, spec, state: st, signal, quote } = input;
  const L = settings.limits;
  const f = settings.filters;
  const checks: RiskCheck[] = accountChecks(settings, spec, st);
  const add = (c: RiskCheck) => checks.push(c);

  const spread = quote.ask - quote.bid;
  add({
    code: 'SPREAD',
    ok: quote.ask > 0 && quote.bid > 0 && spread >= 0 && spread <= f.maxSpreadUsd,
    message: `Spread ${spread.toFixed(3)} (max ${f.maxSpreadUsd})`,
    value: Number(spread.toFixed(4)),
    limit: f.maxSpreadUsd,
  });

  add({
    code: 'DUPLICATE_SIGNAL',
    ok: st.lastEntrySignalCandle !== signal.candleTime,
    message: st.lastEntrySignalCandle === signal.candleTime ? 'Signal candle already traded' : 'New signal candle',
  });

  const contracts = quantityToContracts(settings.position.quantityEth, spec.contractValue);
  add({
    code: 'QUANTITY',
    ok: contracts !== null,
    message: contracts === null ? 'Configured quantity is not a whole number of contracts' : `${contracts} contracts`,
    value: contracts,
  });

  add({
    code: 'LEVERAGE',
    ok: settings.position.leverage <= spec.maxLeverage,
    message: `Leverage ${settings.position.leverage}x (exchange max ${spec.maxLeverage}x)`,
    value: settings.position.leverage,
    limit: spec.maxLeverage,
  });

  let plan: PlannedTrade | null = null;
  if (contracts !== null && quote.ask > 0 && quote.bid > 0) {
    const side = signal.side;
    const dir = side === 'long' ? 1 : -1;
    const entry = side === 'long' ? quote.ask : quote.bid;
    const tick = spec.tickSize;
    const stopPrice = roundToTick(entry - dir * signal.stopMoveUsd, tick, side === 'long' ? 'down' : 'up');
    const targetPrice = roundToTick(entry + dir * signal.targetMoveUsd, tick, side === 'long' ? 'up' : 'down');
    const qtyEth = contracts * spec.contractValue;
    const notional = entry * qtyEth;
    const marginUsd = notional / settings.position.leverage;
    const liq = estimateLiquidationPrice(side, entry, settings.position.leverage, spec.maintenanceMarginPct);
    const liqDist = Math.abs(entry - liq);
    const fees = feeConfigFrom(settings, spec);
    const economics = estimateEconomics(
      {
        side,
        entryPrice: entry + dir * settings.execution.simSlippageUsd,
        targetPrice,
        stopPrice,
        contracts,
        contractValue: spec.contractValue,
        entryRole: 'taker',
        targetRole: settings.exits.takeProfitOrderType === 'limit' ? 'maker' : 'taker',
        stopRole: 'taker',
        stopSlippageUsd: settings.execution.simStopSlippageUsd,
      },
      fees,
    );
    plan = { side, contracts, qtyEth, entryPrice: entry, stopPrice, targetPrice, marginUsd, liquidationPrice: liq, liquidationDistanceUsd: liqDist, economics };

    add({
      code: 'PER_TRADE_RISK',
      ok: economics.riskNet <= L.perTradeRiskUsd,
      message: `Net loss at stop (incl. fees) ${economics.riskNet.toFixed(2)} vs limit ${L.perTradeRiskUsd}`,
      value: Number(economics.riskNet.toFixed(4)),
      limit: L.perTradeRiskUsd,
    });
    add({
      code: 'NET_REWARD',
      ok: economics.rewardNet >= L.minExpectedNetRewardUsd,
      message: `Net reward at target after fees ${economics.rewardNet.toFixed(2)} (min ${L.minExpectedNetRewardUsd}); fee break-even move $${economics.breakevenMoveUsd.toFixed(2)}`,
      value: Number(economics.rewardNet.toFixed(4)),
      limit: L.minExpectedNetRewardUsd,
    });
    add({
      code: 'NET_REWARD_RISK',
      ok: economics.netRewardRisk >= L.minNetRewardRisk,
      message: `Net reward:risk ${economics.netRewardRisk.toFixed(2)} (min ${L.minNetRewardRisk})`,
      value: Number(economics.netRewardRisk.toFixed(4)),
      limit: L.minNetRewardRisk,
    });

    const freeAfter = st.availableMarginUsd - marginUsd;
    const freePct = st.equityUsd > 0 ? (freeAfter / st.equityUsd) * 100 : -Infinity;
    add({
      code: 'FREE_MARGIN',
      ok: freeAfter >= 0 && freePct >= L.minFreeMarginPct,
      message: `Free margin after entry ${freeAfter.toFixed(2)} (${Number.isFinite(freePct) ? freePct.toFixed(1) : 'n/a'}% of equity; min ${L.minFreeMarginPct}%)`,
      value: Number.isFinite(freePct) ? Number(freePct.toFixed(2)) : null,
      limit: L.minFreeMarginPct,
    });

    const stopDist = Math.abs(entry - stopPrice);
    add({
      code: 'LIQUIDATION_BUFFER',
      ok: liqDist >= stopDist * L.minLiquidationBufferMultiple,
      message: `Liquidation distance ~$${liqDist.toFixed(2)} vs stop distance $${stopDist.toFixed(2)} (needs ${L.minLiquidationBufferMultiple}x)`,
      value: Number(liqDist.toFixed(4)),
      limit: Number((stopDist * L.minLiquidationBufferMultiple).toFixed(4)),
    });
  }

  const failed = checks.filter((c) => !c.ok);
  return {
    allowed: failed.length === 0,
    checks,
    reasons: failed.map((c) => `${c.code}: ${c.message}`),
    plan,
  };
}

/** Summary used by the dashboard risk panels. */
export function riskSummary(settings: Settings, spec: ContractSpec, st: RiskState) {
  const checks = accountChecks(settings, spec, st);
  const failed = checks.filter((c) => !c.ok);
  return {
    tradingAllowed: failed.length === 0,
    checks,
    blockers: failed.map((c) => `${c.code}: ${c.message}`),
    tradesLast24h: rollingEntries(st.entries, st.now),
    realisedPnl24h: Number(rollingPnl(st.realised, st.now).toFixed(4)),
  };
}
