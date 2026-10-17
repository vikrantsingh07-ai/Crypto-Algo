import type { Candle, Quote } from '@cryptoalgo/core';

/** Domain-level (already number-typed, ms-timestamped) representations of exchange objects. */

export type OrderSide = 'buy' | 'sell';
export type OrderState = 'open' | 'pending' | 'closed' | 'cancelled';

export interface ExchangeOrder {
  id: number;
  clientOrderId: string | null;
  productId: number;
  symbol: string;
  side: OrderSide;
  orderType: 'limit_order' | 'market_order' | string;
  state: OrderState | string;
  size: number;
  unfilledSize: number;
  filledSize: number;
  limitPrice: number | null;
  stopPrice: number | null;
  stopOrderType: string | null;
  avgFillPrice: number | null;
  reduceOnly: boolean;
  timeInForce: string | null;
  paidCommission: number;
  cancellationReason: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface ExchangePosition {
  productId: number;
  symbol: string;
  /** Signed contracts: >0 long, <0 short, 0 flat. */
  size: number;
  entryPrice: number | null;
  liquidationPrice: number | null;
  bankruptcyPrice: number | null;
  margin: number;
  markPrice: number | null;
  unrealizedPnl: number | null;
  realizedPnl: number;
  realizedFunding: number;
  commission: number;
  updatedAt: number | null;
}

export interface ExchangeFill {
  id: string;
  orderId: string;
  productId: number;
  symbol: string;
  side: OrderSide;
  size: number;
  price: number;
  role: 'maker' | 'taker' | string;
  /** Commission charged in the settling asset (authoritative fee). */
  commission: number;
  fillType: string;
  createdAt: number | null;
  settlingAsset: string | null;
}

export interface WalletBalance {
  assetId: number;
  assetSymbol: string;
  balance: number;
  availableBalance: number;
  blockedMargin: number;
  orderMargin: number;
  positionMargin: number;
}

export interface TickerSnapshot {
  symbol: string;
  productId: number | null;
  quote: Quote | null;
  mark: number | null;
  spot: number | null;
  /** Percent or fraction depending on exchange; null when not provided by REST (WS channel provides it). */
  volume24h: number | null;
  timestamp: number;
}

export interface OrderbookSnapshot {
  symbol: string;
  bids: { price: number; size: number }[];
  asks: { price: number; size: number }[];
  updatedAt: number | null;
}

export interface PlaceOrderRequest {
  product_id: number;
  side: OrderSide;
  size: number;
  order_type: 'limit_order' | 'market_order';
  limit_price?: string;
  stop_order_type?: 'stop_loss_order' | 'take_profit_order';
  stop_price?: string;
  stop_trigger_method?: 'mark_price' | 'last_traded_price' | 'spot_price';
  time_in_force?: 'gtc' | 'ioc';
  post_only?: boolean;
  reduce_only?: boolean;
  client_order_id?: string;
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

/** Common interface so the bot can run on the Delta feed or an explicitly-labelled synthetic feed. */
export interface MarketFeed {
  start(): Promise<void>;
  stop(): void;
  getQuote(): Quote | null;
  /** Closed candles only, oldest first. */
  getClosedCandles(): Candle[];
  getFormingCandle(): Candle | null;
  getFundingRate(): number | null;
  health(): FeedHealth;
  /** Virtual clock (synthetic dev feed only). Real feeds use Date.now(). */
  now?(): number;
  /** true when the data is NOT real market data. */
  readonly synthetic?: boolean;
  on(event: 'quote', cb: (q: Quote) => void): this;
  on(event: 'candleClosed', cb: (c: Candle) => void): this;
  on(event: 'health', cb: (h: FeedHealth) => void): this;
  off(event: string, cb: (...args: any[]) => void): this;
}
