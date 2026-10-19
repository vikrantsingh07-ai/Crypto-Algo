import type { ConnState } from './model';

/**
 * Browser WebSocket lifecycle for the public Delta feed: connect, send subscriptions, detect silence, reconnect with
 * exponential back-off + jitter. It knows nothing about market data. Every socket gets a generation number, so late
 * events from a superseded socket (reconnect race, StrictMode double mount) are ignored.
 */

/** The slice of the WebSocket API we use, so tests can inject a fake. */
export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WsCtor = new (url: string) => WsLike;

export interface FeedClientOptions {
  url: string;
  WebSocketCtor?: WsCtor;
  now?: () => number;
  random?: () => number;
  /** silence (any message) longer than this => reconnect; default 10 s */
  staleMs?: number;
  /** handshake not finished after this => abort and retry; default 10 s */
  connectTimeoutMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /** a connection that stayed up this long resets the back-off; default 15 s */
  healthyAfterMs?: number;
  /** called right after the socket opens (send heartbeat + subscriptions here) */
  onOpen: (send: (obj: unknown) => boolean) => void;
  /** every inbound frame (string payloads only; binary frames are counted as liveness but not delivered) */
  onFrame: (data: string, now: number) => void;
  onState: (state: ConnState, now: number, reason?: string) => void;
  /** called every second while running, after liveness checks */
  onTick?: (now: number) => void;
}

const OPEN = 1;

export class FeedClient {
  state: ConnState = 'idle';
  reconnects = 0;

  private ws: WsLike | null = null;
  private gen = 0;
  private attempt = 0;
  private failures = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private connectStartedAt = 0;
  private openedAt = 0;
  private lastMessageAt = 0;
  private running = false;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly o: FeedClientOptions) {
    this.now = o.now ?? Date.now;
    this.random = o.random ?? Math.random;
  }

  private setState(s: ConnState, reason?: string) {
    if (this.state === s) return;
    this.state = s;
    try {
      this.o.onState(s, this.now(), reason);
    } catch {
      /* a listener must never break the socket */
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.failures = 0;
    this.connect();
    this.tickTimer = setInterval(() => this.tick(), 1000);
  }

  stop() {
    this.running = false;
    this.gen++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.reconnectTimer = null;
    this.tickTimer = null;
    this.dropSocket();
    this.setState('stopped');
  }

  send(obj: unknown): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  /** Close the current socket (if any) and reconnect after a back-off delay. */
  reconnect(reason: string) {
    if (!this.running) return;
    this.gen++;
    this.dropSocket();
    this.scheduleReconnect(reason);
  }

  /** Called when the tab becomes visible again: do not wait for the next tick to notice a dead link. */
  checkNow() {
    this.liveness();
  }

  private dropSocket() {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = null;
    ws.onerror = () => {};
    try {
      ws.close(1000);
    } catch {
      /* ignore */
    }
  }

  private connect() {
    if (!this.running) return;
    const Ctor = this.o.WebSocketCtor ?? (typeof WebSocket !== 'undefined' ? (WebSocket as unknown as WsCtor) : undefined);
    if (!Ctor) {
      this.scheduleReconnect('no-websocket');
      return;
    }
    const gen = ++this.gen;
    this.connectStartedAt = this.now();
    this.setState('connecting');
    let ws: WsLike;
    try {
      ws = new Ctor(this.o.url);
    } catch (e) {
      this.scheduleReconnect(`construct-failed:${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (gen !== this.gen) return;
      this.openedAt = this.now();
      this.lastMessageAt = this.openedAt;
      this.setState('open');
      this.send({ type: 'enable_heartbeat' });
      try {
        this.o.onOpen((obj) => this.send(obj));
      } catch {
        /* subscriptions are re-sent on the next connection */
      }
    };
    ws.onmessage = (ev) => {
      if (gen !== this.gen) return;
      const t = this.now();
      this.lastMessageAt = t;
      if (typeof ev.data === 'string') {
        try {
          this.o.onFrame(ev.data, t);
        } catch {
          /* a bad frame never takes the socket down */
        }
      }
    };
    ws.onerror = () => {
      /* the close event that follows carries the outcome */
    };
    ws.onclose = () => {
      if (gen !== this.gen) return;
      this.ws = null;
      this.scheduleReconnect('closed');
    };
  }

  private scheduleReconnect(reason: string) {
    if (!this.running || this.reconnectTimer) return;
    const wasOpen = this.state === 'open';
    const lived = wasOpen ? this.now() - this.openedAt : 0;
    if (wasOpen && lived >= (this.o.healthyAfterMs ?? 15_000)) {
      this.attempt = 0;
      this.failures = 0;
    } else {
      this.attempt++;
      this.failures++;
    }
    const min = this.o.backoffMinMs ?? 1_000;
    // After many failures in a row (e.g. the upgrade is refused, a browser cannot see the HTTP status) slow right down.
    const max = this.o.backoffMaxMs ?? (this.failures >= 6 ? 120_000 : 30_000);
    const exp = Math.min(max, min * 2 ** Math.min(this.attempt - 1 < 0 ? 0 : this.attempt - 1, 10));
    const delay = Math.round(exp / 2 + this.random() * (exp / 2));
    this.reconnects++;
    this.setState('backoff', reason);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private liveness() {
    if (!this.running) return;
    const t = this.now();
    if (this.state === 'connecting' && t - this.connectStartedAt > (this.o.connectTimeoutMs ?? 10_000)) this.reconnect('connect-timeout');
    else if (this.state === 'open' && t - this.lastMessageAt > (this.o.staleMs ?? 10_000)) this.reconnect('stale');
  }

  private tick() {
    this.liveness();
    try {
      this.o.onTick?.(this.now());
    } catch {
      /* ignore */
    }
  }
}
