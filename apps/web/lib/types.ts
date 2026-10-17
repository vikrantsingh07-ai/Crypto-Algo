import type { ContractSpec, Evaluation, OpenPosition, Settings } from '@cryptoalgo/core';

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
export interface Economics {
  referencePrice: number;
  contracts: number;
  stopUsd: number;
  makerTarget: EconRow[];
  takerTarget: EconRow[];
  breakevenMoveMakerExitUsd: number;
  breakevenMoveTakerExitUsd: number;
  rates: { maker: number; taker: number; gst: number };
  verifiedSpec: boolean;
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
  netPnl: number | null;
  netPnlInr: number | null;
  holdMs: number | null;
  regime: string | null;
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
