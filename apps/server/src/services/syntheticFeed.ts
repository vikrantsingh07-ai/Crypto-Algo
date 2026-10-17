import { EventEmitter } from 'node:events';
import { generateSyntheticCandles, gaussian, mulberry32, type Candle, type Quote } from '@cryptoalgo/core';
import type { FeedHealth, MarketFeed } from '@cryptoalgo/delta';

/**
 * ⚠ SYNTHETIC DEV FEED — NOT REAL MARKET DATA.
 * Enabled only with MARKET_DATA_SOURCE=synthetic (blocked in production). Produces a random-walk
 * ETH-like series so the UI and engines can be exercised offline. Every API response that carries
 * market data includes `synthetic: true` and the dashboard shows a prominent banner.
 * `speed` accelerates virtual time (speed=60 => one candle per real second) for quick demos.
 */
export class SyntheticFeed extends EventEmitter implements MarketFeed {
  readonly synthetic = true;
  private virtualNow: number;
  private lastReal = Date.now();
  private closed: Candle[];
  private forming: Candle;
  private quote: Quote;
  private timer: NodeJS.Timeout | null = null;
  private rand: () => number;
  private price: number;

  constructor(private readonly opts: { seed?: number; speed?: number; startPrice?: number; tickMs?: number } = {}) {
    super();
    const startPrice = opts.startPrice ?? 3000;
    this.virtualNow = Date.now();
    const bucket = Math.floor(this.virtualNow / 60_000) * 60_000;
    this.closed = generateSyntheticCandles({ seed: opts.seed ?? 1, count: 600, startPrice, startTime: bucket - 600 * 60_000, volatility: 0.0006 });
    const last = this.closed[this.closed.length - 1];
    this.price = last.c;
    this.forming = { t: bucket, o: this.price, h: this.price, l: this.price, c: this.price, v: 0 };
    this.quote = { ts: this.virtualNow, bid: this.price - 0.05, ask: this.price + 0.05, last: this.price };
    this.rand = mulberry32((opts.seed ?? 1) + 99);
  }

  now(): number {
    return this.virtualNow;
  }

  async start(): Promise<void> {
    if (this.timer) return;
    this.lastReal = Date.now();
    this.timer = setInterval(() => this.step(), this.opts.tickMs ?? 250);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private step() {
    const real = Date.now();
    const speed = this.opts.speed ?? 1;
    this.virtualNow += (real - this.lastReal) * speed;
    this.lastReal = real;
    // one micro-step of the random walk per tick (scaled so volatility per virtual minute is stable)
    const dtMin = ((this.opts.tickMs ?? 250) * speed) / 60_000;
    const vol = 0.0006 * Math.sqrt(Math.max(dtMin, 1e-6));
    this.price = Math.max(1, this.price * (1 + vol * gaussian(this.rand)));
    const px = Math.round(this.price * 20) / 20;
    const bucket = Math.floor(this.virtualNow / 60_000) * 60_000;
    while (bucket > this.forming.t) {
      const done = { ...this.forming };
      this.closed.push(done);
      if (this.closed.length > 700) this.closed.shift();
      this.forming = { t: this.forming.t + 60_000, o: done.c, h: done.c, l: done.c, c: done.c, v: 0 };
      this.emit('candleClosed', done);
    }
    this.forming.h = Math.max(this.forming.h, px);
    this.forming.l = Math.min(this.forming.l, px);
    this.forming.c = px;
    this.forming.v += 1 + Math.floor(this.rand() * 5);
    this.quote = { ts: this.virtualNow, bid: px - 0.05, ask: px + 0.05, last: px };
    this.emit('quote', this.quote);
  }

  getQuote() {
    return this.quote;
  }
  getClosedCandles() {
    return this.closed;
  }
  getFormingCandle() {
    return this.forming;
  }
  getFundingRate() {
    return 0.0001;
  }
  health(): FeedHealth {
    return { mode: 'synthetic', wsState: 'synthetic', lastQuoteAt: this.quote.ts, lastCandleAt: this.closed[this.closed.length - 1]?.t ?? null, restOk: true, lastError: null, reconnects: 0 };
  }
}
