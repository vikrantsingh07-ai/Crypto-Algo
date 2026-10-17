import { z } from 'zod';
import type { DeltaEnvName } from '@cryptoalgo/delta';

/**
 * Server configuration, read once from environment variables.
 * Secrets (API keys, session secret, encryption key) are ONLY ever read here, on the server.
 */

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().optional(),
  DATABASE_SSL: z.enum(['require', 'no-verify', 'disable']).optional(),
  DATA_DIR: z.string().default('./data'),

  SESSION_SECRET: z.string().optional(),
  SESSION_TTL_HOURS: z.coerce.number().min(0.25).max(168).default(12),
  CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),
  PROXY_SHARED_SECRET: z.string().optional(),

  ADMIN_USERNAME: z.string().default('admin'),
  ADMIN_PASSWORD_HASH: z.string().optional(),
  /** Development convenience only; rejected in production. */
  ADMIN_PASSWORD: z.string().optional(),
  VIEWER_USERNAME: z.string().default('viewer'),
  VIEWER_PASSWORD_HASH: z.string().optional(),

  DELTA_ENV: z.enum(['production', 'testnet', 'global', 'global-testnet', 'custom']).default('production'),
  DELTA_REST_URL: z.string().optional(),
  DELTA_WS_PUBLIC_URL: z.string().optional(),
  DELTA_WS_PRIVATE_URL: z.string().optional(),
  DELTA_API_KEY: z.string().optional(),
  DELTA_API_SECRET: z.string().optional(),
  SYMBOL: z.string().regex(/^ETH[A-Z]{3,4}$/).default('ETHUSD'),

  /** delta = real exchange data. synthetic = DEV ONLY random walk, clearly labelled everywhere. */
  MARKET_DATA_SOURCE: z.enum(['delta', 'synthetic']).default('delta'),
  /** Deployer-level lock: when true Live activation is impossible no matter what the dashboard says. */
  LIVE_HARD_DISABLE: bool(false),
  BOT_AUTOSTART: bool(true),
  /** Allow this instance to run the trading worker (set false on API-only replicas). */
  WORKER_ENABLED: bool(true),
  /** Extra origins allowed for CORS (comma separated). Empty = same-origin / server-to-server only. */
  CORS_ORIGINS: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig extends Omit<Env, 'DELTA_ENV'> {
  DELTA_ENV: DeltaEnvName;
  isProd: boolean;
  sessionSecret: string;
  encryptionKey: Buffer | null;
  warnings: string[];
}

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${msg}`);
  }
  const env = parsed.data;
  const isProd = env.NODE_ENV === 'production';
  const warnings: string[] = [];

  let sessionSecret = env.SESSION_SECRET ?? '';
  if (sessionSecret.length < 32) {
    if (isProd) throw new Error('SESSION_SECRET must be set to a random string of at least 32 characters in production');
    sessionSecret = 'dev-only-insecure-session-secret-change-me-0123456789';
    warnings.push('SESSION_SECRET not set: using an insecure development secret');
  }

  let encryptionKey: Buffer | null = null;
  if (env.CREDENTIAL_ENCRYPTION_KEY) {
    encryptionKey = Buffer.from(env.CREDENTIAL_ENCRYPTION_KEY, 'base64');
    if (encryptionKey.length !== 32) throw new Error('CREDENTIAL_ENCRYPTION_KEY must be 32 bytes, base64-encoded (e.g. `openssl rand -base64 32`)');
  } else if (!isProd) {
    encryptionKey = Buffer.alloc(32, 7);
    warnings.push('CREDENTIAL_ENCRYPTION_KEY not set: using an insecure development key');
  } else {
    warnings.push('CREDENTIAL_ENCRYPTION_KEY not set: dashboard-stored API credentials are disabled (use DELTA_API_KEY / DELTA_API_SECRET)');
  }

  if (isProd && env.ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD (plaintext) is not allowed in production: set ADMIN_PASSWORD_HASH (npm run hash-password)');
  if (isProd && !env.ADMIN_PASSWORD_HASH) throw new Error('ADMIN_PASSWORD_HASH must be set in production (generate with: npm run hash-password -- "your password")');
  if (env.DELTA_ENV === 'custom' && !env.DELTA_REST_URL) throw new Error('DELTA_ENV=custom requires DELTA_REST_URL');
  if (isProd && env.MARKET_DATA_SOURCE === 'synthetic') throw new Error('MARKET_DATA_SOURCE=synthetic is for development only and is not allowed in production');
  if (isProd && !env.DATABASE_URL) warnings.push('DATABASE_URL not set: using embedded PGlite storage (single instance only). Use managed Postgres in production.');

  return { ...env, DELTA_ENV: env.DELTA_ENV as DeltaEnvName, isProd, sessionSecret, encryptionKey, warnings };
}
