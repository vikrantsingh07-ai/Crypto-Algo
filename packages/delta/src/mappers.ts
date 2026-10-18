import type { Candle, ContractSpec, Quote } from '@cryptoalgo/core';
import { fallbackContractSpec } from '@cryptoalgo/core';
import type { ExchangeFill, ExchangeOrder, ExchangePosition, OrderbookSnapshot, TickerSnapshot, WalletBalance } from './types';

const num = (v: unknown, dflt = 0): number => {
  if (v === null || v === undefined || v === '') return dflt;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : dflt;
};
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Delta timestamps appear as epoch seconds / ms / µs (number or string) or ISO-8601 strings. */
export function parseTime(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string' && /[-T:]/.test(v)) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 1e14) return Math.floor(n / 1000); // microseconds
  if (n > 1e11) return Math.floor(n); // milliseconds
  return Math.floor(n * 1000); // seconds
}

/** `GET /v2/products/{symbol}` -> ContractSpec. Returns verified=true because it came from the exchange. */
export function mapProduct(p: any, now = Date.now()): ContractSpec {
  const fb = fallbackContractSpec(p?.symbol ?? 'ETHUSD');
  const initialMarginPct = num(p?.initial_margin, fb.initialMarginPct);
  const maxFromMargin = initialMarginPct > 0 ? Math.floor(100 / initialMarginPct) : fb.maxLeverage;
  return {
    symbol: String(p.symbol),
    productId: numOrNull(p.id),
    contractValue: num(p.contract_value, fb.contractValue),
    tickSize: num(p.tick_size, fb.tickSize),
    makerFeeRate: num(p.maker_commission_rate, fb.makerFeeRate),
    takerFeeRate: num(p.taker_commission_rate, fb.takerFeeRate),
    maxLeverage: maxFromMargin,
    initialMarginPct,
    maintenanceMarginPct: num(p.maintenance_margin, fb.maintenanceMarginPct),
    positionSizeLimit: numOrNull(p.position_size_limit),
    settlingAsset: String(p.settling_asset?.symbol ?? fb.settlingAsset),
    quotingAsset: String(p.quoting_asset?.symbol ?? fb.quotingAsset),
    underlyingAsset: String(p.contract_unit_currency ?? p.underlying_asset?.symbol ?? fb.underlyingAsset),
    notionalType: String(p.notional_type ?? 'vanilla'),
    contractType: String(p.contract_type ?? 'perpetual_futures'),
    tradingStatus: String(p.trading_status ?? 'unknown'),
    fundingIntervalSec: fb.fundingIntervalSec,
    verified: true,
    fetchedAt: now,
  };
}

export function mapTicker(t: any, now = Date.now()): TickerSnapshot {
  const bid = numOrNull(t?.quotes?.best_bid);
  const ask = numOrNull(t?.quotes?.best_ask);
  const last = numOrNull(t?.close) ?? numOrNull(t?.last_price);
  const mark = numOrNull(t?.mark_price);
  let quote: Quote | null = null;
  if (bid !== null && ask !== null && bid > 0 && ask > 0) {
    quote = {
      ts: parseTime(t?.timestamp) ?? now,
      bid,
      ask,
      last: last ?? (bid + ask) / 2,
      mark: mark ?? undefined,
      bidSize: numOrNull(t?.quotes?.bid_size) ?? undefined,
      askSize: numOrNull(t?.quotes?.ask_size) ?? undefined,
    };
  }
  return {
    symbol: String(t?.symbol ?? ''),
    productId: numOrNull(t?.product_id),
    quote,
    mark,
    spot: numOrNull(t?.spot_price),
    volume24h: numOrNull(t?.volume),
    timestamp: now,
  };
}

export function mapOrderbook(o: any): OrderbookSnapshot {
  const side = (arr: any[]) => (Array.isArray(arr) ? arr.map((l) => ({ price: num(l.price), size: num(l.size) })) : []);
  return { symbol: String(o?.symbol ?? ''), bids: side(o?.buy), asks: side(o?.sell), updatedAt: parseTime(o?.last_updated_at) };
}

/** Candle rows from `/v2/history/candles` (`time` in epoch seconds). Sorted ascending and de-duplicated. */
export function mapCandles(rows: any[]): Candle[] {
  const byT = new Map<number, Candle>();
  for (const r of rows ?? []) {
    const t = Number(r.time) * 1000;
    if (!Number.isFinite(t)) continue;
    byT.set(t, { t, o: num(r.open), h: num(r.high), l: num(r.low), c: num(r.close), v: num(r.volume) });
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

export function mapOrder(o: any): ExchangeOrder {
  const size = num(o.size);
  const unfilled = num(o.unfilled_size, size);
  return {
    id: num(o.id),
    clientOrderId: o.client_order_id ?? null,
    productId: num(o.product_id),
    symbol: String(o.product_symbol ?? ''),
    side: o.side,
    orderType: o.order_type,
    state: o.state,
    size,
    unfilledSize: unfilled,
    filledSize: Math.max(0, size - unfilled),
    limitPrice: numOrNull(o.limit_price),
    stopPrice: numOrNull(o.stop_price),
    stopOrderType: o.stop_order_type ?? null,
    avgFillPrice: numOrNull(o.average_fill_price),
    reduceOnly: o.reduce_only === true || o.reduce_only === 'true',
    timeInForce: o.time_in_force ?? null,
    paidCommission: num(o.paid_commission),
    cancellationReason: o.cancellation_reason ?? null,
    createdAt: parseTime(o.created_at),
    updatedAt: parseTime(o.updated_at),
  };
}

export function mapPosition(p: any): ExchangePosition {
  return {
    productId: num(p.product_id),
    symbol: String(p.product_symbol ?? p.symbol ?? ''),
    size: num(p.size),
    entryPrice: numOrNull(p.entry_price),
    liquidationPrice: numOrNull(p.liquidation_price),
    bankruptcyPrice: numOrNull(p.bankruptcy_price),
    margin: num(p.margin),
    markPrice: numOrNull(p.mark_price),
    unrealizedPnl: numOrNull(p.unrealized_pnl),
    realizedPnl: num(p.realized_pnl),
    realizedFunding: num(p.realized_funding),
    commission: num(p.commission),
    updatedAt: parseTime(p.updated_at),
  };
}

/** A commission figure counts as known only when the payload carries a finite number (a blank is not "0"). */
function commissionOf(f: any): { value: number; known: boolean } {
  const raw = f.meta_data?.total_commission_in_settling_asset ?? f.commission;
  const known = raw !== undefined && raw !== null && String(raw).trim() !== '' && Number.isFinite(Number(raw));
  return { value: known ? Number(raw) : 0, known };
}

export function mapFill(f: any): ExchangeFill {
  const commission = commissionOf(f);
  return {
    id: String(f.id),
    orderId: String(f.order_id),
    productId: num(f.product_id),
    symbol: String(f.product_symbol ?? ''),
    side: f.side,
    size: num(f.size),
    price: num(f.price),
    role: f.role,
    commission: commission.value,
    commissionKnown: commission.known,
    fillType: String(f.fill_type ?? 'normal'),
    createdAt: parseTime(f.created_at),
    settlingAsset: f.settling_asset_symbol ?? null,
  };
}

export function mapBalance(w: any): WalletBalance {
  return {
    assetId: num(w.asset_id),
    assetSymbol: String(w.asset_symbol ?? ''),
    balance: num(w.balance),
    availableBalance: num(w.available_balance),
    blockedMargin: num(w.blocked_margin),
    orderMargin: num(w.order_margin),
    positionMargin: num(w.position_margin),
  };
}
