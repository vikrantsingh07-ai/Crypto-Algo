import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DeltaApiError,
  DeltaClient,
  DeltaHttp,
  DeltaNetworkError,
  DeltaRateLimitError,
  RateLimiter,
  entryOrder,
  reduceOnlyLimit,
  reduceOnlyMarket,
  reduceOnlyStopMarket,
} from '../src';
import { MockDeltaExchange } from '../src/mock';

let ex: MockDeltaExchange;
const creds = { apiKey: 'test-key', apiSecret: 'test-secret' };

function client(over: Partial<ConstructorParameters<typeof DeltaHttp>[0]> = {}) {
  const h = new DeltaHttp({ baseUrl: ex.restUrl, credentials: creds, timeoutMs: 1500, userAgent: 'cryptoalgo-test', sleep: async () => {}, ...over });
  return new DeltaClient(h);
}

beforeEach(async () => {
  ex = new MockDeltaExchange();
  await ex.start();
});
afterEach(async () => {
  await ex.stop();
});

describe('public market data', () => {
  it('maps the product to a verified ContractSpec (0.01 ETH/contract, 100x max from 1% margin)', async () => {
    const spec = await client().getProduct('ETHUSD');
    expect(spec.verified).toBe(true);
    expect(spec.productId).toBe(3136);
    expect(spec.contractValue).toBe(0.01);
    expect(spec.tickSize).toBe(0.05);
    expect(spec.takerFeeRate).toBe(0.0005);
    expect(spec.makerFeeRate).toBe(0.0002);
    expect(spec.maxLeverage).toBe(100);
    expect(spec.tradingStatus).toBe('operational');
  });

  it('maps the ticker to a top-of-book quote', async () => {
    ex.setQuote(2999.9, 3000.1, 3000);
    const t = await client().getTicker('ETHUSD');
    expect(t.quote).toMatchObject({ bid: 2999.9, ask: 3000.1, last: 3000 });
    expect(t.mark).toBe(3000);
  });

  it('returns the L2 order book', async () => {
    const ob = await client().getOrderbook('ETHUSD', 5);
    expect(ob.bids[0].price).toBeCloseTo(2999.95);
    expect(ob.asks[0].price).toBeCloseTo(3000.05);
  });

  it('sorts descending candle responses ascending and pages through long ranges', async () => {
    for (let i = 0; i < 5000; i++) ex.candles.push({ time: 1_700_000_000 + i * 60, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });
    const c = client();
    const rows = await c.getCandles('ETHUSD', '1m', 1_700_000_000, 1_700_000_000 + 99 * 60);
    expect(rows.length).toBe(100);
    expect(rows[0].t).toBeLessThan(rows[1].t);
    expect(rows[0].t).toBe(1_700_000_000_000);
    const all = await c.getCandlesRange('ETHUSD', '1m', 1_700_000_000, 1_700_000_000 + 4999 * 60);
    expect(all.length).toBe(5000);
    const calls = ex.requestLog.filter((r) => r.path === '/v2/history/candles').length;
    expect(calls).toBeGreaterThanOrEqual(3); // 2000-per-request cap forces paging
  });

  it('always sends a User-Agent (the CDN rejects requests without one)', async () => {
    const http = new DeltaHttp({ baseUrl: ex.restUrl, userAgent: 'cryptoalgo-test' });
    await new DeltaClient(http).getProduct('ETHUSD');
    expect(ex.requestLog.at(-1)!.status).toBe(200);
  });
});

describe('authentication', () => {
  it('accepts correctly signed private requests', async () => {
    const b = await client().getBalances();
    expect(b[0].assetSymbol).toBe('USD');
    expect(b[0].availableBalance).toBeCloseTo(1000, 4);
    expect(ex.requestLog.at(-1)!.authed).toBe(true);
  });

  it('rejects a wrong secret with Signature Mismatch', async () => {
    const c = client({ credentials: { apiKey: 'test-key', apiSecret: 'WRONG' } });
    await expect(c.getBalances()).rejects.toMatchObject({ name: 'DeltaApiError', code: 'Signature Mismatch', status: 401 });
  });

  it('rejects an unknown key with invalid_api_key', async () => {
    const c = client({ credentials: { apiKey: 'nope', apiSecret: 'test-secret' } });
    await expect(c.getBalances()).rejects.toMatchObject({ code: 'invalid_api_key' });
  });

  it('refuses private calls when no credentials are configured, without hitting the network', async () => {
    const c = client({ credentials: null });
    const before = ex.requestLog.length;
    await expect(c.getBalances()).rejects.toBeInstanceOf(DeltaApiError);
    expect(ex.requestLog.length).toBe(before);
  });

  it('signs the exact query string it sends (comma lists, ordering)', async () => {
    const c = client();
    await c.getOpenOrders([3136, 27]);
    const r = ex.requestLog.at(-1)!;
    expect(r.status).toBe(200);
    expect(r.query).toContain('product_ids=3136%2C27');
  });

  it('recovers from a drifting local clock by resyncing from the Date header and retrying once', async () => {
    // Local clock runs 30s ahead of the exchange => first signature is "expired".
    let skew = 30_000;
    const http = new DeltaHttp({ baseUrl: ex.restUrl, credentials: creds, userAgent: 't', now: () => Date.now() + skew, sleep: async () => {} });
    const c = new DeltaClient(http);
    await c.getProduct('ETHUSD'); // public call teaches the offset via the Date header
    expect(Math.abs(http.clockOffset + 30_000)).toBeLessThan(2_000);
    await expect(c.getBalances()).resolves.toBeDefined();
    skew = 0;
  });

  it('resyncs after a SignatureExpired response and succeeds on the single retry', async () => {
    ex.setClock(() => Date.now() + 120_000); // the exchange thinks it is 2 minutes in the future
    const http = new DeltaHttp({ baseUrl: ex.restUrl, credentials: creds, userAgent: 't', sleep: async () => {} });
    // First signature is rejected as expired; the response's Date header teaches the offset.
    await expect(new DeltaClient(http).getBalances()).resolves.toBeDefined();
    const authed = ex.requestLog.filter((r) => r.path === '/v2/wallet/balances');
    expect(authed.map((r) => r.status)).toEqual([401, 200]);
  });

  it('gives up with SignatureExpired if the retry is also rejected', async () => {
    const strict = new MockDeltaExchange({ allowedSkewSec: 0 });
    await strict.start();
    try {
      const http = new DeltaHttp({ baseUrl: strict.restUrl, credentials: creds, userAgent: 't', sleep: async () => {} });
      await expect(new DeltaClient(http).getBalances()).rejects.toMatchObject({ code: 'SignatureExpired' });
    } finally {
      await strict.stop();
    }
  });
});

describe('orders, fills, positions', () => {
  const buyIoc = (limit: number, cid = 'ca-test-1', contracts = 20) =>
    entryOrder({ productId: 3136, side: 'long', contracts, limitPrice: limit, tickSize: 0.05, clientOrderId: cid });

  it('places an IOC entry that fills fully at the ask as a taker and updates position/fills', async () => {
    const c = client();
    const o = await c.placeOrder(buyIoc(3000.5));
    expect(o.state).toBe('closed');
    expect(o.filledSize).toBe(20);
    expect(o.avgFillPrice).toBeCloseTo(3000.05, 6);
    const pos = await c.getPosition(3136);
    expect(pos.size).toBe(20);
    expect(pos.entryPrice).toBeCloseTo(3000.05, 6);
    const { fills } = await c.getFills();
    expect(fills).toHaveLength(1);
    expect(fills[0].role).toBe('taker');
    expect(fills[0].commission).toBeCloseTo(20 * 0.01 * 3000.05 * 0.0005, 6);
  });

  it('sends exact documented field names and compact JSON', async () => {
    await client().placeOrder(buyIoc(3000.5, 'cid-1'));
    const body = JSON.parse(ex.requestLog.find((r) => r.method === 'POST' && r.path === '/v2/orders')!.body);
    expect(body).toEqual({ product_id: 3136, side: 'buy', size: 20, order_type: 'limit_order', limit_price: '3000.5', time_in_force: 'ioc', post_only: false, reduce_only: false, client_order_id: 'cid-1' });
  });

  it('IOC entry priced below the ask does not fill (slippage cap) and is cancelled', async () => {
    const o = await client().placeOrder(buyIoc(2999.0));
    expect(o.filledSize).toBe(0);
    expect(o.state).toBe('cancelled');
    expect((await client().getPosition(3136)).size).toBe(0);
  });

  it('handles partial fills: IOC remainder is cancelled, position equals filled size', async () => {
    ex.opts.partialFillRatio = 0.5;
    const o = await client().placeOrder(buyIoc(3001));
    expect(o.filledSize).toBe(10);
    expect(o.unfilledSize).toBe(10);
    expect(o.state).toBe('cancelled');
    expect((await client().getPosition(3136)).size).toBe(10);
  });

  it('rests a reduce-only take-profit and fills it as a maker when the market trades through', async () => {
    const c = client();
    await c.placeOrder(buyIoc(3001));
    const tp = await c.placeOrder(reduceOnlyLimit({ productId: 3136, positionSide: 'long', contracts: 20, price: 3005.05, tickSize: 0.05, clientOrderId: 'tp-1' }));
    expect(tp.state).toBe('open');
    expect((await c.getOpenOrders([3136])).length).toBe(1);
    ex.setQuote(3005.1, 3005.2);
    const filled = await c.getOrder(tp.id);
    expect(filled.state).toBe('closed');
    expect((await c.getPosition(3136)).size).toBe(0);
    const { fills } = await c.getFills();
    expect(fills.find((f) => f.orderId === String(tp.id))!.role).toBe('maker');
  });

  it('triggers an exchange-side reduce-only stop-market and cancels the sibling take-profit once flat', async () => {
    const c = client();
    await c.placeOrder(buyIoc(3001));
    const tp = await c.placeOrder(reduceOnlyLimit({ productId: 3136, positionSide: 'long', contracts: 20, price: 3005.05, tickSize: 0.05, clientOrderId: 'tp-2' }));
    const sl = await c.placeOrder(reduceOnlyStopMarket({ productId: 3136, positionSide: 'long', contracts: 20, stopPrice: 2997, tickSize: 0.05, clientOrderId: 'sl-2' }));
    expect(sl.state).toBe('pending');
    ex.setQuote(2996.4, 2996.5);
    expect((await c.getOrder(sl.id)).state).toBe('closed');
    expect((await c.getPosition(3136)).size).toBe(0);
    expect((await c.getOrder(tp.id)).state).toBe('cancelled'); // reduce-only orders cannot outlive the position
  });

  it('cancels an open order', async () => {
    const c = client();
    await c.placeOrder(buyIoc(3001));
    const tp = await c.placeOrder(reduceOnlyLimit({ productId: 3136, positionSide: 'long', contracts: 20, price: 3100, tickSize: 0.05, clientOrderId: 'tp-3' }));
    const cancelled = await c.cancelOrder(3136, tp.id);
    expect(cancelled.state).toBe('cancelled');
    expect(await c.getOpenOrders([3136])).toHaveLength(0);
  });

  it('closes a position with a reduce-only market order and refuses to open one by accident', async () => {
    const c = client();
    await expect(c.placeOrder(reduceOnlyMarket({ productId: 3136, positionSide: 'long', contracts: 20, clientOrderId: 'x1' }))).rejects.toMatchObject({ code: 'no_position_for_reduce_only' });
    await c.placeOrder(buyIoc(3001));
    const close = await c.placeOrder(reduceOnlyMarket({ productId: 3136, positionSide: 'long', contracts: 20, clientOrderId: 'x2' }));
    expect(close.filledSize).toBe(20);
    expect((await c.getPosition(3136)).size).toBe(0);
  });

  it('rejects duplicate client_order_id among open orders (exchange-side duplicate protection)', async () => {
    const c = client();
    await c.placeOrder(buyIoc(3001));
    await c.placeOrder(reduceOnlyLimit({ productId: 3136, positionSide: 'long', contracts: 20, price: 3100, tickSize: 0.05, clientOrderId: 'dup' }));
    await expect(c.placeOrder(reduceOnlyLimit({ productId: 3136, positionSide: 'long', contracts: 20, price: 3101, tickSize: 0.05, clientOrderId: 'dup' }))).rejects.toMatchObject({ code: 'duplicate_client_order_id' });
  });

  it('surfaces insufficient_margin', async () => {
    ex.balance = 1;
    await expect(client().placeOrder(buyIoc(3001))).rejects.toMatchObject({ code: 'insufficient_margin' });
  });

  it('gets and sets order leverage', async () => {
    const c = client();
    expect(await c.getOrderLeverage(3136)).toBe(10);
    expect(await c.setOrderLeverage(3136, 50)).toBe(50);
    expect(await c.getOrderLeverage(3136)).toBe(50);
    await expect(c.setOrderLeverage(3136, 500)).rejects.toMatchObject({ code: 'max_leverage_exceeded' });
  });

  it('looks orders up by client_order_id and returns null when unknown', async () => {
    const c = client();
    await c.placeOrder(buyIoc(3001, 'known-1'));
    expect((await c.getOrderByClientId('known-1'))!.filledSize).toBe(20);
    expect(await c.getOrderByClientId('unknown')).toBeNull();
  });
});

describe('failure handling', () => {
  it('never auto-retries a state-changing request after an ambiguous failure; resolves it by client_order_id', async () => {
    const c = client();
    ex.failNext(/POST \/v2\/orders/, 'drop-after-process');
    const req = entryOrder({ productId: 3136, side: 'long', contracts: 20, limitPrice: 3001, tickSize: 0.05, clientOrderId: 'amb-1' });
    const err = await c.placeOrder(req).catch((e) => e);
    expect(err).toBeInstanceOf(DeltaNetworkError);
    expect((err as DeltaNetworkError).ambiguous).toBe(true);
    // exactly ONE order request reached the exchange:
    expect(ex.placedOrderRequests).toHaveLength(1);
    // ...and it WAS processed, which we discover by lookup rather than by resending
    const found = await c.getOrderByClientId('amb-1');
    expect(found?.filledSize).toBe(20);
    expect(ex.placedOrderRequests).toHaveLength(1);
  });

  it('times out hung requests and flags state-changing ones as ambiguous', async () => {
    const c = client({ timeoutMs: 150 });
    ex.failNext(/POST \/v2\/orders/, 'timeout');
    const err = await c.placeOrder(entryOrder({ productId: 3136, side: 'long', contracts: 1, limitPrice: 3001, tickSize: 0.05, clientOrderId: 't-1' })).catch((e) => e);
    expect(err).toBeInstanceOf(DeltaNetworkError);
    expect(err.ambiguous).toBe(true);
  });

  it('retries idempotent GETs on 5xx and network errors', async () => {
    const c = client();
    ex.failNext(/GET \/v2\/products/, 'http500', 1);
    await expect(c.getProduct('ETHUSD')).resolves.toBeDefined();
    ex.failNext(/GET \/v2\/tickers/, 'drop-before-process', 1);
    await expect(c.getTicker('ETHUSD')).resolves.toBeDefined();
  });

  it('turns HTTP 429 into DeltaRateLimitError and honours X-RATE-LIMIT-RESET', async () => {
    const c = client();
    ex.limitRequests(0, 5000);
    const err = await c.getBalances().catch((e) => e);
    expect(err).toBeInstanceOf(DeltaRateLimitError);
    expect(err.resetMs).toBe(5000);
  });

  it('a critical exit waits out a 429 and then succeeds', async () => {
    let now = Date.now();
    const limiter = new RateLimiter(20_000, 0.7, () => now, async (ms) => void (now += ms), 100, 10_000);
    const c = client({ limiter, now: () => now });
    await c.placeOrder(entryOrder({ productId: 3136, side: 'long', contracts: 20, limitPrice: 3001, tickSize: 0.05, clientOrderId: 'e-1' }));
    ex.failNext(/DELETE \/v2\/orders/, 'http429', 1);
    const tp = await c.placeOrder(reduceOnlyLimit({ productId: 3136, positionSide: 'long', contracts: 20, price: 3100, tickSize: 0.05, clientOrderId: 'tp-9' }));
    const cancelled = await c.cancelOrder(3136, tp.id, 'critical');
    expect(cancelled.state).toBe('cancelled');
  });

  it('a request without User-Agent is blocked by the CDN (403) — which is why the client always sends one', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: ex.port, path: '/v2/products/ETHUSD', headers: {} }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .on('error', reject);
    });
    expect(status).toBe(403);
  });
});
