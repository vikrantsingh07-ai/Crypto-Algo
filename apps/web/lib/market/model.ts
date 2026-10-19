import { OrderBook } from './book';
import { CandleSeries, minuteStart } from './candles';
import type { FeedEvent, RawLevel } from './protocol';
import type { BookLevel, MarketState, MarketStatus } from './types';

/**
 * Pure state machine behind useDeltaMarket: feed events + connection state + backend seed in, MarketState out.
 * No timers, no I/O, no React: the caller passes `now` (ms) everywhere, which keeps it fully testable.
 */

export type ConnState = 'idle' | 'connecting' | 'open' | 'backoff' | 'stopped';

export interface SeedQuote {
  bid: number;
  ask: number;
  last: number;
  ts?: number;
}

export interface ModelConfig {
  symbol: string;
  /** ETH per contract */
  contractValue: number;
  levels: number;
  /** feed considered stale after this much silence (default 10 s) */
  staleMs?: number;
  /** while the first connection has not delivered anything yet, status stays "connecting" for this long (default 8 s) */
  connectGraceMs?: number;
  /** false = browser feed disabled, the backend seed is all there is */
  feedEnabled?: boolean;
}

export type ModelEffect = { type: 'resync-book'; delayMs: number; reason: string };

export interface IngestResult {
  changed: boolean;
  effects: ModelEffect[];
}

const NOTHING: IngestResult = { changed: false, effects: [] };
const TRADE_FRESH_MS = 2_000;
const CANDLE_FRESH_MS = 5_000;
const L1_FRESH_MS = 6_000;
const L2_FRESH_MS = 3_000;
const DEPTH_HOLD_MS = 3_000;
const SEED_USABLE_MS = 120_000;
const STALE_TRADE_REPLAY_MS = 2_000;
const MAX_SEED_CANDLES = 600;

interface Depth {
  bids: BookLevel[];
  asks: BookLevel[];
  at: number;
}

export class MarketModel {
  readonly book = new OrderBook();
  readonly candles = new CandleSeries();
  readonly channelErrors = new Map<string, string>();

  private readonly cfg: Required<ModelConfig>;
  private conn: ConnState = 'idle';
  private connOpenedAt = 0;
  private startedAt: number | null = null;
  private everLive = false;
  private lastMessageAt = 0;
  private dataSinceOpen = false;

  private l1: { bid: number | null; ask: number | null; at: number } | null = null;
  private l2: { bids: RawLevel[]; asks: RawLevel[]; at: number } | null = null;
  private trade: { price: number; at: number; tsMs: number | null; side: 'buy' | 'sell' | null } | null = null;
  private candleAt = 0;
  private mark: number | null = null;
  private open24h: number | null = null;
  private lastDepth: Depth | null = null;
  private seed: SeedQuote | null = null;
  private seedChangedAt = 0;
  bookWaitingSince: number | null = null;

  constructor(cfg: ModelConfig) {
    this.cfg = { staleMs: 10_000, connectGraceMs: 8_000, feedEnabled: true, ...cfg };
  }

  // ---- inputs -------------------------------------------------------------------------------------------------

  /** The caller started the feed (first connection attempt). */
  feedStarted(now: number) {
    if (this.startedAt === null) this.startedAt = now;
  }

  setConnection(state: ConnState, now: number) {
    if (state === this.conn) return;
    this.conn = state;
    if (state === 'open') {
      this.connOpenedAt = now;
      this.lastMessageAt = now;
      this.dataSinceOpen = false;
      this.book.reset();
      this.bookWaitingSince = now;
      this.channelErrors.clear();
    } else {
      this.book.reset();
      this.bookWaitingSince = null;
    }
  }

  private markData(now: number) {
    this.dataSinceOpen = true;
    this.everLive = true;
    this.lastMessageAt = now;
  }

  /** The caller is about to unsubscribe + subscribe the book channel: drop the local copy and wait for the new snapshot. */
  beginBookResync(now: number) {
    this.book.reset();
    this.bookWaitingSince = now;
  }

  /** Any inbound frame at all (heartbeat, ack, garbage): proof the link is alive. */
  noteMessage(now: number) {
    this.lastMessageAt = now;
  }

  setSeed(quote: SeedQuote | null | undefined, candles: readonly unknown[] | undefined | null, now: number): boolean {
    let changed = false;
    const q = quote && quote.last > 0 && Number.isFinite(quote.last) ? quote : null;
    if (q && (!this.seed || this.seed.last !== q.last || this.seed.bid !== q.bid || this.seed.ask !== q.ask)) {
      this.seed = { bid: q.bid, ask: q.ask, last: q.last, ts: q.ts };
      this.seedChangedAt = now;
      changed = true;
    } else if (q && this.seed && q.ts !== this.seed.ts) {
      this.seed = { ...this.seed, ts: q.ts };
    }
    if (candles && candles.length) {
      const slice = candles.length > MAX_SEED_CANDLES ? candles.slice(candles.length - MAX_SEED_CANDLES) : candles;
      if (this.candles.mergeSeed(slice, !this.isLive(now))) changed = true;
    }
    return changed;
  }

  ingest(ev: FeedEvent, now: number): IngestResult {
    const sym = this.cfg.symbol;
    switch (ev.kind) {
      case 'heartbeat':
      case 'other':
        return NOTHING;
      case 'subscriptions': {
        for (const c of ev.channels) {
          if (c.error) this.channelErrors.set(c.name, c.error);
          else this.channelErrors.delete(c.name);
        }
        return NOTHING;
      }
      case 'l1': {
        if (ev.symbol !== sym) return NOTHING;
        this.markData(now);
        this.l1 = { bid: ev.bid, ask: ev.ask, at: now };
        return { changed: true, effects: [] };
      }
      case 'l2': {
        if (ev.symbol !== sym) return NOTHING;
        this.markData(now);
        this.l2 = { bids: ev.bids, asks: ev.asks, at: now };
        return { changed: !this.book.synced, effects: [] };
      }
      case 'book': {
        if (ev.symbol !== sym) return NOTHING;
        this.markData(now);
        const r = this.book.apply(ev);
        if (r.status === 'applied') {
          this.bookWaitingSince = null;
          return { changed: true, effects: [] };
        }
        if (r.status === 'resync') {
          this.bookWaitingSince = now;
          return { changed: true, effects: [{ type: 'resync-book', delayMs: 0, reason: r.reason }] };
        }
        return NOTHING;
      }
      case 'book-error': {
        if (ev.symbol && ev.symbol !== sym) return NOTHING;
        this.book.reset();
        this.bookWaitingSince = now;
        return { changed: true, effects: [{ type: 'resync-book', delayMs: 3_000, reason: 'server-error' }] };
      }
      case 'trade': {
        if (ev.symbol !== sym) return NOTHING;
        this.markData(now);
        const prev = this.trade;
        if (prev && prev.tsMs !== null && ev.tsMs !== null && ev.tsMs < prev.tsMs - STALE_TRADE_REPLAY_MS) return NOTHING; // old frame, not a new price
        this.trade = { price: ev.price, at: now, tsMs: ev.tsMs, side: ev.takerSide };
        this.candles.applyTick(ev.price, ev.tsMs ?? now);
        return { changed: true, effects: [] };
      }
      case 'candle': {
        if (ev.symbol !== sym) return NOTHING;
        this.markData(now);
        this.candleAt = now;
        this.candles.applyLive(ev.candle, ev.tsMs);
        // keep the forming candle's tip consistent with a trade that arrived just before this (possibly older-stamped) message
        if (this.trade && now - this.trade.at < 1_000 && minuteStart(this.trade.tsMs ?? now) === ev.candle.t) this.candles.applyTick(this.trade.price, this.trade.tsMs ?? now);
        return { changed: true, effects: [] };
      }
      case 'mark': {
        if (ev.symbol !== `MARK:${sym}`) return NOTHING;
        this.markData(now);
        this.mark = ev.price;
        return { changed: true, effects: [] };
      }
      case 'ticker': {
        if (ev.symbol !== sym) return NOTHING;
        this.markData(now);
        if (ev.open24h !== null) this.open24h = ev.open24h;
        if (ev.mark !== null && this.mark === null) this.mark = ev.mark;
        return { changed: true, effects: [] };
      }
    }
  }

  // ---- outputs ------------------------------------------------------------------------------------------------

  private feedFresh(now: number): boolean {
    return this.conn === 'open' && this.dataSinceOpen && now - this.lastMessageAt <= this.cfg.staleMs && this.livePrice(now) !== null;
  }

  isLive(now: number): boolean {
    return this.cfg.feedEnabled && this.feedFresh(now);
  }

  private seedUsable(now: number): boolean {
    return this.seed !== null && now - this.seedChangedAt <= SEED_USABLE_MS;
  }

  status(now: number): MarketStatus {
    if (this.isLive(now)) return 'live';
    const usable = this.seedUsable(now);
    if (this.cfg.feedEnabled && !this.everLive && (this.startedAt === null || now - this.startedAt < this.cfg.connectGraceMs)) return 'connecting';
    return usable ? 'fallback' : 'down';
  }

  private bestFromBook(): { bid: number | null; ask: number | null } | null {
    if (!this.book.synced) return null;
    return { bid: this.book.bids[0]?.price ?? null, ask: this.book.asks[0]?.price ?? null };
  }

  private topOfBook(now: number): { bid: number | null; ask: number | null } {
    const b = this.bestFromBook();
    if (b && (b.bid !== null || b.ask !== null)) return b;
    if (this.l1 && now - this.l1.at <= L1_FRESH_MS) return { bid: this.l1.bid, ask: this.l1.ask };
    if (this.l2 && now - this.l2.at <= L2_FRESH_MS) return { bid: this.l2.bids[0]?.price ?? null, ask: this.l2.asks[0]?.price ?? null };
    return { bid: null, ask: null };
  }

  /** last traded price; falls back to the forming candle, then the mid price, only when the tape is quiet */
  private livePrice(now: number): number | null {
    if (this.trade && now - this.trade.at <= TRADE_FRESH_MS) return this.trade.price;
    const last = this.candles.last();
    if (last && this.candleAt > 0 && now - this.candleAt <= CANDLE_FRESH_MS) return last.c;
    const tob = this.topOfBook(now);
    if (tob.bid !== null && tob.ask !== null) return (tob.bid + tob.ask) / 2;
    if (this.trade) return this.trade.price;
    return last && this.candleAt > 0 ? last.c : null;
  }

  private mapLevels(rows: readonly RawLevel[]): BookLevel[] {
    const n = Math.min(this.cfg.levels, rows.length);
    const out: BookLevel[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = { price: rows[i].price, size: Math.round(rows[i].size * this.cfg.contractValue * 1e6) / 1e6 };
    return out;
  }

  private depth(now: number): { bids: BookLevel[]; asks: BookLevel[] } {
    if (this.book.synced) {
      const d = { bids: this.mapLevels(this.book.bids), asks: this.mapLevels(this.book.asks), at: now };
      this.lastDepth = d;
      return d;
    }
    if (this.l2 && now - this.l2.at <= L2_FRESH_MS) {
      const d = { bids: this.mapLevels(this.l2.bids), asks: this.mapLevels(this.l2.asks), at: now };
      this.lastDepth = d;
      return d;
    }
    if (this.lastDepth && now - this.lastDepth.at <= DEPTH_HOLD_MS) return this.lastDepth;
    return { bids: [], asks: [] };
  }

  snapshot(now: number): MarketState {
    const status = this.status(now);
    const symbol = this.cfg.symbol;
    if (status === 'live') {
      const price = this.livePrice(now);
      const tob = this.topOfBook(now);
      const d = this.depth(now);
      let changePct: number | null = null;
      let changeLabel: string | null = null;
      if (price !== null && this.open24h !== null) {
        changePct = (price / this.open24h - 1) * 100;
        changeLabel = '24h';
      } else if (price !== null) {
        const w = this.candles.windowChange(price);
        if (w) {
          changePct = w.pct;
          changeLabel = w.label;
        }
      }
      return {
        status,
        symbol,
        price,
        bid: tob.bid,
        ask: tob.ask,
        mark: this.mark,
        changePct,
        changeLabel,
        lastTradeSide: this.trade?.side ?? null,
        bids: d.bids,
        asks: d.asks,
        candles: this.candles.toArray(),
        updatedAt: this.lastMessageAt,
        source: 'delta-ws',
      };
    }
    // Not live: never show a frozen or empty price if the backend quote is there.
    const q = this.seed;
    const usable = this.seedUsable(now);
    const feedPrice = this.trade?.price ?? null;
    const price = usable || !feedPrice ? (q?.last ?? null) : feedPrice;
    const source: MarketState['source'] = price === null ? 'none' : usable || !feedPrice ? 'backend' : 'delta-ws';
    let changePct: number | null = null;
    let changeLabel: string | null = null;
    if (price !== null) {
      const w = this.candles.windowChange(price);
      if (w) {
        changePct = w.pct;
        changeLabel = w.label;
      }
    }
    return {
      status,
      symbol,
      price,
      bid: source === 'backend' && q ? q.bid : null,
      ask: source === 'backend' && q ? q.ask : null,
      mark: this.mark,
      changePct,
      changeLabel,
      lastTradeSide: null,
      bids: [],
      asks: [],
      candles: this.candles.toArray(),
      // browser clock: when we last RECEIVED a changed backend quote (a server timestamp could disagree with this machine's clock)
      updatedAt: source === 'backend' ? this.seedChangedAt : this.lastMessageAt,
      source,
    };
  }
}
