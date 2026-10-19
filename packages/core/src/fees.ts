import type { ContractSpec, FeeBreakdown, PnlResult, Role, Side } from './types';
import type { Settings } from './settings';
import { round } from './math';

/**
 * Fee model for Delta Exchange linear perpetuals.
 *
 *   commission = notional * rate           (notional = contracts * contractValue * price)
 *   gst        = commission * gstRate       (Indian platforms levy GST on trading fees)
 *   tax        = notional * otherTaxRate  (0 unless configured)
 *   total fee  = commission + gst + tax
 *
 * `rate` is the product's `maker_commission_rate` / `taker_commission_rate` published by the
 * exchange (read from `GET /v2/products/{symbol}`); Settings may override it. The actual
 * commission charged is always returned on each fill by the exchange; in LIVE mode the fill's
 * `commission` is authoritative and this module is only used for estimates.
 *
 * Brokerage is paid on BOTH legs. Delta's "Scalper Offer" (an exit leg of a position open for at most
 * `waiver.withinMinutes` pays no commission/GST) is dormant: it applies only when
 * `settings.execution.exitFeeWaiver.enabled` is switched on, which is off by default. In LIVE the
 * exchange-reported fee is authoritative.
 */
export interface FeeConfig {
  makerRate: number;
  takerRate: number;
  gstRate: number;
  otherTaxRate: number;
  waiver: { enabled: boolean; withinMinutes: number };
  usdInrRate: number;
}

export interface FeeConfigOptions {
  /**
   * Overrides `settings.execution.exitFeeWaiver.enabled`. Used by the live engine to fall back to
   * "no waiver" when the exchange has been observed charging a closing fee on an eligible trade.
   */
  waiverOverride?: boolean;
}

export function feeConfigFrom(settings: Settings, spec: ContractSpec, opts: FeeConfigOptions = {}): FeeConfig {
  const w = settings.execution.exitFeeWaiver;
  return {
    makerRate: settings.execution.makerFeeRate ?? spec.makerFeeRate,
    takerRate: settings.execution.takerFeeRate ?? spec.takerFeeRate,
    gstRate: settings.execution.gstRate,
    otherTaxRate: settings.execution.otherTaxRate ?? 0,
    waiver: { enabled: opts.waiverOverride ?? w.enabled, withinMinutes: w.withinMinutes },
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
  /** Liquidations are not eligible for the Scalper Offer: the closing fee is always charged. */
  liquidation?: boolean;
}

export function notionalOf(price: number, contracts: number, contractValue: number): number {
  return price * contracts * contractValue;
}

export function calcFee(input: FeeInput, cfg: FeeConfig): FeeBreakdown {
  const notional = notionalOf(input.price, input.contracts, input.contractValue);
  const rate = input.role === 'maker' ? cfg.makerRate : cfg.takerRate;
  const waived =
    !!input.isExit &&
    !input.liquidation &&
    cfg.waiver.enabled &&
    input.holdMs !== undefined &&
    input.holdMs <= cfg.waiver.withinMinutes * 60_000;
  const fullCommission = notional * rate;
  const commission = waived ? 0 : fullCommission;
  const gst = commission * cfg.gstRate;
  // The offer waives the exchange's closing fee (commission + its GST). Any extra transaction tax the operator
  // configured is a separate levy and is never assumed to be waived.
  const tax = notional * (cfg.otherTaxRate ?? 0);
  const fullTotal = fullCommission * (1 + cfg.gstRate);
  return {
    notional: round(notional, 8),
    commission: round(commission, 8),
    gst: round(gst, 8),
    tax: round(tax, 8),
    total: round(commission + gst + tax, 8),
    rate,
    role: input.role,
    waived,
    saved: round(waived ? fullTotal : 0, 8),
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
  /** The exit was a liquidation (never eligible for the Scalper Offer). */
  liquidation?: boolean;
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
        liquidation: input.liquidation,
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
  /** Opening-leg fee (always charged). */
  entryFee: number;
  /** True when the exit legs are assumed fee-free (Scalper Offer, exit inside the window). */
  exitFeeWaived: boolean;
  /** Closing fee that the waiver saves on a take-profit exit (0 when not waived). */
  exitFeeSaved: number;
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
  /** Expected hold at exit, used to evaluate the Scalper Offer window (default 0 = inside the window). */
  exitHoldMs?: number;
}

/** Pre-trade expected economics, used by the risk manager and shown in the UI. */
export function estimateEconomics(i: EconomicsInput, cfg: FeeConfig): TradeEconomics {
  const entryRole = i.entryRole ?? 'taker';
  const targetRole = i.targetRole ?? 'maker';
  const stopRole = i.stopRole ?? 'taker';
  const qty = i.contracts * i.contractValue;
  const dir = i.side === 'long' ? 1 : -1;
  const stopFillPrice = i.stopPrice - dir * (i.stopSlippageUsd ?? 0);

  // Only matters while the dormant waiver is enabled: the exit is then modelled as happening inside the offer window
  // (hold = 0) unless the caller says otherwise. With the waiver off both legs are always charged.
  const exitHoldMs = i.exitHoldMs ?? 0;
  const entryFee = calcFee({ price: i.entryPrice, contracts: i.contracts, contractValue: i.contractValue, role: entryRole }, cfg).total;
  const targetExit = calcFee({ price: i.targetPrice, contracts: i.contracts, contractValue: i.contractValue, role: targetRole, isExit: true, holdMs: exitHoldMs }, cfg);
  const stopExit = calcFee({ price: stopFillPrice, contracts: i.contracts, contractValue: i.contractValue, role: stopRole, isExit: true, holdMs: exitHoldMs }, cfg);
  const targetExitFee = targetExit.total;
  const stopExitFee = stopExit.total;
  const exitFeeWaived = targetExit.waived;

  const rewardGross = dir * (i.targetPrice - i.entryPrice) * qty;
  const riskGross = dir * (i.entryPrice - stopFillPrice) * qty;
  const feeIfTarget = entryFee + targetExitFee;
  const feeIfStop = entryFee + stopExitFee;
  const rewardNet = rewardGross - feeIfTarget;
  const riskNet = riskGross + feeIfStop;

  // Break-even move m solving  m*qty = entryFee + exitRate' * qty * (p + dir*m), exitRate' = rate*(1+gst)
  const exitRate = exitFeeWaived ? 0 : (targetRole === 'maker' ? cfg.makerRate : cfg.takerRate) * (1 + cfg.gstRate) + (cfg.otherTaxRate ?? 0);
  const breakevenMoveUsd = (entryFee + exitRate * qty * i.entryPrice) / (qty * (1 - dir * exitRate));

  return {
    qtyEth: qty,
    rewardGross: round(rewardGross, 8),
    rewardNet: round(rewardNet, 8),
    riskGross: round(riskGross, 8),
    riskNet: round(riskNet, 8),
    feeIfTarget: round(feeIfTarget, 8),
    feeIfStop: round(feeIfStop, 8),
    entryFee: round(entryFee, 8),
    exitFeeWaived,
    exitFeeSaved: round(targetExit.saved ?? 0, 8),
    breakevenMoveUsd: round(breakevenMoveUsd, 6),
    netRewardRisk: riskNet > 0 ? round(rewardNet / riskNet, 6) : 0,
  };
}

/** Required win-rate for break-even given net reward and net risk of a single trade. */
export function breakevenWinRate(rewardNet: number, riskNet: number): number {
  if (rewardNet <= 0) return 1;
  return riskNet / (riskNet + rewardNet);
}

export interface RoundTripFeeInput {
  /** Price both legs are evaluated at (the exit price differs from the entry by a few dollars, which moves the fee by cents). */
  price: number;
  contracts: number;
  contractValue: number;
  cfg: FeeConfig;
  /** Default taker (market / IOC entry). */
  entryRole?: Role;
  /** Default taker (a stop is a triggered market order). Pass 'maker' for a resting take-profit limit. */
  exitRole?: Role;
}

export interface RoundTripFee {
  /** Entry-leg brokerage including GST (and any configured extra tax), USD. */
  entry: number;
  /** Exit-leg brokerage including GST, USD. */
  exit: number;
  total: number;
  /** One leg's notional at `price`, USD. */
  notional: number;
}

/**
 * Brokerage for one full round trip (entry + exit). Both legs are charged: the exit-fee waiver is never applied here,
 * so this is the figure to show as "fees" in a plain-language summary. At ETH 3,390 and 0.20 ETH taker/taker it is
 * about 0.80 USD including 18% GST; the number follows the fee rates in `cfg`, nothing is hard-coded.
 */
export function roundTripFee(i: RoundTripFeeInput): RoundTripFee {
  const leg = (role: Role) => calcFee({ price: i.price, contracts: i.contracts, contractValue: i.contractValue, role }, i.cfg);
  const entry = leg(i.entryRole ?? 'taker');
  const exit = leg(i.exitRole ?? 'taker');
  return {
    entry: entry.total,
    exit: exit.total,
    total: round(entry.total + exit.total, 8),
    notional: entry.notional,
  };
}

export interface DailyOutlookInput {
  /** Number of trades in the scenario. */
  trades: number;
  /** Fraction of those trades that win, 0..1. */
  winRate: number;
  /** Net gain of a winning trade after fees, USD (positive). */
  winNetUsd: number;
  /** Net loss of a losing trade after fees, USD, as a positive magnitude. */
  lossNetUsd: number;
  usdInrRate: number;
}

export interface DailyOutlook {
  expectedNetUsd: number;
  expectedNetInr: number;
}

/**
 * What a day of `trades` trades would net under an ASSUMED win rate. This is arithmetic on the inputs, not a forecast:
 * the win rate is whatever the caller supplies and nothing here says it can be reached.
 */
export function dailyOutlook(i: DailyOutlookInput): DailyOutlook {
  const trades = Math.max(0, i.trades);
  const p = Math.min(1, Math.max(0, i.winRate));
  const perTrade = p * Math.abs(i.winNetUsd) - (1 - p) * Math.abs(i.lossNetUsd);
  const usd = trades * perTrade;
  return { expectedNetUsd: round(usd, 6), expectedNetInr: round(usd * i.usdInrRate, 2) };
}

export interface RequiredWinRateInput {
  /** Net gain of a winning trade after fees, USD (positive). */
  winNetUsd: number;
  /** Net loss of a losing trade after fees, USD, as a positive magnitude. */
  lossNetUsd: number;
  /** Average net result wanted per trade, USD. Omit for the break-even win rate (0). */
  targetNetPerTradeUsd?: number;
}

/**
 * Win rate at which the average trade nets `targetNetPerTradeUsd`:  p * win - (1 - p) * loss = target
 * =>  p = (target + loss) / (win + loss). Omitting the target gives the break-even rate. A result above 1 means the
 * target cannot be reached at any win rate with these win and loss sizes; it is returned as is, not clamped.
 */
export function requiredWinRate(i: RequiredWinRateInput): number {
  const win = Math.abs(i.winNetUsd);
  const loss = Math.abs(i.lossNetUsd);
  const target = i.targetNetPerTradeUsd ?? 0;
  if (win + loss <= 0) return Infinity;
  return Math.max(0, (target + loss) / (win + loss));
}
