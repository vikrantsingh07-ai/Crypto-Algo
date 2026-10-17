import { roundToTick, type Side } from '@cryptoalgo/core';
import type { PlaceOrderRequest } from './types';

/**
 * Order builders using the exact field names of `POST /v2/orders` (official docs).
 * `size` is an INTEGER number of contracts; prices are strings.
 * client_order_id must be unique across the user's open orders and is limited to 32 characters.
 */

export const MAX_CLIENT_ORDER_ID = 32;

export function clientOrderId(prefix: string, tradeId: string, leg: 'e' | 's' | 't' | 'x' | 'm'): string {
  const id = `${prefix}${tradeId.replace(/[^A-Za-z0-9]/g, '')}${leg}`;
  return id.slice(0, MAX_CLIENT_ORDER_ID);
}

const priceStr = (p: number, tick: number, dir: 'nearest' | 'up' | 'down') => String(roundToTick(p, tick, dir));

/** Opening order: IMMEDIATE-OR-CANCEL limit order priced through the book, i.e. a slippage-capped taker entry. */
export function entryOrder(a: {
  productId: number;
  side: Side;
  contracts: number;
  /** Worst acceptable price (ask + buffer for longs, bid - buffer for shorts). */
  limitPrice: number;
  tickSize: number;
  clientOrderId: string;
}): PlaceOrderRequest {
  return {
    product_id: a.productId,
    side: a.side === 'long' ? 'buy' : 'sell',
    size: a.contracts,
    order_type: 'limit_order',
    limit_price: priceStr(a.limitPrice, a.tickSize, a.side === 'long' ? 'up' : 'down'),
    time_in_force: 'ioc',
    post_only: false,
    reduce_only: false,
    client_order_id: a.clientOrderId,
  };
}

/** Closing sides are the opposite of the position side. */
const closeSide = (s: Side) => (s === 'long' ? 'sell' : 'buy') as 'sell' | 'buy';

/** Reduce-only market order to flatten a position. Never opens or increases exposure. */
export function reduceOnlyMarket(a: { productId: number; positionSide: Side; contracts: number; clientOrderId: string }): PlaceOrderRequest {
  return {
    product_id: a.productId,
    side: closeSide(a.positionSide),
    size: a.contracts,
    order_type: 'market_order',
    reduce_only: true,
    client_order_id: a.clientOrderId,
  };
}

/** Resting reduce-only take-profit limit order (maker). */
export function reduceOnlyLimit(a: { productId: number; positionSide: Side; contracts: number; price: number; tickSize: number; clientOrderId: string }): PlaceOrderRequest {
  return {
    product_id: a.productId,
    side: closeSide(a.positionSide),
    size: a.contracts,
    order_type: 'limit_order',
    limit_price: priceStr(a.price, a.tickSize, a.positionSide === 'long' ? 'up' : 'down'),
    time_in_force: 'gtc',
    post_only: false,
    reduce_only: true,
    client_order_id: a.clientOrderId,
  };
}

/** Exchange-side protective stop: reduce-only stop-market, triggered on mark price (less spoofable than last trade). */
export function reduceOnlyStopMarket(a: {
  productId: number;
  positionSide: Side;
  contracts: number;
  stopPrice: number;
  tickSize: number;
  clientOrderId: string;
  trigger?: 'mark_price' | 'last_traded_price';
}): PlaceOrderRequest {
  return {
    product_id: a.productId,
    side: closeSide(a.positionSide),
    size: a.contracts,
    order_type: 'market_order',
    stop_order_type: 'stop_loss_order',
    stop_price: priceStr(a.stopPrice, a.tickSize, a.positionSide === 'long' ? 'down' : 'up'),
    stop_trigger_method: a.trigger ?? 'mark_price',
    reduce_only: true,
    client_order_id: a.clientOrderId,
  };
}
