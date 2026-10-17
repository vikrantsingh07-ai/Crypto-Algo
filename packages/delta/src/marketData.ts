import { EventEmitter } from 'node:events';
import type { Candle, Quote } from '@cryptoalgo/core';
import type { DeltaClient } from './client';
import type { DeltaEndpoints } from './env';
import type { Logger } from './http';
import { noopLogger } from './http';
import type { FeedHealth, MarketFeed } from './types';
import { DeltaWs } from './ws';

const MIN_MS = 60_000;

export interface MarketFeedOptions {
  client: DeltaClient;
  endpoints: DeltaEndpoints;
  symbol: string;
  /** How many 1m candles to keep / seed (default 600). */
  candleHistory?: number;
  /** REST ticker polling interval used while the websocket is not delivering quotes. */
  fallbackPollMs?: number;
  /** How long after a minute boundary we wait before declaring the previous candle closed. */
  closeGraceMs?: number;
  logger?: Logger;
  now?: () => number;
  /** Test hook. */
  wsFactory?: (url: string, name: string) => DeltaWs;
}

/**
 * Real Delta Exchange market data feed (ETH 1m candles + top-of-book quote).
 *
 *  - seeds history with `GET /v2/history/candles`
 *  - streams `ob_l1` (best bid/ask), `trades` (last), `candlestick_1m`, `mark_price`, `funding_rate`
 *    from the PUBLIC websocket endpoint (no credentials required)
 *  - confirms every closed candle against REST (authoritative) shortly after the minute rolls
 *  - falls back to REST ticker polling if the websocket stops delivering quotes
 */
export class DeltaMarketFeed extends EventEmitter implements MarketFeed {
  private readonly client: DeltaClient;
  private readonly symbol: string;
  private readonly logger: Logger;
  private readonly clock: () => number;
  private readonly historyMax: number;
  private readonly pollMs: number;
  private readonly graceMs: number;

  private ws: DeltaWs | null = null;
  private quote: Quote | null = null;
  private lastQuoteAt: number | null = null;
  private lastCandleAt: number | null = null;
  private closed: Candle[] = [];
  private forming: Candle | null = null;
  private lastClosedBucket = 0;
  private funding: number | null = null;
  private restOk = false;
  private lastError: string | null = null;
  private timers: NodeJS.Timeout[] = [];
  private closeChain: Promise<void> = Promise.resolve();
  private started = false;

  constructor(private readonly opts: MarketFeedOptions) {
    super();
    this.client = opts.client;
    this.symbol = opts.symbol;
    this.logger = opts.logger ?? noopLogger;
    this.clock = opts.now ?? Date.now;
    this.historyMax = opts.candleHistory ?? 600;
    this.pollMs = opts.fallbackPollMs ?? 2_000;
    this.graceMs = opts.closeGraceMs ?? 1_500;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.seed().catch((e) => this.noteError(e));
    this.startWs();
    this.timers.push(setInterval(() => void this.housekeeping(), 1_000));
    this.timers.push(setInterval(() => this.emit('health', this.health()), 5_000));
    for (const t of this.timers) t.unref?.();
  }

  stop() {
    this.started = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.ws?.stop();
    this.ws = null;
  }

  private noteError(e: unknown) {
    this.lastError = e instanceof Error ? e.message : String(e);
    this.logger.warn('market data error', { error: this.lastError });
  }

  // ---- seeding ----
  private bucketOf(ms: number) {
    return Math.floor(ms / MIN_MS) * MIN_MS;
  }

  private async seed() {
    const nowS = Math.floor(this.clock() / 1000);
    const rows = await this.client.getCandles(this.symbol, '1m', nowS - this.historyMax * 60, nowS);
    this.restOk = true;
    const current = this.bucketOf(this.clock());
    this.closed = rows.filter((c) => c.t < current);
    const f = rows.find((c) => c.t === current);
    this.forming = f ?? null;
    this.lastClosedBucket = this.closed.length ? this.closed[this.closed.length - 1].t : current - MIN_MS;
    if (this.closed.length) this.lastCandleAt = this.clock();
    this.trim();
  }

  private trim() {
    if (this.closed.length > this.historyMax) this.closed.splice(0, this.closed.length - this.historyMax);
  }

  // ---- websocket ----
  private startWs() {
    const url = this.opts.endpoints.wsPublicUrl;
    if (!url) {
      this.logger.warn('no public websocket url configured; REST fallback only');
      return;
    }
    const ws = this.opts.wsFactory ? this.opts.wsFactory(url, 'public') : new DeltaWs({ url, name: 'public', logger: this.logger, now: this.clock });
    this.ws = ws;
    ws.subscribe([
      { name: 'ob_l1', symbols: [this.symbol] },
      { name: 'trades', symbols: [this.symbol] },
      { name: 'candlestick_1m', symbols: [this.symbol] },
      { name: 'mark_price', symbols: [`MARK:${this.symbol}`] },
      { name: 'funding_rate', symbols: [this.symbol] },
    ]);
    ws.on('message', (m) => this.onMessage(m));
    ws.on('state', () => this.emit('health', this.health()));
    ws.start();
  }

  private onMessage(m: any) {
    const t = this.clock();
    switch (m.type) {
      case 'ob_l1': {
        if (m.sy !== this.symbol) return;
        const bid = Number(m.bp);
        const ask = Number(m.ap);
        if (!(bid > 0 && ask > 0)) return;
        this.setQuote({ ts: t, bid, ask, last: this.quote?.last ?? (bid + ask) / 2, mark: this.quote?.mark, bidSize: Number(m.bs), askSize: Number(m.as) });
        break;
      }
      case 'trades': {
        if (m.sy !== this.symbol) return;
        const p = Number(m.p);
        if (p > 0 && this.quote) this.setQuote({ ...this.quote, ts: t, last: p });
        else if (p > 0) this.quote = { ts: t, bid: p, ask: p, last: p };
        break;
      }
      case 'mark_price': {
        const p = Number(m.p);
        if (p > 0 && this.quote) this.quote = { ...this.quote, mark: p };
        break;
      }
      case 'funding_rate': {
        if (m.sy !== this.symbol) return;
        // Delta publishes the rate in percent (sample 0.01 == 0.01% per 8h); convert to a fraction.
        const fr = Number(m.fr);
        if (Number.isFinite(fr)) this.funding = fr / 100;
        break;
      }
      case 'candlestick_1m': {
        if (m.sy !== this.symbol) return;
        // `ts` is the publish time in microseconds, so the candle bucket is derived from it.
        const ts = Number(m.ts) / 1000;
        if (!Number.isFinite(ts)) return;
        this.onWsCandle(this.bucketOf(ts), { o: Number(m.o), h: Number(m.h), l: Number(m.l), c: Number(m.c), v: Number(m.v ?? 0) });
        break;
      }
      default:
        break;
    }
  }

  private setQuote(q: Quote) {
    this.quote = q;
    this.lastQuoteAt = q.ts;
    this.emit('quote', q);
  }

  private onWsCandle(bucket: number, c: { o: number; h: number; l: number; c: number; v: number }) {
    if (!(c.o > 0 && c.c > 0)) return;
    if (this.forming && this.forming.t !== bucket && bucket > this.forming.t) {
      // A newer bucket started: the previous candle is complete.
      void this.closeUpTo(this.forming.t);
    }
    if (!this.forming || bucket >= this.forming.t) this.forming = { t: bucket, ...c };
  }

  // ---- periodic housekeeping: candle close + REST fallback ----
  /** Periodic work: close finished minutes and fall back to REST polling. Public so tests can drive it. */
  async housekeeping() {
    const t = this.clock();
    const current = this.bucketOf(t);
    if (t - current >= this.graceMs && this.lastClosedBucket < current - MIN_MS) {
      // every bucket before `current` that has not been closed yet
      await this.closeUpTo(current - MIN_MS);
    }
    const wsStale = this.lastQuoteAt === null || t - this.lastQuoteAt > this.pollMs * 1.5 + 1_000;
    if (wsStale) await this.pollRest();
  }

  private async pollRest() {
    try {
      const tk = await this.client.getTicker(this.symbol);
      this.restOk = true;
      if (tk.quote) this.setQuote({ ...tk.quote, ts: this.clock() });
    } catch (e) {
      this.restOk = false;
      this.noteError(e);
    }
  }

  /** Close every pending minute bucket up to and including `target`, strictly in order. */
  private closeUpTo(target: number): Promise<void> {
    this.closeChain = this.closeChain.then(async () => {
      for (let b = this.lastClosedBucket + MIN_MS; b <= target; b += MIN_MS) await this.closeBucket(b);
    });
    return this.closeChain;
  }

  private async closeBucket(bucket: number) {
    if (bucket <= this.lastClosedBucket) return;
    let candle: Candle | null = null;
    try {
      const s = Math.floor(bucket / 1000);
      const rows = await this.client.getCandles(this.symbol, '1m', s - 60, s + 60);
      this.restOk = true;
      candle = rows.find((c) => c.t === bucket) ?? null;
    } catch (e) {
      this.restOk = false;
      this.noteError(e);
    }
    if (!candle && this.forming && this.forming.t === bucket) candle = { ...this.forming };
    if (!candle) {
      // No trades in that minute: carry the previous close forward so indicators stay continuous.
      const prev = this.closed[this.closed.length - 1];
      if (!prev) {
        this.lastClosedBucket = bucket;
        return;
      }
      candle = { t: bucket, o: prev.c, h: prev.c, l: prev.c, c: prev.c, v: 0 };
    }
    this.closed.push(candle);
    this.lastClosedBucket = bucket;
    this.lastCandleAt = this.clock();
    if (this.forming && this.forming.t <= bucket) this.forming = null;
    this.trim();
    this.emit('candleClosed', candle);
  }

  // ---- MarketFeed ----
  getQuote(): Quote | null {
    return this.quote;
  }
  getClosedCandles(): Candle[] {
    return this.closed;
  }
  getFormingCandle(): Candle | null {
    return this.forming;
  }
  getFundingRate(): number | null {
    return this.funding;
  }

  health(): FeedHealth {
    const t = this.clock();
    const wsReady = this.ws?.state === 'ready' && this.lastQuoteAt !== null && t - this.lastQuoteAt < 5_000;
    const quoteFresh = this.lastQuoteAt !== null && t - this.lastQuoteAt < 10_000;
    return {
      mode: wsReady ? 'ws' : quoteFresh ? 'rest-fallback' : 'down',
      wsState: this.ws?.state ?? 'none',
      lastQuoteAt: this.lastQuoteAt,
      lastCandleAt: this.lastCandleAt,
      restOk: this.restOk,
      lastError: this.lastError ?? this.ws?.lastError ?? null,
      reconnects: this.ws?.reconnects ?? 0,
    };
  }
}
