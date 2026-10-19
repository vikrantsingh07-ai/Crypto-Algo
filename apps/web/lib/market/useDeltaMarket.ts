'use client';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { DEFAULT_WS_URL } from './protocol';
import { MarketStore } from './store';
import type { MarketState, UseDeltaMarketOptions } from './types';

/**
 * Live ETH market data straight from Delta Exchange's PUBLIC WebSocket (no key, no secret), with the backend quote as
 * fallback so the page never shows a frozen or empty price. See PROTOCOL.md for the channels and what is verified.
 *
 * The socket is opened after mount (never during render / SSR), React updates are batched to at most ~20 per second,
 * and everything is torn down on unmount. Pass the latest backend snapshot values as `seedQuote` / `seedCandles`; they
 * are read again on every change (a new array with the same candles does not cause work).
 */
export function useDeltaMarket(opts: UseDeltaMarketOptions = {}): MarketState {
  const symbol = opts.symbol ?? 'ETHUSD';
  const contractValue = opts.contractValue && opts.contractValue > 0 ? opts.contractValue : 0.01;
  const levels = Math.max(1, Math.min(25, Math.floor(opts.levels ?? 10)));
  const wsUrl = opts.wsUrl ?? DEFAULT_WS_URL;
  const enabled = opts.enabled !== false;

  // One store per (symbol, url, units, depth, enabled). The initial seeds are read once here; later changes go through setSeed below.
  const store = useMemo(
    () => new MarketStore({ symbol, contractValue, levels, wsUrl, enabled, seedQuote: opts.seedQuote, seedCandles: opts.seedCandles }),
    [symbol, contractValue, levels, wsUrl, enabled],
  );

  const quote = opts.seedQuote ?? null;
  const q = quote ? `${quote.bid}|${quote.ask}|${quote.last}|${quote.ts ?? ''}` : '';
  const c = opts.seedCandles;
  const lastCandle = c && c.length ? c[c.length - 1] : undefined;
  const candleKey = c ? `${c.length}|${lastCandle?.t ?? ''}|${lastCandle?.c ?? ''}|${lastCandle?.h ?? ''}|${lastCandle?.l ?? ''}` : '';
  useEffect(() => {
    store.setSeed(quote, c);
  }, [store, q, candleKey]);

  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}
