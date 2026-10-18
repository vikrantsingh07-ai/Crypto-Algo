'use client';
import { useMemo } from 'react';
import type { MarketState, UseDeltaMarketOptions } from './types';

/**
 * STUB (contract only). The market agent replaces the body: a browser WebSocket straight to Delta's PUBLIC feed
 * with reconnect, stale detection, throttled state updates and a fallback to the backend seed quote.
 */
export function useDeltaMarket(opts: UseDeltaMarketOptions = {}): MarketState {
  const symbol = opts.symbol ?? 'ETHUSD';
  const q = opts.seedQuote ?? null;
  return useMemo<MarketState>(
    () => ({
      status: q ? 'fallback' : 'connecting',
      symbol,
      price: q?.last ?? null,
      bid: q?.bid ?? null,
      ask: q?.ask ?? null,
      mark: null,
      changePct: null,
      lastTradeSide: null,
      bids: [],
      asks: [],
      candles: opts.seedCandles ?? [],
      updatedAt: q?.ts ?? 0,
      source: q ? 'backend' : 'none',
    }),
    [symbol, q, opts.seedCandles],
  );
}
