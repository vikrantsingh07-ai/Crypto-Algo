import fs from 'node:fs';
import { z } from 'zod';
import type { DeltaEnvName } from '@cryptoalgo/delta';
import { parseEncryptionKey } from './crypto';

/**
 * Server configuration, read once from environment variables.
 * Secrets (API keys, session secret, encryption key) are ONLY ever read here, on the server.
 */

export const MIN_PROD_ADMIN_PASSWORD_LENGTH = 12;
/** $2a$/$2b$/$2y$ + two-digit cost + 53 hash characters. */
const BCRYPT_HASH = /^\$2[abxy]\$\d{2}\$[./A-Za-z0-9]{53}$/;

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
  /** Trimmed: a pasted trailing space or newline must not make the dashboard proxy and the API disagree. */
  PROXY_SHARED_SECRET: z.string().optional().transform((v) => v?.trim() || undefined),

  ADMIN_USERNAME: z.string().default('admin'),
  ADMIN_PASSWORD_HASH: z.string().optional(),
  /**
   * Plain-text admin password. Development convenience; in production it is accepted only when
   * ADMIN_PASSWORD_HASH is not set and it has at least MIN_PROD_ADMIN_PASSWORD_LENGTH characters
   * (it is hashed at startup; prefer ADMIN_PASSWORD_HASH).
   */
  ADMIN_PASSWORD: z.string().optional(),
  VIEWER_USERNAME: z.string().default('viewer'),
  VIEWER_PASSWORD_HASH: z.string().optional(),

  DELTA_ENV: z.enum(['production', 'testnet', 'global', 'global-testnet', 'custom']).default('production'),
  DELTA_REST_URL: z.string().optional(),
  DELTA_WS_PUBLIC_URL: z.string().optional(),
  DELTA_WS_PRIVATE_URL: z.string().optional(),
  /** Override the human label shown in the UI (e.g. for a local mock exchange). */
  DELTA_LABEL: z.string().max(120).optional(),
  /** Override whether the endpoint is real money. Only meaningful with DELTA_ENV=custom. */
  DELTA_REAL_MONEY: bool(true),
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
});

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig extends Omit<Env, 'DELTA_ENV'> {
  DELTA_ENV: DeltaEnvName;
  isProd: boolean;
  sessionSecret: string;
  encryptionKey: Buffer | null;
  warnings: string[];
}

/** Loads a local `.env` for development (never overrides variables that are already set). */
export function loadDotEnv(): void {
  if (process.env.NODE_ENV === 'production') return;
  for (const f of ['.env', '../../.env']) {
    try {
      if (fs.existsSync(f)) (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(f);
    } catch {
      /* unreadable .env: ignore, the normal validation will report what is missing */
    }
  }
}

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  // Empty values (as in .env.example) mean "not set".
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${msg}`);
  }
  const env = parsed.data;
  const isProd = env.NODE_ENV === 'production';
  const warnings: string[] = [];

  if (env.DATABASE_URL !== undefined) {
    // Copy-paste from a phone often brings along spaces or quotes; a whole `psql '...'` command is rejected without echoing it.
    const url = env.DATABASE_URL.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
    if (!/^postgres(ql)?:\/\/\S+$/.test(url)) throw new Error('DATABASE_URL must be a single connection string starting with postgresql:// (copy only the URL, without psql, quotes or spaces)');
    env.DATABASE_URL = url;
  }

  let sessionSecret = env.SESSION_SECRET ?? '';
  if (sessionSecret.length < 32) {
    if (isProd) throw new Error('SESSION_SECRET must be set to a random string of at least 32 characters in production');
    sessionSecret = 'dev-only-insecure-session-secret-change-me-0123456789';
    warnings.push('SESSION_SECRET not set: using an insecure development secret');
  }

  let encryptionKey: Buffer | null = null;
  if (env.CREDENTIAL_ENCRYPTION_KEY) {
    encryptionKey = parseEncryptionKey(env.CREDENTIAL_ENCRYPTION_KEY);
  } else if (!isProd) {
    encryptionKey = Buffer.alloc(32, 7);
    warnings.push('CREDENTIAL_ENCRYPTION_KEY not set: using an insecure development key');
  } else {
    warnings.push('CREDENTIAL_ENCRYPTION_KEY not set: dashboard-stored API credentials are disabled (use DELTA_API_KEY / DELTA_API_SECRET)');
  }

  if (isProd) {
    // A plain password pasted into a *_HASH setting (or a hash whose "$" signs a host expanded) would silently lock everyone out.
    if (env.ADMIN_PASSWORD_HASH && !BCRYPT_HASH.test(env.ADMIN_PASSWORD_HASH)) {
      throw new Error(`ADMIN_PASSWORD_HASH does not look like a bcrypt hash (it starts with $2b$12$ and is 60 characters). To use a plain password instead, leave it empty and set ADMIN_PASSWORD (at least ${MIN_PROD_ADMIN_PASSWORD_LENGTH} characters)`);
    }
    if (env.VIEWER_PASSWORD_HASH && !BCRYPT_HASH.test(env.VIEWER_PASSWORD_HASH)) {
      throw new Error('VIEWER_PASSWORD_HASH does not look like a bcrypt hash (generate one with: npm run hash-password -- "your password")');
    }
    if (env.ADMIN_PASSWORD_HASH) {
      if (env.ADMIN_PASSWORD) warnings.push('ADMIN_PASSWORD is ignored because ADMIN_PASSWORD_HASH is set (the hash wins); remove ADMIN_PASSWORD from the host settings');
    } else if (env.ADMIN_PASSWORD) {
      if (env.ADMIN_PASSWORD.length < MIN_PROD_ADMIN_PASSWORD_LENGTH) throw new Error(`ADMIN_PASSWORD must be at least ${MIN_PROD_ADMIN_PASSWORD_LENGTH} characters in production`);
      warnings.push('ADMIN_PASSWORD (plain text) is used: it is hashed with bcrypt at startup. Prefer ADMIN_PASSWORD_HASH (npm run hash-password) so the plain password is not kept in the host settings');
      if (env.ADMIN_PASSWORD !== env.ADMIN_PASSWORD.trim()) warnings.push('ADMIN_PASSWORD starts or ends with a space: the space is part of the password and must be typed at login');
    } else {
      throw new Error(`ADMIN_PASSWORD_HASH must be set in production (generate with: npm run hash-password -- "your password"), or set ADMIN_PASSWORD to a password of at least ${MIN_PROD_ADMIN_PASSWORD_LENGTH} characters`);
    }
  }
  if (env.DELTA_ENV === 'custom' && !env.DELTA_REST_URL) throw new Error('DELTA_ENV=custom requires DELTA_REST_URL');
  if (isProd && env.MARKET_DATA_SOURCE === 'synthetic') throw new Error('MARKET_DATA_SOURCE=synthetic is for development only and is not allowed in production');
  if (isProd && env.PROXY_SHARED_SECRET && env.PROXY_SHARED_SECRET.length < 16) warnings.push('PROXY_SHARED_SECRET is shorter than 16 characters: use a long random value (the Render Blueprint generates one)');
  if (isProd && !env.PROXY_SHARED_SECRET) warnings.push('PROXY_SHARED_SECRET not set: anyone who can reach this API directly can attempt logins; set the same secret here and on Vercel so only the dashboard proxy can call it');
  if (isProd && !env.DATABASE_URL) warnings.push('DATABASE_URL not set: using embedded PGlite storage (single instance only). Use managed Postgres in production.');

  return { ...env, DELTA_ENV: env.DELTA_ENV as DeltaEnvName, isProd, sessionSecret, encryptionKey, warnings };
}
