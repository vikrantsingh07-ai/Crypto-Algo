// Test-only helpers (fake WebSocket + a fake exchange message stream). Not imported by any production code.
import { bookChecksum } from './book';
import type { WsLike } from './feed';
import type { RawLevel } from './protocol';

export class FakeWs implements WsLike {
  static instances: FakeWs[] = [];
  static failConstruct = false;
  static reset() {
    FakeWs.instances = [];
    FakeWs.failConstruct = false;
  }
  readyState = 0;
  sent: any[] = [];
  closedByClient = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(public url: string) {
    if (FakeWs.failConstruct) throw new Error('SecurityError');
    FakeWs.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closedByClient = true;
    this.readyState = 3;
  }
  // ---- server side ----
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  emit(obj: unknown) {
    this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) });
  }
  serverClose() {
    this.readyState = 3;
    this.onclose?.({});
  }
  get sentTypes(): string[] {
    return this.sent.map((m) => m.type);
  }
  static get last(): FakeWs {
    return FakeWs.instances[FakeWs.instances.length - 1];
  }
}

const us = (ms: number) => ms * 1000;

/** A tiny matching-engine stand-in that emits ob_updates frames with correct sequence numbers and checksums. */
export class FakeExchange {
  seq = 1000;
  asks = new Map<string, string>();
  bids = new Map<string, string>();
  constructor(public symbol = 'ETHUSD', public clock: () => number = Date.now) {}

  private sorted(side: 'asks' | 'bids'): RawLevel[] {
    return [...this[side].entries()]
      .map(([p, s]) => ({ price: Number(p), priceStr: p, size: Number(s), sizeStr: s }))
      .sort((a, b) => (side === 'asks' ? a.price - b.price : b.price - a.price));
  }
  private rows(side: 'asks' | 'bids') {
    return this.sorted(side).map((l) => [l.priceStr, l.sizeStr]);
  }
  private cs() {
    return bookChecksum(this.sorted('asks'), this.sorted('bids'));
  }

  seed(mid: number, levels = 40, tick = 0.05, size = 200) {
    this.asks.clear();
    this.bids.clear();
    for (let i = 0; i < levels; i++) {
      this.asks.set((mid + tick / 2 + i * tick).toFixed(2), String(size + ((i * 37) % 90)));
      this.bids.set((mid - tick / 2 - i * tick).toFixed(2), String(size + ((i * 53) % 90)));
    }
  }

  snapshot() {
    return { action: 'snapshot', a: this.rows('asks'), b: this.rows('bids'), ts: us(this.clock()), seq: ++this.seq, sy: this.symbol, type: 'ob_updates', cs: this.cs() };
  }

  /** change = [side, price, size]; size '0' deletes */
  update(changes: ['a' | 'b', string, string][], opts: { skipSeq?: number; badChecksum?: boolean } = {}) {
    const a: string[][] = [];
    const b: string[][] = [];
    for (const [side, p, s] of changes) {
      const m = side === 'a' ? this.asks : this.bids;
      if (s === '0') m.delete(p);
      else m.set(p, s);
      (side === 'a' ? a : b).push([p, s]);
    }
    this.seq += 1 + (opts.skipSeq ?? 0);
    return { action: 'update', a, b, seq: this.seq, ts: us(this.clock()), sy: this.symbol, type: 'ob_updates', cs: opts.badChecksum ? 1 : this.cs() };
  }

  l1() {
    const ask = this.sorted('asks')[0];
    const bid = this.sorted('bids')[0];
    return { type: 'ob_l1', sy: this.symbol, ap: ask?.priceStr ?? null, as: ask?.sizeStr ?? null, bp: bid?.priceStr ?? null, bs: bid?.sizeStr ?? null, lts: us(this.clock()), ts: us(this.clock()) };
  }

  l2() {
    return { type: 'ob_l2', sy: this.symbol, a: this.rows('asks').slice(0, 15), b: this.rows('bids').slice(0, 15), lts: us(this.clock()), ts: us(this.clock()) };
  }

  trade(price: number, buyerRole: 't' | 'm' = 't', size = 1) {
    return { type: 'trades', sy: this.symbol, p: price.toFixed(2), r: buyerRole, s: size, t: us(this.clock()), ts: us(this.clock()) };
  }

  candle(o: number, h: number, l: number, c: number, v = 100, tsMs = this.clock()) {
    return { type: 'candlestick_1m', res: '1m', sy: this.symbol, o, h, l, c, v, ts: us(tsMs) };
  }

  mark(p: number) {
    return { type: 'mark_price', sy: `MARK:${this.symbol}`, p: p.toFixed(4), ts: us(this.clock()) };
  }

  ticker(open24h: number) {
    return { type: 'ticker', sy: this.symbol, ohlc: [open24h, open24h * 1.01, open24h * 0.99, open24h], ts: us(this.clock()) };
  }
}
