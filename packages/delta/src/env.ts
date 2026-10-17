/**
 * Delta Exchange environments.
 *
 * Source: official docs (github.com/delta-exchange/slate, "Authentication" + "Websocket Feed",
 * and the official python-rest-client docstring). Each environment is FULLY INDEPENDENT:
 * API keys, product ids, asset ids and user ids all differ between them, and a key created for one
 * environment is rejected (`invalid_api_key`) by another.
 *
 *   production   Delta India live trading        https://api.india.delta.exchange
 *   testnet      Delta India demo account        https://cdn-ind.testnet.deltaex.org
 *   global / global-testnet are provided for Delta Global accounts. Their WebSocket hosts follow the
 *   Global docs repo and should be re-checked against the current Global documentation.
 *   custom       Explicit URLs (also used for the local mock exchange in tests).
 */

export type DeltaEnvName = 'production' | 'testnet' | 'global' | 'global-testnet' | 'custom';

export interface DeltaEndpoints {
  env: DeltaEnvName;
  restUrl: string;
  /** Public market-data WebSocket (ob_l1, trades, candlesticks, mark_price, funding_rate ...). */
  wsPublicUrl: string;
  /** Private WebSocket (orders, positions, margins, user trades) after key-auth. */
  wsPrivateUrl: string;
  /** Human label shown in the UI. */
  label: string;
  /** true if this environment places REAL orders with REAL funds. */
  realMoney: boolean;
}

export const DELTA_ENVIRONMENTS: Record<Exclude<DeltaEnvName, 'custom'>, DeltaEndpoints> = {
  production: {
    env: 'production',
    restUrl: 'https://api.india.delta.exchange',
    wsPublicUrl: 'wss://public-socket.india.delta.exchange',
    wsPrivateUrl: 'wss://socket.india.delta.exchange',
    label: 'Delta Exchange India (production)',
    realMoney: true,
  },
  testnet: {
    env: 'testnet',
    restUrl: 'https://cdn-ind.testnet.deltaex.org',
    wsPublicUrl: 'wss://socket-ind-pub.testnet.deltaex.org',
    wsPrivateUrl: 'wss://socket-ind.testnet.deltaex.org',
    label: 'Delta Exchange India TESTNET (demo account, no real funds)',
    realMoney: false,
  },
  global: {
    env: 'global',
    restUrl: 'https://api.delta.exchange',
    wsPublicUrl: 'wss://public-socket.faida.trade',
    wsPrivateUrl: 'wss://socket.faida.trade',
    label: 'Delta Exchange Global (production)',
    realMoney: true,
  },
  'global-testnet': {
    env: 'global-testnet',
    restUrl: 'https://testnet-api.delta.exchange',
    wsPublicUrl: 'wss://testnet-socket-pub.faida.trade',
    wsPrivateUrl: 'wss://testnet-socket.faida.trade',
    label: 'Delta Exchange Global TESTNET (no real funds)',
    realMoney: false,
  },
};

export interface EnvOverrides {
  restUrl?: string;
  wsPublicUrl?: string;
  wsPrivateUrl?: string;
  realMoney?: boolean;
}

export function resolveEndpoints(env: DeltaEnvName, overrides: EnvOverrides = {}): DeltaEndpoints {
  if (env === 'custom') {
    if (!overrides.restUrl) throw new Error('DELTA_ENV=custom requires DELTA_REST_URL');
    return {
      env,
      restUrl: overrides.restUrl.replace(/\/$/, ''),
      wsPublicUrl: overrides.wsPublicUrl ?? '',
      wsPrivateUrl: overrides.wsPrivateUrl ?? overrides.wsPublicUrl ?? '',
      label: `Custom endpoint (${overrides.restUrl})`,
      realMoney: overrides.realMoney ?? true,
    };
  }
  const base = DELTA_ENVIRONMENTS[env];
  if (!base) throw new Error(`Unknown DELTA_ENV "${env}"`);
  return {
    ...base,
    restUrl: (overrides.restUrl ?? base.restUrl).replace(/\/$/, ''),
    wsPublicUrl: overrides.wsPublicUrl ?? base.wsPublicUrl,
    wsPrivateUrl: overrides.wsPrivateUrl ?? base.wsPrivateUrl,
    realMoney: overrides.realMoney ?? base.realMoney,
  };
}
