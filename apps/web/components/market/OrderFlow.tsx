'use client';
import type { MarketState } from '@/lib/market/types';

/** STUB: buyers on the left, sellers on the right, price in the middle, threads from every level to the price. */
export function OrderFlow({ market }: { market: MarketState; levels?: number; positionPrice?: number | null }) {
  return <div data-stub="OrderFlow">{market.bids.length}/{market.asks.length}</div>;
}
