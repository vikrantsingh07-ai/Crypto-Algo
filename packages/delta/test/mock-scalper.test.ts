import { afterEach, describe, expect, it } from 'vitest';
import { DeltaClient, DeltaHttp, entryOrder, reduceOnlyLimit, reduceOnlyMarket } from '../src';
import { MockDeltaExchange } from '../src/mock';

/**
 * The mock's model of Delta's "Scalper Offer": a fill that closes a position opened at most `windowMs`
 * earlier (mock clock) reports commission 0. This verifies the LOCAL mock only - not the real exchange.
 */
const WINDOW = 30 * 60_000;
const creds = { apiKey: 'test-key', apiSecret: 'test-secret' };
let ex: MockDeltaExchange;
const clock = { t: Date.UTC(2026, 5, 1, 12, 0, 0) };

async function setup(scalperOffer?: { enabled: boolean; windowMs: number }) {
  ex = new MockDeltaExchange(scalperOffer ? { scalperOffer } : {});
  await ex.start();
  clock.t = Date.UTC(2026, 5, 1, 12, 0, 0);
  ex.setClock(() => clock.t);
  // the client signs with the same clock the exchange validates against
  const http = new DeltaHttp({ baseUrl: ex.restUrl, credentials: creds, userAgent: 'cryptoalgo-test', now: () => clock.t, sleep: async () => {} });
  return new DeltaClient(http);
}

afterEach(async () => {
  await ex.stop();
});

const buy = (n = 20, cid = 'e1') => entryOrder({ productId: 3136, side: 'long', contracts: n, limitPrice: 3001, tickSize: 0.05, clientOrderId: cid });
const sellClose = (n = 20, cid = 'x1') => reduceOnlyMarket({ productId: 3136, positionSide: 'long', contracts: n, clientOrderId: cid });

describe('mock exchange: Scalper Offer model', () => {
  it('is OFF by default, so existing behaviour is unchanged (closing fee is charged)', async () => {
    const c = await setup();
    expect(ex.opts.scalperOffer.enabled).toBe(false);
    await c.placeOrder(buy());
    clock.t += 60_000;
    await c.placeOrder(sellClose());
    const { fills } = await c.getFills();
    const close = fills.find((f) => f.side === 'sell')!;
    expect(close.commission).toBeCloseTo(20 * 0.01 * 2999.95 * 0.0005, 6);
    expect(ex.scalperWaivedUsd).toBe(0);
  });

  it('opening fill pays its fee, a closing fill inside the window pays nothing', async () => {
    const c = await setup({ enabled: true, windowMs: WINDOW });
    await c.placeOrder(buy());
    expect(ex.positionOpenedAt).toBe(clock.t);
    clock.t += 10 * 60_000;
    const close = await c.placeOrder(sellClose());
    expect(close.paidCommission).toBe(0);
    const { fills } = await c.getFills();
    const open = fills.find((f) => f.side === 'buy')!;
    const shut = fills.find((f) => f.side === 'sell')!;
    expect(open.commission).toBeCloseTo(20 * 0.01 * 3000.05 * 0.0005, 6);
    expect(shut.commission).toBe(0);
    expect(ex.scalperWaivedUsd).toBeCloseTo(20 * 0.01 * 2999.95 * 0.0005, 6);
    expect(ex.positionOpenedAt).toBeNull();
    // balance only lost the opening fee (plus the spread on the round trip)
    const gross = (2999.95 - 3000.05) * 20 * 0.01;
    expect(ex.balance).toBeCloseTo(1000 + gross - 20 * 0.01 * 3000.05 * 0.0005, 6);
  });

  it('a take-profit limit (maker) fill inside the window is free too', async () => {
    const c = await setup({ enabled: true, windowMs: WINDOW });
    await c.placeOrder(buy());
    const tp = await c.placeOrder(reduceOnlyLimit({ productId: 3136, positionSide: 'long', contracts: 20, price: 3005.05, tickSize: 0.05, clientOrderId: 'tp' }));
    clock.t += 5 * 60_000;
    ex.setQuote(3005.1, 3005.2);
    expect((await c.getOrder(tp.id)).paidCommission).toBe(0);
  });

  it('the window boundary is inclusive; one millisecond later the closing fee is charged', async () => {
    const c = await setup({ enabled: true, windowMs: WINDOW });
    await c.placeOrder(buy());
    clock.t += WINDOW;
    expect((await c.placeOrder(sellClose())).paidCommission).toBe(0);

    await c.placeOrder(buy(20, 'e2'));
    clock.t += WINDOW + 1;
    const late = await c.placeOrder(sellClose(20, 'x2'));
    expect(late.paidCommission).toBeCloseTo(20 * 0.01 * 2999.95 * 0.0005, 6);
  });

  it('a close outside the window pays the normal fee even though an opening fill never is waived', async () => {
    const c = await setup({ enabled: true, windowMs: WINDOW });
    const o = await c.placeOrder(buy());
    expect(o.paidCommission).toBeGreaterThan(0); // opening is never free
    clock.t += 45 * 60_000;
    const late = await c.placeOrder(sellClose());
    expect(late.paidCommission).toBeGreaterThan(0);
    expect(ex.scalperWaivedUsd).toBe(0);
  });

  it('a partial close inside the window is free, and adding to a position does not restart the clock', async () => {
    const c = await setup({ enabled: true, windowMs: WINDOW });
    await c.placeOrder(buy(20, 'a'));
    const opened = clock.t;
    clock.t += 20 * 60_000;
    await c.placeOrder(buy(10, 'b')); // add: the clock keeps running from the first fill
    expect(ex.positionOpenedAt).toBe(opened);
    clock.t += 11 * 60_000; // 31 min after the first fill
    const lateClose = await c.placeOrder(sellClose(30, 'late'));
    expect(lateClose.paidCommission).toBeGreaterThan(0);

    // fresh position: half closed early is free
    await c.placeOrder(buy(20, 'c'));
    clock.t += 60_000;
    const half = await c.placeOrder(sellClose(10, 'half'));
    expect(half.paidCommission).toBe(0);
    expect(ex.position.size).toBe(10);
  });

  it('only the closing part of a flipping fill is waived', async () => {
    const c = await setup({ enabled: true, windowMs: WINDOW });
    await c.placeOrder(buy(10, 'l'));
    clock.t += 60_000;
    // sell 30: closes 10 (free) and opens 20 short (charged)
    const flip = await c.placeOrder({ product_id: 3136, side: 'sell', size: 30, order_type: 'market_order', client_order_id: 'flip' });
    expect(flip.paidCommission).toBeCloseTo(20 * 0.01 * 2999.95 * 0.0005, 6);
    expect(ex.position.size).toBe(-20);
    expect(ex.positionOpenedAt).toBe(clock.t); // the new short starts its own window
  });
});


import { mapFill } from '../src/mappers';

describe('mapFill commission', () => {
  const base = { id: 1, order_id: 2, product_id: 3, product_symbol: 'ETHUSD', side: 'sell', size: '20', price: '3004', role: 'taker', fill_type: 'normal', created_at: '2026-06-01T10:10:00Z' };
  it('flags a missing, blank or non-numeric commission as unknown instead of reading it as 0', () => {
    for (const commission of [undefined, null, '', '  ', 'n/a']) {
      const f = mapFill({ ...base, commission });
      expect(f.commissionKnown).toBe(false);
      expect(f.commission).toBe(0);
    }
  });
  it('an explicit zero is a known zero; settling-asset commission wins over the plain field', () => {
    expect(mapFill({ ...base, commission: '0' })).toMatchObject({ commission: 0, commissionKnown: true });
    expect(mapFill({ ...base, commission: '0.4', meta_data: { total_commission_in_settling_asset: '0.35' } })).toMatchObject({ commission: 0.35, commissionKnown: true });
  });
});
