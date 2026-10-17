import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, backendHeaders, backendUrl, clientIp, isAllowedPath, sameOriginMutation } from '@/lib/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // live preflight / kill-switch flatten talk to the exchange

/**
 * Authenticated pass-through to the trading backend.
 *  - the browser holds only an httpOnly session cookie; the backend bearer token is attached here
 *  - the backend URL and PROXY_SHARED_SECRET never reach the browser
 *  - only an allow-list of backend paths is reachable
 *  - state-changing requests must be same-origin and carry x-requested-with (CSRF defence)
 */
async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const sub = path.join('/');
  if (!isAllowedPath(sub)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const method = req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && !sameOriginMutation(req)) {
    return NextResponse.json({ error: 'csrf_rejected' }, { status: 403 });
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token && sub !== 'health') return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const headers = backendHeaders({ 'content-type': 'application/json', 'x-forwarded-for': clientIp(req.headers) });
  if (token) headers.authorization = `Bearer ${token}`;

  let body: string | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    body = (await req.text()) || '{}';
    if (body.length > 64 * 1024) return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${backendUrl()}/api/${sub}${req.nextUrl.search}`, {
      method,
      headers,
      body: body || undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(55_000),
    });
  } catch {
    return NextResponse.json({ error: 'backend_unreachable', message: 'The trading backend is not reachable from the dashboard server.' }, { status: 502 });
  }

  const text = await upstream.text();
  const res = new NextResponse(text, { status: upstream.status, headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' } });
  // An expired/invalid session on the backend ends the browser session too.
  if (upstream.status === 401 && token) res.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}

export { handle as GET, handle as POST, handle as PUT, handle as DELETE };
