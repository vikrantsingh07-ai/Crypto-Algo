import { createHmac } from 'node:crypto';

/**
 * Request signing exactly as documented by Delta Exchange:
 *
 *   prehash   = METHOD + TIMESTAMP + REQUEST_PATH + QUERY_STRING + BODY
 *   signature = hex(HMAC_SHA256(api_secret, prehash))
 *
 * - METHOD is upper-case ("GET", "POST", ...)
 * - TIMESTAMP is epoch SECONDS as a string and must also be sent in the `timestamp` header
 * - REQUEST_PATH includes the /v2 prefix, e.g. "/v2/orders"
 * - QUERY_STRING includes the leading "?" (empty string when there is none)
 * - BODY is the exact JSON string that is sent (compact, no spaces); empty for GET
 * - a signature is only valid for 5 seconds
 * - every request must carry a User-Agent header
 */

const SAFE = /[A-Za-z0-9_.\-~]/;

/** Python `urllib.parse.quote_plus` compatible encoder (what the official client signs and sends). */
export function quotePlus(value: string): string {
  let out = '';
  for (const ch of value) {
    if (SAFE.test(ch)) out += ch;
    else if (ch === ' ') out += '+';
    else {
      for (const b of new TextEncoder().encode(ch)) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

export type Query = Record<string, string | number | boolean | undefined | null>;

/** Builds "?a=1&b=2" (or "") preserving insertion order; undefined/null values are dropped. */
export function buildQueryString(query?: Query): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${quotePlus(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

export function bodyString(body?: unknown): string {
  return body === undefined || body === null ? '' : JSON.stringify(body);
}

export function generateSignature(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

export interface SignInput {
  method: string;
  timestamp: string;
  path: string;
  queryString: string;
  body: string;
  secret: string;
}

export function signRequest(i: SignInput): string {
  return generateSignature(i.secret, i.method.toUpperCase() + i.timestamp + i.path + i.queryString + i.body);
}

/** Signature for the private WebSocket `key-auth` message: GET + timestamp + "/live". */
export function signWebSocketAuth(secret: string, timestamp: string): string {
  return generateSignature(secret, 'GET' + timestamp + '/live');
}
