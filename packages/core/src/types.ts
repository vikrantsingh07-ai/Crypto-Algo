/**
 * Shared domain types. Everything in @cryptoalgo/core is pure (no I/O) so the same
 * code path runs in backtests, the demo (paper) engine and the live executor.
 */

export type Side = 'long' | 'short';
export type TradingMode = 'demo' | 'live';
export type Role = 'maker' | 'taker';

export type ExitReason =
  | 'take_profit'
  | 'stop_loss'
  | 'breakeven_stop'
  | 'time_exit'
  | 'manual'
  | 'kill_switch'
  | 'mode_switch'
  | 'liquidation'
  | 'reconcile';

export type MarketRegime = 'trend_up' | 'trend_down' | 'range' | 'high_volatility' | 'low_volatility';

/** One OHLCV candle. `t` is the candle OPEN time in epoch milliseconds. */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** Top-of-book snapshot. All prices are in the quoting currency (USD for ETHUSD). */
export interface Quote {
  /** Epoch ms when the quote was observed by us (or exchange timestamp when known). */
  ts: number;
  bid: number;
  ask: number;
  last: number;
  mark?: number;
  bidSize?: number;
  askSize?: number;
}

/**
 * Exchange contract specification. For Delta's linear perpetuals `contractValue` is the
 * amount of the underlying (ETH) represented by ONE contract, and order `size` is an
 * integer number of contracts.
 */
export interface ContractSpec {
  symbol: string;
  productId: number | null;
  /** Underlying units (ETH) per contract. */
  contractValue: number;
  tickSize: number;
  makerFeeRate: number;
  takerFeeRate: number;
  /** Maximum leverage derived from the product's initial margin (100 / initial_margin%). */
  maxLeverage: number;
  initialMarginPct: number;
  maintenanceMarginPct: number;
  positionSizeLimit: number | null;
  settlingAsset: string;
  quotingAsset: string;
  underlyingAsset: string;
  notionalType: 'vanilla' | 'inverse' | string;
  contractType: string;
  tradingStatus: string;
  /** Funding interval in seconds, when known (Delta: 28800). */
  fundingIntervalSec: number;
  /** true only if read from the exchange; false means documented fallback values. */
  verified: boolean;
  fetchedAt: number | null;
}

export type SignalFeatures = Record<string, number | string | boolean>;

export interface Signal {
  side: Side;
  /** Time of the closed candle that produced the signal (candle open time, ms). */
  candleTime: number;
  /** Close of the signal candle. */
  refPrice: number;
  atr: number;
  /** Intended favourable move in USD per ETH (clamped to the configured $ band). */
  targetMoveUsd: number;
  /** Intended adverse move (stop distance) in USD per ETH. */
  stopMoveUsd: number;
  regime: MarketRegime;
  reasons: string[];
  features: SignalFeatures;
}

export interface FeeBreakdown {
  notional: number;
  /** commission = notional * rate (before GST). */
  commission: number;
  gst: number;
  /** commission + gst */
  total: number;
  rate: number;
  role: Role;
  waived: boolean;
}

export interface OpenPosition {
  id: string;
  mode: TradingMode;
  side: Side;
  contracts: number;
  contractValue: number;
  qtyEth: number;
  leverage: number;
  entryTs: number;
  entryPrice: number;
  /** Reference (signal / quote) price before slippage. */
  entryRefPrice: number;
  stopPrice: number;
  targetPrice: number;
  initialStopPrice: number;
  targetMoveUsd: number;
  stopMoveUsd: number;
  entryFee: FeeBreakdown;
  entrySlippageCost: number;
  marginUsed: number;
  liquidationPrice: number;
  fundingAccrued: number;
  /** Maximum favourable / adverse excursion in USD per ETH. */
  mfe: number;
  mae: number;
  reachedTargetAtMs: number | null;
  breakevenArmed: boolean;
  nextFundingTs: number | null;
  regime: MarketRegime;
  reasons: string[];
  signalCandleTime: number;
}

export interface ClosedTrade {
  id: string;
  mode: TradingMode;
  side: Side;
  contracts: number;
  qtyEth: number;
  leverage: number;
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  exitPrice: number;
  exitReason: ExitReason;
  stopPrice: number;
  targetPrice: number;
  grossPnl: number;
  entryFee: number;
  exitFee: number;
  fees: number;
  slippageCost: number;
  funding: number;
  netPnl: number;
  netPnlInr: number;
  holdMs: number;
  mfe: number;
  mae: number;
  /** true if price travelled at least the target distance in our favour while open. */
  reachedTarget: boolean;
  regime: MarketRegime;
  reasons: string[];
}

export interface DemoAccountState {
  startingBalanceUsd: number;
  /** Realised balance (starting + closed-trade net P&L). Excludes unrealised P&L. */
  balanceUsd: number;
  peakEquityUsd: number;
  maxDrawdownPct: number;
  totalFeesUsd: number;
  openPosition: OpenPosition | null;
  updatedAt: number;
}

/** Pure per-trade P&L result. */
export interface PnlResult {
  grossPnl: number;
  entryFee: number;
  exitFee: number;
  fees: number;
  funding: number;
  slippageCost: number;
  netPnl: number;
  netPnlInr: number;
}
