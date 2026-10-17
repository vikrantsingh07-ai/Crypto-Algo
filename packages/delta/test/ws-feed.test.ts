import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DELTA_ENVIRONMENTS, DeltaClient, DeltaHttp, DeltaMarketFeed, DeltaWs, resolveEndpoints } from '../src';
import { MockDeltaExchange } from '../src/mock';

let ex: MockDeltaExchange;
const creds = { apiKey: 'test-key', apiSecret: 'test-secret' };
const until = async (fn: () => boolean, ms = 3000, step = 10) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, step));
  }
};

beforeEach(async () => {
  ex = new MockDeltaExchange({ heartbeatMs: 50 });
  await ex.start();
});
afterEach(async () => {
  await ex.stop();
});

describe('environments', () => {
  it('uses the documented Delta India hosts', () => {
    expect(DELTA_ENVIRONMENTS.production.restUrl).toBe('https://api.india.delta.exchange');
    expect(DELTA_ENVIRONMENTS.production.wsPublicUrl).toBe('wss://public-socket.india.delta.exchange');
    expect(DELTA_ENVIRONMENTS.production.wsPrivateUrl).toBe('wss://socket.india.delta.exchange');
    expect(DELTA_ENVIRONMENTS.testnet.restUrl).toBe('https://cdn-ind.testnet.deltaex.org');
    expect(DELTA_ENVIRONMENTS.testnet.wsPublicUrl).toBe('wss://socket-ind-pub.testnet.deltaex.org');
    expect(DELTA_ENVIRONMENTS.testnet.wsPrivateUrl).toBe('wss://socket-ind.testnet.deltaex.org');
  });

  it('flags testnet as non-real-money and custom requires a rest url', () => {
    expect(resolveEndpoints('testnet').realMoney).toBe(false);
    expect(resolveEndpoints('production').realMoney).toBe(true);
    expect(() => resolveEndpoints('custom')).toThrow(/DELTA_REST_URL/);
  });
});

describe('DeltaWs', () => {
  const mk = (over: Record<string, unknown> = {}) =>
    new DeltaWs({ url: ex.wsUrl, name: 't', backoffMinMs: 20, backoffMaxMs: 60, heartbeatTimeoutMs: 400, ...over });

  it('connects, enables heartbeat, subscribes and delivers messages', async () => {
    const ws = mk();
    const msgs: any[] = [];
    ws.on('message', (m) => msgs.push(m));
    ws.subscribe([{ name: 'ob_l1', symbols: ['ETHUSD'] }]);
    ws.start();
    await until(() => ws.state === 'ready');
    ex.setQuote(2999, 3001);
    await until(() => msgs.some((m) => m.type === 'ob_l1'));
    expect(msgs.find((m) => m.type === 'ob_l1')).toMatchObject({ bp: '2999', ap: '3001', sy: 'ETHUSD' });
    ws.stop();
  });

  it('reconnects after the connection drops and replays subscriptions', async () => {
    const ws = mk();
    const msgs: any[] = [];
    ws.on('message', (m) => msgs.push(m));
    ws.subscribe([{ name: 'trades', symbols: ['ETHUSD'] }]);
    ws.start();
    await until(() => ws.state === 'ready');
    const before = ws.reconnects;
    ex.dropWsConnections();
    await until(() => ws.reconnects > before && ws.state === 'ready', 4000);
    msgs.length = 0;
    ex.setQuote(3010, 3010.1, 3010.05);
    await until(() => msgs.some((m) => m.type === 'trades'));
    ws.stop();
  });

  it('detects a silent link via the heartbeat watchdog and reconnects', async () => {
    await ex.stop();
    ex = new MockDeltaExchange({ heartbeatMs: 60_000 }); // server effectively never sends a heartbeat
    await ex.start();
    const ws = mk({ heartbeatTimeoutMs: 300 });
    ws.subscribe([{ name: 'ob_l1', symbols: ['ETHUSD'] }]);
    ws.start();
    await until(() => ws.state === 'ready');
    await until(() => ws.reconnects >= 1, 4000);
    expect(ws.lastError).toMatch(/no websocket traffic/);
    ws.stop();
  });

  it('authenticates the private channel with key-auth and receives order/position updates', async () => {
    const ws = mk({ auth: () => creds });
    const msgs: any[] = [];
    ws.on('message', (m) => msgs.push(m));
    ws.subscribe([{ name: 'positions', symbols: ['ETHUSD'] }, { name: 'orders', symbols: ['ETHUSD'] }, { name: 'margins' }, { name: 'user_trades', symbols: ['ETHUSD'] }]);
    ws.start();
    await until(() => ws.state === 'ready');
    const c = new DeltaClient(new DeltaHttp({ baseUrl: ex.restUrl, credentials: creds, userAgent: 't' }));
    await c.placeOrder({ product_id: 3136, side: 'buy', size: 5, order_type: 'market_order', client_order_id: 'ws-1' });
    await until(() => msgs.some((m) => m.type === 'positions') && msgs.some((m) => m.type === 'orders'));
    expect(msgs.find((m) => m.type === 'positions')).toMatchObject({ size: 5 });
    ws.stop();
  });

  it('reports authentication failure (bad secret) and never becomes ready', async () => {
    const ws = mk({ auth: () => ({ apiKey: 'test-key', apiSecret: 'wrong' }) });
    let failed: any = null;
    ws.on('authFailed', (m) => (failed = m));
    ws.subscribe([{ name: 'positions', symbols: ['ETHUSD'] }]);
    ws.start();
    await until(() => failed !== null);
    expect(failed.status).toBe('invalid_signature');
    expect(ws.state).not.toBe('ready');
    ws.stop();
  });
});

describe('DeltaMarketFeed', () => {
  const endpoints = () => ({ env: 'custom' as const, restUrl: ex.restUrl, wsPublicUrl: ex.wsUrl, wsPrivateUrl: ex.wsUrl, label: 'mock', realMoney: false });
  const mkClient = () => new DeltaClient(new DeltaHttp({ baseUrl: ex.restUrl, userAgent: 't', sleep: async () => {} }));
  const seedCandles = (endBucketSec: number, n: number) => {
    for (let i = n; i >= 0; i--) {
      const t = endBucketSec - i * 60;
      ex.candles.push({ time: t, open: 3000 + i, high: 3002 + i, low: 2998 + i, close: 3001 + i, volume: 50 });
    }
  };

  it('seeds closed candles from REST, streams top-of-book quotes over WS and reports health', async () => {
    const nowMs = Date.UTC(2026, 5, 1, 12, 30, 20);
    const bucketSec = Math.floor(nowMs / 60000) * 60;
    seedCandles(bucketSec, 50); // includes the still-forming current minute
    const feed = new DeltaMarketFeed({ client: mkClient(), endpoints: endpoints(), symbol: 'ETHUSD', now: () => nowMs });
    const quotes: any[] = [];
    feed.on('quote', (q) => quotes.push(q));
    await feed.start();
    expect(feed.getClosedCandles().length).toBe(50);
    expect(feed.getClosedCandles().at(-1)!.t).toBe((bucketSec - 60) * 1000);
    expect(feed.getFormingCandle()?.t).toBe(bucketSec * 1000);
    await until(() => feed.health().wsState === 'ready');
    ex.setQuote(3000.9, 3001.1, 3001);
    await until(() => quotes.length > 0);
    const q = feed.getQuote()!;
    expect(q.bid).toBe(3000.9);
    expect(q.ask).toBe(3001.1);
    expect(feed.health().mode).toBe('ws');
    feed.stop();
  });

  it('converts the published funding rate from percent to a fraction', async () => {
    const nowMs = Date.now();
    seedCandles(Math.floor(nowMs / 60000) * 60, 5);
    const feed = new DeltaMarketFeed({ client: mkClient(), endpoints: endpoints(), symbol: 'ETHUSD' });
    await feed.start();
    await until(() => feed.health().wsState === 'ready');
    ex.fundingRate = 0.01;
    ex.pushFunding();
    await until(() => feed.getFundingRate() !== null);
    expect(feed.getFundingRate()).toBeCloseTo(0.0001, 10);
    feed.stop();
  });

  it('falls back to REST ticker polling when the websocket is unavailable', async () => {
    const nowMs = Date.now();
    seedCandles(Math.floor(nowMs / 60000) * 60, 5);
    ex.setQuote(3000.4, 3000.6, 3000.5);
    const feed = new DeltaMarketFeed({ client: mkClient(), endpoints: { ...endpoints(), wsPublicUrl: '' }, symbol: 'ETHUSD' });
    await feed.start();
    expect(feed.getQuote()).toBeNull();
    await feed.housekeeping();
    expect(feed.getQuote()).toMatchObject({ bid: 3000.4, ask: 3000.6 });
    expect(feed.health().mode).toBe('rest-fallback');
    feed.stop();
  });

  it('emits each closed candle exactly once, confirmed against REST, and carries forward minutes with no trades', async () => {
    let nowMs = Date.UTC(2026, 5, 1, 12, 30, 20);
    const bucketSec = Math.floor(nowMs / 60000) * 60;
    seedCandles(bucketSec, 30);
    const feed = new DeltaMarketFeed({ client: mkClient(), endpoints: { ...endpoints(), wsPublicUrl: '' }, symbol: 'ETHUSD', now: () => nowMs, closeGraceMs: 1000 });
    const closed: any[] = [];
    feed.on('candleClosed', (c) => closed.push(c));
    await feed.start();

    // minute 12:30 finishes; REST now holds its final values
    ex.candles.find((c) => c.time === bucketSec)!.close = 3123.45;
    nowMs = (bucketSec + 60) * 1000 + 500; // inside the grace period: not closed yet
    await feed.housekeeping();
    expect(closed).toHaveLength(0);
    nowMs = (bucketSec + 60) * 1000 + 1500;
    await feed.housekeeping();
    await feed.housekeeping(); // idempotent
    expect(closed).toHaveLength(1);
    expect(closed[0].t).toBe(bucketSec * 1000);
    expect(closed[0].c).toBe(3123.45);

    // Next minute has no trades at all => REST has no candle => flat carry-forward candle
    nowMs = (bucketSec + 120) * 1000 + 2000;
    await feed.housekeeping();
    expect(closed).toHaveLength(2);
    expect(closed[1]).toMatchObject({ t: (bucketSec + 60) * 1000, o: 3123.45, h: 3123.45, l: 3123.45, c: 3123.45, v: 0 });
    feed.stop();
  });

  it('reports "down" with no fresh quote and recovers when quotes resume', async () => {
    const nowMs = Date.now();
    seedCandles(Math.floor(nowMs / 60000) * 60, 5);
    const feed = new DeltaMarketFeed({ client: mkClient(), endpoints: { ...endpoints(), wsPublicUrl: '' }, symbol: 'ETHUSD' });
    await feed.start();
    expect(feed.health().mode).toBe('down');
    ex.setQuote(3000, 3000.1);
    await feed.housekeeping();
    expect(feed.health().mode).toBe('rest-fallback');
    feed.stop();
  });
});
