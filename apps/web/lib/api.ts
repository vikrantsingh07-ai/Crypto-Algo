'use client';

/** Browser → dashboard proxy client. The browser never sees the backend URL or any token. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body: any,
  ) {
    super(message);
  }
}

export async function api<T = any>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'cryptoalgo' },
    // body-less POST/PUT/DELETE still send `{}` so the JSON content-type is never paired with an empty body
    body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body),
    cache: 'no-store',
    credentials: 'same-origin',
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('auth/')) window.location.href = '/login';
    throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? data?.error ?? `Request failed (${res.status})`, data);
  }
  return data as T;
}
