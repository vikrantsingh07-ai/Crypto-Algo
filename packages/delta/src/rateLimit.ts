import { DeltaRateLimitError } from './errors';

/**
 * Client-side rate limiter.
 *
 * Delta: default quota 20,000 weight per fixed 5-minute window per user (authenticated) or per IP
 * (public). Heavier endpoints cost more. A 429 response carries `X-RATE-LIMIT-RESET` = milliseconds
 * until the next request may be sent. We keep usage under a safety fraction of the quota and honour
 * 429 back-offs; safety-critical calls (exits, cancels) wait through a back-off instead of failing.
 */

export const WINDOW_MS = 5 * 60_000;
export const DEFAULT_QUOTA = 20_000;

/** Endpoint weight table from the official docs; anything not listed costs 1. */
export function endpointWeight(method: string, path: string): number {
  const m = method.toUpperCase();
  const p = path.split('?')[0];
  if (p.includes('/orders/batch')) return 25;
  if (m === 'GET') {
    if (p === '/v2/orders/history' || p === '/v2/fills' || p === '/v2/wallet/transactions') return 10;
    if (
      p === '/v2/products' ||
      p.startsWith('/v2/products/') && !p.includes('/orders/leverage') ||
      p.startsWith('/v2/l2orderbook') ||
      p.startsWith('/v2/tickers') ||
      p === '/v2/orders' ||
      p.startsWith('/v2/positions') ||
      p === '/v2/wallet/balances' ||
      p === '/v2/history/candles'
    )
      return 3;
    return 1;
  }
  if (p === '/v2/orders' || p === '/v2/orders/bracket' || p === '/v2/positions/change_margin') return 5;
  return 1;
}

export type Priority = 'normal' | 'critical';

export class RateLimiter {
  private events: { ts: number; w: number }[] = [];
  private blockedUntil = 0;

  constructor(
    private readonly quota = DEFAULT_QUOTA,
    /** Fraction of the quota we allow ourselves to use. */
    private readonly safety = 0.7,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    /** Longest we will sleep for a normal-priority request before failing fast. */
    private readonly maxWaitMs = 3_000,
    /** Longest we will sleep for a critical request. */
    private readonly maxCriticalWaitMs = 60_000,
  ) {}

  private prune(t: number) {
    const cutoff = t - WINDOW_MS;
    while (this.events.length && this.events[0].ts <= cutoff) this.events.shift();
  }

  used(): number {
    this.prune(this.now());
    return this.events.reduce((s, e) => s + e.w, 0);
  }

  get budget(): number {
    return Math.floor(this.quota * this.safety);
  }

  /** Called when the server answered 429. */
  noteRateLimited(resetMs: number | null) {
    const wait = resetMs !== null && resetMs >= 0 ? resetMs : 5_000;
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + wait);
  }

  /** Record a response's remaining-quota hint, if present. */
  noteHeaders(headers: Headers) {
    const reset = headers.get('x-rate-limit-reset');
    const remaining = headers.get('x-rate-limit-remaining');
    if (remaining !== null && Number(remaining) <= 0 && reset !== null) this.noteRateLimited(Number(reset));
  }

  async acquire(weight: number, endpoint: string, priority: Priority = 'normal'): Promise<void> {
    const maxWait = priority === 'critical' ? this.maxCriticalWaitMs : this.maxWaitMs;
    const start = this.now();
    for (;;) {
      const t = this.now();
      if (t - start > maxWait) throw new DeltaRateLimitError(endpoint, Math.max(0, this.blockedUntil - t));
      if (t < this.blockedUntil) {
        const wait = this.blockedUntil - t;
        if (wait + (t - start) > maxWait) throw new DeltaRateLimitError(endpoint, wait);
        await this.sleep(wait);
        continue;
      }
      this.prune(t);
      const used = this.events.reduce((s, e) => s + e.w, 0);
      const cap = priority === 'critical' ? this.quota : this.budget;
      if (used + weight <= cap) {
        this.events.push({ ts: t, w: weight });
        return;
      }
      // Wait until the oldest events age out.
      const oldest = this.events[0];
      const wait = oldest ? Math.max(50, oldest.ts + WINDOW_MS - t) : 50;
      if (wait + (t - start) > maxWait) throw new DeltaRateLimitError(endpoint, wait);
      await this.sleep(Math.min(wait, 1_000));
    }
  }
}
