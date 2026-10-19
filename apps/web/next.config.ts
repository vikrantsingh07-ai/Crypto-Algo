import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV !== 'production';

// The dashboard talks to its own origin (the server-side proxy under /api) and, for the live price / chart / order flow,
// to Delta Exchange's PUBLIC market-data endpoints straight from the browser (no key, no secret; see lib/market/PROTOCOL.md).
// public-socket is the documented public WebSocket the feed uses; the other two are listed for the exchange's legacy
// socket host and public REST host so a documented fallback never needs a redeploy.
const DELTA_PUBLIC = ['wss://public-socket.india.delta.exchange', 'wss://socket.india.delta.exchange', 'https://api.india.delta.exchange'];

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  `connect-src 'self' ${DELTA_PUBLIC.join(' ')}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const config: NextConfig = {
  transpilePackages: ['@cryptoalgo/core'],
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
    ];
  },
};

export default config;
