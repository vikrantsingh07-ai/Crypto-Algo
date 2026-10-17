import { generateSyntheticCandles, gaussian, mulberry32 } from '@cryptoalgo/core';
import { MockDeltaExchange } from '@cryptoalgo/delta/mock';

/**
 * `npm run dev:mock` — runs the full server against a LOCAL MOCK of the Delta Exchange API
 * (REST + WebSocket, signature checking, a tiny matching engine). Nothing here touches the internet
 * or any real account; use it to try the dashboard, the Live activation flow and the kill switch safely.
 * The mock's prices are a random walk — they are NOT market data.
 */
const KEY = 'mock-api-key-0001';
const SECRET = 'mock-api-secret-0001';
const port = Number(process.env.MOCK_PORT ?? 9911);

const ex = new MockDeltaExchange({ port, apiKey: KEY, apiSecret: SECRET, startingBalance: 500, startPrice: 3000, heartbeatMs: 10_000 });
await ex.start();

// seed 600 minutes of history ending at the current minute
const hist = generateSyntheticCandles({ seed: 5, count: 600, startPrice: 3000, startTime: Math.floor(Date.now() / 60_000) * 60_000 - 600 * 60_000, volatility: 0.0006 });
ex.candles = hist.map((c) => ({ time: c.t / 1000, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v }));
let price = hist[hist.length - 1].c;
const rand = mulberry32(77);
const tick = () => {
  price = Math.max(100, price * (1 + 0.00025 * gaussian(rand)));
  const px = Math.round(price * 20) / 20;
  const bucket = Math.floor(Date.now() / 60_000) * 60;
  let cur = ex.candles[ex.candles.length - 1];
  if (cur.time < bucket) {
    cur = { time: bucket, open: px, high: px, low: px, close: px, volume: 0 };
    ex.candles.push(cur);
  }
  cur.high = Math.max(cur.high, px);
  cur.low = Math.min(cur.low, px);
  cur.close = px;
  cur.volume += 1 + Math.floor(rand() * 4);
  ex.setQuote(px - 0.05, px + 0.05, px);
  ex.pushCandleUpdate({ o: cur.open, h: cur.high, l: cur.low, c: cur.close, v: cur.volume });
};
tick();
setInterval(tick, 500).unref?.();
setInterval(() => ex.pushFunding(), 5000).unref?.();

Object.assign(process.env, {
  DELTA_ENV: 'custom',
  DELTA_REST_URL: ex.restUrl,
  DELTA_WS_PUBLIC_URL: ex.wsUrl,
  DELTA_WS_PRIVATE_URL: ex.wsUrl,
  DELTA_LABEL: 'LOCAL MOCK EXCHANGE (not Delta — no real funds)',
  DELTA_REAL_MONEY: 'false',
  MARKET_DATA_SOURCE: 'delta',
});
if (!process.env.DELTA_API_KEY) {
  process.env.DELTA_API_KEY = KEY;
  process.env.DELTA_API_SECRET = SECRET;
}
process.stdout.write(`\n  Mock Delta exchange listening on ${ex.restUrl} (key: ${KEY})\n  Prices are a random walk, NOT market data.\n\n`);
await import('../main');
