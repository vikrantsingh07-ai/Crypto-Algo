/**
 * Contract between the live-market layer (apps/web/lib/market, apps/web/components/market) and the dashboard.
 * Public Delta market data only: nothing here ever carries a secret.
 */
export interface BookLevel {
  price: number;
  /** size in ETH (contracts x contract value) */
  size: number;
}

export interface MarketCandle {
  /** candle open time, ms since epoch */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type MarketStatus = 'connecting' | 'live' | 'fallback' | 'down';

export interface MarketState {
  status: MarketStatus;
  symbol: string;
  price: number | null;
  bid: number | null;
  ask: number | null;
  mark: number | null;
  /** % change: 24h when the feed's ticker has delivered it, otherwise over the loaded candle window (see changeLabel) */
  changePct: number | null;
  /** what changePct is measured over: "24h" or a window such as "3h"; absent when changePct is null */
  changeLabel?: string | null;
  /** taker side of the most recent trade */
  lastTradeSide: 'buy' | 'sell' | null;
  /** best first (descending price) */
  bids: BookLevel[];
  /** best first (ascending price) */
  asks: BookLevel[];
  /** closed candles + the forming one last */
  candles: MarketCandle[];
  /** ms epoch of the last message of any kind */
  updatedAt: number;
  source: 'delta-ws' | 'backend' | 'none';
}

export interface PositionLines {
  side: 'long' | 'short';
  entry: number;
  stop: number;
  target: number;
}

export interface UseDeltaMarketOptions {
  symbol?: string; // default ETHUSD
  /** closed candles from the backend snapshot, used until the live feed delivers its own */
  seedCandles?: MarketCandle[];
  /** last backend quote, used while the browser feed is not live (fallback) */
  seedQuote?: { bid: number; ask: number; last: number; ts?: number } | null;
  /** ETH per contract (default 0.01), to convert order-book sizes */
  contractValue?: number;
  /** order-book levels per side to keep (default 10) */
  levels?: number;
  /**
   * override for tests / other environments. Default wss://public-socket.india.delta.exchange: the documented PUBLIC endpoint
   * (wss://socket.india.delta.exchange is the private/legacy one), see PROTOCOL.md
   */
  wsUrl?: string;
  /** set false to disable the browser feed entirely (backend quote only) */
  enabled?: boolean;
}
