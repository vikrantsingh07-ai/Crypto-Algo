import type {
  Candle,
  ClosedTrade,
  ContractSpec,
  DemoAccountState,
  ExitReason,
  OpenPosition,
  Quote,
  Role,
  Side,
  Signal,
} from './types';
import { effectiveMaxHoldMs, type Settings } from './settings';
import { calcFee, calcPnl, estimateEconomics, feeConfigFrom, grossPnl, type FeeConfig, type FeeConfigOptions } from './fees';
import { estimateLiquidationPrice } from './risk';
import { round, roundToTick } from './math';

/**
 * Paper (demo) execution simulator. Pure functions only; the demo engine in the server and the
 * backtester both drive these so simulated behaviour is identical in both.
 *
 * Fill model (all adverse to the trader):
 *  - Entry: market/IOC order fills at ask (long) / bid (short) plus `simSlippageUsd`; taker fee.
 *  - Stop: triggered when price trades through the stop; fills at min(stop, bid) - slippage
 *    (mirror for shorts) with extra `simStopSlippageUsd`; taker fee.
 *  - Take profit: resting reduce-only limit. Fills at the target price (maker fee) once the
 *    market trades THROUGH it (`tpFillModel = 'through'`, one tick beyond) or touches it
 *    (`'touch'`). With `takeProfitOrderType = 'market'` it fills as taker with slippage.
 *  - Time exit: market close at bid/ask with slippage; taker fee. While the Scalper Offer waiver is assumed
 *    the time exit fires `safetyMarginSeconds` before the 30-minute window ends (see `effectiveMaxHoldMs`).
 *  - Scalper Offer: any exit within the window pays no closing fee (`calcFee`, holdMs <= window); the entry
 *    fee is always charged. A close after the window (waiver off / clamp off) pays the normal closing fee.
 *  - If stop and target both trigger inside one tick/candle, the STOP is assumed to hit first.
 *  - Funding is charged when a funding timestamp is crossed while the position is open.
 */

export interface Tick {
  ts: number;
  bid: number;
  ask: number;
  last: number;
  /** Highest / lowest traded price since the previous tick (== last for plain quotes). */
  high: number;
  low: number;
}

export function tickFromQuote(q: Quote): Tick {
  return { ts: q.ts, bid: q.bid, ask: q.ask, last: q.last, high: Math.max(q.last, q.bid), low: Math.min(q.last, q.ask) };
}

/** Candle-to-tick conversion for backtests. `closeTs` is the candle close time. */
export function tickFromCandle(c: Candle, closeTs: number, spreadUsd: number): Tick {
  const half = spreadUsd / 2;
  return { ts: closeTs, bid: c.c - half, ask: c.c + half, last: c.c, high: c.h, low: c.l };
}

export interface PaperContext {
  settings: Settings;
  spec: ContractSpec;
  fees: FeeConfig;
  /** Funding rate per interval as a fraction (positive: longs pay shorts). */
  fundingRate?: number;
}

export function paperContext(settings: Settings, spec: ContractSpec, fundingRate = 0, feeOpts: FeeConfigOptions = {}): PaperContext {
  return { settings, spec, fees: feeConfigFrom(settings, spec, feeOpts), fundingRate };
}

/** Time exit used by the simulator and by live: the Scalper Offer clamp applies while the waiver is assumed. */
export function timeExitMs(ctx: PaperContext): number {
  return effectiveMaxHoldMs(ctx.settings, ctx.fees.waiver.enabled);
}

export function newDemoAccount(startingBalanceUsd: number, now: number): DemoAccountState {
  return {
    startingBalanceUsd,
    balanceUsd: startingBalanceUsd,
    peakEquityUsd: startingBalanceUsd,
    maxDrawdownPct: 0,
    totalFeesUsd: 0,
    openPosition: null,
    updatedAt: now,
  };
}

function nextFundingAfter(ts: number, intervalSec: number): number {
  const iv = intervalSec * 1000;
  return (Math.floor(ts / iv) + 1) * iv;
}

export interface OpenArgs {
  id: string;
  signal: Signal;
  tick: Tick;
  contracts: number;
}

/** Simulate the entry fill and build the open position. Account is mutated by `applyOpen`. */
export function openPaperPosition(args: OpenArgs, ctx: PaperContext): OpenPosition {
  const { settings: s, spec, fees } = ctx;
  const { signal, tick, contracts } = args;
  const side: Side = signal.side;
  const dir = side === 'long' ? 1 : -1;
  const refPrice = side === 'long' ? tick.ask : tick.bid;
  const entryPrice = roundToTick(refPrice + dir * s.execution.simSlippageUsd, spec.tickSize, side === 'long' ? 'up' : 'down');
  const qtyEth = contracts * spec.contractValue;
  const entryFee = calcFee({ price: entryPrice, contracts, contractValue: spec.contractValue, role: 'taker' }, fees);
  const stopPrice = roundToTick(entryPrice - dir * signal.stopMoveUsd, spec.tickSize, side === 'long' ? 'down' : 'up');
  const targetPrice = roundToTick(entryPrice + dir * signal.targetMoveUsd, spec.tickSize, side === 'long' ? 'up' : 'down');
  const notional = entryPrice * qtyEth;
  return {
    id: args.id,
    mode: 'demo',
    side,
    contracts,
    contractValue: spec.contractValue,
    qtyEth,
    leverage: s.position.leverage,
    entryTs: tick.ts,
    entryPrice,
    entryRefPrice: refPrice,
    stopPrice,
    initialStopPrice: stopPrice,
    targetPrice,
    targetMoveUsd: signal.targetMoveUsd,
    stopMoveUsd: signal.stopMoveUsd,
    entryFee,
    entrySlippageCost: round(Math.abs(entryPrice - refPrice) * qtyEth, 8),
    marginUsed: round(notional / s.position.leverage, 8),
    liquidationPrice: round(estimateLiquidationPrice(side, entryPrice, s.position.leverage, spec.maintenanceMarginPct), 8),
    fundingAccrued: 0,
    mfe: 0,
    mae: 0,
    reachedTargetAtMs: null,
    breakevenArmed: false,
    nextFundingTs: nextFundingAfter(tick.ts, spec.fundingIntervalSec),
    regime: signal.regime,
    reasons: signal.reasons,
    signalCandleTime: signal.candleTime,
  };
}

export function applyOpen<A extends DemoAccountState>(account: A, pos: OpenPosition, now: number): A {
  return {
    ...account,
    balanceUsd: round(account.balanceUsd - pos.entryFee.total, 8),
    totalFeesUsd: round(account.totalFeesUsd + pos.entryFee.total, 8),
    openPosition: pos,
    updatedAt: now,
  };
}

export function unrealizedGross(pos: OpenPosition, tick: Tick): number {
  const mark = pos.side === 'long' ? tick.bid : tick.ask;
  return grossPnl(pos.side, pos.entryPrice, mark, pos.contracts, pos.contractValue);
}

export function accountEquity(account: DemoAccountState, tick: Tick | null): number {
  if (!account.openPosition || !tick) return account.balanceUsd;
  return account.balanceUsd + unrealizedGross(account.openPosition, tick) + account.openPosition.fundingAccrued;
}

/** Update peak / max drawdown from current equity. */
export function markEquity<A extends DemoAccountState>(account: A, equity: number, now: number): A {
  const peak = Math.max(account.peakEquityUsd, equity);
  const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
  return { ...account, peakEquityUsd: round(peak, 8), maxDrawdownPct: round(Math.max(account.maxDrawdownPct, dd), 6), updatedAt: now };
}

export interface ExitDecision {
  reason: ExitReason;
  price: number;
  role: Role;
}

export interface StepResult {
  position: OpenPosition;
  exit: ExitDecision | null;
  /** Funding cashflow recognised in this step (signed; negative = paid). */
  fundingDelta: number;
}

/**
 * Breakeven stop price that covers entry+exit fees on the current position. With the Scalper Offer waiver
 * the closing leg is free while the position is inside the window, so only the entry fee has to be recovered.
 */
export function breakevenStopPrice(pos: OpenPosition, ctx: PaperContext, heldMs = 0): number {
  const dir = pos.side === 'long' ? 1 : -1;
  const waived = ctx.fees.waiver.enabled && heldMs <= ctx.fees.waiver.withinMinutes * 60_000;
  const exitRate = waived ? 0 : ctx.fees.takerRate * (1 + ctx.fees.gstRate) + (ctx.fees.otherTaxRate ?? 0);
  const qty = pos.qtyEth;
  const move = (pos.entryFee.total + exitRate * qty * pos.entryPrice) / (qty * (1 - dir * exitRate));
  return roundToTick(pos.entryPrice + dir * move, ctx.spec.tickSize, pos.side === 'long' ? 'up' : 'down');
}

/** Advance a position by one tick. Pure: returns the updated position and an optional exit. */
export function stepPosition(prev: OpenPosition, tick: Tick, ctx: PaperContext): StepResult {
  const { settings: s, spec } = ctx;
  const pos: OpenPosition = { ...prev };
  const dir = pos.side === 'long' ? 1 : -1;
  const heldMs = tick.ts - pos.entryTs;
  let fundingDelta = 0;

  // Excursions in USD per ETH (favourable positive).
  const fav = dir * ((dir === 1 ? tick.high : tick.low) - pos.entryPrice);
  const adv = dir * ((dir === 1 ? tick.low : tick.high) - pos.entryPrice);
  pos.mfe = Math.max(pos.mfe, fav);
  pos.mae = Math.min(pos.mae, adv);
  if (pos.reachedTargetAtMs === null && pos.mfe >= pos.targetMoveUsd) pos.reachedTargetAtMs = tick.ts;

  // Funding (signed cashflow: longs pay when rate > 0).
  if (ctx.fundingRate && pos.nextFundingTs !== null) {
    while (pos.nextFundingTs !== null && tick.ts >= pos.nextFundingTs) {
      const notional = tick.last * pos.qtyEth;
      const cash = -dir * ctx.fundingRate * notional;
      pos.fundingAccrued = round(pos.fundingAccrued + cash, 8);
      fundingDelta += cash;
      pos.nextFundingTs += spec.fundingIntervalSec * 1000;
    }
  }

  const stopSlip = s.execution.simStopSlippageUsd;
  const slip = s.execution.simSlippageUsd;

  // 1) Liquidation
  const liqHit = dir === 1 ? tick.low <= pos.liquidationPrice : tick.high >= pos.liquidationPrice;
  if (liqHit) return { position: pos, exit: { reason: 'liquidation', price: pos.liquidationPrice, role: 'taker' }, fundingDelta };

  // 2) Stop (checked before target: if both trigger in one tick the stop is assumed first)
  const stopHit = dir === 1 ? tick.low <= pos.stopPrice : tick.high >= pos.stopPrice;
  if (stopHit) {
    const base = dir === 1 ? Math.min(pos.stopPrice, tick.bid) : Math.max(pos.stopPrice, tick.ask);
    const price = roundToTick(base - dir * stopSlip, spec.tickSize, dir === 1 ? 'down' : 'up');
    const reason: ExitReason = pos.breakevenArmed && Math.abs(pos.stopPrice - pos.initialStopPrice) > 1e-9 ? 'breakeven_stop' : 'stop_loss';
    return { position: pos, exit: { reason, price, role: 'taker' }, fundingDelta };
  }

  // 3) Take profit
  const tpTrigger = s.execution.tpFillModel === 'through' ? pos.targetPrice + dir * spec.tickSize : pos.targetPrice;
  const tpHit = dir === 1 ? tick.high >= tpTrigger : tick.low <= tpTrigger;
  if (tpHit) {
    if (s.exits.takeProfitOrderType === 'limit') {
      return { position: pos, exit: { reason: 'take_profit', price: pos.targetPrice, role: 'maker' }, fundingDelta };
    }
    const price = roundToTick(pos.targetPrice - dir * slip, spec.tickSize, dir === 1 ? 'down' : 'up');
    return { position: pos, exit: { reason: 'take_profit', price, role: 'taker' }, fundingDelta };
  }

  // 4) Break-even tightening for trades that have not reached the target yet.
  if (
    s.exits.timeExitPolicy === 'breakeven_then_close' &&
    !pos.breakevenArmed &&
    heldMs >= s.exits.breakevenAfterMinutes * 60_000
  ) {
    const be = breakevenStopPrice(pos, ctx, heldMs);
    const inProfit = dir === 1 ? tick.bid > be : tick.ask < be;
    if (inProfit) {
      // Only ever tighten the stop.
      const tighter = dir === 1 ? be > pos.stopPrice : be < pos.stopPrice;
      if (tighter) pos.stopPrice = be;
      pos.breakevenArmed = true;
    }
  }

  // 5) Time exit (hard backstop): close at market.
  if (heldMs >= timeExitMs(ctx)) {
    const ref = dir === 1 ? tick.bid : tick.ask;
    const price = roundToTick(ref - dir * slip, spec.tickSize, dir === 1 ? 'down' : 'up');
    return { position: pos, exit: { reason: 'time_exit', price, role: 'taker' }, fundingDelta };
  }

  return { position: pos, exit: null, fundingDelta };
}

/** Manually/forcibly close at the current market (kill switch, mode switch, operator). */
export function marketExit(pos: OpenPosition, tick: Tick, reason: ExitReason, ctx: PaperContext): ExitDecision {
  const dir = pos.side === 'long' ? 1 : -1;
  const ref = dir === 1 ? tick.bid : tick.ask;
  return { reason, price: roundToTick(ref - dir * ctx.settings.execution.simSlippageUsd, ctx.spec.tickSize, dir === 1 ? 'down' : 'up'), role: 'taker' };
}

/** Finalise a closed trade with the fee engine. */
export function closePosition(pos: OpenPosition, exit: ExitDecision, exitTs: number, ctx: PaperContext): ClosedTrade {
  const holdMs = exitTs - pos.entryTs;
  const exitLeg = calcFee(
    { price: exit.price, contracts: pos.contracts, contractValue: pos.contractValue, role: exit.role, isExit: true, holdMs },
    ctx.fees,
  );
  const pnl = calcPnl(
    {
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice: exit.price,
      contracts: pos.contracts,
      contractValue: pos.contractValue,
      entryRole: 'taker',
      exitRole: exit.role,
      holdMs,
      funding: pos.fundingAccrued,
      slippageCost: pos.entrySlippageCost,
      actualEntryFee: pos.entryFee.total,
    },
    ctx.fees,
  );
  return {
    id: pos.id,
    mode: pos.mode,
    side: pos.side,
    contracts: pos.contracts,
    qtyEth: pos.qtyEth,
    leverage: pos.leverage,
    entryTs: pos.entryTs,
    exitTs,
    entryPrice: pos.entryPrice,
    exitPrice: exit.price,
    exitReason: exit.reason,
    stopPrice: pos.initialStopPrice,
    targetPrice: pos.targetPrice,
    grossPnl: pnl.grossPnl,
    entryFee: pnl.entryFee,
    exitFee: pnl.exitFee,
    exitFeeSaved: round(exitLeg.saved ?? 0, 8),
    fees: pnl.fees,
    slippageCost: pnl.slippageCost,
    funding: pnl.funding,
    netPnl: pnl.netPnl,
    netPnlInr: pnl.netPnlInr,
    holdMs,
    mfe: round(pos.mfe, 6),
    mae: round(pos.mae, 6),
    reachedTarget: pos.reachedTargetAtMs !== null,
    regime: pos.regime,
    reasons: pos.reasons,
  };
}

/** Apply a closed trade to the account (entry fee was already deducted by applyOpen). */
export function applyClose<A extends DemoAccountState>(account: A, trade: ClosedTrade, now: number): A {
  const delta = trade.grossPnl - trade.exitFee + trade.funding;
  const balance = round(account.balanceUsd + delta, 8);
  const peak = Math.max(account.peakEquityUsd, balance);
  const dd = peak > 0 ? ((peak - balance) / peak) * 100 : 0;
  return {
    ...account,
    balanceUsd: balance,
    peakEquityUsd: round(peak, 8),
    maxDrawdownPct: round(Math.max(account.maxDrawdownPct, dd), 6),
    totalFeesUsd: round(account.totalFeesUsd + trade.exitFee, 8),
    openPosition: null,
    updatedAt: now,
  };
}

export { estimateEconomics };
