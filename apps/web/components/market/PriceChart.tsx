'use client';
import type { MarketState, PositionLines } from '@/lib/market/types';

/** STUB: live candle/line chart with optional entry / stop / target lines. */
export function PriceChart({ market, height = 260 }: { market: MarketState; positionLines?: PositionLines | null; height?: number }) {
  return <div data-stub="PriceChart" style={{ height }}>{market.candles.length} candles</div>;
}
