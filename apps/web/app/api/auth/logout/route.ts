import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, sameOriginMutation } from '@/lib/server';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (!sameOriginMutation(req)) return NextResponse.json({ error: 'csrf_rejected' }, { status: 403 });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 0 });
  return res;
}
