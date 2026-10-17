import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { computeMetrics, drawdownSeries, type Settings } from '@cryptoalgo/core';
import { explainDeltaError } from '@cryptoalgo/delta';
import { AuthService, type Principal, type UserRole } from './auth';
import { safeEqual } from './crypto';
import type { Runtime } from './runtime';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

const downsample = <T>(xs: T[], max: number): T[] => {
  if (xs.length <= max) return xs;
  const step = xs.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(xs[Math.floor(i * step)]);
  out.push(xs[xs.length - 1]);
  return out;
};

export async function buildApi(rt: Runtime, auth = new AuthService(rt.cfg, rt.repos)): Promise<FastifyInstance & { auth: AuthService }> {
  const base = Fastify({ logger: false, trustProxy: true, bodyLimit: 64 * 1024, disableRequestLogging: true });
  const app = Object.assign(base, { auth }) as unknown as FastifyInstance & { auth: AuthService };

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute', allowList: [] });

  // ---- optional shared secret between the dashboard proxy and this API (defence in depth) ----
  app.addHook('onRequest', async (req, reply) => {
    const secret = rt.cfg.PROXY_SHARED_SECRET;
    if (!secret || req.url === '/api/health' || req.url.startsWith('/api/health?')) return;
    const got = req.headers['x-proxy-secret'];
    if (typeof got !== 'string' || !safeEqual(got, secret)) return reply.code(403).send({ error: 'forbidden' });
  });

  const requireRole = (role: UserRole) => async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
    const principal = token ? await auth.verify(token) : null;
    if (!principal) return reply.code(401).send({ error: 'unauthorized' });
    if (role === 'admin' && principal.role !== 'admin') {
      await rt.repos.audit({ actor: principal.username, role: principal.role, ip: req.ip, action: 'forbidden', success: false, details: { path: req.url, method: req.method } }).catch(() => {});
      return reply.code(403).send({ error: 'forbidden', message: 'Administrator role required' });
    }
    req.principal = principal;
  };
  const viewer = { preHandler: requireRole('viewer') };
  const admin = { preHandler: requireRole('admin') };
  const strict = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

  const parse = <T extends z.ZodTypeAny>(schema: T, data: unknown, reply: FastifyReply): z.infer<T> | null => {
    const r = schema.safeParse(data ?? {});
    if (!r.success) {
      reply.code(400).send({ error: 'invalid_request', issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
      return null;
    }
    return r.data;
  };
  const needWorker = (reply: FastifyReply): boolean => {
    if (!rt.bot.workerActive) {
      reply.code(409).send({ error: 'worker_not_active_here', message: 'The trading worker is not active on this instance; commands are disabled.' });
      return false;
    }
    return true;
  };
  const who = (req: FastifyRequest) => ({ actor: req.principal!.username, role: req.principal!.role, ip: req.ip });

  // ------------------------------------------------------------------ public
  app.get('/api/health', async () => {
    let dbOk = false;
    try {
      await rt.db.query('SELECT 1');
      dbOk = true;
    } catch {
      /* reported below */
    }
    return { ok: dbOk, db: dbOk, workerActive: rt.bot.workerActive, time: Date.now() };
  });

  app.post('/api/auth/login', { ...strict(10) }, async (req, reply) => {
    const body = parse(z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(500) }), req.body, reply);
    if (!body) return;
    const res = await auth.login(body.username, body.password, req.ip);
    if (!res.ok) return reply.code(res.status).send({ error: res.error });
    return { token: res.token, role: res.role, username: res.username, expiresAt: res.expiresAt };
  });

  // ------------------------------------------------------------------ read (viewer+)
  app.get('/api/auth/me', viewer, async (req) => ({ username: req.principal!.username, role: req.principal!.role }));

  app.get('/api/state', viewer, async () => ({ ...rt.bot.snapshot(), serverTime: Date.now() }));

  app.get('/api/settings', viewer, async () => ({ settings: rt.getSettings(), spec: rt.getSpec() }));

  app.get('/api/trades', viewer, async (req, reply) => {
    const q = parse(z.object({ mode: z.enum(['demo', 'live']), limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0), all: z.coerce.boolean().default(false) }), req.query, reply);
    if (!q) return;
    const since = q.mode === 'demo' && !q.all && rt.demo.account ? rt.demo.account.epochStart : 0;
    const rows = await rt.repos.listTrades(q.mode, { limit: q.limit, offset: q.offset, since });
    return { mode: q.mode, label: q.mode === 'demo' ? 'SIMULATED trades (virtual balance, paper fills)' : 'REAL exchange trades', trades: rows };
  });

  app.get('/api/analytics', viewer, async (req, reply) => {
    const q = parse(z.object({ mode: z.enum(['demo', 'live']) }), req.query, reply);
    if (!q) return;
    const s = rt.getSettings();
    const since = q.mode === 'demo' ? rt.demo.account?.epochStart ?? 0 : 0;
    const trades = await rt.repos.closedTrades(q.mode, since);
    const start = q.mode === 'demo' ? rt.demo.account?.startingBalanceUsd ?? s.demo.startingBalanceUsd : (rt.live.baselineEquityUsd ?? 0);
    const m = computeMetrics(trades, start, s.execution.usdInrRate);
    const curve = downsample(m.equityCurve, 400);
    const equity = await rt.repos.equitySeries(q.mode, since, 1500);
    return {
      mode: q.mode,
      label: q.mode === 'demo' ? 'SIMULATED (paper) results — virtual balance, simulated fills' : 'ACTUAL exchange results',
      metrics: { ...m, equityCurve: curve },
      drawdown: drawdownSeries(curve, m.startingBalance),
      equitySnapshots: downsample(equity, 400),
      recent: trades.slice(-200).map((t) => ({ id: t.id, side: t.side, entryTs: t.entryTs, exitTs: t.exitTs, netPnl: t.netPnl, fees: t.fees, holdMs: t.holdMs, exitReason: t.exitReason, regime: t.regime, reachedTarget: t.reachedTarget })),
    };
  });

  app.get('/api/backtests', viewer, async () => ({ runs: await rt.repos.listBacktests(20), dataSource: rt.cfg.MARKET_DATA_SOURCE }));
  app.get('/api/backtests/:id', viewer, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const run = await rt.repos.getBacktest(id);
    if (!run) return reply.code(404).send({ error: 'not_found' });
    return run;
  });

  app.get('/api/credentials', viewer, async () => rt.creds.status());

  // ------------------------------------------------------------------ admin: bot control
  app.post('/api/bot/start', admin, async (req, reply) => {
    if (!needWorker(reply)) return;
    const w = who(req);
    return { state: await rt.bot.setRunning(true, w.actor, w.role, w.ip) };
  });
  app.post('/api/bot/stop', admin, async (req, reply) => {
    if (!needWorker(reply)) return;
    const w = who(req);
    return { state: await rt.bot.setRunning(false, w.actor, w.role, w.ip) };
  });

  app.post('/api/mode', { ...admin, ...strict(20) }, async (req, reply) => {
    const body = parse(z.object({ mode: z.enum(['demo', 'live']) }), req.body, reply);
    if (!body) return;
    if (!needWorker(reply)) return;
    const w = who(req);
    if (body.mode === 'live') {
      // Selecting Live NEVER arms execution by itself.
      await rt.repos.audit({ ...w, action: 'live_switch_rejected', success: false, details: { reason: 'activation workflow required' } });
      return reply.code(409).send({ error: 'use_activation_workflow', message: 'Live trading can only be enabled through the activation workflow (POST /api/live/preflight, then /api/live/activate).' });
    }
    const res = await rt.bot.switchToDemo(w.actor, w.role, w.ip);
    return { result: res, state: rt.bot.state };
  });

  app.post('/api/kill-switch', { ...admin, ...strict(20) }, async (req, reply) => {
    const body = parse(z.object({ engage: z.boolean(), reason: z.string().max(200).optional() }), req.body, reply);
    if (!body) return;
    if (!needWorker(reply)) return;
    const w = who(req);
    if (body.engage) {
      const r = await rt.bot.engageKillSwitch(w.actor, w.role, w.ip, body.reason ?? 'dashboard');
      return { engaged: true, action: r.action, state: r.state };
    }
    return { engaged: false, state: await rt.bot.releaseKillSwitch(w.actor, w.role, w.ip) };
  });

  app.post('/api/attention/clear', admin, async (req) => {
    const w = who(req);
    await rt.bot.clearAttention(w.actor, w.role, w.ip);
    return { ok: true };
  });

  // ------------------------------------------------------------------ admin: live activation
  app.post('/api/live/preflight', { ...admin, ...strict(12) }, async (req, reply) => {
    if (!needWorker(reply)) return;
    const w = who(req);
    const result = await rt.activation.preflight(w.actor);
    await rt.repos.audit({ ...w, action: 'live_preflight', success: result.ok, details: { failed: result.checks.filter((c) => c.blocker && !c.ok).map((c) => c.id) } });
    return result;
  });

  app.post('/api/live/activate', { ...admin, ...strict(6) }, async (req, reply) => {
    const body = parse(z.object({ token: z.string().min(10), phrase: z.string().max(100), acknowledged: z.boolean(), password: z.string().min(1).max(500) }), req.body, reply);
    if (!body) return;
    if (!needWorker(reply)) return;
    const w = who(req);
    // step-up: the operator must re-enter their password
    if (!(await auth.verifyPassword(w.actor, body.password))) {
      await rt.repos.audit({ ...w, action: 'live_activation_failed', success: false, details: { error: 'password re-entry failed' } });
      return reply.code(403).send({ error: 'password_incorrect', message: 'Password confirmation failed' });
    }
    const res = await rt.activation.activate({ actor: w.actor, role: w.role, ip: w.ip, token: body.token, phrase: body.phrase, acknowledged: body.acknowledged });
    if (!res.ok) return reply.code(res.failedChecks ? 412 : 400).send({ error: 'activation_refused', message: res.error, failedChecks: res.failedChecks ?? [] });
    return { ok: true, state: res.state };
  });

  app.post('/api/live/reconcile', { ...admin, ...strict(30) }, async (req, reply) => {
    if (!needWorker(reply)) return;
    await rt.live.reconcile();
    return { reconciled: rt.live.reconciled, reason: rt.live.reconcileReason, live: rt.live.snapshot() };
  });

  app.post('/api/live/close-position', { ...admin, ...strict(10) }, async (req, reply) => {
    if (!needWorker(reply)) return;
    const w = who(req);
    await rt.repos.audit({ ...w, action: 'live_manual_close_requested', details: {} });
    try {
      await rt.live.closeNow('manual');
      return { ok: true };
    } catch (e) {
      return reply.code(502).send({ error: 'close_failed', message: explainDeltaError(e) });
    }
  });

  app.post('/api/live/reset-baseline', admin, async (req) => {
    const w = who(req);
    rt.live.resetBaseline();
    await rt.repos.audit({ ...w, action: 'live_drawdown_baseline_reset', details: { equity: rt.live.baselineEquityUsd } });
    return { ok: true, baselineEquityUsd: rt.live.baselineEquityUsd };
  });

  // ------------------------------------------------------------------ admin: demo
  app.post('/api/demo/reset', admin, async (req, reply) => {
    const body = parse(z.object({ startingBalanceUsd: z.number().min(1).max(10_000_000).optional() }), req.body, reply);
    if (!body) return;
    if (!needWorker(reply)) return;
    const w = who(req);
    await rt.demo.reset(body.startingBalanceUsd);
    await rt.repos.audit({ ...w, action: 'demo_reset', details: body });
    return { ok: true, demo: rt.demo.summary() };
  });
  app.post('/api/demo/close', admin, async (req, reply) => {
    if (!needWorker(reply)) return;
    const w = who(req);
    const t = await rt.demo.closeNow('manual');
    await rt.repos.audit({ ...w, action: 'demo_manual_close', details: { closed: !!t } });
    return { ok: true, closed: !!t };
  });

  // ------------------------------------------------------------------ admin: settings, credentials, backtests, audit
  app.put('/api/settings', { ...admin, ...strict(30) }, async (req, reply) => {
    const patch = req.body;
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return reply.code(400).send({ error: 'invalid_request' });
    const w = who(req);
    const res = await rt.updateSettings(patch, w.actor, w.role, w.ip);
    if (!res.ok) return reply.code(422).send({ error: 'settings_invalid', issues: res.issues });
    return { settings: res.settings as Settings, issues: res.issues, changed: res.changed };
  });

  app.put('/api/credentials', { ...admin, ...strict(10) }, async (req, reply) => {
    const body = parse(z.object({ apiKey: z.string().min(8).max(200), apiSecret: z.string().min(8).max(400), password: z.string().min(1).max(500) }), req.body, reply);
    if (!body) return;
    const w = who(req);
    if (!(await auth.verifyPassword(w.actor, body.password))) return reply.code(403).send({ error: 'password_incorrect' });
    try {
      await rt.creds.save(body.apiKey, body.apiSecret, w.actor);
    } catch (e) {
      return reply.code(400).send({ error: 'cannot_store', message: (e as Error).message });
    }
    // credentials changed: disarm live execution, it must be re-activated with the new key
    const st = await rt.bot.reload();
    if (st.liveArmed || st.mode === 'live') {
      await rt.bot.save({ ...st, liveArmed: false, mode: 'demo', attention: [...st.attention, 'API credentials replaced; Live trading disarmed'] });
    }
    await rt.repos.audit({ ...w, action: 'credentials_updated', details: { fingerprint: rt.creds.fingerprint(), env: rt.endpoints.env } });
    return rt.creds.status();
  });

  app.delete('/api/credentials', { ...admin, ...strict(10) }, async (req, reply) => {
    const w = who(req);
    try {
      await rt.creds.clear();
    } catch (e) {
      return reply.code(400).send({ error: 'cannot_clear', message: (e as Error).message });
    }
    const st = await rt.bot.reload();
    if (st.liveArmed || st.mode === 'live') await rt.bot.save({ ...st, liveArmed: false, mode: 'demo' });
    await rt.repos.audit({ ...w, action: 'credentials_deleted', details: { env: rt.endpoints.env } });
    return rt.creds.status();
  });

  app.post('/api/credentials/test', { ...admin, ...strict(10) }, async (req, reply) => {
    if (!rt.creds.status().configured) return reply.code(400).send({ error: 'no_credentials' });
    const w = who(req);
    const out: { step: string; ok: boolean; detail: string }[] = [];
    try {
      const spec = await rt.refreshSpec();
      out.push({ step: 'public API', ok: spec.verified, detail: `${spec.symbol} product ${spec.productId}` });
    } catch (e) {
      out.push({ step: 'public API', ok: false, detail: explainDeltaError(e) });
    }
    try {
      const b = await rt.client.getBalances();
      out.push({ step: 'authenticated read (balances)', ok: true, detail: `${b.length} wallet(s) visible` });
    } catch (e) {
      out.push({ step: 'authenticated read (balances)', ok: false, detail: explainDeltaError(e) });
    }
    await rt.repos.audit({ ...w, action: 'credentials_tested', success: out.every((o) => o.ok), details: { results: out } });
    return { ok: out.every((o) => o.ok), steps: out, environment: rt.endpoints.label, clockOffsetMs: rt.http.clockOffset };
  });

  app.post('/api/backtests', { ...admin, ...strict(6) }, async (req, reply) => {
    const body = parse(
      z.object({
        kind: z.enum(['backtest', 'walkforward']).default('backtest'),
        days: z.number().int().min(2).max(60).default(14),
        spreadUsd: z.number().min(0).max(5).optional(),
        trainDays: z.number().min(1).max(40).optional(),
        testDays: z.number().min(1).max(20).optional(),
      }),
      req.body,
      reply,
    );
    if (!body) return;
    const w = who(req);
    try {
      const id = await rt.backtests.start(body);
      await rt.repos.audit({ ...w, action: 'backtest_started', details: { id, ...body, dataSource: rt.cfg.MARKET_DATA_SOURCE } });
      return reply.code(202).send({ id });
    } catch (e) {
      return reply.code(409).send({ error: 'backtest_unavailable', message: (e as Error).message });
    }
  });

  app.get('/api/audit', admin, async (req, reply) => {
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), action: z.string().max(60).optional() }), req.query, reply);
    if (!q) return;
    return { entries: await rt.repos.listAudit(q.limit, q.action) };
  });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err?.statusCode === 429) return reply.code(429).send({ error: 'rate_limited', message: 'Too many requests' });
    rt.logger.error('api error', { error: err?.message });
    return reply.code(err?.statusCode && err.statusCode < 500 ? err.statusCode : 500).send({ error: 'internal_error' });
  });

  return app;
}
