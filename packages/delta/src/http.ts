import { DeltaApiError, DeltaNetworkError, DeltaRateLimitError, isDefinitelyNotProcessed } from './errors';
import { RateLimiter, endpointWeight, type Priority } from './rateLimit';
import { bodyString, buildQueryString, signRequest, type Query } from './signing';

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export interface Credentials {
  apiKey: string;
  apiSecret: string;
}

export interface HttpOptions {
  baseUrl: string;
  /** Mandatory for Delta: requests without a User-Agent are rejected with 403 by the CDN. */
  userAgent?: string;
  timeoutMs?: number;
  /** Static credentials, or a provider so rotated credentials are picked up without a restart. */
  credentials?: Credentials | (() => Credentials | null) | null;
  limiter?: RateLimiter;
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  auth?: boolean;
  priority?: Priority;
  /**
   * Safe to retry on transport errors / 5xx. Defaults to true for GET, false otherwise.
   * State-changing calls are NEVER auto-retried after an ambiguous failure.
   */
  idempotent?: boolean;
  retries?: number;
}

export interface DeltaResponse<T> {
  result: T;
  meta: Record<string, unknown> | null;
  status: number;
  headers: Headers;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class DeltaHttp {
  readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly limiter: RateLimiter;
  readonly logger: Logger;
  private credentials: HttpOptions['credentials'];
  /** serverTime - localTime in ms, learned from `Date` response headers. */
  private clockOffsetMs = 0;
  lastError: { at: number; message: string } | null = null;
  lastSuccessAt: number | null = null;

  constructor(opts: HttpOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.userAgent = opts.userAgent ?? 'cryptoalgo-delta-client/1.0';
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
    this.limiter = opts.limiter ?? new RateLimiter(undefined, undefined, this.now, this.sleep);
    this.logger = opts.logger ?? noopLogger;
    this.credentials = opts.credentials ?? null;
  }

  setCredentials(c: HttpOptions['credentials']) {
    this.credentials = c;
  }

  hasCredentials(): boolean {
    return this.resolveCredentials() !== null;
  }

  get clockOffset(): number {
    return this.clockOffsetMs;
  }

  private resolveCredentials(): Credentials | null {
    const c = this.credentials;
    if (!c) return null;
    return typeof c === 'function' ? c() : c;
  }

  private learnClock(headers: Headers, sentAt: number, receivedAt: number) {
    const date = headers.get('date');
    if (!date) return;
    const server = Date.parse(date);
    if (!Number.isFinite(server)) return;
    // `Date` has 1s resolution, so the true server time is in [server, server + 1s).
    const mid = (sentAt + receivedAt) / 2;
    const offset = server + 500 - mid;
    // Ignore sub-1.5s differences (header granularity); only correct real drift.
    this.clockOffsetMs = Math.abs(offset) > 1_500 ? offset : 0;
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<DeltaResponse<T>> {
    const m = method.toUpperCase();
    const idempotent = opts.idempotent ?? m === 'GET';
    const maxAttempts = (opts.retries ?? (idempotent ? 2 : 1)) + 1;
    const priority = opts.priority ?? 'normal';
    const queryString = buildQueryString(opts.query);
    const body = bodyString(opts.body);
    const weight = endpointWeight(m, path);
    const endpoint = `${m} ${path}`;
    let attempt = 0;
    let signatureRetried = false;

    for (;;) {
      attempt++;
      await this.limiter.acquire(weight, endpoint, priority);

      const headers: Record<string, string> = {
        'User-Agent': this.userAgent,
        Accept: 'application/json',
      };
      if (body || m !== 'GET') headers['Content-Type'] = 'application/json';
      if (opts.auth) {
        const creds = this.resolveCredentials();
        if (!creds) throw new DeltaApiError('API credentials are not configured', 401, 'no_credentials', null, endpoint, false);
        const timestamp = String(Math.floor((this.now() + this.clockOffsetMs) / 1000));
        headers['api-key'] = creds.apiKey;
        headers['timestamp'] = timestamp;
        headers['signature'] = signRequest({ method: m, timestamp, path, queryString, body, secret: creds.apiSecret });
      }

      const url = `${this.baseUrl}${path}${queryString}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const sentAt = this.now();
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method: m, headers, body: body || undefined, signal: controller.signal });
      } catch (err) {
        clearTimeout(timer);
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        this.lastError = { at: this.now(), message };
        if (idempotent && attempt < maxAttempts) {
          await this.sleep(250 * 2 ** (attempt - 1));
          continue;
        }
        // For state-changing requests the outcome is unknown.
        throw new DeltaNetworkError(`Network error on ${endpoint}: ${message}`, endpoint, !idempotent, err);
      }
      clearTimeout(timer);
      const receivedAt = this.now();
      this.learnClock(res.headers, sentAt, receivedAt);
      this.limiter.noteHeaders(res.headers);

      let json: any = null;
      let text = '';
      try {
        text = await res.text();
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }

      if (res.status === 429) {
        const resetHeader = res.headers.get('x-rate-limit-reset');
        const resetMs = resetHeader !== null && Number.isFinite(Number(resetHeader)) ? Number(resetHeader) : null;
        this.limiter.noteRateLimited(resetMs);
        this.lastError = { at: this.now(), message: `429 ${endpoint}` };
        // A 429 means the request was not processed, so retrying is safe for every method.
        if (attempt < (priority === 'critical' ? 4 : 2)) continue;
        throw new DeltaRateLimitError(endpoint, resetMs);
      }

      const failed = res.status >= 400 || (json && json.success === false) || (!json && res.status >= 200);
      if (failed) {
        const errField = json?.error;
        const code: string | null = typeof errField === 'string' ? errField : errField?.code ?? null;
        const context = typeof errField === 'object' && errField !== null ? errField.context ?? null : json?.message ?? null;
        const message = `${endpoint} failed: HTTP ${res.status}${code ? ` ${code}` : ''}${!json && text ? ` ${text.slice(0, 120)}` : ''}`;
        const err = new DeltaApiError(message, res.status, code, context, endpoint, res.status >= 500);

        // Expired signature: the request was NOT processed. Resync the clock and retry once.
        if (opts.auth && isDefinitelyNotProcessed(err) && !signatureRetried) {
          signatureRetried = true;
          const dateHdr = res.headers.get('date');
          if (dateHdr) this.learnClock(res.headers, receivedAt, receivedAt);
          this.logger.warn('signature expired, retrying once', { endpoint });
          continue;
        }
        if (err.retryable && idempotent && attempt < maxAttempts) {
          await this.sleep(250 * 2 ** (attempt - 1));
          continue;
        }
        this.lastError = { at: this.now(), message: err.message };
        throw err;
      }

      this.lastSuccessAt = this.now();
      return { result: json.result as T, meta: json.meta ?? null, status: res.status, headers: res.headers };
    }
  }

  get<T>(path: string, opts: RequestOptions = {}) {
    return this.request<T>('GET', path, opts);
  }
  post<T>(path: string, body: unknown, opts: RequestOptions = {}) {
    return this.request<T>('POST', path, { ...opts, body });
  }
  put<T>(path: string, body: unknown, opts: RequestOptions = {}) {
    return this.request<T>('PUT', path, { ...opts, body });
  }
  delete<T>(path: string, body?: unknown, opts: RequestOptions = {}) {
    return this.request<T>('DELETE', path, { ...opts, body });
  }
}
