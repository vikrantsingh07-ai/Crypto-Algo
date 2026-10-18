/**
 * Server-only helpers (used by route handlers and server components). Nothing here is bundled for
 * the browser: it reads BACKEND_URL / PROXY_SHARED_SECRET, which must never be NEXT_PUBLIC_*.
 */

export const SESSION_COOKIE = 'ca_session';

/** Hosts where plain http between the dashboard server and the backend is acceptable (same machine / private network). */
const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|[^.]+|.*\.(internal|local|svc|cluster\.local))$/i;

export function backendUrl(): string {
  const url = process.env.BACKEND_URL?.trim();
  if (!url) throw new Error('BACKEND_URL is not configured on the dashboard server');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('BACKEND_URL is not a valid URL (expected https://your-backend.example.com)');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && PRIVATE_HOST.test(parsed.hostname))) {
    // The proxy forwards the login password and PROXY_SHARED_SECRET in this request: never over plain http on the internet.
    throw new Error('BACKEND_URL must use https:// (plain http is only allowed for localhost or a private network host)');
  }
  return url.replace(/\/$/, '');
}

export function backendHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  const secret = process.env.PROXY_SHARED_SECRET;
  if (secret) h['x-proxy-secret'] = secret;
  return h;
}

/** Paths the browser is allowed to reach through the proxy. Anything else is a 404. */
const ALLOWED = [
  /^health$/,
  /^auth\/me$/,
  /^state$/,
  /^settings$/,
  /^trades$/,
  /^analytics$/,
  /^credentials(\/test)?$/,
  /^backtests(\/[\w-]+)?$/,
  /^bot\/(start|stop)$/,
  /^mode$/,
  /^kill-switch$/,
  /^attention\/clear$/,
  /^live\/(preflight|activate|reconcile|close-position|reset-baseline|waiver\/reset)$/,
  /^demo\/(reset|close)$/,
  /^audit$/,
];

export function isAllowedPath(path: string): boolean {
  return ALLOWED.some((r) => r.test(path));
}

export function clientIp(headers: Headers): string {
  const fwd = headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return headers.get('x-real-ip') ?? '0.0.0.0';
}

/** CSRF defence for state-changing requests: same-origin + a custom header that cross-site forms cannot set. */
export function sameOriginMutation(req: Request): boolean {
  if (req.headers.get('x-requested-with') !== 'cryptoalgo') return false;
  const origin = req.headers.get('origin');
  if (!origin) return true; // non-browser client (curl): protected by the cookie requirement anyway
  try {
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
