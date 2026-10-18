import { SettingsSchema, defaultSettings, type ClosedTrade, type DemoAccountState, type OpenPosition, type Settings, type TradingMode } from '@cryptoalgo/core';
import type { Db, Queryable } from './db/db';

/** Persistent state held in the database. */

export interface BotState {
  /** Which engine receives NEW entries. 'demo' on a fresh install. */
  mode: TradingMode;
  /** Strategy loop on/off for the active mode. */
  running: boolean;
  /** Emergency stop: blocks all new entries in every mode until released by an admin. */
  killSwitch: boolean;
  killSwitchAt: number | null;
  /** Live execution armed: set ONLY by the multi-step activation workflow. */
  liveArmed: boolean;
  liveArmedAt: number | null;
  liveArmedBy: string | null;
  liveArmedFingerprint: string | null;
  liveArmedEnv: string | null;
  /** Human-readable items that need operator attention (e.g. an open real position after a mode switch). */
  attention: string[];
  updatedAt: number;
}

export function defaultBotState(autostart: boolean): BotState {
  return {
    mode: 'demo',
    running: autostart,
    killSwitch: false,
    killSwitchAt: null,
    liveArmed: false,
    liveArmedAt: null,
    liveArmedBy: null,
    liveArmedFingerprint: null,
    liveArmedEnv: null,
    attention: [],
    updatedAt: Date.now(),
  };
}

export interface AuditEntry {
  actor: string;
  role?: string | null;
  action: string;
  success?: boolean;
  ip?: string | null;
  details?: unknown;
}

export interface LiveOrderRow {
  clientOrderId: string;
  exchangeOrderId: string | null;
  tradeId: string;
  purpose: 'entry' | 'stop' | 'target' | 'exit' | 'breakeven_stop';
  side: string;
  size: number;
  price: number | null;
  state: string;
  filledSize: number;
  avgFillPrice: number | null;
  commission: number | null;
}

export interface TradeRow {
  id: string;
  mode: TradingMode;
  status: 'pending_entry' | 'open' | 'closed' | 'failed';
  side: 'long' | 'short';
  contracts: number;
  qtyEth: number;
  leverage: number;
  entryTs: number;
  exitTs: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  exitReason: string | null;
  stopPrice: number | null;
  targetPrice: number | null;
  grossPnl: number | null;
  entryFee: number | null;
  exitFee: number | null;
  /** Closing fee waived by the Scalper Offer, USD. null on rows stored before the offer was modelled. */
  exitFeeSaved: number | null;
  fees: number | null;
  slippageCost: number | null;
  funding: number | null;
  netPnl: number | null;
  netPnlInr: number | null;
  holdMs: number | null;
  mfe: number | null;
  mae: number | null;
  reachedTarget: boolean | null;
  regime: string | null;
  reasons: string[] | null;
  meta: Record<string, any> | null;
}

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function rowToTrade(r: any): TradeRow {
  return {
    id: r.id,
    mode: r.mode,
    status: r.status,
    side: r.side,
    contracts: Number(r.contracts),
    qtyEth: Number(r.qty_eth),
    leverage: Number(r.leverage),
    entryTs: Number(r.entry_ts),
    exitTs: n(r.exit_ts),
    entryPrice: n(r.entry_price),
    exitPrice: n(r.exit_price),
    exitReason: r.exit_reason ?? null,
    stopPrice: n(r.stop_price),
    targetPrice: n(r.target_price),
    grossPnl: n(r.gross_pnl),
    entryFee: n(r.entry_fee),
    exitFee: n(r.exit_fee),
    exitFeeSaved: n(r.exit_fee_saved),
    fees: n(r.fees),
    slippageCost: n(r.slippage_cost),
    funding: n(r.funding),
    netPnl: n(r.net_pnl),
    netPnlInr: n(r.net_pnl_inr),
    holdMs: n(r.hold_ms),
    mfe: n(r.mfe),
    mae: n(r.mae),
    reachedTarget: r.reached_target ?? null,
    regime: r.regime ?? null,
    reasons: r.reasons ?? null,
    meta: r.meta ?? null,
  };
}

export function tradeRowToClosed(t: TradeRow): ClosedTrade {
  return {
    id: t.id,
    mode: t.mode,
    side: t.side,
    contracts: t.contracts,
    qtyEth: t.qtyEth,
    leverage: t.leverage,
    entryTs: t.entryTs,
    exitTs: t.exitTs ?? t.entryTs,
    entryPrice: t.entryPrice ?? 0,
    exitPrice: t.exitPrice ?? 0,
    exitReason: (t.exitReason ?? 'manual') as ClosedTrade['exitReason'],
    stopPrice: t.stopPrice ?? 0,
    targetPrice: t.targetPrice ?? 0,
    grossPnl: t.grossPnl ?? 0,
    entryFee: t.entryFee ?? 0,
    exitFee: t.exitFee ?? 0,
    exitFeeSaved: t.exitFeeSaved ?? 0,
    fees: t.fees ?? 0,
    slippageCost: t.slippageCost ?? 0,
    funding: t.funding ?? 0,
    netPnl: t.netPnl ?? 0,
    netPnlInr: t.netPnlInr ?? 0,
    holdMs: t.holdMs ?? 0,
    mfe: t.mfe ?? 0,
    mae: t.mae ?? 0,
    reachedTarget: t.reachedTarget ?? false,
    regime: (t.regime ?? 'range') as ClosedTrade['regime'],
    reasons: t.reasons ?? [],
  };
}

export class Repos {
  constructor(public readonly db: Db) {}

  // ---------- singleton documents ----------
  async getDoc<T>(key: string, q: Queryable = this.db): Promise<T | null> {
    const rows = await q.query<{ value: T }>('SELECT value FROM app_state WHERE key = $1', [key]);
    return rows[0]?.value ?? null;
  }

  async setDoc(key: string, value: unknown, q: Queryable = this.db): Promise<void> {
    await q.query(
      `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }

  // ---------- settings ----------
  async loadSettings(): Promise<Settings> {
    const raw = await this.getDoc<unknown>('settings');
    if (!raw) return defaultSettings();
    const parsed = SettingsSchema.safeParse(raw);
    return parsed.success ? parsed.data : defaultSettings();
  }

  async saveSettings(s: Settings): Promise<void> {
    await this.setDoc('settings', s);
  }

  // ---------- bot state ----------
  async getBotState(autostart: boolean): Promise<BotState> {
    const raw = await this.getDoc<Partial<BotState>>('bot_state');
    return { ...defaultBotState(autostart), ...(raw ?? {}) };
  }

  async saveBotState(s: BotState): Promise<void> {
    await this.setDoc('bot_state', { ...s, updatedAt: Date.now() });
  }

  // ---------- demo account ----------
  async getDemoAccount(): Promise<(DemoAccountState & { epochStart: number }) | null> {
    return this.getDoc('demo_account');
  }
  async saveDemoAccount(a: DemoAccountState & { epochStart: number }, q: Queryable = this.db): Promise<void> {
    await this.setDoc('demo_account', a, q);
  }

  // ---------- trades ----------
  async upsertTrade(t: Partial<TradeRow> & Pick<TradeRow, 'id' | 'mode' | 'status' | 'side' | 'contracts' | 'qtyEth' | 'leverage' | 'entryTs'>, q: Queryable = this.db): Promise<void> {
    await q.query(
      `INSERT INTO trades (id, mode, status, side, contracts, qty_eth, leverage, entry_ts, exit_ts, entry_price, exit_price, exit_reason,
         stop_price, target_price, gross_pnl, entry_fee, exit_fee, fees, slippage_cost, funding, net_pnl, net_pnl_inr, hold_ms, mfe, mae,
         reached_target, regime, reasons, meta, exit_fee_saved, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28::jsonb,$29::jsonb,$30, now())
       ON CONFLICT (id) DO UPDATE SET
         status=EXCLUDED.status, contracts=EXCLUDED.contracts, qty_eth=EXCLUDED.qty_eth, exit_ts=EXCLUDED.exit_ts, entry_price=EXCLUDED.entry_price,
         exit_price=EXCLUDED.exit_price, exit_reason=EXCLUDED.exit_reason, stop_price=EXCLUDED.stop_price, target_price=EXCLUDED.target_price,
         gross_pnl=EXCLUDED.gross_pnl, entry_fee=EXCLUDED.entry_fee, exit_fee=EXCLUDED.exit_fee, fees=EXCLUDED.fees, slippage_cost=EXCLUDED.slippage_cost,
         funding=EXCLUDED.funding, net_pnl=EXCLUDED.net_pnl, net_pnl_inr=EXCLUDED.net_pnl_inr, hold_ms=EXCLUDED.hold_ms, mfe=EXCLUDED.mfe, mae=EXCLUDED.mae,
         reached_target=EXCLUDED.reached_target, regime=EXCLUDED.regime, reasons=EXCLUDED.reasons, meta=EXCLUDED.meta,
         exit_fee_saved=EXCLUDED.exit_fee_saved, updated_at=now()`,
      [
        t.id, t.mode, t.status, t.side, t.contracts, t.qtyEth, t.leverage, t.entryTs, t.exitTs ?? null, t.entryPrice ?? null, t.exitPrice ?? null,
        t.exitReason ?? null, t.stopPrice ?? null, t.targetPrice ?? null, t.grossPnl ?? null, t.entryFee ?? null, t.exitFee ?? null, t.fees ?? null,
        t.slippageCost ?? null, t.funding ?? null, t.netPnl ?? null, t.netPnlInr ?? null, t.holdMs ?? null, t.mfe ?? null, t.mae ?? null,
        t.reachedTarget ?? null, t.regime ?? null, JSON.stringify(t.reasons ?? []), JSON.stringify(t.meta ?? {}), t.exitFeeSaved ?? null,
      ],
    );
  }

  async saveClosedTrade(c: ClosedTrade, meta: Record<string, unknown> = {}, q: Queryable = this.db): Promise<void> {
    await this.upsertTrade(
      {
        id: c.id, mode: c.mode, status: 'closed', side: c.side, contracts: c.contracts, qtyEth: c.qtyEth, leverage: c.leverage, entryTs: c.entryTs,
        exitTs: c.exitTs, entryPrice: c.entryPrice, exitPrice: c.exitPrice, exitReason: c.exitReason, stopPrice: c.stopPrice, targetPrice: c.targetPrice,
        grossPnl: c.grossPnl, entryFee: c.entryFee, exitFee: c.exitFee, exitFeeSaved: c.exitFeeSaved ?? 0, fees: c.fees, slippageCost: c.slippageCost, funding: c.funding, netPnl: c.netPnl,
        netPnlInr: c.netPnlInr, holdMs: c.holdMs, mfe: c.mfe, mae: c.mae, reachedTarget: c.reachedTarget, regime: c.regime, reasons: c.reasons, meta,
      },
      q,
    );
  }

  async saveOpenPositionRow(p: OpenPosition, status: 'open' | 'pending_entry' = 'open', meta: Record<string, unknown> = {}, q: Queryable = this.db): Promise<void> {
    await this.upsertTrade(
      {
        id: p.id, mode: p.mode, status, side: p.side, contracts: p.contracts, qtyEth: p.qtyEth, leverage: p.leverage, entryTs: p.entryTs,
        entryPrice: p.entryPrice, stopPrice: p.initialStopPrice, targetPrice: p.targetPrice, entryFee: p.entryFee.total, regime: p.regime, reasons: p.reasons, meta,
      },
      q,
    );
  }

  async getTrade(id: string): Promise<TradeRow | null> {
    const rows = await this.db.query('SELECT * FROM trades WHERE id = $1', [id]);
    return rows[0] ? rowToTrade(rows[0]) : null;
  }

  async listTrades(mode: TradingMode, opts: { limit?: number; offset?: number; since?: number; status?: string } = {}): Promise<TradeRow[]> {
    const rows = await this.db.query(
      `SELECT * FROM trades WHERE mode = $1 AND entry_ts >= $2 AND ($3::text IS NULL OR status = $3)
       ORDER BY entry_ts DESC LIMIT $4 OFFSET $5`,
      [mode, opts.since ?? 0, opts.status ?? null, Math.min(opts.limit ?? 100, 1000), opts.offset ?? 0],
    );
    return rows.map(rowToTrade);
  }

  async closedTrades(mode: TradingMode, since = 0): Promise<ClosedTrade[]> {
    const rows = await this.db.query(`SELECT * FROM trades WHERE mode = $1 AND status = 'closed' AND entry_ts >= $2 ORDER BY exit_ts ASC`, [mode, since]);
    return rows.map((r) => tradeRowToClosed(rowToTrade(r)));
  }

  /** Entries (incl. open / pending_entry, excl. failed) since a timestamp: drives the rolling-24h trade cap. */
  async entryTimestamps(mode: TradingMode, since: number): Promise<number[]> {
    const rows = await this.db.query(`SELECT entry_ts FROM trades WHERE mode = $1 AND status IN ('open','pending_entry','closed') AND entry_ts >= $2`, [mode, since]);
    return rows.map((r) => Number(r.entry_ts));
  }

  async openLiveTrades(): Promise<TradeRow[]> {
    const rows = await this.db.query(`SELECT * FROM trades WHERE mode = 'live' AND status IN ('open','pending_entry') ORDER BY entry_ts ASC`);
    return rows.map(rowToTrade);
  }

  async countTrades(mode: TradingMode, since = 0): Promise<number> {
    const rows = await this.db.query<{ c: number }>(`SELECT count(*)::int AS c FROM trades WHERE mode = $1 AND status = 'closed' AND entry_ts >= $2`, [mode, since]);
    return Number(rows[0]?.c ?? 0);
  }

  // ---------- live orders / fills ----------
  async saveLiveOrder(o: LiveOrderRow, raw?: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO live_orders (client_order_id, exchange_order_id, trade_id, purpose, side, size, price, state, filled_size, avg_fill_price, commission, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
       ON CONFLICT (client_order_id) DO UPDATE SET exchange_order_id = COALESCE(EXCLUDED.exchange_order_id, live_orders.exchange_order_id),
         state = EXCLUDED.state, filled_size = EXCLUDED.filled_size, avg_fill_price = EXCLUDED.avg_fill_price, commission = EXCLUDED.commission,
         raw = COALESCE(EXCLUDED.raw, live_orders.raw), updated_at = now()`,
      [o.clientOrderId, o.exchangeOrderId, o.tradeId, o.purpose, o.side, o.size, o.price, o.state, o.filledSize, o.avgFillPrice, o.commission, raw ? JSON.stringify(raw) : null],
    );
  }

  async liveOrdersForTrade(tradeId: string): Promise<LiveOrderRow[]> {
    const rows = await this.db.query('SELECT * FROM live_orders WHERE trade_id = $1 ORDER BY id ASC', [tradeId]);
    return rows.map((r) => ({
      clientOrderId: r.client_order_id,
      exchangeOrderId: r.exchange_order_id,
      tradeId: r.trade_id,
      purpose: r.purpose,
      side: r.side,
      size: Number(r.size),
      price: n(r.price),
      state: r.state,
      filledSize: Number(r.filled_size),
      avgFillPrice: n(r.avg_fill_price),
      commission: n(r.commission),
    }));
  }

  async liveOrderExists(clientOrderId: string): Promise<boolean> {
    return (await this.db.query('SELECT 1 FROM live_orders WHERE client_order_id = $1', [clientOrderId])).length > 0;
  }

  async saveFill(f: { fillId: string; orderId: string; tradeId: string | null; side: string; size: number; price: number; role: string; commission: number; ts: number | null }): Promise<void> {
    await this.db.query(
      `INSERT INTO live_fills (fill_id, order_id, trade_id, side, size, price, role, commission, ts) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (fill_id) DO UPDATE SET trade_id = COALESCE(EXCLUDED.trade_id, live_fills.trade_id)`,
      [f.fillId, f.orderId, f.tradeId, f.side, f.size, f.price, f.role, f.commission, f.ts],
    );
  }

  // ---------- audit ----------
  async audit(e: AuditEntry): Promise<void> {
    await this.db.query('INSERT INTO audit_log (actor, role, action, success, ip, details) VALUES ($1,$2,$3,$4,$5,$6::jsonb)', [
      e.actor,
      e.role ?? null,
      e.action,
      e.success ?? true,
      e.ip ?? null,
      JSON.stringify(e.details ?? {}),
    ]);
  }

  async listAudit(limit = 200, action?: string): Promise<{ id: number; ts: string; actor: string; role: string | null; action: string; success: boolean; ip: string | null; details: any }[]> {
    const rows = await this.db.query(`SELECT * FROM audit_log WHERE ($2::text IS NULL OR action = $2) ORDER BY id DESC LIMIT $1`, [Math.min(limit, 1000), action ?? null]);
    return rows.map((r) => ({ id: Number(r.id), ts: new Date(r.ts).toISOString(), actor: r.actor, role: r.role, action: r.action, success: r.success, ip: r.ip, details: r.details }));
  }

  // ---------- equity ----------
  async addEquity(mode: TradingMode, ts: number, equity: number, balance: number, unrealized: number): Promise<void> {
    await this.db.query('INSERT INTO equity_snapshots (mode, ts, equity, balance, unrealized) VALUES ($1,$2,$3,$4,$5)', [mode, ts, equity, balance, unrealized]);
  }

  async equitySeries(mode: TradingMode, since: number, limit = 2000): Promise<{ ts: number; equity: number; balance: number }[]> {
    const rows = await this.db.query('SELECT ts, equity, balance FROM equity_snapshots WHERE mode = $1 AND ts >= $2 ORDER BY ts ASC LIMIT $3', [mode, since, limit]);
    return rows.map((r) => ({ ts: Number(r.ts), equity: Number(r.equity), balance: Number(r.balance) }));
  }

  // ---------- backtests ----------
  async createBacktest(id: string, kind: 'backtest' | 'walkforward', dataSource: string, params: unknown): Promise<void> {
    await this.db.query(`INSERT INTO backtest_runs (id, kind, data_source, params) VALUES ($1,$2,$3,$4::jsonb)`, [id, kind, dataSource, JSON.stringify(params)]);
  }
  async finishBacktest(id: string, status: 'done' | 'failed', summary: unknown, result: unknown, error?: string): Promise<void> {
    await this.db.query(`UPDATE backtest_runs SET status=$2, summary=$3::jsonb, result=$4::jsonb, error=$5, finished_at=now() WHERE id=$1`, [
      id,
      status,
      JSON.stringify(summary ?? null),
      JSON.stringify(result ?? null),
      error ?? null,
    ]);
  }
  async listBacktests(limit = 20) {
    const rows = await this.db.query(`SELECT id, kind, data_source, status, params, summary, error, created_at, finished_at FROM backtest_runs ORDER BY created_at DESC LIMIT $1`, [limit]);
    return rows.map((r) => ({ id: r.id, kind: r.kind, dataSource: r.data_source, status: r.status, params: r.params, summary: r.summary, error: r.error, createdAt: new Date(r.created_at).toISOString(), finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null }));
  }
  async getBacktest(id: string) {
    const rows = await this.db.query(`SELECT * FROM backtest_runs WHERE id = $1`, [id]);
    const r = rows[0];
    return r ? { id: r.id, kind: r.kind, dataSource: r.data_source, status: r.status, params: r.params, summary: r.summary, result: r.result, error: r.error, createdAt: new Date(r.created_at).toISOString(), finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null } : null;
  }
  /** Mark runs that were interrupted by a restart. */
  async failStaleBacktests(): Promise<void> {
    await this.db.query(`UPDATE backtest_runs SET status='failed', error='interrupted by restart', finished_at=now() WHERE status='running'`);
  }

  // ---------- credentials ----------
  async getCredentialRow(env: string) {
    const rows = await this.db.query('SELECT * FROM credentials WHERE env = $1', [env]);
    return rows[0] ? { env: rows[0].env as string, apiKeyEnc: rows[0].api_key_enc as string, apiSecretEnc: rows[0].api_secret_enc as string, fingerprint: rows[0].fingerprint as string, keyHint: rows[0].key_hint as string, updatedBy: rows[0].updated_by as string | null, updatedAt: new Date(rows[0].updated_at).toISOString() } : null;
  }
  async putCredentialRow(env: string, apiKeyEnc: string, apiSecretEnc: string, fingerprint: string, keyHint: string, by: string) {
    await this.db.query(
      `INSERT INTO credentials (env, api_key_enc, api_secret_enc, fingerprint, key_hint, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (env) DO UPDATE SET api_key_enc=EXCLUDED.api_key_enc, api_secret_enc=EXCLUDED.api_secret_enc, fingerprint=EXCLUDED.fingerprint, key_hint=EXCLUDED.key_hint, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [env, apiKeyEnc, apiSecretEnc, fingerprint, keyHint, by],
    );
  }
  async deleteCredentialRow(env: string) {
    await this.db.query('DELETE FROM credentials WHERE env = $1', [env]);
  }

  // ---------- worker lease ----------
  /** Try to acquire or renew the single-worker lease. Returns true if `holder` owns it afterwards. */
  async acquireLease(holder: string, ttlMs: number, now: number, info: unknown = {}): Promise<boolean> {
    const rows = await this.db.query<{ holder: string }>(
      `INSERT INTO worker_lease (id, holder, expires_at, started_at, info) VALUES (1, $1, $2, $3, $4::jsonb)
       ON CONFLICT (id) DO UPDATE SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at,
         started_at = CASE WHEN worker_lease.holder = EXCLUDED.holder THEN worker_lease.started_at ELSE EXCLUDED.started_at END,
         info = EXCLUDED.info
       WHERE worker_lease.holder = EXCLUDED.holder OR worker_lease.expires_at < $3
       RETURNING holder`,
      [holder, now + ttlMs, now, JSON.stringify(info)],
    );
    return rows[0]?.holder === holder;
  }
  async releaseLease(holder: string): Promise<void> {
    await this.db.query('DELETE FROM worker_lease WHERE id = 1 AND holder = $1', [holder]);
  }
  async getLease() {
    const rows = await this.db.query('SELECT * FROM worker_lease WHERE id = 1');
    return rows[0] ? { holder: rows[0].holder as string, expiresAt: Number(rows[0].expires_at), startedAt: Number(rows[0].started_at), info: rows[0].info } : null;
  }
}
