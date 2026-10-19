import type { ContractSpec, Evaluation, OpenPosition, Settings } from '@cryptoalgo/core';
import type { MarketCandle } from './market/types';

export interface RiskCheck {
  code: string;
  ok: boolean;
  message: string;
}
export interface RiskSummary {
  tradingAllowed: boolean;
  checks: RiskCheck[];
  blockers: string[];
  tradesLast24h: number;
  realisedPnl24h: number;
}
export interface Decision {
  at: number;
  candleTime: number;
  side: string;
  allowed: boolean;
  reasons: string[];
}
export interface FeedHealth {
  mode: 'ws' | 'rest-fallback' | 'down' | 'synthetic';
  wsState: string;
  lastQuoteAt: number | null;
  lastCandleAt: number | null;
  restOk: boolean;
  lastError: string | null;
  reconnects: number;
}
export interface Quote {
  ts: number;
  bid: number;
  ask: number;
  last: number;
  mark?: number;
}
/**
 * The simulated account's results for the current IST day. Absent on a backend that predates it: the dashboard then
 * works it out from the trade list instead (see lib/simple.ts).
 */
export interface DemoToday {
  /** IST calendar day, "YYYY-MM-DD" */
  day: string;
  trades: number;
  wins: number;
  losses: number;
  netPnlUsd: number;
  netPnlInr: number;
  feesUsd: number;
  /** the daily goal in INR. A goal only; nothing trades towards it */
  goalInr: number;
  /** ceiling of new trades per rolling 24 h */
  tradesLimit: number;
}
export interface DemoSummary {
  startingBalanceUsd: number;
  balanceUsd: number;
  equityUsd: number;
  unrealizedPnlUsd: number;
  peakEquityUsd: number;
  maxDrawdownPct: number;
  totalFeesUsd: number;
  epochStart: number;
  tradesLast24h: number;
  openPosition: OpenPosition | null;
  usdInrRate: number;
  lastDecision: Decision | null;
  risk: RiskSummary;
  /** Absent on an older backend. */
  today?: DemoToday;
}
export interface ExchangeOrder {
  id: number;
  clientOrderId: string | null;
  side: string;
  orderType: string;
  state: string;
  size: number;
  unfilledSize: number;
  limitPrice: number | null;
  stopPrice: number | null;
  stopOrderType: string | null;
  reduceOnly: boolean;
}
export interface ExchangePosition {
  symbol: string;
  size: number;
  entryPrice: number | null;
  liquidationPrice: number | null;
  margin: number;
  markPrice: number | null;
  unrealizedPnl: number | null;
  realizedPnl: number;
}
export interface LiveSummary {
  reconciled: boolean;
  reconcileReason: string | null;
  lastReconcileAt: number | null;
  pending: boolean;
  account: {
    fetchedAt: number | null;
    error: string | null;
    balances: { assetSymbol: string; balance: number; availableBalance: number; blockedMargin: number }[];
    equityUsd: number | null;
    availableUsd: number | null;
    position: ExchangePosition | null;
    openOrders: ExchangeOrder[];
  };
  position: (OpenPosition & { productId: number; stopOrderId: number | null; targetOrderId: number | null }) | null;
  lastDecision: Decision | null;
  peakEquityUsd: number | null;
  baselineEquityUsd: number | null;
  consecutiveLosses: number;
  /** Scalper Offer verification (absent on an older server). */
  scalper?: LiveScalper;
  credentials: { configured: boolean; source: 'environment' | 'database' | null; env: string; fingerprint: string | null; keyHint: string | null; canStoreInDatabase: boolean; updatedAt: string | null };
  risk: RiskSummary;
  clockOffsetMs: number;
  apiLastSuccessAt: number | null;
  apiLastError: { at: number; message: string } | null;
}
export interface EconRow {
  moveUsd: number;
  grossReward: number;
  fees: number;
  netReward: number;
  netRewardRisk: number;
  requiredWinRate: number;
}
/** Delta Scalper Offer (closing-fee waiver): what the bot assumes for estimates, as reported by the server. */
export interface ScalperEconomics {
  /** settings.execution.exitFeeWaiver.enabled */
  assumed: boolean;
  /** Demo / backtest / pre-trade economics use the waiver. */
  effective: boolean;
  /** Live pre-trade economics use the waiver (false once the exchange has shown closing fees being charged). */
  liveEffective: boolean;
  windowMinutes: number;
  safetyMarginSeconds: number;
  /** null = no time limit (the default); an older backend always sends a number */
  effectiveMaxHoldMinutes: number | null;
}
export type ScalperStatus = 'unverified' | 'confirmed' | 'not_applied';
export interface LiveScalperCheck {
  tradeId: string;
  at: number;
  holdMs: number;
  expectedWaived: boolean;
  exitFeeUsd: number;
}
/** The assumption is checked against the exchange-reported commission of eligible live closes. */
export interface LiveScalper {
  assumed: boolean;
  effective: boolean;
  status: ScalperStatus;
  confirmedCount: number;
  lastCheck: LiveScalperCheck | null;
  windowMinutes: number;
  safetyMarginSeconds: number;
  /** null = no time limit */
  effectiveMaxHoldMinutes: number | null;
  note: string;
}
/** Plain-language brokerage figure: taker entry + taker exit at the current price. Absent on an older backend. */
export interface RoundTripFee {
  priceUsd: number;
  qtyEth: number;
  notionalUsd: number;
  entryFeeUsd: number;
  exitFeeUsd: number;
  totalFeeUsd: number;
}
export interface Economics {
  referencePrice: number;
  contracts: number;
  stopUsd: number;
  roundTrip?: RoundTripFee;
  /** Rows use the basis in `scalper` (waiver applied when `scalper.effective`). */
  makerTarget: EconRow[];
  takerTarget: EconRow[];
  /** Same targets with the full closing fee (no waiver). Absent on an older server. */
  makerTargetNoWaiver?: EconRow[];
  takerTargetNoWaiver?: EconRow[];
  breakevenMoveMakerExitUsd: number;
  breakevenMoveTakerExitUsd: number;
  /** Break-even move with a maker exit and the full closing fee. */
  breakevenMoveNoWaiverMakerExitUsd?: number;
  /** Break-even move when only the opening fee is paid. */
  breakevenMoveWaivedUsd?: number;
  scalper?: ScalperEconomics;
  rates: { maker: number; taker: number; gst: number };
  verifiedSpec: boolean;
}
/** Chart seed and fallback quote from the backend. Absent on an older backend (then `spark` seeds the chart). */
export interface MarketSnapshot {
  quote: Quote | null;
  /** closed 1m candles, oldest first (empty in a slim snapshot) */
  candles: MarketCandle[];
  forming?: MarketCandle | null;
}
export interface BotState {
  now: number;
  serverTime: number;
  mode: 'demo' | 'live';
  running: boolean;
  killSwitch: boolean;
  killSwitchAt: number | null;
  liveArmed: boolean;
  liveArmedAt: number | null;
  liveArmedBy: string | null;
  attention: string[];
  workerActive: boolean;
  instanceId: string;
  startedAt: number;
  deployment: { exchange: string; env: string; realMoney: boolean; marketData: 'delta' | 'synthetic'; liveHardDisabled: boolean; restUrl: string };
  feed: { health: FeedHealth; quote: Quote | null; ageMs: number | null; stale: boolean; synthetic: boolean; fundingRate: number | null };
  spec: ContractSpec;
  evaluation: (Evaluation & { at: number }) | null;
  demo: DemoSummary | null;
  live: LiveSummary;
  economics: Economics | null;
  spark: [number, number][];
  market?: MarketSnapshot;
  /** true when the backend left out the bulky chart series (`/api/state?slim=1`) */
  slim?: boolean;
  settings: Settings;
}

export interface TradeRow {
  id: string;
  mode: 'demo' | 'live';
  status: string;
  side: 'long' | 'short';
  contracts: number;
  qtyEth: number;
  leverage: number;
  entryTs: number;
  exitTs: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  exitReason: string | null;
  grossPnl: number | null;
  fees: number | null;
  /** Split of `fees`; absent on rows stored before the Scalper Offer was modelled. */
  entryFee?: number | null;
  exitFee?: number | null;
  /** Closing fee the Scalper Offer saved (assumed in Demo; estimated in Live). */
  exitFeeSaved?: number | null;
  netPnl: number | null;
  netPnlInr: number | null;
  holdMs: number | null;
  regime: string | null;
  meta?: Record<string, any> | null;
}

export interface GroupStats {
  trades: number;
  wins: number;
  winRate: number;
  netPnl: number;
  grossPnl: number;
  fees: number;
  avgNetPnl: number;
}

export interface Metrics {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  winRateCI95: { low: number; high: number };
  grossPnl: number;
  fees: number;
  /** Closing fees the Scalper Offer saved (absent on an older server). */
  feesSavedUsd?: number;
  funding: number;
  slippageCost: number;
  netPnl: number;
  netPnlInr: number;
  profitFactor: number | null;
  avgNetPnl: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  startingBalance: number;
  endingBalance: number;
  avgHoldMinutes: number;
  targetReachedPct: number;
  takeProfitPct: number;
  stopLossPct: number;
  timeExitPct: number;
  breakevenStopPct: number;
  exitReasons: Record<string, number>;
  breakevenWinRate: number | null;
  byRegime: Record<string, GroupStats>;
  bySide: Record<'long' | 'short', GroupStats>;
  smallSample: boolean;
  equityCurve: { ts: number; equity: number }[];
  dailyPnl: { day: string; netPnl: number; fees: number; trades: number }[];
  holdingBuckets: { label: string; count: number }[];
}

export interface Analytics {
  mode: 'demo' | 'live';
  label: string;
  metrics: Metrics;
  drawdown: { ts: number; dd: number }[];
  recent: { id: string; side: string; entryTs: number; exitTs: number; netPnl: number; fees: number; holdMs: number; exitReason: string; regime: string; reachedTarget: boolean }[];
}

export interface Me {
  username: string;
  role: 'admin' | 'viewer';
}
