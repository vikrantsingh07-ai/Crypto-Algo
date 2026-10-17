import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, backendHeaders, backendUrl, clientIp, sameOriginMutation } from '@/lib/server';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (!sameOriginMutation(req)) return NextResponse.json({ error: 'csrf_rejected' }, { status: 403 });
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  let upstream: Response;
  try {
    upstream = await fetch(`${backendUrl()}/api/auth/login`, {
      method: 'POST',
      headers: backendHeaders({ 'content-type': 'application/json', 'x-forwarded-for': clientIp(req.headers) }),
      body: JSON.stringify(payload),
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return NextResponse.json({ error: 'backend_unreachable', message: 'The trading backend is not reachable.' }, { status: 502 });
  }
  const data = (await upstream.json().catch(() => ({}))) as { token?: string; role?: string; username?: string; expiresAt?: number; error?: string };
  if (!upstream.ok || !data.token) return NextResponse.json({ error: data.error ?? 'login_failed' }, { status: upstream.status === 200 ? 401 : upstream.status });

  const res = NextResponse.json({ username: data.username, role: data.role });
  res.cookies.set(SESSION_COOKIE, data.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    expires: data.expiresAt ? new Date(data.expiresAt) : undefined,
  });
  return res;
}
