import {
  breakevenStopPrice,
  calcFee,
  estimateLiquidationPrice,
  evaluateEntryRisk,
  effectiveConsecutiveLosses,
  feeConfigFrom,
  grossPnl,
  paperContext,
  quantityToContracts,
  roundToTick,
  type ClosedTrade,
  type ContractSpec,
  type ExitReason,
  type OpenPosition,
  type Quote,
  type RiskDecision,
  type RiskState,
  type Settings,
  type Signal,
} from '@cryptoalgo/core';
import {
  DeltaApiError,
  DeltaNetworkError,
  clientOrderId,
  entryOrder,
  explainDeltaError,
  reduceOnlyLimit,
  reduceOnlyMarket,
  reduceOnlyStopMarket,
  type DeltaClient,
  type ExchangeFill,
  type ExchangeOrder,
  type ExchangePosition,
  type Logger,
  type PlaceOrderRequest,
  type WalletBalance,
} from '@cryptoalgo/delta';
import type { BotState, Repos, TradeRow } from '../repos';

/**
 * LIVE executor: the ONLY component that sends orders to the exchange.
 *
 * Safety design
 *  - Single choke point `submit()`. A request that is not reduce-only (i.e. can open or grow
 *    exposure) is refused unless a FRESH read of the persisted bot state says: mode=live,
 *    liveArmed=true, killSwitch=false, running=true. Reduce-only exits are always allowed because
 *    they can only lower risk.
 *  - Fail closed: entries require a reconciled exchange state, a verified contract spec, fresh data
 *    and healthy connectivity.
 *  - Write-ahead: the trade row and the order reference are persisted BEFORE the order is sent, with a
 *    deterministic client_order_id per signal candle, so a crash/restart/retry can never double-submit.
 *  - Ambiguous network failures (timeout / dropped connection) are never retried blindly; the order
 *    is looked up by client_order_id.
 *  - Exchange-side protective stop is placed immediately after the entry fill; if that fails the
 *    position is flattened at once.
 *  - After any restart, `reconcile()` compares the database with the exchange before entries resume.
 */

export interface LiveDeps {
  client: DeltaClient;
  repos: Repos;
  getSettings: () => Settings;
  getSpec: () => ContractSpec;
  getBotState: () => Promise<BotState>;
  getQuote: () => Quote | null;
  /** Freshness of market data in ms since last quote (null = none). */
  quoteAgeMs: () => number | null;
  feedHealthy: () => boolean;
  hasCredentials: () => boolean;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger: Logger;
  onAttention?: (message: string) => void;
}

export interface LiveAccountView {
  fetchedAt: number | null;
  error: string | null;
  balances: WalletBalance[];
  equityUsd: number | null;
  availableUsd: number | null;
  position: ExchangePosition | null;
  openOrders: ExchangeOrder[];
}

export interface LivePosition extends OpenPosition {
  productId: number;
  stopClientId: string;
  targetClientId: string | null;
  stopOrderId: number | null;
  targetOrderId: number | null;
  entryOrderId: number | null;
  stopGeneration: number;
  closing: boolean;
  lastRealizedFunding: number;
}

export class EntryRefusedError extends Error {}
class AmbiguousOrderError extends Error {}

const SOFT_STOP_BUFFER_USD = 0.5;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class LiveExecutor {
  position: LivePosition | null = null;
  reconciled = false;
  reconcileReason: string | null = 'not yet reconciled';
  lastReconcileAt: number | null = null;
  account: LiveAccountView = { fetchedAt: null, error: null, balances: [], equityUsd: null, availableUsd: null, position: null, openOrders: [] };
  lastDecision: { at: number; candleTime: number; side: string; allowed: boolean; reasons: string[]; checks: RiskDecision['checks'] } | null = null;
  lastMonitorAt = 0;
  peakEquityUsd: number | null = null;
  baselineEquityUsd: number | null = null;

  private pending = false;
  private chain: Promise<unknown> = Promise.resolve();
  private consecutiveLosses = 0;
  private lastLossTs: number | null = null;
  private sleep: (ms: number) => Promise<void>;
  /** Count of orders submitted by this process (tests assert it stays 0 while disarmed). */
  ordersSubmitted = 0;

  constructor(private readonly d: LiveDeps) {
    this.sleep = d.sleep ?? defaultSleep;
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }

  private productId(): number {
    const id = this.d.getSpec().productId;
    if (!id) throw new Error('Exchange product id unknown (contract spec not fetched from the exchange)');
    return id;
  }

  private toUsd(amount: number, asset: string): number {
    return asset.toUpperCase() === 'INR' ? amount / this.d.getSettings().execution.usdInrRate : amount;
  }

  // ======================================================================================
  // The single order choke point
  // ======================================================================================

  /** Assert the persisted state allows OPENING exposure. Throws EntryRefusedError otherwise. */
  async assertEntryAllowed(): Promise<BotState> {
    const bot = await this.d.getBotState();
    const why: string[] = [];
    if (bot.mode !== 'live') why.push('mode is not live');
    if (!bot.liveArmed) why.push('live execution is not armed');
    if (bot.killSwitch) why.push('kill switch engaged');
    if (!bot.running) why.push('bot is not running');
    if (why.length) throw new EntryRefusedError(`Entry order refused: ${why.join(', ')}`);
    return bot;
  }

  private async submit(req: PlaceOrderRequest, purpose: 'entry' | 'stop' | 'target' | 'exit' | 'breakeven_stop', tradeId: string): Promise<ExchangeOrder> {
    if (!req.client_order_id) throw new Error('client_order_id is required');
    if (req.reduce_only !== true) await this.assertEntryAllowed();
    if (!this.d.hasCredentials()) throw new EntryRefusedError('No exchange credentials configured');

    const cid = req.client_order_id;
    // write-ahead record
    await this.d.repos.saveLiveOrder({ clientOrderId: cid, exchangeOrderId: null, tradeId, purpose, side: req.side, size: req.size, price: req.limit_price ? Number(req.limit_price) : req.stop_price ? Number(req.stop_price) : null, state: 'submitted', filledSize: 0, avgFillPrice: null, commission: null }, req);
    this.ordersSubmitted++;
    const priority = req.reduce_only ? 'critical' : 'normal';
    let order: ExchangeOrder;
    try {
      order = await this.d.client.placeOrder(req, priority);
    } catch (e) {
      if (e instanceof DeltaNetworkError && e.ambiguous) {
        const found = await this.resolveAmbiguous(cid);
        if (!found) {
          this.reconciled = false;
          this.reconcileReason = `order ${cid} outcome unknown after network failure`;
          await this.d.repos.saveLiveOrder({ clientOrderId: cid, exchangeOrderId: null, tradeId, purpose, side: req.side, size: req.size, price: null, state: 'unknown', filledSize: 0, avgFillPrice: null, commission: null });
          throw new AmbiguousOrderError(`Order ${cid} outcome unknown`);
        }
        order = found;
      } else {
        await this.d.repos.saveLiveOrder({ clientOrderId: cid, exchangeOrderId: null, tradeId, purpose, side: req.side, size: req.size, price: null, state: 'rejected', filledSize: 0, avgFillPrice: null, commission: null }, { error: explainDeltaError(e) });
        throw e;
      }
    }
    await this.recordOrder(order, tradeId, purpose, cid);
    return order;
  }

  private async recordOrder(o: ExchangeOrder, tradeId: string, purpose: 'entry' | 'stop' | 'target' | 'exit' | 'breakeven_stop', cid: string) {
    await this.d.repos.saveLiveOrder(
      { clientOrderId: cid, exchangeOrderId: String(o.id), tradeId, purpose, side: o.side, size: o.size, price: o.limitPrice ?? o.stopPrice, state: o.state, filledSize: o.filledSize, avgFillPrice: o.avgFillPrice, commission: o.paidCommission },
    );
  }

  /** After a dropped connection: look the order up by client id, a few times, before declaring it unknown. */
  private async resolveAmbiguous(cid: string): Promise<ExchangeOrder | null> {
    for (let i = 0; i < 4; i++) {
      try {
        const o = await this.d.client.getOrderByClientId(cid, 'critical');
        if (o) return o;
      } catch {
        /* keep trying */
      }
      await this.sleep(300 * (i + 1));
    }
    return null;
  }

  // ======================================================================================
  // Account + reconciliation
  // ======================================================================================

  async refreshAccount(): Promise<LiveAccountView> {
    const spec = this.d.getSpec();
    try {
      if (!this.d.hasCredentials()) throw new Error('No API credentials configured');
      const pid = this.productId();
      const [balances, position, openOrders] = await Promise.all([this.d.client.getBalances(), this.d.client.getPosition(pid), this.d.client.getOpenOrders([pid])]);
      const w = balances.find((b) => b.assetSymbol.toUpperCase() === spec.settlingAsset.toUpperCase()) ?? balances.find((b) => ['USD', 'USDT', 'USDC', 'INR'].includes(b.assetSymbol.toUpperCase())) ?? balances[0];
      const unreal = position.unrealizedPnl ?? 0;
      const equityUsd = w ? this.toUsd(w.balance, w.assetSymbol) + unreal : null;
      const availableUsd = w ? this.toUsd(w.availableBalance, w.assetSymbol) : null;
      this.account = { fetchedAt: this.d.now(), error: null, balances, equityUsd, availableUsd, position, openOrders };
      if (equityUsd !== null) {
        this.baselineEquityUsd ??= equityUsd;
        this.peakEquityUsd = Math.max(this.peakEquityUsd ?? equityUsd, equityUsd);
        await this.persistBaseline();
      }
    } catch (e) {
      this.account = { ...this.account, error: explainDeltaError(e) };
    }
    return this.account;
  }

  private lastBaselinePersist: { baseline: number | null; peak: number | null } = { baseline: null, peak: null };

  /** The drawdown reference must survive restarts, otherwise a restart would silently clear a drawdown halt. */
  private async persistBaseline(force = false): Promise<void> {
    const cur = { baseline: this.baselineEquityUsd, peak: this.peakEquityUsd };
    const prev = this.lastBaselinePersist;
    if (!force && prev.baseline === cur.baseline && prev.peak !== null && cur.peak !== null && Math.abs(prev.peak - cur.peak) < 0.01) return;
    this.lastBaselinePersist = cur;
    await this.d.repos.setDoc('live_baseline', { ...cur, updatedAt: this.d.now() });
  }

  async loadHistory(): Promise<void> {
    const now = this.d.now();
    const saved = await this.d.repos.getDoc<{ baseline: number | null; peak: number | null }>('live_baseline');
    if (saved) {
      this.baselineEquityUsd = saved.baseline;
      this.peakEquityUsd = saved.peak;
      this.lastBaselinePersist = { baseline: saved.baseline, peak: saved.peak };
    }
    const closed = await this.d.repos.closedTrades('live', 0);
    this.consecutiveLosses = 0;
    this.lastLossTs = null;
    for (let i = closed.length - 1; i >= 0; i--) {
      if (closed[i].netPnl < 0) {
        this.consecutiveLosses++;
        this.lastLossTs ??= closed[i].exitTs;
      } else break;
    }
    void now;
  }

  /** Reset the live drawdown baseline (operator action, audited by the caller). */
  async resetBaseline(): Promise<void> {
    this.baselineEquityUsd = this.account.equityUsd;
    this.peakEquityUsd = this.account.equityUsd;
    await this.persistBaseline(true);
  }

  /**
   * Compare database and exchange. Sets `reconciled`; new entries are impossible while it is false.
   * Never opens positions. May finalise a trade that the exchange closed (stop/target/liquidation).
   */
  reconcile(): Promise<void> {
    return this.run(() => this.reconcileInner());
  }

  private fail(reason: string) {
    this.reconciled = false;
    this.reconcileReason = reason;
    this.lastReconcileAt = this.d.now();
  }

  private async reconcileInner(): Promise<void> {
    if (!this.d.hasCredentials()) return this.fail('no API credentials configured');
    const acct = await this.refreshAccount();
    if (acct.error || !acct.position) return this.fail(`cannot read exchange state: ${acct.error ?? 'unknown'}`);
    const pid = this.productId();
    const pos = acct.position;
    const dbOpen = await this.d.repos.openLiveTrades();

    // 1) trades that crashed between "intent recorded" and "fill confirmed"
    for (const t of dbOpen.filter((x) => x.status === 'pending_entry')) {
      const resolved = await this.resolvePendingEntry(t, pos);
      if (!resolved) return;
    }
    const open = (await this.d.repos.openLiveTrades()).filter((x) => x.status === 'open');

    if (open.length > 1) return this.fail(`database has ${open.length} open live trades; expected at most 1`);

    const dbTrade = open[0] ?? null;
    const stray = acct.openOrders.filter((o) => !o.reduceOnly);
    if (!dbTrade) {
      this.position = null;
      if (pos.size !== 0) return this.fail(`exchange shows an untracked ${pos.size > 0 ? 'long' : 'short'} position of ${Math.abs(pos.size)} contracts`);
      if (stray.length) return this.fail(`${stray.length} unrelated open order(s) exist on ${pos.symbol || 'the contract'}`);
      this.reconciled = true;
      this.reconcileReason = null;
      this.lastReconcileAt = this.d.now();
      return;
    }

    if (pos.size === 0) {
      // closed by exchange-side stop/target/liquidation or manually while we were away
      await this.finalizeFromExchange(dbTrade, pos);
      this.position = null;
      return this.reconcileInner();
    }

    const dir = pos.size > 0 ? 'long' : 'short';
    if (dir !== dbTrade.side) return this.fail(`exchange position side (${dir}) contradicts the recorded trade (${dbTrade.side})`);

    // adopt / refresh in-memory position
    const live = await this.rebuildPosition(dbTrade, pos, acct.openOrders);
    this.position = live;
    if (Math.abs(pos.size) !== live.contracts) {
      this.d.logger.warn('live position size differs from record; adopting exchange size', { recorded: live.contracts, exchange: Math.abs(pos.size) });
      live.contracts = Math.abs(pos.size);
      live.qtyEth = live.contracts * live.contractValue;
    }
    await this.ensureProtection(live, acct.openOrders);
    if (live.fundingAccrued !== 0) await this.persistOpen(live);
    this.reconciled = true;
    this.reconcileReason = null;
    this.lastReconcileAt = this.d.now();
  }

  private async rebuildPosition(t: TradeRow, pos: ExchangePosition, orders: ExchangeOrder[]): Promise<LivePosition> {
    const spec = this.d.getSpec();
    const dir = t.side === 'long' ? 1 : -1;
    const stopOrder = orders.find((o) => o.reduceOnly && o.stopOrderType === 'stop_loss_order');
    const targetOrder = orders.find((o) => o.reduceOnly && !o.stopOrderType && o.orderType === 'limit_order');
    const meta = t.meta ?? {};
    const entryPrice = pos.entryPrice ?? t.entryPrice ?? 0;
    const fees = feeConfigFrom(this.d.getSettings(), spec);
    const entryFee = calcFee({ price: entryPrice, contracts: Math.abs(pos.size), contractValue: spec.contractValue, role: 'taker' }, fees);
    const existing = this.position?.id === t.id ? this.position : null;
    return {
      id: t.id,
      mode: 'live',
      side: t.side,
      contracts: Math.abs(pos.size),
      contractValue: spec.contractValue,
      qtyEth: Math.abs(pos.size) * spec.contractValue,
      leverage: t.leverage,
      entryTs: t.entryTs,
      entryPrice,
      entryRefPrice: Number(meta.entryRefPrice ?? entryPrice),
      stopPrice: stopOrder?.stopPrice ?? t.stopPrice ?? entryPrice - dir * 3,
      initialStopPrice: t.stopPrice ?? entryPrice - dir * 3,
      targetPrice: t.targetPrice ?? entryPrice + dir * 5,
      targetMoveUsd: Number(meta.targetMoveUsd ?? Math.abs((t.targetPrice ?? entryPrice) - entryPrice)),
      stopMoveUsd: Number(meta.stopMoveUsd ?? Math.abs(entryPrice - (t.stopPrice ?? entryPrice))),
      entryFee: { ...entryFee, total: Number(meta.entryFeeActual ?? t.entryFee ?? entryFee.total) },
      entrySlippageCost: Number(meta.entrySlippageCost ?? 0),
      marginUsed: pos.margin,
      liquidationPrice: pos.liquidationPrice ?? estimateLiquidationPrice(t.side, entryPrice, t.leverage, spec.maintenanceMarginPct),
      fundingAccrued: pos.realizedFunding - Number(meta.fundingBase ?? existing?.lastRealizedFunding ?? pos.realizedFunding),
      mfe: existing?.mfe ?? Number(meta.mfe ?? 0),
      mae: existing?.mae ?? Number(meta.mae ?? 0),
      reachedTargetAtMs: existing?.reachedTargetAtMs ?? (meta.reachedTargetAtMs ? Number(meta.reachedTargetAtMs) : null),
      breakevenArmed: existing?.breakevenArmed ?? Boolean(meta.breakevenArmed),
      nextFundingTs: null,
      regime: (t.regime ?? 'range') as OpenPosition['regime'],
      reasons: t.reasons ?? [],
      signalCandleTime: Number(meta.signalCandleTime ?? 0),
      productId: pos.productId || this.productId(),
      stopClientId: stopOrder?.clientOrderId ?? existing?.stopClientId ?? this.cid(t.id, 's', 1),
      targetClientId: targetOrder?.clientOrderId ?? existing?.targetClientId ?? null,
      stopOrderId: stopOrder?.id ?? null,
      targetOrderId: targetOrder?.id ?? null,
      entryOrderId: existing?.entryOrderId ?? (meta.entryOrderId ? Number(meta.entryOrderId) : null),
      stopGeneration: existing?.stopGeneration ?? Number(meta.stopGeneration ?? 1),
      closing: existing?.closing ?? false,
      lastRealizedFunding: Number(meta.fundingBase ?? existing?.lastRealizedFunding ?? pos.realizedFunding),
    };
  }

  private cid(tradeId: string, leg: 'e' | 's' | 't' | 'x' | 'm', n = 1): string {
    return clientOrderId('ca', tradeId, leg).slice(0, 29) + (n > 1 ? `-${n}` : '');
  }

  /** Ensure an exchange-side stop (and target) exist and match the position size; flatten if impossible. */
  private async ensureProtection(p: LivePosition, orders: ExchangeOrder[]) {
    const settings = this.d.getSettings();
    const spec = this.d.getSpec();
    const stop = orders.find((o) => o.reduceOnly && o.stopOrderType === 'stop_loss_order');
    if (!stop || stop.size !== p.contracts) {
      try {
        if (stop) await this.d.client.cancelOrder(p.productId, stop.id).catch(() => {});
        const req = reduceOnlyStopMarket({ productId: p.productId, positionSide: p.side, contracts: p.contracts, stopPrice: p.stopPrice, tickSize: spec.tickSize, clientOrderId: this.cid(p.id, 's', ++p.stopGeneration) });
        const o = await this.submit(req, 'stop', p.id);
        p.stopOrderId = o.id;
        p.stopClientId = req.client_order_id!;
      } catch (e) {
        this.d.logger.error('could not place protective stop; flattening', { error: explainDeltaError(e) });
        this.d.onAttention?.('Protective stop could not be placed — position flattened');
        await this.closeInner(p, 'reconcile');
        return;
      }
    }
    if (settings.exits.takeProfitOrderType === 'limit') {
      const tp = orders.find((o) => o.reduceOnly && !o.stopOrderType && o.orderType === 'limit_order');
      if (!tp || tp.size !== p.contracts) {
        try {
          if (tp) await this.d.client.cancelOrder(p.productId, tp.id).catch(() => {});
          const req = reduceOnlyLimit({ productId: p.productId, positionSide: p.side, contracts: p.contracts, price: p.targetPrice, tickSize: spec.tickSize, clientOrderId: this.cid(p.id, 't', Date.now() % 1000) });
          const o = await this.submit(req, 'target', p.id);
          p.targetOrderId = o.id;
          p.targetClientId = req.client_order_id!;
        } catch (e) {
          // not fatal: the stop protects the position and the software target monitor takes over
          this.d.logger.warn('could not place take-profit order', { error: explainDeltaError(e) });
        }
      }
    }
  }

  private async resolvePendingEntry(t: TradeRow, pos: ExchangePosition): Promise<boolean> {
    const orders = await this.d.repos.liveOrdersForTrade(t.id);
    const entry = orders.find((o) => o.purpose === 'entry');
    let ex: ExchangeOrder | null = null;
    if (entry) {
      try {
        ex = await this.d.client.getOrderByClientId(entry.clientOrderId, 'critical');
      } catch (e) {
        this.fail(`cannot resolve entry ${entry.clientOrderId}: ${explainDeltaError(e)}`);
        return false;
      }
    }
    if (!ex || ex.filledSize === 0) {
      await this.d.repos.upsertTrade({ ...t, status: 'failed', exitReason: 'no_fill', meta: { ...(t.meta ?? {}), resolvedAt: this.d.now() } });
      this.d.logger.info('pending live entry resolved as not filled', { id: t.id });
      return true;
    }
    if (pos.size === 0) {
      // filled and already closed (stop/target) while we were down; finalised as external close below
      await this.d.repos.upsertTrade({ ...t, status: 'open', entryPrice: ex.avgFillPrice ?? t.entryPrice, contracts: ex.filledSize, qtyEth: ex.filledSize * this.d.getSpec().contractValue });
      return true;
    }
    await this.d.repos.upsertTrade({ ...t, status: 'open', entryPrice: ex.avgFillPrice ?? pos.entryPrice ?? t.entryPrice, contracts: Math.abs(pos.size), qtyEth: Math.abs(pos.size) * this.d.getSpec().contractValue, meta: { ...(t.meta ?? {}), entryOrderId: ex.id, adopted: true } });
    this.d.logger.warn('adopted live entry that completed during an interruption', { id: t.id });
    return true;
  }

  /** The exchange closed the position (stop / target / liquidation / manual). Build the final trade record. */
  private async finalizeFromExchange(t: TradeRow, _pos: ExchangePosition): Promise<ClosedTrade> {
    const spec = this.d.getSpec();
    const settings = this.d.getSettings();
    const pid = this.productId();
    const orders = await this.d.repos.liveOrdersForTrade(t.id);
    const entryOrder = orders.find((o) => o.purpose === 'entry');
    let fills: ExchangeFill[] = [];
    try {
      const res = await this.d.client.getFills({ productIds: [pid], startTimeUs: Math.max(0, t.entryTs - 60_000) * 1000, pageSize: 100 });
      fills = res.fills;
    } catch (e) {
      this.d.logger.warn('could not fetch fills for finalisation', { error: explainDeltaError(e) });
    }
    const entryIds = new Set<string>(entryOrder?.exchangeOrderId ? [entryOrder.exchangeOrderId] : []);
    const dir = t.side === 'long' ? 1 : -1;
    const entrySide = t.side === 'long' ? 'buy' : 'sell';
    const entryFills = fills.filter((f) => entryIds.has(f.orderId) || (entryIds.size === 0 && f.side === entrySide && (f.createdAt ?? 0) >= t.entryTs - 60_000));
    const exitFills = fills.filter((f) => f.side !== entrySide && (f.createdAt ?? Infinity) >= t.entryTs - 1_000);

    const vwap = (fs: ExchangeFill[]) => (fs.length ? fs.reduce((s, f) => s + f.price * f.size, 0) / fs.reduce((s, f) => s + f.size, 0) : null);
    const entryPrice = vwap(entryFills) ?? t.entryPrice ?? 0;
    const exitPrice = vwap(exitFills) ?? t.entryPrice ?? entryPrice;
    const contracts = t.contracts;
    const usd = (v: number) => v; // settling asset assumed USD-valued; INR handled in toUsd for balances
    const entryFee = entryFills.length ? usd(entryFills.reduce((s, f) => s + f.commission, 0)) : t.entryFee ?? 0;
    const exitFee = exitFills.length ? usd(exitFills.reduce((s, f) => s + f.commission, 0)) : calcFee({ price: exitPrice, contracts, contractValue: spec.contractValue, role: 'taker', isExit: true }, feeConfigFrom(settings, spec)).total;
    const gross = grossPnl(t.side, entryPrice, exitPrice, contracts, spec.contractValue);
    const meta = t.meta ?? {};
    const funding = Number(meta.fundingEstimate ?? 0);
    const net = gross - entryFee - exitFee + funding;

    const exitIds = new Set(exitFills.map((f) => f.orderId));
    const exitOrders = orders.filter((o) => o.exchangeOrderId && exitIds.has(o.exchangeOrderId));
    let reason: ExitReason = 'reconcile';
    if (exitFills.some((f) => f.fillType === 'liquidation')) reason = 'liquidation';
    else if (exitOrders.some((o) => o.purpose === 'stop' || o.purpose === 'breakeven_stop')) reason = meta.breakevenArmed ? 'breakeven_stop' : 'stop_loss';
    else if (exitOrders.some((o) => o.purpose === 'target')) reason = 'take_profit';
    else if (exitOrders.some((o) => o.purpose === 'exit')) reason = (meta.closeReason as ExitReason) ?? 'manual';
    else if (exitFills.length === 0) reason = 'reconcile';

    const exitTs = exitFills.length ? Math.max(...exitFills.map((f) => f.createdAt ?? this.d.now())) : this.d.now();
    const trade: ClosedTrade = {
      id: t.id, mode: 'live', side: t.side, contracts, qtyEth: contracts * spec.contractValue, leverage: t.leverage, entryTs: t.entryTs, exitTs,
      entryPrice, exitPrice, exitReason: reason, stopPrice: t.stopPrice ?? 0, targetPrice: t.targetPrice ?? 0, grossPnl: gross, entryFee, exitFee,
      fees: entryFee + exitFee, slippageCost: Number(meta.entrySlippageCost ?? 0), funding, netPnl: net, netPnlInr: net * settings.execution.usdInrRate,
      holdMs: Math.max(0, exitTs - t.entryTs), mfe: Number(meta.mfe ?? 0), mae: Number(meta.mae ?? 0), reachedTarget: Boolean(meta.reachedTargetAtMs) || (dir === 1 ? exitPrice >= (t.targetPrice ?? Infinity) : exitPrice <= (t.targetPrice ?? -Infinity)),
      regime: (t.regime ?? 'range') as ClosedTrade['regime'], reasons: t.reasons ?? [],
    };
    for (const f of fills) {
      if (entryFills.includes(f) || exitFills.includes(f)) await this.d.repos.saveFill({ fillId: f.id, orderId: f.orderId, tradeId: t.id, side: f.side, size: f.size, price: f.price, role: f.role, commission: f.commission, ts: f.createdAt });
    }
    await this.d.repos.saveClosedTrade(trade, { ...meta, finalizedBy: 'exchange_sync', commissionSource: fills.length ? 'exchange_fills' : 'estimate' });
    this.noteClosed(trade);
    this.d.logger.info('live trade finalised from exchange state', { id: t.id, reason, net });
    if (this.position?.id === t.id) this.position = null;
    return trade;
  }

  private noteClosed(trade: ClosedTrade) {
    if (trade.netPnl < 0) {
      this.consecutiveLosses++;
      this.lastLossTs = trade.exitTs;
    } else this.consecutiveLosses = 0;
  }

  // ======================================================================================
  // Entry
  // ======================================================================================

  riskState(): RiskState {
    const now = this.d.now();
    const s = this.d.getSettings();
    const age = this.d.quoteAgeMs();
    const eq = this.account.equityUsd ?? 0;
    return {
      now,
      mode: 'live',
      killSwitch: false, // overwritten by caller from fresh bot state
      liveArmed: false,
      equityUsd: eq,
      startingEquityUsd: this.baselineEquityUsd ?? eq,
      peakEquityUsd: this.peakEquityUsd ?? eq,
      availableMarginUsd: this.account.availableUsd ?? 0,
      openPositions: (this.position ? 1 : 0) + (this.account.position && this.account.position.size !== 0 && !this.position ? 1 : 0),
      entries: [],
      realised: [],
      consecutiveLosses: effectiveConsecutiveLosses(this.consecutiveLosses, this.lastLossTs, now, s),
      lastLossTs: this.lastLossTs,
      lastTickTs: age === null ? null : now - age,
      apiHealthy: this.d.feedHealthy() && !this.account.error,
      reconciled: this.reconciled && this.lastReconcileAt !== null && now - this.lastReconcileAt < Math.max(30_000, s.live.reconcileIntervalSeconds * 3_000),
      lastEntrySignalCandle: null,
      pendingOrder: this.pending,
    };
  }

  /** Attempt a live entry. Every refusal is returned (and kept in `lastDecision`), never thrown to the loop. */
  tryEnter(signal: Signal, quote: Quote): Promise<{ allowed: boolean; reasons: string[] }> {
    return this.run(async () => {
      const settings = this.d.getSettings();
      const spec = this.d.getSpec();
      const now = this.d.now();
      const record = (allowed: boolean, reasons: string[], checks: RiskDecision['checks'] = []) => {
        this.lastDecision = { at: now, candleTime: signal.candleTime, side: signal.side, allowed, reasons, checks };
        return { allowed, reasons };
      };

      let bot: BotState;
      try {
        bot = await this.assertEntryAllowed();
      } catch (e) {
        return record(false, [(e as Error).message]);
      }

      // fresh exchange view right before deciding (inner variant: we already hold the serial queue)
      await this.reconcileInner();
      const [entries, closed] = await Promise.all([this.d.repos.entryTimestamps('live', now - 24 * 3_600_000), this.d.repos.closedTrades('live', now - 24 * 3_600_000)]);
      const rs = this.riskState();
      rs.killSwitch = bot.killSwitch;
      rs.liveArmed = bot.liveArmed;
      rs.entries = entries.map((ts) => ({ ts }));
      rs.realised = closed.map((t) => ({ ts: t.exitTs, netPnl: t.netPnl }));
      const id = `L-${Math.floor(signal.candleTime / 1000)}-${signal.side[0]}`;
      const entryCid = this.cid(id, 'e');
      rs.lastEntrySignalCandle = (await this.d.repos.getTrade(id)) || (await this.d.repos.liveOrderExists(entryCid)) ? signal.candleTime : null;

      const decision = evaluateEntryRisk({ settings, spec, state: rs, signal, quote });
      record(decision.allowed, decision.reasons, decision.checks);
      if (!decision.allowed || !decision.plan) return { allowed: false, reasons: decision.reasons };

      const plan = decision.plan;
      const contracts = quantityToContracts(settings.position.quantityEth, spec.contractValue)!;
      this.pending = true;
      try {
        await this.ensureLeverage(settings.position.leverage);

        const dir = signal.side === 'long' ? 1 : -1;
        const limit = plan.entryPrice + dir * settings.filters.maxSlippageUsd;
        const req = entryOrder({ productId: this.productId(), side: signal.side, contracts, limitPrice: limit, tickSize: spec.tickSize, clientOrderId: entryCid });

        // write-ahead: the intent is durable before the order leaves the process
        await this.d.repos.upsertTrade({
          id, mode: 'live', status: 'pending_entry', side: signal.side, contracts, qtyEth: contracts * spec.contractValue, leverage: settings.position.leverage, entryTs: now,
          stopPrice: plan.stopPrice, targetPrice: plan.targetPrice, regime: signal.regime, reasons: signal.reasons,
          meta: { signalCandleTime: signal.candleTime, targetMoveUsd: signal.targetMoveUsd, stopMoveUsd: signal.stopMoveUsd, entryRefPrice: plan.entryPrice },
        });

        let order: ExchangeOrder;
        try {
          order = await this.submit(req, 'entry', id);
        } catch (e) {
          if (e instanceof AmbiguousOrderError) {
            this.d.onAttention?.(`Entry ${id} outcome unknown; trading paused until reconciliation`);
            return { allowed: false, reasons: [e.message] };
          }
          await this.d.repos.upsertTrade({ id, mode: 'live', status: 'failed', side: signal.side, contracts, qtyEth: contracts * spec.contractValue, leverage: settings.position.leverage, entryTs: now, exitReason: 'rejected', meta: { error: explainDeltaError(e) } });
          return { allowed: false, reasons: [`ORDER_REJECTED: ${explainDeltaError(e)}`] };
        }

        // IOC orders are final immediately; poll defensively if the exchange says otherwise.
        for (let i = 0; i < 5 && (order.state === 'open' || order.state === 'pending'); i++) {
          await this.sleep(300);
          order = await this.d.client.getOrder(order.id, 'critical');
        }
        if (order.filledSize === 0) {
          await this.d.repos.upsertTrade({ id, mode: 'live', status: 'failed', side: signal.side, contracts, qtyEth: contracts * spec.contractValue, leverage: settings.position.leverage, entryTs: now, exitReason: 'no_fill' });
          return { allowed: false, reasons: ['NO_FILL: IOC entry did not fill within the slippage limit'] };
        }
        if (order.state === 'open' || order.state === 'pending') {
          // should be impossible for IOC; cancel remainder to stay in control
          await this.d.client.cancelOrder(order.productId, order.id).catch(() => {});
        }

        // Source of truth for what we hold now is the exchange position.
        const pos = await this.d.client.getPosition(this.productId(), 'critical');
        const held = Math.abs(pos.size);
        const entryPrice = pos.entryPrice ?? order.avgFillPrice ?? plan.entryPrice;
        const fillFee = await this.entryFees(order, entryPrice, held);
        const stopPrice = roundToTick(entryPrice - dir * signal.stopMoveUsd, spec.tickSize, dir === 1 ? 'down' : 'up');
        const targetPrice = roundToTick(entryPrice + dir * signal.targetMoveUsd, spec.tickSize, dir === 1 ? 'up' : 'down');

        const live: LivePosition = {
          id, mode: 'live', side: signal.side, contracts: held, contractValue: spec.contractValue, qtyEth: held * spec.contractValue, leverage: settings.position.leverage,
          entryTs: now, entryPrice, entryRefPrice: plan.entryPrice, stopPrice, initialStopPrice: stopPrice, targetPrice, targetMoveUsd: signal.targetMoveUsd, stopMoveUsd: signal.stopMoveUsd,
          entryFee: { ...calcFee({ price: entryPrice, contracts: held, contractValue: spec.contractValue, role: 'taker' }, feeConfigFrom(settings, spec)), total: fillFee },
          entrySlippageCost: Math.abs(entryPrice - plan.entryPrice) * held * spec.contractValue, marginUsed: pos.margin,
          liquidationPrice: pos.liquidationPrice ?? plan.liquidationPrice, fundingAccrued: 0, mfe: 0, mae: 0, reachedTargetAtMs: null, breakevenArmed: false, nextFundingTs: null,
          regime: signal.regime, reasons: signal.reasons, signalCandleTime: signal.candleTime, productId: this.productId(), stopClientId: this.cid(id, 's', 1), targetClientId: null,
          stopOrderId: null, targetOrderId: null, entryOrderId: order.id, stopGeneration: 1, closing: false, lastRealizedFunding: pos.realizedFunding,
        };
        if (held === 0) {
          await this.d.repos.upsertTrade({ id, mode: 'live', status: 'failed', side: signal.side, contracts, qtyEth: contracts * spec.contractValue, leverage: settings.position.leverage, entryTs: now, exitReason: 'no_position_after_fill' });
          return { allowed: false, reasons: ['NO_POSITION: order reported filled but the exchange shows no position'] };
        }
        this.position = live;
        await this.persistOpen(live);

        // immediate exchange-side protection
        try {
          const stopReq = reduceOnlyStopMarket({ productId: live.productId, positionSide: live.side, contracts: held, stopPrice, tickSize: spec.tickSize, clientOrderId: live.stopClientId });
          const so = await this.submit(stopReq, 'stop', id);
          live.stopOrderId = so.id;
        } catch (e) {
          this.d.logger.error('protective stop failed after fill — flattening immediately', { error: explainDeltaError(e) });
          this.d.onAttention?.('Protective stop failed after entry; position flattened');
          await this.closeInner(live, 'reconcile');
          return { allowed: false, reasons: [`STOP_FAILED: ${explainDeltaError(e)} (position flattened)`] };
        }
        if (settings.exits.takeProfitOrderType === 'limit') {
          try {
            const tcid = this.cid(id, 't', 1);
            const tp = await this.submit(reduceOnlyLimit({ productId: live.productId, positionSide: live.side, contracts: held, price: targetPrice, tickSize: spec.tickSize, clientOrderId: tcid }), 'target', id);
            live.targetOrderId = tp.id;
            live.targetClientId = tcid;
          } catch (e) {
            this.d.logger.warn('take-profit order failed; software target monitor will handle the exit', { error: explainDeltaError(e) });
          }
        }
        await this.persistOpen(live);
        this.d.logger.info('live position opened', { id, side: live.side, contracts: held, entry: entryPrice, stop: stopPrice, target: targetPrice });
        return { allowed: true, reasons: [] };
      } finally {
        this.pending = false;
      }
    });
  }

  private async entryFees(order: ExchangeOrder, entryPrice: number, contracts: number): Promise<number> {
    const spec = this.d.getSpec();
    for (let i = 0; i < 3; i++) {
      try {
        const { fills } = await this.d.client.getFills({ productIds: [this.productId()], startTimeUs: Math.max(0, this.d.now() - 120_000) * 1000, pageSize: 50 });
        const mine = fills.filter((f) => f.orderId === String(order.id));
        if (mine.length) {
          for (const f of mine) await this.d.repos.saveFill({ fillId: f.id, orderId: f.orderId, tradeId: null, side: f.side, size: f.size, price: f.price, role: f.role, commission: f.commission, ts: f.createdAt });
          return mine.reduce((s, f) => s + f.commission, 0);
        }
      } catch {
        /* retry */
      }
      await this.sleep(250);
    }
    if (order.paidCommission > 0) return order.paidCommission;
    return calcFee({ price: entryPrice, contracts, contractValue: spec.contractValue, role: 'taker' }, feeConfigFrom(this.d.getSettings(), spec)).total;
  }

  private async ensureLeverage(target: number) {
    const pid = this.productId();
    const cur = await this.d.client.getOrderLeverage(pid);
    if (cur !== target) {
      const set = await this.d.client.setOrderLeverage(pid, target);
      if (set !== target) throw new Error(`Exchange leverage is ${set}x, expected ${target}x`);
    }
  }

  private async persistOpen(p: LivePosition) {
    await this.d.repos.saveOpenPositionRow(p, 'open', {
      entryRefPrice: p.entryRefPrice, entryFeeActual: p.entryFee.total, entrySlippageCost: p.entrySlippageCost, targetMoveUsd: p.targetMoveUsd, stopMoveUsd: p.stopMoveUsd,
      signalCandleTime: p.signalCandleTime, entryOrderId: p.entryOrderId, stopOrderId: p.stopOrderId, targetOrderId: p.targetOrderId, stopGeneration: p.stopGeneration,
      breakevenArmed: p.breakevenArmed, mfe: p.mfe, mae: p.mae, reachedTargetAtMs: p.reachedTargetAtMs, fundingEstimate: p.fundingAccrued, fundingBase: p.lastRealizedFunding,
    });
  }

  // ======================================================================================
  // Monitoring and exits
  // ======================================================================================

  /** Called on quotes (throttled by the caller). Applies time exit, break-even tightening and software backstops. */
  monitor(quote: Quote): Promise<void> {
    return this.run(async () => {
      const p = this.position;
      if (!p || p.closing) return;
      const s = this.d.getSettings();
      const now = this.d.now();
      this.lastMonitorAt = now;
      const dir = p.side === 'long' ? 1 : -1;
      const fav = dir * ((dir === 1 ? quote.bid : quote.ask) - p.entryPrice);
      p.mfe = Math.max(p.mfe, fav);
      p.mae = Math.min(p.mae, fav);
      if (p.reachedTargetAtMs === null && p.mfe >= p.targetMoveUsd) p.reachedTargetAtMs = now;

      const last = quote.last;
      if (s.exits.takeProfitOrderType === 'market' && (dir === 1 ? last >= p.targetPrice : last <= p.targetPrice)) {
        await this.closeInner(p, 'take_profit');
        return;
      }
      // software backstop behind the exchange-side stop
      if (dir === 1 ? last <= p.stopPrice - SOFT_STOP_BUFFER_USD : last >= p.stopPrice + SOFT_STOP_BUFFER_USD) {
        this.d.logger.warn('price beyond stop but position still open: software stop engaged', { last, stop: p.stopPrice });
        await this.closeInner(p, 'stop_loss');
        return;
      }
      const heldMs = now - p.entryTs;
      if (heldMs >= s.exits.maxHoldMinutes * 60_000) {
        await this.closeInner(p, 'time_exit');
        return;
      }
      if (s.exits.timeExitPolicy === 'breakeven_then_close' && !p.breakevenArmed && heldMs >= s.exits.breakevenAfterMinutes * 60_000) {
        const spec = this.d.getSpec();
        const ctx = paperContext(s, spec, 0);
        const be = breakevenStopPrice(p, ctx);
        const inProfit = dir === 1 ? quote.bid > be : quote.ask < be;
        const tighter = dir === 1 ? be > p.stopPrice : be < p.stopPrice;
        if (inProfit && tighter) await this.replaceStop(p, be);
        else if (inProfit) p.breakevenArmed = true;
      }
    });
  }

  /** Place the tighter stop FIRST, then cancel the old one: the position is never unprotected. */
  private async replaceStop(p: LivePosition, newStop: number) {
    const spec = this.d.getSpec();
    const oldId = p.stopOrderId;
    try {
      const req = reduceOnlyStopMarket({ productId: p.productId, positionSide: p.side, contracts: p.contracts, stopPrice: newStop, tickSize: spec.tickSize, clientOrderId: this.cid(p.id, 's', ++p.stopGeneration) });
      const o = await this.submit(req, 'breakeven_stop', p.id);
      if (oldId) await this.d.client.cancelOrder(p.productId, oldId).catch(() => {});
      p.stopOrderId = o.id;
      p.stopClientId = req.client_order_id!;
      p.stopPrice = newStop;
      p.breakevenArmed = true;
      await this.persistOpen(p);
    } catch (e) {
      this.d.logger.warn('break-even stop replacement failed; original stop remains', { error: explainDeltaError(e) });
    }
  }

  /** Operator / system close of the real position at market (reduce-only). */
  closeNow(reason: ExitReason): Promise<ClosedTrade | null> {
    return this.run(async () => {
      const p = this.position;
      if (!p) {
        // maybe an orphan: close whatever the exchange shows (reduce-only)
        const pos = await this.d.client.getPosition(this.productId(), 'critical');
        if (pos.size === 0) return null;
        await this.flattenRaw(pos, reason);
        await this.reconcileInner();
        return null;
      }
      return this.closeInner(p, reason);
    });
  }

  private async flattenRaw(pos: ExchangePosition, reason: string) {
    const side = pos.size > 0 ? 'long' : 'short';
    const req = reduceOnlyMarket({ productId: this.productId(), positionSide: side, contracts: Math.abs(pos.size), clientOrderId: `ca-orphan-${this.d.now() % 1e9}-x`.slice(0, 32) });
    await this.submit(req, 'exit', `orphan-${reason}`);
  }

  private async closeInner(p: LivePosition, reason: ExitReason): Promise<ClosedTrade | null> {
    if (p.closing) return null;
    p.closing = true;
    try {
      // 1) drop the resting target (not safety-critical); keep the stop until we are flat
      if (p.targetOrderId) await this.d.client.cancelOrder(p.productId, p.targetOrderId).catch(() => {});

      // 2) reduce-only market close, repeated for any remainder
      for (let attempt = 1; attempt <= 3; attempt++) {
        const pos = await this.d.client.getPosition(p.productId, 'critical');
        if (pos.size === 0) break;
        const req = reduceOnlyMarket({ productId: p.productId, positionSide: p.side, contracts: Math.abs(pos.size), clientOrderId: this.cid(p.id, 'x', attempt) });
        try {
          await this.submit(req, 'exit', p.id);
        } catch (e) {
          if (e instanceof AmbiguousOrderError) continue; // re-check position next loop
          // The stop may be reserving the position size; free it and retry once.
          if (e instanceof DeltaApiError && attempt === 1 && p.stopOrderId) {
            await this.d.client.cancelOrder(p.productId, p.stopOrderId).catch(() => {});
            p.stopOrderId = null;
            continue;
          }
          throw e;
        }
      }

      const after = await this.d.client.getPosition(p.productId, 'critical');
      if (after.size !== 0) {
        p.closing = false;
        this.d.onAttention?.('Failed to fully close the live position — manual action required');
        throw new Error(`position still open after close attempts (${after.size} contracts)`);
      }
      // 3) tidy up leftovers (reduce-only orders disappear with the position, but be explicit)
      if (p.stopOrderId) await this.d.client.cancelOrder(p.productId, p.stopOrderId).catch(() => {});

      // 4) finalise from real fills
      const row = await this.d.repos.getTrade(p.id);
      let result: ClosedTrade | null = null;
      if (row) {
        const meta = { ...(row.meta ?? {}), closeReason: reason, breakevenArmed: p.breakevenArmed, mfe: p.mfe, mae: p.mae, reachedTargetAtMs: p.reachedTargetAtMs, fundingEstimate: p.fundingAccrued };
        result = await this.finalizeFromExchange({ ...row, meta }, after);
      }
      this.position = null;
      return result;
    } catch (e) {
      p.closing = false;
      this.d.logger.error('live close failed', { error: explainDeltaError(e) });
      throw e;
    }
  }

  /** Cancel resting entry (non-reduce-only) orders on the contract. Protective reduce-only orders are kept. */
  async cancelEntryOrders(): Promise<number> {
    const pid = this.productId();
    const orders = await this.d.client.getOpenOrders([pid]);
    let n = 0;
    for (const o of orders.filter((x) => !x.reduceOnly)) {
      await this.d.client.cancelOrder(pid, o.id).catch(() => {});
      n++;
    }
    return n;
  }

  snapshot() {
    const p = this.position;
    return {
      reconciled: this.reconciled,
      reconcileReason: this.reconcileReason,
      lastReconcileAt: this.lastReconcileAt,
      pending: this.pending,
      account: this.account,
      position: p,
      lastDecision: this.lastDecision,
      peakEquityUsd: this.peakEquityUsd,
      baselineEquityUsd: this.baselineEquityUsd,
      consecutiveLosses: this.consecutiveLosses,
      ordersSubmitted: this.ordersSubmitted,
    };
  }
}
