import type { Candle, ContractSpec } from '@cryptoalgo/core';
import { DeltaApiError } from './errors';
import { DeltaHttp, type RequestOptions } from './http';
import { mapBalance, mapCandles, mapFill, mapOrder, mapOrderbook, mapPosition, mapProduct, mapTicker } from './mappers';
import type {
  ExchangeFill,
  ExchangeOrder,
  ExchangePosition,
  OrderbookSnapshot,
  PlaceOrderRequest,
  TickerSnapshot,
  WalletBalance,
} from './types';
import type { Priority } from './rateLimit';

export const CANDLE_RESOLUTION_SEC: Record<string, number> = {
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '1d': 86400,
};
/** Delta returns at most 2000 candles per request. */
export const MAX_CANDLES_PER_REQUEST = 2000;

/**
 * Typed Delta Exchange REST client. Endpoint paths and field names follow the official docs.
 * All state-changing calls are single-shot (never auto-retried after an ambiguous failure); callers
 * resolve ambiguity by looking the order up via client_order_id.
 */
export class DeltaClient {
  constructor(public readonly http: DeltaHttp) {}

  // ---------- public market data ----------
  async getProduct(symbol: string): Promise<ContractSpec> {
    const { result } = await this.http.get<any>(`/v2/products/${encodeURIComponent(symbol)}`);
    return mapProduct(result);
  }

  async getTicker(symbol: string): Promise<TickerSnapshot> {
    const { result } = await this.http.get<any>(`/v2/tickers/${encodeURIComponent(symbol)}`);
    return mapTicker(result);
  }

  async getOrderbook(symbol: string, depth = 10): Promise<OrderbookSnapshot> {
    const { result } = await this.http.get<any>(`/v2/l2orderbook/${encodeURIComponent(symbol)}`, { query: { depth } });
    return mapOrderbook(result);
  }

  /** Single request: up to 2000 candles in [startSec, endSec]. */
  async getCandles(symbol: string, resolution: string, startSec: number, endSec: number): Promise<Candle[]> {
    const { result } = await this.http.get<any[]>('/v2/history/candles', {
      query: { resolution, symbol, start: Math.floor(startSec), end: Math.floor(endSec) },
    });
    return mapCandles(result);
  }

  /** Pages through history in <=2000-candle windows. */
  async getCandlesRange(symbol: string, resolution: string, startSec: number, endSec: number, onProgress?: (done: number, total: number) => void): Promise<Candle[]> {
    const step = CANDLE_RESOLUTION_SEC[resolution];
    if (!step) throw new Error(`Unsupported resolution ${resolution}`);
    const span = step * (MAX_CANDLES_PER_REQUEST - 1);
    const out = new Map<number, Candle>();
    const total = Math.max(1, Math.ceil((endSec - startSec) / span));
    let done = 0;
    for (let s = startSec; s < endSec; s += span + step) {
      const e = Math.min(endSec, s + span);
      const rows = await this.getCandles(symbol, resolution, s, e);
      for (const c of rows) out.set(c.t, c);
      onProgress?.(++done, total);
    }
    return [...out.values()].sort((a, b) => a.t - b.t);
  }

  // ---------- private account data ----------
  private auth(priority: Priority = 'normal', extra: RequestOptions = {}): RequestOptions {
    return { auth: true, priority, ...extra };
  }

  async getBalances(): Promise<WalletBalance[]> {
    const { result } = await this.http.get<any[]>('/v2/wallet/balances', this.auth());
    return (result ?? []).map(mapBalance);
  }

  /** Real-time position for one product. Flat => size 0. */
  async getPosition(productId: number, priority: Priority = 'normal'): Promise<ExchangePosition> {
    const { result } = await this.http.get<any>('/v2/positions', this.auth(priority, { query: { product_id: productId } }));
    if (!result || (Array.isArray(result) && result.length === 0)) {
      return { productId, symbol: '', size: 0, entryPrice: null, liquidationPrice: null, bankruptcyPrice: null, margin: 0, markPrice: null, unrealizedPnl: null, realizedPnl: 0, realizedFunding: 0, commission: 0, updatedAt: null };
    }
    const row = Array.isArray(result) ? result[0] : result;
    return mapPosition({ product_id: productId, ...row });
  }

  /** All open margined positions (note: may lag up to ~10s per docs; use getPosition for real-time). */
  async getMarginedPositions(productIds?: number[]): Promise<ExchangePosition[]> {
    const { result } = await this.http.get<any[]>('/v2/positions/margined', this.auth('normal', { query: productIds ? { product_ids: productIds.join(',') } : undefined }));
    return (result ?? []).map(mapPosition).filter((p) => p.size !== 0);
  }

  async getOpenOrders(productIds?: number[], states = 'open,pending'): Promise<ExchangeOrder[]> {
    const { result } = await this.http.get<any[]>('/v2/orders', this.auth('normal', { query: { product_ids: productIds?.join(','), states, page_size: 100 } }));
    return (result ?? []).map(mapOrder);
  }

  async getOrder(orderId: number | string, priority: Priority = 'normal'): Promise<ExchangeOrder> {
    const { result } = await this.http.get<any>(`/v2/orders/${orderId}`, this.auth(priority));
    return mapOrder(result);
  }

  async getOrderByClientId(clientOrderId: string, priority: Priority = 'normal'): Promise<ExchangeOrder | null> {
    try {
      const { result } = await this.http.get<any>(`/v2/orders/client_order_id/${encodeURIComponent(clientOrderId)}`, this.auth(priority));
      return result ? mapOrder(result) : null;
    } catch (e) {
      if (e instanceof DeltaApiError && (e.status === 404 || e.code === 'order_not_found' || e.code === 'not_found')) return null;
      throw e;
    }
  }

  async getFills(query: { productIds?: number[]; startTimeUs?: number; endTimeUs?: number; pageSize?: number; after?: string } = {}): Promise<{ fills: ExchangeFill[]; after: string | null }> {
    const { result, meta } = await this.http.get<any[]>(
      '/v2/fills',
      this.auth('normal', {
        query: { product_ids: query.productIds?.join(','), start_time: query.startTimeUs, end_time: query.endTimeUs, page_size: query.pageSize ?? 50, after: query.after },
      }),
    );
    return { fills: (result ?? []).map(mapFill), after: (meta?.after as string | null) ?? null };
  }

  async getOrderLeverage(productId: number): Promise<number> {
    const { result } = await this.http.get<any>(`/v2/products/${productId}/orders/leverage`, this.auth());
    return Number(result?.leverage);
  }

  async setOrderLeverage(productId: number, leverage: number): Promise<number> {
    const { result } = await this.http.post<any>(`/v2/products/${productId}/orders/leverage`, { leverage: String(leverage) }, this.auth('critical'));
    return Number(result?.leverage);
  }

  // ---------- trading (state-changing) ----------
  async placeOrder(req: PlaceOrderRequest, priority: Priority = 'normal'): Promise<ExchangeOrder> {
    const { result } = await this.http.post<any>('/v2/orders', req, this.auth(priority, { idempotent: false }));
    return mapOrder(result);
  }

  async cancelOrder(productId: number, orderId: number, priority: Priority = 'critical'): Promise<ExchangeOrder> {
    const { result } = await this.http.delete<any>('/v2/orders', { id: orderId, product_id: productId }, this.auth(priority, { idempotent: false }));
    return mapOrder(result);
  }

}
