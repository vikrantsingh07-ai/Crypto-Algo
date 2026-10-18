'use client';
import type { MarketState } from '@/lib/market/types';

/** STUB: big live price with change and a connection dot. */
export function PriceHero({ market }: { market: MarketState; symbol?: string }) {
  return <div data-stub="PriceHero">{market.price ?? '...'}</div>;
}
