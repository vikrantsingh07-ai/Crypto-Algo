import { DeltaWs, type DeltaEndpoints, type Logger } from '@cryptoalgo/delta';
import type { CredentialStore } from './credentials';

export interface PrivateStreamStatus {
  enabled: boolean;
  state: string;
  lastMessageAt: number | null;
  lastEventAt: number | null;
  lastError: string | null;
  reconnects: number;
}

/**
 * Authenticated account WebSocket (orders, positions, margins, fills).
 * It is only a low-latency TRIGGER: any account event schedules a reconciliation against the REST API,
 * which remains the single source of truth. If the socket is down the periodic reconcile still runs.
 */
export class PrivateStream {
  private ws: DeltaWs | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastTrigger = 0;
  lastEventAt: number | null = null;

  constructor(
    private readonly d: {
      endpoints: DeltaEndpoints;
      creds: CredentialStore;
      symbol: () => string;
      onEvent: () => void;
      logger: Logger;
      now: () => number;
      /** minimum spacing between triggered reconciliations (protects the REST rate limit) */
      minIntervalMs?: number;
    },
  ) {}

  start(): void {
    this.stop();
    const url = this.d.endpoints.wsPrivateUrl;
    if (!url || !this.d.creds.status().configured) return;
    const ws = new DeltaWs({ url, name: 'private', auth: this.d.creds.provider, logger: this.d.logger, now: this.d.now });
    const sym = this.d.symbol();
    ws.subscribe([{ name: 'positions', symbols: [sym] }, { name: 'orders', symbols: [sym] }, { name: 'v2/user_trades', symbols: [sym] }, { name: 'margins' }]);
    ws.on('message', (m: { type?: string }) => {
      if (m?.type === 'subscriptions') return;
      this.lastEventAt = this.d.now();
      this.schedule();
    });
    ws.on('authFailed', (m: { status?: string; message?: string }) => this.d.logger.warn('private websocket authentication failed', { status: m?.status }));
    this.ws = ws;
    ws.start();
  }

  private schedule() {
    if (this.timer) return;
    const gap = this.d.minIntervalMs ?? 2000;
    const wait = Math.max(300, gap - (this.d.now() - this.lastTrigger));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.lastTrigger = this.d.now();
      this.d.onEvent();
    }, wait);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ws?.stop();
    this.ws = null;
  }

  status(): PrivateStreamStatus {
    return {
      enabled: !!this.ws,
      state: this.ws?.state ?? 'off',
      lastMessageAt: this.ws?.lastMessageAt ?? null,
      lastEventAt: this.lastEventAt,
      lastError: this.ws?.lastError ?? null,
      reconnects: this.ws?.reconnects ?? 0,
    };
  }
}
