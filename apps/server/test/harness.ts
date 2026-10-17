import { EventEmitter } from 'node:events';
import type { Candle, Quote, Signal } from '@cryptoalgo/core';
import type { FeedHealth, MarketFeed } from '@cryptoalgo/delta';
import { MockDeltaExchange } from '@cryptoalgo/delta/mock';
import { loadConfig, type AppConfig } from '../src/config';
import { createDb, migrate, type Db } from '../src/db/db';
import { createLogger } from '../src/logger';
import { createRuntime, type Runtime } from '../src/runtime';

export class FakeFeed extends EventEmitter implements MarketFeed {
  q: Quote | null = null;
  candles: Candle[] = [];
  funding: number | null = 0.0001;
  mode: FeedHealth['mode'] = 'ws';
  clock = () => Date.now();
  async start() {}
  stop() {}
  getQuote() {
    return this.q;
  }
  getClosedCandles() {
    return this.candles;
  }
  getFormingCandle() {
    return null;
  }
  getFundingRate() {
    return this.funding;
  }
  health(): FeedHealth {
    return { mode: this.mode, wsState: 'ready', lastQuoteAt: this.q?.ts ?? null, lastCandleAt: null, restOk: true, lastError: null, reconnects: 0 };
  }
  push(bid: number, ask: number, ts = this.clock()) {
    this.q = { ts, bid, ask, last: (bid + ask) / 2 };
    this.emit('quote', this.q);
  }
}

let sharedDb: Db | null = null;
/** One embedded Postgres per test file (booting PGlite costs ~2s); tables are truncated between tests. */
export async function getSharedDb(): Promise<Db> {
  if (!sharedDb) sharedDb = await createDb({ dataDir: 'memory://' });
  return sharedDb;
}
export async function closeSharedDb() {
  await sharedDb?.close();
  sharedDb = null;
}
export async function resetDb(db: Db) {
  await db.exec('TRUNCATE app_state, trades, live_orders, live_fills, audit_log, equity_snapshots, backtest_runs, credentials, worker_lease RESTART IDENTITY');
}

export interface Harness {
  ex: MockDeltaExchange;
  rt: Runtime;
  feed: FakeFeed;
  cfg: AppConfig;
  db: Db;
  clock: { t: number };
  logs: string[];
  stop(): Promise<void>;
  restart(): Promise<Harness>;
}

export const baseEnv = (ex: MockDeltaExchange, over: Record<string, string> = {}) => ({
  NODE_ENV: 'test',
  DELTA_ENV: 'custom',
  DELTA_REST_URL: ex.restUrl,
  DELTA_WS_PUBLIC_URL: ex.wsUrl,
  DELTA_API_KEY: 'test-key',
  DELTA_API_SECRET: 'test-secret',
  SESSION_SECRET: 'x'.repeat(40),
  ADMIN_PASSWORD: 'correct horse battery',
  ...over,
});

/** Permissive risk gates so unit tests can reach the order path (fees make defaults reject most signals). */
export const RELAXED = { limits: { minNetRewardRisk: 0, minExpectedNetRewardUsd: 0, perTradeRiskUsd: 20, dailyLossLimitUsd: 100, maxDrawdownPct: 90 } };

export async function makeHarness(opts: { ex?: MockDeltaExchange; db?: Db; env?: Record<string, string>; relax?: boolean; startClock?: number; withCredentials?: boolean; keepDb?: boolean } = {}): Promise<Harness> {
  const ex = opts.ex ?? new MockDeltaExchange({ heartbeatMs: 100 });
  if (!opts.ex) await ex.start();
  const env = baseEnv(ex, opts.env);
  if (opts.withCredentials === false) {
    delete (env as any).DELTA_API_KEY;
    delete (env as any).DELTA_API_SECRET;
  }
  const cfg = loadConfig(env);
  let db = opts.db;
  const shared = !db || !!opts.keepDb;
  if (!db) {
    db = await getSharedDb();
    await migrateIfNeeded(db);
    await resetDb(db);
  }
  const feed = new FakeFeed();
  const clock = { t: opts.startClock ?? Date.now() };
  feed.clock = () => clock.t;
  const logs: string[] = [];
  const logger = createLogger('debug', 'test', (l) => logs.push(l));
  const rt = await createRuntime(cfg, {
    db,
    feed,
    logger,
    now: () => clock.t,
    sleep: async () => {},
    endpoints: { env: 'custom', restUrl: ex.restUrl, wsPublicUrl: ex.wsUrl, wsPrivateUrl: ex.wsUrl, label: 'MOCK exchange (tests)', realMoney: false },
  });
  ex.setQuote(2999.95, 3000.05);
  feed.push(2999.95, 3000.05);
  if (opts.relax !== false) await rt.updateSettings(RELAXED, 'test', 'admin');
  await rt.demo.init();
  await rt.live.loadHistory();
  await rt.creds.refresh();
  const h: Harness = {
    ex,
    rt,
    feed,
    cfg,
    db: db!,
    clock,
    logs,
    async stop() {
      await rt.bot.shutdown();
      await ex.stop();
      if (!shared) await db!.close();
    },
    async restart() {
      await rt.bot.shutdown();
      // simulate a process restart: new runtime over the SAME database and the SAME exchange
      return makeHarness({ ex, db: db!, keepDb: shared, env: opts.env, relax: false, startClock: clock.t, withCredentials: opts.withCredentials });
    },
  };
  return h;
}

export const signalAt = (candleTime: number, side: 'long' | 'short' = 'long', over: Partial<Signal> = {}): Signal => ({
  side,
  candleTime,
  refPrice: 3000,
  atr: 1.6,
  targetMoveUsd: 5,
  stopMoveUsd: 3,
  regime: 'trend_up',
  reasons: ['test signal'],
  features: {},
  ...over,
});

/** Put the persisted bot state into "live and armed", the way the activation workflow does. */
export async function arm(h: Harness) {
  const s = await h.rt.repos.getBotState(true);
  await h.rt.bot.save({ ...s, mode: 'live', liveArmed: true, running: true, liveArmedFingerprint: h.rt.creds.fingerprint() });
}

async function migrateIfNeeded(db: Db) {
  await migrate(db);
}
