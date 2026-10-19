import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OrderFlow } from '../../components/market/OrderFlow';
import { PriceChart } from '../../components/market/PriceChart';
import { PriceHero } from '../../components/market/PriceHero';
import type { BookLevel, MarketCandle, MarketState } from './types';

// Vitest transforms TSX with the classic JSX runtime (the app's tsconfig says jsx: preserve and Next compiles it itself), so expose React globally for the component files.
(globalThis as { React?: typeof React }).React = React;

// Server-side render smoke tests: the dashboard is server-rendered by Next first, so every state must render
// without throwing, without NaN/undefined text and without relying on browser-only APIs.

const base: MarketState = {
  status: 'live',
  symbol: 'ETHUSD',
  price: 3390.45,
  bid: 3390.4,
  ask: 3390.45,
  mark: 3390.42,
  changePct: 0.5,
  changeLabel: '24h',
  lastTradeSide: 'buy',
  bids: [],
  asks: [],
  candles: [],
  updatedAt: 1,
  source: 'delta-ws',
};
const levels = (from: number, step: number, n: number): BookLevel[] => Array.from({ length: n }, (_, i) => ({ price: from + step * i, size: 5 + ((i * 7) % 11) }));
const candles: MarketCandle[] = Array.from({ length: 50 }, (_, i) => ({ t: 1_775_800_000_000 + i * 60_000, o: 3380 + i * 0.1, h: 3385 + i * 0.1, l: 3375 + i * 0.1, c: 3381 + i * 0.1, v: 3 }));
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
const clean = (s: string) => {
  expect(s).not.toMatch(/NaN|undefined|Infinity|\[object/);
};

describe('PriceHero (server render)', () => {
  it('shows the price, change, bid/ask and a plain status label for every status', () => {
    const live = html(createElement(PriceHero, { market: base }));
    clean(live);
    expect(live).toContain('3,390.45');
    expect(live).toContain('+0.50%');
    expect(live).toContain('24h');
    expect(live).toContain('Bid');
    expect(live).toContain('Live');
    for (const [status, label] of [['connecting', 'Connecting'], ['fallback', 'Delayed'], ['down', 'Reconnecting']] as const) {
      const out = html(createElement(PriceHero, { market: { ...base, status } }));
      clean(out);
      expect(out).toContain(label);
    }
  });
  it('renders without a price (skeleton) and without change / quote', () => {
    const out = html(createElement(PriceHero, { market: { ...base, status: 'down', price: null, bid: null, ask: null, changePct: null, changeLabel: null, source: 'none', updatedAt: 0 } }));
    clean(out);
    expect(out).toContain('Reconnecting');
    expect(out).not.toContain('Spread');
  });
});

describe('OrderFlow (server render)', () => {
  it('renders exactly `levels` rows per side, buyers first (left) and sellers second (right), with prices and ETH sizes', () => {
    const market = { ...base, bids: levels(3390.4, -0.05, 10).map((l) => ({ ...l })), asks: levels(3390.45, 0.05, 10) };
    const out = html(createElement(OrderFlow, { market }));
    clean(out);
    expect((out.match(/data-bar/g) ?? []).length).toBe(20);
    const buyers = out.indexOf('Buyers');
    const sellers = out.indexOf('Sellers');
    expect(buyers).toBeGreaterThan(-1);
    expect(sellers).toBeGreaterThan(-1);
    // left column (first 10 bars) holds the bid prices, right column the ask prices
    const firstBid = out.indexOf('3,390.40');
    const firstAsk = out.indexOf('3,390.45', firstBid);
    expect(firstBid).toBeGreaterThan(-1);
    expect(firstAsk).toBeGreaterThan(firstBid);
    expect(out).toContain('Spread 0.05');
    expect(out).toContain('ETH');
    // 20 threads, one per bar
    expect((out.match(/<path/g) ?? []).length).toBe(20);
  });

  it('honours a custom number of levels and pads missing levels instead of breaking', () => {
    const few = { ...base, bids: levels(3390.4, -0.05, 3), asks: levels(3390.45, 0.05, 4) };
    const out = html(createElement(OrderFlow, { market: few, levels: 6 }));
    clean(out);
    expect((out.match(/data-bar/g) ?? []).length).toBe(12);
    expect(out).toContain('—'); // placeholder dashes for the missing levels
  });

  it('empty / connecting book shows skeleton rows, never NaN', () => {
    for (const status of ['connecting', 'fallback', 'down', 'live'] as const) {
      const out = html(createElement(OrderFlow, { market: { ...base, status, bids: [], asks: [], price: status === 'down' ? null : base.price } }));
      clean(out);
      expect((out.match(/data-bar/g) ?? []).length).toBe(20);
      expect(out).toMatch(/Waiting for the live order book|reconnecting/);
    }
  });

  it('pressure shows the buy/sell split of the visible levels', () => {
    const market = { ...base, bids: [{ price: 3390.4, size: 30 }], asks: [{ price: 3390.45, size: 10 }] };
    const out = html(createElement(OrderFlow, { market }));
    expect(out).toContain('Buyers 75%');
    expect(out).toContain('25% Sellers');
  });

  it('shows the entry price of a running trade when given', () => {
    const out = html(createElement(OrderFlow, { market: base, positionPrice: 3388.2 }));
    expect(out).toContain('Entry 3,388.20');
  });
});

describe('PriceChart (server render)', () => {
  it('renders its container (the SVG is drawn after the width is measured in the browser) for empty and populated data', () => {
    for (const cs of [[], candles]) {
      const out = html(createElement(PriceChart, { market: { ...base, candles: cs }, height: 240 }));
      clean(out);
      expect(out).toContain('height:240px');
    }
  });
  it('empty chart says what is happening', () => {
    expect(html(createElement(PriceChart, { market: { ...base, status: 'connecting', candles: [] } }))).toContain('Loading chart');
    expect(html(createElement(PriceChart, { market: { ...base, status: 'down', candles: [] } }))).toContain('not available yet');
  });
});
