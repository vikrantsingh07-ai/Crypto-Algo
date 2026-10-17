import { describe, expect, it } from 'vitest';
import { RateLimiter, buildQueryString, bodyString, endpointWeight, generateSignature, quotePlus, signRequest, signWebSocketAuth } from '../src';

/**
 * Vectors below were produced by running the OFFICIAL delta-rest-client (v1.0.14) functions
 * generate_signature / query_string / body_string in Python, so our signer is byte-compatible.
 */
const SECRET = 's3cr3t-Key_0123456789';

describe('request signing (matches the official client)', () => {
  const cases: [string, string, string, Record<string, any> | undefined, unknown, string, string][] = [
    ['GET', '1700000000', '/v2/wallet/balances', undefined, undefined, '', '4b5cbd0ca1d393b6e84e0a86282a02928e03d25ce9f3dc25cd8075cf316a760d'],
    ['GET', '1700000001', '/v2/orders', { product_ids: '3136,27', states: 'open,pending', page_size: 100 }, undefined, '?product_ids=3136%2C27&states=open%2Cpending&page_size=100', 'ccdc97b7e801f33d6e81965be79ac39027672b0ab2ccfe6a30714ae47ff07d46'],
    [
      'POST',
      '1700000002',
      '/v2/orders',
      undefined,
      { product_id: 3136, side: 'buy', size: 20, order_type: 'limit_order', limit_price: '3000.05', time_in_force: 'ioc', post_only: false, reduce_only: false, client_order_id: 'ca1abce' },
      '',
      '0e7ce84d1826efe0fd609e2cc5ed1c6252d68f669e64a5550eb24759884f10a9',
    ],
    ['DELETE', '1700000003', '/v2/orders', undefined, { id: 123456, product_id: 3136 }, '', 'd587cbd2d33f79aac4c4dbec8f2c5a1f4fa2087d05a75adbb3430804723e5993'],
    ['GET', '1700000004', '/v2/positions', { product_id: 3136 }, undefined, '?product_id=3136', '533baa10c5285efb39122747672a66863f06ca0788b58825524020438c51fb30'],
  ];

  for (const [method, ts, path, query, body, expectedQs, expectedSig] of cases) {
    it(`${method} ${path}${expectedQs}`, () => {
      const qs = buildQueryString(query);
      expect(qs).toBe(expectedQs);
      expect(signRequest({ method, timestamp: ts, path, queryString: qs, body: bodyString(body), secret: SECRET })).toBe(expectedSig);
    });
  }

  it('encodes like Python quote_plus', () => {
    expect(quotePlus('a b,c/d')).toBe('a+b%2Cc%2Fd');
    expect(quotePlus('MARK:ETHUSD')).toBe('MARK%3AETHUSD');
    expect(quotePlus('é')).toBe('%C3%A9');
  });

  it('drops undefined query values and produces no "?" for empty queries', () => {
    expect(buildQueryString({ a: undefined, b: null })).toBe('');
    expect(buildQueryString({ a: 1, b: undefined, c: 'x' })).toBe('?a=1&c=x');
  });

  it('signs the websocket key-auth message as HMAC("GET"+timestamp+"/live")', () => {
    expect(signWebSocketAuth(SECRET, '1700000000')).toBe(generateSignature(SECRET, 'GET1700000000/live'));
  });

  it('signature changes when any component changes', () => {
    const base = { method: 'POST', timestamp: '1', path: '/v2/orders', queryString: '', body: '{}', secret: SECRET };
    const sig = signRequest(base);
    expect(signRequest({ ...base, body: '{ }' })).not.toBe(sig);
    expect(signRequest({ ...base, timestamp: '2' })).not.toBe(sig);
    expect(signRequest({ ...base, secret: SECRET + 'x' })).not.toBe(sig);
    expect(signRequest({ ...base, method: 'PUT' })).not.toBe(sig);
  });
});

describe('rate limiter', () => {
  it('uses the documented endpoint weights', () => {
    expect(endpointWeight('GET', '/v2/tickers/ETHUSD')).toBe(3);
    expect(endpointWeight('GET', '/v2/history/candles')).toBe(3);
    expect(endpointWeight('GET', '/v2/orders')).toBe(3);
    expect(endpointWeight('GET', '/v2/wallet/balances')).toBe(3);
    expect(endpointWeight('POST', '/v2/orders')).toBe(5);
    expect(endpointWeight('DELETE', '/v2/orders')).toBe(5);
    expect(endpointWeight('GET', '/v2/fills')).toBe(10);
    expect(endpointWeight('GET', '/v2/orders/history')).toBe(10);
    expect(endpointWeight('POST', '/v2/orders/batch')).toBe(25);
    expect(endpointWeight('POST', '/v2/products/1/orders/leverage')).toBe(1);
  });

  it('refuses to exceed its safety budget for normal requests but lets critical exits through', async () => {
    let now = 0;
    const rl = new RateLimiter(100, 0.5, () => now, async (ms) => void (now += ms), 200, 5_000);
    await rl.acquire(40, 'x');
    await rl.acquire(10, 'x');
    await expect(rl.acquire(5, 'x')).rejects.toThrow(/Rate limited/);
    await expect(rl.acquire(5, 'x', 'critical')).resolves.toBeUndefined();
  });

  it('honours a 429 back-off (X-RATE-LIMIT-RESET)', async () => {
    let now = 1_000;
    const sleeps: number[] = [];
    const rl = new RateLimiter(20_000, 0.7, () => now, async (ms) => { sleeps.push(ms); now += ms; }, 100, 10_000);
    rl.noteRateLimited(2_000);
    await expect(rl.acquire(1, 'x')).rejects.toThrow(); // normal priority will not wait 2s
    await rl.acquire(1, 'x', 'critical'); // critical waits it out
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1_900);
  });

  it('frees budget as the 5-minute window slides', async () => {
    let now = 0;
    const rl = new RateLimiter(100, 1, () => now, async (ms) => void (now += ms), 500, 5_000);
    await rl.acquire(100, 'x');
    now += 5 * 60_000 + 1;
    await expect(rl.acquire(100, 'x')).resolves.toBeUndefined();
  });
});
