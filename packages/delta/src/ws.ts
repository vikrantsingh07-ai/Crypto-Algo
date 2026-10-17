import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { Credentials, Logger } from './http';
import { noopLogger } from './http';
import { signWebSocketAuth } from './signing';

/**
 * Resilient Delta Exchange WebSocket client.
 *
 * Protocol (official docs):
 *  - subscribe:  {"type":"subscribe","payload":{"channels":[{"name":"ob_l1","symbols":["ETHUSD"]}]}}
 *  - heartbeat:  send {"type":"enable_heartbeat"} after connecting; the server then sends
 *                {"type":"heartbeat"} every ~30s. If nothing arrives for 35s the link is considered dead.
 *  - private:    {"type":"key-auth","payload":{"api-key":..,"signature":..,"timestamp":<seconds>}} where
 *                signature = HMAC_SHA256(secret, "GET" + timestamp + "/live"). Replies with
 *                {"type":"key-auth","success":true,...}.
 *  - limits:     150 connection attempts / 5 min / IP (HTTP 429 on upgrade => wait 5-10 minutes);
 *                the server disconnects idle connections after 60s.
 *
 * Subscriptions are remembered and replayed after every reconnect. Reconnects use exponential
 * back-off with jitter. Nothing here places orders.
 */

export type WsState = 'idle' | 'connecting' | 'open' | 'authenticating' | 'ready' | 'backoff' | 'stopped';

export interface ChannelSub {
  name: string;
  symbols?: string[];
}

export interface DeltaWsOptions {
  url: string;
  name: string;
  /** When provided the socket performs key-auth before subscribing (private endpoint). */
  auth?: () => Credentials | null | undefined;
  logger?: Logger;
  userAgent?: string;
  heartbeatTimeoutMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /** Wait applied after an HTTP 429 on connect (docs: 5-10 minutes). */
  rateLimitBackoffMs?: number;
  now?: () => number;
  WebSocketCtor?: typeof WebSocket;
}

export class DeltaWs extends EventEmitter {
  state: WsState = 'idle';
  lastMessageAt: number | null = null;
  lastError: string | null = null;
  reconnects = 0;
  connectedAt: number | null = null;

  private ws: WebSocket | null = null;
  private desired = new Map<string, Set<string>>();
  private desiredNoSymbols = new Set<string>();
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private stopped = true;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(private readonly opts: DeltaWsOptions) {
    super();
    this.logger = opts.logger ?? noopLogger;
    this.now = opts.now ?? Date.now;
  }

  private setState(s: WsState) {
    if (this.state !== s) {
      this.state = s;
      this.emit('state', s);
    }
  }

  /** Register channels; sent immediately if the socket is ready, and replayed after reconnects. */
  subscribe(channels: ChannelSub[]) {
    for (const c of channels) {
      if (!c.symbols || c.symbols.length === 0) this.desiredNoSymbols.add(c.name);
      else {
        const set = this.desired.get(c.name) ?? new Set<string>();
        c.symbols.forEach((s) => set.add(s));
        this.desired.set(c.name, set);
      }
    }
    if (this.state === 'ready') this.flushSubscriptions();
  }

  private flushSubscriptions() {
    const channels: ChannelSub[] = [];
    for (const [name, syms] of this.desired) channels.push({ name, symbols: [...syms] });
    for (const name of this.desiredNoSymbols) channels.push({ name });
    if (channels.length) this.send({ type: 'subscribe', payload: { channels } });
  }

  send(obj: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.reconnectTimer = null;
    this.watchdog = null;
    try {
      this.ws?.removeAllListeners();
      this.ws?.on('error', () => {});
      this.ws?.terminate();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.setState('stopped');
  }

  private connect() {
    if (this.stopped) return;
    this.setState('connecting');
    const Ctor = this.opts.WebSocketCtor ?? WebSocket;
    let ws: WebSocket;
    try {
      ws = new Ctor(this.opts.url, { headers: { 'User-Agent': this.opts.userAgent ?? 'cryptoalgo-delta-client/1.0' }, handshakeTimeout: 10_000 });
    } catch (e) {
      this.fail(e);
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.connectedAt = this.now();
      this.lastMessageAt = this.now();
      this.attempt = 0;
      this.setState('open');
      this.send({ type: 'enable_heartbeat' });
      this.startWatchdog();
      if (this.opts.auth) this.authenticate();
      else {
        this.setState('ready');
        this.flushSubscriptions();
        this.emit('ready');
      }
    });

    ws.on('message', (data) => {
      this.lastMessageAt = this.now();
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'heartbeat') {
        this.emit('heartbeat');
        return;
      }
      if (msg.type === 'key-auth') {
        if (msg.success) {
          this.setState('ready');
          this.flushSubscriptions();
          this.emit('ready');
        } else {
          this.lastError = `key-auth failed: ${msg.status ?? ''} ${msg.message ?? ''}`.trim();
          this.logger.error('websocket authentication failed', { status: msg.status, code: msg.status_code });
          this.emit('authFailed', msg);
          // Authentication problems (bad key, IP not whitelisted) will not fix themselves quickly.
          this.scheduleReconnect(60_000);
          try {
            ws.terminate();
          } catch {
            /* ignore */
          }
        }
        return;
      }
      this.emit('message', msg);
    });

    ws.on('unexpected-response', (_req, res) => {
      this.lastError = `HTTP ${res.statusCode} on websocket upgrade`;
      this.logger.warn('websocket upgrade rejected', { status: res.statusCode });
      if (res.statusCode === 429) this.scheduleReconnect(this.opts.rateLimitBackoffMs ?? 5 * 60_000 + Math.random() * 5 * 60_000);
      else this.scheduleReconnect();
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    });

    ws.on('error', (e) => {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.emit('socketError', e);
    });

    ws.on('close', () => {
      if (this.watchdog) clearInterval(this.watchdog);
      this.watchdog = null;
      this.emit('close');
      if (!this.stopped && !this.reconnectTimer) this.scheduleReconnect();
    });
  }

  private authenticate() {
    const creds = this.opts.auth?.();
    if (!creds) {
      this.lastError = 'no credentials available for private websocket';
      this.setState('open');
      this.emit('authFailed', { status: 'no_credentials' });
      return;
    }
    this.setState('authenticating');
    const timestamp = String(Math.floor(this.now() / 1000));
    this.send({ type: 'key-auth', payload: { 'api-key': creds.apiKey, signature: signWebSocketAuth(creds.apiSecret, timestamp), timestamp: Number(timestamp) } });
  }

  private startWatchdog() {
    if (this.watchdog) clearInterval(this.watchdog);
    const limit = this.opts.heartbeatTimeoutMs ?? 35_000;
    this.watchdog = setInterval(() => {
      if (this.lastMessageAt !== null && this.now() - this.lastMessageAt > limit) {
        this.lastError = `no websocket traffic for ${Math.round((this.now() - this.lastMessageAt) / 1000)}s`;
        this.logger.warn('websocket heartbeat timeout, reconnecting', { name: this.opts.name });
        try {
          this.ws?.terminate();
        } catch {
          /* ignore */
        }
      }
    }, Math.min(5_000, Math.max(100, limit / 4)));
    this.watchdog.unref?.();
  }

  private fail(e: unknown) {
    this.lastError = e instanceof Error ? e.message : String(e);
    this.scheduleReconnect();
  }

  private scheduleReconnect(forcedMs?: number) {
    if (this.stopped || this.reconnectTimer) return;
    const min = this.opts.backoffMinMs ?? 1_000;
    const max = this.opts.backoffMaxMs ?? 30_000;
    const exp = Math.min(max, min * 2 ** Math.min(this.attempt, 10));
    const delay = forcedMs ?? Math.round(exp / 2 + Math.random() * (exp / 2));
    this.attempt++;
    this.reconnects++;
    this.setState('backoff');
    this.logger.info('websocket reconnect scheduled', { name: this.opts.name, delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }
}
