import type { ContractSpec, FeeBreakdown, PnlResult, Role, Side } from './types';
import type { Settings } from './settings';
import { round } from './math';

/**
 * Fee model for Delta Exchange linear perpetuals.
 *
 *   commission = notional * rate           (notional = contracts * contractValue * price)
 *   gst        = commission * gstRate       (Indian platforms levy GST on trading fees)
 *   total fee  = commission + gst
 *
 * `rate` is the product's `maker_commission_rate` / `taker_commission_rate` published by the
 * exchange (read from `GET /v2/products/{symbol}`); Settings may override it. The actual
 * commission charged is always returned on each fill by the exchange; in LIVE mode the fill's
 * `commission` is authoritative and this module is only used for estimates.
 *
 * Exit-fee waivers are NOT assumed. They only apply when explicitly enabled in settings.
 */
export interface FeeConfig {
  makerRate: number;
  takerRate: number;
  gstRate: number;
  waiver: { enabled: boolean; withinMinutes: number };
  usdInrRate: number;
}

export function feeConfigFrom(settings: Settings, spec: ContractSpec): FeeConfig {
  return {
    makerRate: settings.execution.makerFeeRate ?? spec.makerFeeRate,
    takerRate: settings.execution.takerFeeRate ?? spec.takerFeeRate,
    gstRate: settings.execution.gstRate,
    waiver: { ...settings.execution.exitFeeWaiver },
    usdInrRate: settings.execution.usdInrRate,
  };
}

export interface FeeInput {
  price: number;
  contracts: number;
  contractValue: number;
  role: Role;
  /** Set for exit legs so the optional waiver can be evaluated. */
  isExit?: boolean;
  holdMs?: number;
}

export function notionalOf(price: number, contracts: number, contractValue: number): number {
  return price * contracts * contractValue;
}

export function calcFee(input: FeeInput, cfg: FeeConfig): FeeBreakdown {
  const notional = notionalOf(input.price, input.contracts, input.contractValue);
  const rate = input.role === 'maker' ? cfg.makerRate : cfg.takerRate;
  const waived =
    !!input.isExit &&
    cfg.waiver.enabled &&
    input.holdMs !== undefined &&
    input.holdMs <= cfg.waiver.withinMinutes * 60_000;
  const commission = waived ? 0 : notional * rate;
  const gst = commission * cfg.gstRate;
  return {
    notional: round(notional, 8),
    commission: round(commission, 8),
    gst: round(gst, 8),
    total: round(commission + gst, 8),
    rate,
    role: input.role,
    waived,
  };
}

export function grossPnl(side: Side, entryPrice: number, exitPrice: number, contracts: number, contractValue: number): number {
  const qty = contracts * contractValue;
  return (side === 'long' ? exitPrice - entryPrice : entryPrice - exitPrice) * qty;
}

export interface PnlInput {
  side: Side;
  entryPrice: number;
  exitPrice: number;
  contracts: number;
  contractValue: number;
  entryRole: Role;
  exitRole: Role;
  holdMs: number;
  /** Signed funding cashflow already settled for the position (negative = paid). */
  funding?: number;
  /** Memo: slippage already embedded in the fill prices, in USD. */
  slippageCost?: number;
  /** Override with exchange-reported fees (LIVE). */
  actualEntryFee?: number;
  actualExitFee?: number;
}

/**
 * Compute net P&L. Slippage and spread are already inside the fill prices (we fill at bid/ask +
 * slippage), so `slippageCost` is reported as a memo and is NOT subtracted a second time.
 */
export function calcPnl(input: PnlInput, cfg: FeeConfig): PnlResult {
  const gross = grossPnl(input.side, input.entryPrice, input.exitPrice, input.contracts, input.contractValue);
  const entryFee =
    input.actualEntryFee ??
    calcFee({ price: input.entryPrice, contracts: input.contracts, contractValue: input.contractValue, role: input.entryRole }, cfg).total;
  const exitFee =
    input.actualExitFee ??
    calcFee(
      {
        price: input.exitPrice,
        contracts: input.contracts,
        contractValue: input.contractValue,
        role: input.exitRole,
        isExit: true,
        holdMs: input.holdMs,
      },
      cfg,
    ).total;
  const funding = input.funding ?? 0;
  const net = gross - entryFee - exitFee + funding;
  return {
    grossPnl: round(gross, 8),
    entryFee: round(entryFee, 8),
    exitFee: round(exitFee, 8),
    fees: round(entryFee + exitFee, 8),
    funding: round(funding, 8),
    slippageCost: round(input.slippageCost ?? 0, 8),
    netPnl: round(net, 8),
    netPnlInr: round(net * cfg.usdInrRate, 4),
  };
}

export interface TradeEconomics {
  qtyEth: number;
  rewardGross: number;
  rewardNet: number;
  riskGross: number;
  riskNet: number;
  feeIfTarget: number;
  feeIfStop: number;
  /** Price move (USD per ETH) needed just to cover fees, with the given entry/exit roles. */
  breakevenMoveUsd: number;
  netRewardRisk: number;
}

export interface EconomicsInput {
  side: Side;
  entryPrice: number;
  targetPrice: number;
  stopPrice: number;
  contracts: number;
  contractValue: number;
  /** Role of the entry fill (market/IOC entries are takers). */
  entryRole?: Role;
  /** Role of the take-profit fill (resting limit => maker). */
  targetRole?: Role;
  /** Stops are triggered market orders => taker. */
  stopRole?: Role;
  /** Slippage assumed on the stop fill, USD per ETH (adverse). */
  stopSlippageUsd?: number;
}

/** Pre-trade expected economics, used by the risk manager and shown in the UI. */
export function estimateEconomics(i: EconomicsInput, cfg: FeeConfig): TradeEconomics {
  const entryRole = i.entryRole ?? 'taker';
  const targetRole = i.targetRole ?? 'maker';
  const stopRole = i.stopRole ?? 'taker';
  const qty = i.contracts * i.contractValue;
  const dir = i.side === 'long' ? 1 : -1;
  const stopFillPrice = i.stopPrice - dir * (i.stopSlippageUsd ?? 0);

  const entryFee = calcFee({ price: i.entryPrice, contracts: i.contracts, contractValue: i.contractValue, role: entryRole }, cfg).total;
  const targetExitFee = calcFee({ price: i.targetPrice, contracts: i.contracts, contractValue: i.contractValue, role: targetRole }, cfg).total;
  const stopExitFee = calcFee({ price: stopFillPrice, contracts: i.contracts, contractValue: i.contractValue, role: stopRole }, cfg).total;

  const rewardGross = dir * (i.targetPrice - i.entryPrice) * qty;
  const riskGross = dir * (i.entryPrice - stopFillPrice) * qty;
  const feeIfTarget = entryFee + targetExitFee;
  const feeIfStop = entryFee + stopExitFee;
  const rewardNet = rewardGross - feeIfTarget;
  const riskNet = riskGross + feeIfStop;

  // Break-even move m solving  m*qty = entryFee + exitRate' * qty * (p + dir*m), exitRate' = rate*(1+gst)
  const exitRate = (targetRole === 'maker' ? cfg.makerRate : cfg.takerRate) * (1 + cfg.gstRate);
  const breakevenMoveUsd = (entryFee + exitRate * qty * i.entryPrice) / (qty * (1 - dir * exitRate));

  return {
    qtyEth: qty,
    rewardGross: round(rewardGross, 8),
    rewardNet: round(rewardNet, 8),
    riskGross: round(riskGross, 8),
    riskNet: round(riskNet, 8),
    feeIfTarget: round(feeIfTarget, 8),
    feeIfStop: round(feeIfStop, 8),
    breakevenMoveUsd: round(breakevenMoveUsd, 6),
    netRewardRisk: riskNet > 0 ? round(rewardNet / riskNet, 6) : 0,
  };
}

/** Required win-rate for break-even given net reward and net risk of a single trade. */
export function breakevenWinRate(rewardNet: number, riskNet: number): number {
  if (rewardNet <= 0) return 1;
  return riskNet / (riskNet + rewardNet);
}
