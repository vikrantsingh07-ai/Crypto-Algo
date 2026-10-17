import { buildApi } from './api';
import { AuthService } from './auth';
import { loadConfig } from './config';
import { createLogger } from './logger';
import { createRuntime } from './runtime';

/**
 * Entry point for the always-on server: HTTP API + trading worker in one process.
 * Exactly one process may hold the worker lease and trade; extra replicas serve read-only API.
 */
async function main() {
  const cfg = loadConfig();
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
  logger.info(`▶ ${banner}`, { port: cfg.PORT, exchange: rt.endpoints.label, marketData: cfg.MARKET_DATA_SOURCE, db: rt.db.kind, workerActive: rt.bot.workerActive });

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

main().catch((e) => {
  process.stderr.write(`Fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
