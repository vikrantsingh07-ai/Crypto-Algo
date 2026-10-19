import { FeedClient, type WsCtor } from './feed';
import { MarketModel, type ConnState, type ModelEffect, type SeedQuote } from './model';
import { buildSubscribeAll, buildSubscribeBook, buildUnsubscribeBook, parseFeedMessage, DEFAULT_WS_URL } from './protocol';
import type { MarketState } from './types';

/**
 * External store behind useDeltaMarket (React's useSyncExternalStore): owns the socket, the pure model and the
 * render throttle. Framework-free so it can be driven by a fake WebSocket, fake timers and a fake rAF in tests.
 */

export interface StoreConfig {
  symbol: string;
  contractValue: number;
  levels: number;
  wsUrl?: string;
  /** false = never open the browser feed (backend quote only) */
  enabled?: boolean;
  seedQuote?: SeedQuote | null;
  seedCandles?: readonly unknown[];
  /** upper bound for React updates per second (default 20) */
  maxFps?: number;
}

export interface StoreEnv {
  WebSocketCtor?: WsCtor;
  now?: () => number;
  random?: () => number;
  raf?: (cb: (ts: number) => void) => unknown;
  cancelRaf?: (handle: unknown) => void;
  isHidden?: () => boolean;
  onVisibilityChange?: (cb: () => void) => () => void;
}

const HIDDEN_RESYNC_MS = 20_000;
const BOOK_WAIT_MS = 5_000;
const RESYNC_WINDOW_MS = 60_000;
const RESYNC_BURST = 6;

export class MarketStore {
  private readonly model: MarketModel;
  private readonly now: () => number;
  private readonly raf: (cb: (ts: number) => void) => unknown;
  private readonly cancelRaf: (h: unknown) => void;
  private readonly isHidden: () => boolean;
  private readonly onVisibility: (cb: () => void) => () => void;
  private readonly minInterval: number;
  private readonly listeners = new Set<() => void>();
  private readonly env: StoreEnv;

  private state: MarketState;
  private feed: FeedClient | null = null;
  private started = false;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private rafHandle: unknown = null;
  private dirty = false;
  private lastFlushAt = 0;
  private lastStatus: MarketState['status'];
  private unVisibility: (() => void) | null = null;
  private hiddenAt: number | null = null;
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;
  private resyncStamps: number[] = [];
  resyncCount = 0;

  constructor(private readonly cfg: StoreConfig, env: StoreEnv = {}) {
    this.now = env.now ?? Date.now;
    this.raf = env.raf ?? (typeof requestAnimationFrame === 'function' ? (cb) => requestAnimationFrame(cb) : (cb) => setTimeout(() => cb(this.now()), 16));
    this.cancelRaf = env.cancelRaf ?? (typeof cancelAnimationFrame === 'function' ? (h) => cancelAnimationFrame(h as number) : (h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.isHidden = env.isHidden ?? (() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
    this.onVisibility =
      env.onVisibilityChange ??
      ((cb) => {
        if (typeof document === 'undefined') return () => {};
        document.addEventListener('visibilitychange', cb);
        return () => document.removeEventListener('visibilitychange', cb);
      });
    this.minInterval = 1000 / (cfg.maxFps ?? 20) - 1;
    this.env = env;
    const now = this.now();
    this.model = new MarketModel({ symbol: cfg.symbol, contractValue: cfg.contractValue, levels: cfg.levels, feedEnabled: cfg.enabled !== false });
    this.model.setSeed(cfg.seedQuote, cfg.seedCandles, now);
    this.state = this.model.snapshot(now);
    this.lastStatus = this.state.status;
  }

  // ---- useSyncExternalStore API -----------------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.scheduleStart();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.shutdown();
    };
  };

  getSnapshot = (): MarketState => this.state;
  getServerSnapshot = (): MarketState => this.state;

  /** the model, for tests and diagnostics */
  get debug() {
    return { model: this.model, feed: this.feed };
  }

  // ---- inputs from the dashboard ------------------------------------------------------------------------------

  setSeed(quote: SeedQuote | null | undefined, candles: readonly unknown[] | undefined) {
    if (this.model.setSeed(quote, candles, this.now())) this.markDirty();
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------------

  /** Deferred by a tick so React StrictMode's mount/unmount/mount never opens (and instantly closes) a socket. */
  private scheduleStart() {
    if (this.started || this.startTimer) return;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      this.start();
    }, 0);
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.unVisibility = this.onVisibility(this.handleVisibility);
    if (this.cfg.enabled === false) return;
    const now = this.now();
    this.model.feedStarted(now);
    this.feed = new FeedClient({
      url: this.cfg.wsUrl ?? DEFAULT_WS_URL,
      WebSocketCtor: this.env.WebSocketCtor,
      now: this.now,
      random: this.env.random,
      onOpen: (send) => {
        send(buildSubscribeAll(this.cfg.symbol));
      },
      onFrame: this.handleFrame,
      onState: this.handleConn,
      onTick: this.handleTick,
    });
    this.feed.start();
    this.markDirty();
  }

  private shutdown() {
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    this.resyncTimer = null;
    if (this.rafHandle !== null) this.cancelRaf(this.rafHandle);
    this.rafHandle = null;
    this.unVisibility?.();
    this.unVisibility = null;
    this.feed?.stop();
    this.feed = null;
    this.started = false;
    this.model.setConnection('stopped', this.now());
  }

  /** hard stop regardless of subscribers (tests) */
  destroy() {
    this.listeners.clear();
    this.shutdown();
  }

  // ---- socket callbacks --------------------------------------------------------------------------------------

  private handleConn = (s: ConnState, now: number) => {
    this.model.setConnection(s, now);
    this.markDirty();
  };

  private handleFrame = (data: string, now: number) => {
    this.model.noteMessage(now);
    const ev = parseFeedMessage(data);
    if (!ev) return;
    const r = this.model.ingest(ev, now);
    for (const e of r.effects) this.runEffect(e);
    if (r.changed) this.markDirty();
  };

  private runEffect(e: ModelEffect) {
    if (e.type === 'resync-book') this.requestResync(e.delayMs);
  }

  private handleTick = (now: number) => {
    const st = this.model.status(now);
    if (st !== this.lastStatus) this.markDirty();
    const waiting = this.model.bookWaitingSince;
    if (waiting !== null && now - waiting > BOOK_WAIT_MS && this.feed?.state === 'open') this.requestResync(0);
  };

  // ---- order-book resynchronisation (documented: unsubscribe + subscribe to get a fresh snapshot) -----------

  private requestResync(delayMs: number) {
    if (this.resyncTimer || !this.feed) return;
    const now = this.now();
    this.resyncStamps = this.resyncStamps.filter((t) => now - t < RESYNC_WINDOW_MS);
    // A book that keeps failing must not hammer the server: after a burst, retry only every 30 s (depth meanwhile comes from ob_l2).
    const wait = this.resyncStamps.length >= RESYNC_BURST ? 30_000 : delayMs;
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null;
      const feed = this.feed;
      if (!feed || feed.state !== 'open') return;
      const t = this.now();
      this.resyncStamps.push(t);
      this.resyncCount++;
      this.model.beginBookResync(t);
      feed.send(buildUnsubscribeBook(this.cfg.symbol));
      feed.send(buildSubscribeBook(this.cfg.symbol));
      this.markDirty();
    }, wait);
  }

  private handleVisibility = () => {
    const now = this.now();
    if (this.isHidden()) {
      this.hiddenAt = now;
      if (this.rafHandle !== null) this.cancelRaf(this.rafHandle);
      this.rafHandle = null;
      return;
    }
    const hiddenFor = this.hiddenAt === null ? 0 : now - this.hiddenAt;
    this.hiddenAt = null;
    this.feed?.checkNow();
    if (hiddenFor > HIDDEN_RESYNC_MS && this.feed?.state === 'open') this.requestResync(0);
    this.dirty = true;
    this.schedule();
  };

  // ---- render throttle ---------------------------------------------------------------------------------------

  private markDirty() {
    this.dirty = true;
    this.schedule();
  }

  private schedule() {
    if (this.rafHandle !== null || !this.dirty || this.isHidden()) return;
    this.rafHandle = this.raf(this.frame);
  }

  private frame = () => {
    this.rafHandle = null;
    if (!this.dirty) return;
    const now = this.now();
    if (now - this.lastFlushAt < this.minInterval) {
      this.schedule();
      return;
    }
    this.flush(now);
  };

  private flush(now: number) {
    this.dirty = false;
    this.lastFlushAt = now;
    this.state = this.model.snapshot(now);
    this.lastStatus = this.state.status;
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        /* one broken subscriber must not starve the others */
      }
    }
  }
}
