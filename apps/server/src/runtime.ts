import path from 'node:path';
import {
  SettingsSchema,
  deepMerge,
  fallbackContractSpec,
  hasErrors,
  validateSettings,
  type ContractSpec,
  type Settings,
  type SettingsIssue,
} from '@cryptoalgo/core';
import {
  DeltaClient,
  DeltaHttp,
  DeltaMarketFeed,
  resolveEndpoints,
  type DeltaEndpoints,
  type Logger,
  type MarketFeed,
} from '@cryptoalgo/delta';
import type { AppConfig } from './config';
import { createDb, migrate, type Db } from './db/db';
import { createLogger } from './logger';
import { Repos } from './repos';
import { LiveActivation } from './services/activation';
import { BacktestService } from './services/backtestService';
import { Bot } from './services/bot';
import { CredentialStore } from './services/credentials';
import { DemoEngine } from './services/demoEngine';
import { LiveExecutor } from './services/liveExecutor';
import { SyntheticFeed } from './services/syntheticFeed';

export interface RuntimeOverrides {
  db?: Db;
  feed?: MarketFeed;
  endpoints?: DeltaEndpoints;
  logger?: Logger & { child(scope: string): Logger };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Runtime {
  cfg: AppConfig;
  db: Db;
  repos: Repos;
  logger: Logger;
  endpoints: DeltaEndpoints;
  creds: CredentialStore;
  http: DeltaHttp;
  client: DeltaClient;
  feed: MarketFeed;
  demo: DemoEngine;
  live: LiveExecutor;
  bot: Bot;
  activation: LiveActivation;
  backtests: BacktestService;
  getSettings(): Settings;
  getSpec(): ContractSpec;
  refreshSpec(): Promise<ContractSpec>;
  updateSettings(patch: unknown, actor: string, role: string, ip?: string | null): Promise<{ ok: boolean; settings: Settings; issues: SettingsIssue[]; changed: string[] }>;
  close(): Promise<void>;
}

function diffPaths(a: unknown, b: unknown, prefix = ''): string[] {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix];
  const out: string[] = [];
  for (const k of new Set([...Object.keys(a as object), ...Object.keys(b as object)])) {
    out.push(...diffPaths((a as any)[k], (b as any)[k], prefix ? `${prefix}.${k}` : k));
  }
  return out;
}

export async function createRuntime(cfg: AppConfig, ov: RuntimeOverrides = {}): Promise<Runtime> {
  const logger = ov.logger ?? createLogger(cfg.LOG_LEVEL);
  const db = ov.db ?? (await createDb({ url: cfg.DATABASE_URL, ssl: cfg.DATABASE_SSL, dataDir: path.join(cfg.DATA_DIR, 'pglite') }));
  await migrate(db);
  const repos = new Repos(db);

  const endpoints =
    ov.endpoints ??
    resolveEndpoints(cfg.DELTA_ENV, { restUrl: cfg.DELTA_REST_URL, wsPublicUrl: cfg.DELTA_WS_PUBLIC_URL, wsPrivateUrl: cfg.DELTA_WS_PRIVATE_URL });

  const creds = new CredentialStore(repos, cfg, endpoints.env);
  await creds.refresh();
  const http = new DeltaHttp({ baseUrl: endpoints.restUrl, credentials: creds.provider, userAgent: 'cryptoalgo-bot/1.0', logger, sleep: ov.sleep });
  const client = new DeltaClient(http);

  let settings = await repos.loadSettings();
  let spec: ContractSpec = fallbackContractSpec(cfg.SYMBOL);

  const feed: MarketFeed =
    ov.feed ??
    (cfg.MARKET_DATA_SOURCE === 'synthetic'
      ? new SyntheticFeed({ speed: Number(process.env.SYNTHETIC_SPEED ?? 1) })
      : new DeltaMarketFeed({ client, endpoints, symbol: settings.instrument.symbol || cfg.SYMBOL, logger: (logger as any).child?.('feed') ?? logger }));
  const now = ov.now ?? (feed.now ? () => feed.now!() : Date.now);

  const getSettings = () => settings;
  const getSpec = () => spec;
  const refreshSpec = async (): Promise<ContractSpec> => {
    if (cfg.MARKET_DATA_SOURCE === 'synthetic') return spec;
    try {
      spec = await client.getProduct(settings.instrument.symbol);
    } catch (e) {
      logger.warn('could not refresh contract spec from the exchange', { error: (e as Error).message });
      if (spec.verified) spec = { ...spec, verified: spec.fetchedAt !== null && now() - spec.fetchedAt < 6 * 3_600_000 };
    }
    return spec;
  };
  // Best effort at boot; the bot re-tries periodically and live activation requires a fresh read.
  await refreshSpec();

  let botRef: Bot | null = null;
  const demo = new DemoEngine({ repos, getSettings, getSpec, getFundingRate: () => feed.getFundingRate(), now, logger: (logger as any).child?.('demo') ?? logger });
  const live = new LiveExecutor({
    client,
    repos,
    getSettings,
    getSpec,
    getBotState: () => repos.getBotState(cfg.BOT_AUTOSTART),
    getQuote: () => feed.getQuote(),
    quoteAgeMs: () => {
      const q = feed.getQuote();
      return q ? now() - q.ts : null;
    },
    feedHealthy: () => feed.health().mode !== 'down',
    hasCredentials: () => creds.status().configured,
    now,
    sleep: ov.sleep,
    logger: (logger as any).child?.('live') ?? logger,
    onAttention: (m) => void botRef?.addAttention(m).catch(() => {}),
  });
  const bot = new Bot({ cfg, repos, logger: (logger as any).child?.('bot') ?? logger, feed, demo, live, creds, http, endpoints, getSettings, getSpec, refreshSpec, now });
  botRef = bot;
  const activation = new LiveActivation({
    cfg, repos, creds, client, http, endpoints, getSettings, getSpec, refreshSpec, executor: live, feed,
    getBotState: () => repos.getBotState(cfg.BOT_AUTOSTART),
    saveBotState: (s) => bot.save(s),
    now,
    logger: (logger as any).child?.('activation') ?? logger,
  });
  const backtests = new BacktestService({ repos, client: cfg.MARKET_DATA_SOURCE === 'synthetic' ? null : client, source: cfg.MARKET_DATA_SOURCE, symbol: settings.instrument.symbol, getSettings, getSpec, logger });

  const updateSettings: Runtime['updateSettings'] = async (patch, actor, role, ip) => {
    const merged = deepMerge(settings, patch);
    const parsed = SettingsSchema.safeParse(merged);
    if (!parsed.success) {
      const issues: SettingsIssue[] = parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message, severity: 'error' as const }));
      return { ok: false, settings, issues, changed: [] };
    }
    const issues = validateSettings(parsed.data, spec, { referencePrice: feed.getQuote()?.last ?? null });
    if (hasErrors(issues)) return { ok: false, settings, issues, changed: [] };
    const changed = diffPaths(settings, parsed.data);
    settings = parsed.data;
    await repos.saveSettings(settings);
    if (changed.length) await repos.audit({ actor, role, ip, action: 'settings_changed', details: { changed } });
    return { ok: true, settings, issues, changed };
  };

  return {
    cfg, db, repos, logger, endpoints, creds, http, client, feed, demo, live, bot, activation, backtests,
    getSettings, getSpec, refreshSpec, updateSettings,
    async close() {
      await bot.shutdown();
      await db.close();
    },
  };
}
