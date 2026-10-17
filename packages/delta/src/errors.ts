/** Normalised Delta Exchange errors. */

export class DeltaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The exchange answered with an error (HTTP 4xx/5xx or `{success:false}`). */
export class DeltaApiError extends DeltaError {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null,
    public readonly context: unknown,
    public readonly endpoint: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

export class DeltaRateLimitError extends DeltaApiError {
  constructor(
    endpoint: string,
    /** Milliseconds until the quota resets (X-RATE-LIMIT-RESET) when provided. */
    public readonly resetMs: number | null,
  ) {
    super(`Rate limited on ${endpoint}${resetMs !== null ? ` (resets in ${resetMs}ms)` : ''}`, 429, 'rate_limited', null, endpoint, true);
  }
}

/**
 * Transport failure (DNS, TCP, TLS, timeout). For state-changing calls `ambiguous` is TRUE:
 * the request may or may not have been processed, so callers must look the order up by
 * client_order_id instead of blindly retrying.
 */
export class DeltaNetworkError extends DeltaError {
  constructor(
    message: string,
    public readonly endpoint: string,
    public readonly ambiguous: boolean,
    public readonly original?: unknown,
  ) {
    super(message);
  }
}

/** Errors that mean the request definitely was NOT processed and may be safely re-sent. */
export function isDefinitelyNotProcessed(e: unknown): boolean {
  if (e instanceof DeltaRateLimitError) return true;
  if (e instanceof DeltaApiError) {
    return e.code === 'SignatureExpired' || e.code === 'signature_expired' || (e.status === 401 && /expired/i.test(e.message));
  }
  return false;
}

/** Friendly explanations for the failure modes called out in the official docs. */
export function explainDeltaError(e: unknown): string {
  if (e instanceof DeltaRateLimitError) return 'Exchange rate limit hit; requests are being throttled.';
  if (e instanceof DeltaApiError) {
    switch (e.code) {
      case 'invalid_api_key':
        return 'The API key is invalid or belongs to a different environment (production vs testnet keys are not interchangeable).';
      case 'ip_not_whitelisted_for_api_key':
        return `The server IP is not whitelisted for this API key. ${JSON.stringify(e.context ?? {})}`;
      case 'Signature Mismatch':
        return 'Request signature mismatch: check the API secret and that the server clock is accurate.';
      case 'SignatureExpired':
        return 'Signature expired (>5s old): the server clock is drifting or latency is high.';
      case 'UnauthorizedApiAccess':
        return 'The API key does not have permission for this endpoint (enable Trading permission).';
      case 'insufficient_margin':
        return 'Insufficient margin for the requested size and leverage.';
      default:
        break;
    }
    if (e.status === 403) return 'Request blocked (403): missing User-Agent or the IP is blocked by the CDN.';
    return `${e.code ?? 'error'} (${e.status}) on ${e.endpoint}`;
  }
  return e instanceof Error ? e.message : String(e);
}
