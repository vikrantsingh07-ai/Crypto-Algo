import {
  accountEquity,
  applyClose,
  applyOpen,
  closePosition,
  evaluateEntryRisk,
  effectiveConsecutiveLosses,
  markEquity,
  marketExit,
  newDemoAccount,
  openPaperPosition,
  paperContext,
  quantityToContracts,
  rollingEntries,
  stepPosition,
  tickFromQuote,
  type ClosedTrade,
  type ContractSpec,
  type DemoAccountState,
  type ExitReason,
  type OpenPosition,
  type Quote,
  type RiskDecision,
  type RiskState,
  type Settings,
  type Signal,
  type Tick,
} from '@cryptoalgo/core';
import type { Logger } from '@cryptoalgo/delta';
import type { Repos } from '../repos';

/**
 * DEMO (paper) engine. Uses real market quotes but SIMULATED orders, fills, fees and balances.
 * It never imports or touches the exchange client: demo can not place real orders by construction.
 * State is persisted after every structural change so restarts keep the virtual account and any open
 * simulated position.
 */

type Account = DemoAccountState & { epochStart: number };

export interface DemoDeps {
  repos: Repos;
  getSettings: () => Settings;
  getSpec: () => ContractSpec;
  getFundingRate: () => number | null;
  now: () => number;
  logger: Logger;
  /** Called whenever a demo trade opens or closes. */
  onEvent?: (e: { type: 'opened' | 'closed'; trade: ClosedTrade | OpenPosition }) => void;
}

export interface EntryContext {
  killSwitch: boolean;
  apiHealthy: boolean;
  lastTickTs: number | null;
}

export interface DemoDecision {
  at: number;
  candleTime: number;
  side: string;
  allowed: boolean;
  reasons: string[];
  checks: RiskDecision['checks'];
}

export class DemoEngine {
  account!: Account;
  lastTick: Tick | null = null;
  lastDecision: DemoDecision | null = null;
  private entries: number[] = [];
  private closed24h: { ts: number; netPnl: number }[] = [];
  private consecutiveLosses = 0;
  private lastLossTs: number | null = null;
  private lastEntrySignalCandle: number | null = null;
  private lastPersist = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: DemoDeps) {}

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }

  async init(): Promise<void> {
    const s = this.d.getSettings();
    const stored = await this.d.repos.getDemoAccount();
    const now = this.d.now();
    this.account = stored ?? { ...newDemoAccount(s.demo.startingBalanceUsd, now), epochStart: now };
    if (!stored) await this.d.repos.saveDemoAccount(this.account);
    await this.rebuildHistory();
  }

  /** Rebuild rolling-window state from persisted trades (after restart). */
  private async rebuildHistory(): Promise<void> {
    const now = this.d.now();
    const since = Math.max(this.account.epochStart, now - 24 * 3_600_000);
    this.entries = await this.d.repos.entryTimestamps('demo', since);
    const closed = await this.d.repos.closedTrades('demo', this.account.epochStart);
    this.closed24h = closed.filter((t) => t.exitTs > now - 24 * 3_600_000).map((t) => ({ ts: t.exitTs, netPnl: t.netPnl }));
    this.consecutiveLosses = 0;
    this.lastLossTs = null;
    for (let i = closed.length - 1; i >= 0; i--) {
      if (closed[i].netPnl < 0) {
        this.consecutiveLosses++;
        this.lastLossTs ??= closed[i].exitTs;
      } else break;
    }
    this.lastEntrySignalCandle = this.account.openPosition?.signalCandleTime ?? null;
  }

  get openPosition(): OpenPosition | null {
    return this.account.openPosition;
  }

  private ctx() {
    const s = this.d.getSettings();
    return paperContext(s, this.d.getSpec(), this.d.getFundingRate() ?? s.execution.fundingRateFallback);
  }

  equity(): { equity: number; balance: number; unrealized: number } {
    const eq = accountEquity(this.account, this.lastTick);
    const unrealized = eq - this.account.balanceUsd;
    return { equity: eq, balance: this.account.balanceUsd, unrealized };
  }

  riskState(entryCtx: EntryContext): RiskState {
    const now = this.d.now();
    const s = this.d.getSettings();
    const eq = accountEquity(this.account, this.lastTick);
    const margin = this.account.openPosition?.marginUsed ?? 0;
    return {
      now,
      mode: 'demo',
      killSwitch: entryCtx.killSwitch,
      equityUsd: eq,
      startingEquityUsd: this.account.startingBalanceUsd,
      peakEquityUsd: this.account.peakEquityUsd,
      availableMarginUsd: eq - margin,
      openPositions: this.account.openPosition ? 1 : 0,
      entries: this.entries.map((ts) => ({ ts })),
      realised: this.closed24h,
      consecutiveLosses: effectiveConsecutiveLosses(this.consecutiveLosses, this.lastLossTs, now, s),
      lastLossTs: this.lastLossTs,
      lastTickTs: entryCtx.lastTickTs,
      apiHealthy: entryCtx.apiHealthy,
      lastEntrySignalCandle: this.lastEntrySignalCandle,
      pendingOrder: false,
    };
  }

  /** Called for every market quote. Manages the open simulated position. */
  onQuote(q: Quote): Promise<void> {
    this.lastTick = tickFromQuote(q);
    if (!this.account) return Promise.resolve();
    return this.run(async () => {
      const pos = this.account.openPosition;
      const tick = this.lastTick!;
      if (!pos) {
        this.account = markEquity(this.account, this.account.balanceUsd, tick.ts);
        return;
      }
      const res = stepPosition(pos, tick, this.ctx());
      this.account = { ...this.account, openPosition: res.position };
      if (res.exit) {
        await this.finish(res.position, res.exit.reason, res.exit.price, res.exit.role, tick.ts);
        return;
      }
      this.account = markEquity(this.account, accountEquity(this.account, tick), tick.ts);
      const changed = res.position.stopPrice !== pos.stopPrice || res.position.breakevenArmed !== pos.breakevenArmed || (res.position.reachedTargetAtMs !== null && pos.reachedTargetAtMs === null);
      if (changed || tick.ts - this.lastPersist > 5_000) {
        this.lastPersist = tick.ts;
        await this.d.repos.saveDemoAccount(this.account);
      }
    });
  }

  /** Evaluate a strategy signal against the risk manager and open a simulated position if allowed. */
  tryEnter(signal: Signal, quote: Quote, entryCtx: EntryContext): Promise<DemoDecision> {
    return this.run(async () => {
      const settings = this.d.getSettings();
      const spec = this.d.getSpec();
      const decision = evaluateEntryRisk({ settings, spec, state: this.riskState(entryCtx), signal, quote });
      const record: DemoDecision = { at: this.d.now(), candleTime: signal.candleTime, side: signal.side, allowed: decision.allowed, reasons: decision.reasons, checks: decision.checks };
      this.lastDecision = record;
      if (!decision.allowed || !decision.plan) return record;

      const tick = tickFromQuote(quote);
      const id = `D-${Math.floor(signal.candleTime / 1000)}-${signal.side[0]}`;
      if (await this.d.repos.getTrade(id)) {
        record.allowed = false;
        record.reasons = ['DUPLICATE_SIGNAL: trade already exists for this signal candle'];
        return record;
      }
      const contracts = quantityToContracts(settings.position.quantityEth, spec.contractValue);
      if (contracts === null) return { ...record, allowed: false, reasons: ['QUANTITY: invalid'] };

      const pos = openPaperPosition({ id, signal, tick: { ...tick, ts: this.d.now() }, contracts }, this.ctx());
      this.account = applyOpen(this.account, pos, this.d.now());
      this.entries.push(pos.entryTs);
      this.lastEntrySignalCandle = signal.candleTime;
      await this.d.repos.db.tx(async (q) => {
        await this.d.repos.saveOpenPositionRow(pos, 'open', { simulated: true }, q);
        await this.d.repos.saveDemoAccount(this.account, q);
      });
      this.d.logger.info('demo position opened', { id, side: pos.side, entry: pos.entryPrice, stop: pos.stopPrice, target: pos.targetPrice });
      this.d.onEvent?.({ type: 'opened', trade: pos });
      return record;
    });
  }

  /** Operator / system initiated market close of the simulated position. */
  closeNow(reason: ExitReason): Promise<ClosedTrade | null> {
    return this.run(async () => {
      const pos = this.account.openPosition;
      const tick = this.lastTick;
      if (!pos || !tick) return null;
      const ex = marketExit(pos, tick, reason, this.ctx());
      return this.finish(pos, ex.reason, ex.price, ex.role, this.d.now());
    });
  }

  private async finish(pos: OpenPosition, reason: ExitReason, price: number, role: 'maker' | 'taker', ts: number): Promise<ClosedTrade> {
    const trade = closePosition(pos, { reason, price, role }, ts, this.ctx());
    this.account = applyClose(this.account, trade, ts);
    this.closed24h.push({ ts: trade.exitTs, netPnl: trade.netPnl });
    if (trade.netPnl < 0) {
      this.consecutiveLosses++;
      this.lastLossTs = trade.exitTs;
    } else {
      this.consecutiveLosses = 0;
    }
    await this.d.repos.db.tx(async (q) => {
      await this.d.repos.saveClosedTrade(trade, { simulated: true }, q);
      await this.d.repos.saveDemoAccount(this.account, q);
    });
    this.d.logger.info('demo position closed', { id: trade.id, reason, net: trade.netPnl });
    this.d.onEvent?.({ type: 'closed', trade });
    return trade;
  }

  /** Start a fresh virtual account. History before the reset is kept but excluded from the current epoch. */
  reset(startingBalanceUsd?: number): Promise<void> {
    return this.run(async () => {
      const s = this.d.getSettings();
      const now = this.d.now();
      const open = this.account.openPosition;
      if (open && this.lastTick) {
        const ex = marketExit(open, this.lastTick, 'manual', this.ctx());
        await this.finish(open, ex.reason, ex.price, ex.role, now);
      }
      this.account = { ...newDemoAccount(startingBalanceUsd ?? s.demo.startingBalanceUsd, now), epochStart: now + 1 };
      this.entries = [];
      this.closed24h = [];
      this.consecutiveLosses = 0;
      this.lastLossTs = null;
      this.lastEntrySignalCandle = null;
      await this.d.repos.saveDemoAccount(this.account);
    });
  }

  summary() {
    const eq = this.equity();
    const s = this.d.getSettings();
    return {
      startingBalanceUsd: this.account.startingBalanceUsd,
      balanceUsd: this.account.balanceUsd,
      equityUsd: eq.equity,
      unrealizedPnlUsd: eq.unrealized,
      peakEquityUsd: this.account.peakEquityUsd,
      maxDrawdownPct: this.account.maxDrawdownPct,
      totalFeesUsd: this.account.totalFeesUsd,
      epochStart: this.account.epochStart,
      tradesLast24h: rollingEntries(this.entries.map((ts) => ({ ts })), this.d.now()),
      openPosition: this.account.openPosition,
      usdInrRate: s.execution.usdInrRate,
      lastDecision: this.lastDecision,
    };
  }
}
