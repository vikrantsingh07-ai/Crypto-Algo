import { buildApi } from './api';
import { AuthService } from './auth';
import { loadConfig, loadDotEnv, type AppConfig } from './config';
import { createLogger } from './logger';
import { createRuntime } from './runtime';

/**
 * Entry point for the always-on server: HTTP API + trading worker in one process.
 * Exactly one process may hold the worker lease and trade; extra replicas serve read-only API.
 */
async function main() {
  loadDotEnv();
  let cfg: AppConfig;
  try {
    cfg = loadConfig();
  } catch (e) {
    // One readable line for the host's log viewer (no stack trace, no values): the message names the setting to fix.
    process.stderr.write(`Configuration error: ${e instanceof Error ? e.message : String(e)}\nFix this setting in the host's environment variables and redeploy. The server did not start.\n`);
    process.exit(1);
  }
  const logger = createLogger(cfg.LOG_LEVEL, 'main');
  for (const w of cfg.warnings) logger.warn(w);

  const rt = await createRuntime(cfg);
  const auth = new AuthService(cfg, rt.repos);
  if (auth.generatedAdminPassword) {
    // Development convenience only (never in production: config refuses to start without a hash).
    process.stdout.write(`\n  [dev] No ADMIN_PASSWORD_HASH set. Generated admin login -> user: ${cfg.ADMIN_USERNAME}  password: ${auth.generatedAdminPassword}\n\n`);
  }

  await rt.bot.init();
  const app = await buildApi(rt, auth);
  await app.listen({ host: cfg.HOST, port: cfg.PORT });
  await rt.bot.start();

  const st = rt.bot.state;
  const banner =
    st.mode === 'demo' && !st.liveArmed
      ? 'DEMO MODE — LIVE TRADING DISABLED'
      : st.liveArmed
        ? `LIVE EXECUTION ARMED (${rt.endpoints.label})`
        : `mode=${st.mode}`;
  // Only yes/no facts about secrets, never their values. (Key names avoid "secret"/"password": the logger redacts those.)
  logger.info(`▶ ${banner}`, {
    port: cfg.PORT,
    exchange: rt.endpoints.label,
    marketData: cfg.MARKET_DATA_SOURCE,
    db: rt.db.kind,
    workerActive: rt.bot.workerActive,
    liveHardDisabled: cfg.LIVE_HARD_DISABLE,
    proxyGuard: !!cfg.PROXY_SHARED_SECRET,
    credentialEncryption: !!cfg.encryptionKey,
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.warn(`${signal} received: shutting down (open real positions keep their exchange-side stop and target)`);
    await app.close().catch(() => {});
    await rt.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => logger.error('unhandled rejection', { error: e instanceof Error ? e.message : String(e) }));
  process.on('uncaughtException', (e) => {
    logger.error('uncaught exception: exiting so the supervisor restarts the process', { error: e.message });
    process.exit(1);
  });
}

/** A one-line hint for the startup failures a first-time deployer actually hits (read in the host's log viewer). */
function startupHint(e: unknown): string | null {
  const err = e as { code?: string; message?: string; errors?: Array<{ code?: string }> };
  const code = err?.code ?? err?.errors?.[0]?.code ?? '';
  const msg = String(err?.message ?? '');
  if (/password authentication failed/i.test(msg)) return 'The database rejected the user or password in DATABASE_URL. Copy the connection string again from the database provider.';
  if (/does not support SSL/i.test(msg)) return 'This database does not use TLS: set DATABASE_SSL=disable.';
  if (/self[- ]signed|certificate|unable to verify|\bSSL\b|\bTLS\b/i.test(msg)) return 'TLS problem with the database. Make sure DATABASE_URL ends with ?sslmode=require, or set DATABASE_SSL=no-verify (encrypted, certificate not checked).';
  if (['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code) || /connection terminated|timeout/i.test(msg)) {
    return 'The server cannot reach the database in DATABASE_URL. Check the host name, that the database is running, and that you copied the whole connection string.';
  }
  return null;
}

main().catch((e) => {
  const hint = startupHint(e);
  process.stderr.write(`Fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n${hint ? `Hint: ${hint}\n` : ''}`);
  process.exit(1);
});
